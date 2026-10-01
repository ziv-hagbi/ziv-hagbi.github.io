/**
 * Post‑deploy check of the REAL public site, run by GitHub Actions right after deployment.
 *
 *   node scripts/verify-live.mjs https://ziv-hagbi.github.io/
 *
 * Fails (exit 1) on any broken page, asset, deep link, navigation or map link.
 */
import { chromium, devices, request } from "@playwright/test";

const base = (process.argv[2] ?? "").replace(/\/?$/, "/");
if (!base.startsWith("https://") && !process.env.ALLOW_HTTP) throw new Error("usage: verify-live.mjs <https://production-url/>");
const origin = new URL(base).origin;

const pages = [
  ["", /זיו/],
  ["story/", /הסיפור של זיו/],
  ["words/", /המשפטים של זיו/],
  ["memorial/", /ח.*י.*י.*ם/],
  ["archive/", /כל התמונות והסרטונים/],
];
const failures = [];
const fail = (m) => {
  failures.push(m);
  console.log("FAIL", m);
};
const pass = (m) => console.log("ok  ", m);
const check = (ok, good, bad) => (ok ? pass(good) : fail(bad));

// GitHub Pages can take a moment to serve a fresh deployment.
const api = await request.newContext();
for (let i = 0; ; i++) {
  const r = await api.get(base);
  if (r.ok() && (await r.text()).includes("נבנה ועוצב באהבה")) break;
  if (i > 30) throw new Error(`site not serving the new build at ${base} (last status ${r.status()})`);
  await new Promise((res) => setTimeout(res, 10_000));
}

// 1. Every page, asset and deep URL answers over HTTPS.
for (const [path] of pages) {
  const r = await api.get(base + path);
  check(r.status() === 200, `200 ${base + path}`, `${r.status()} ${base + path}`);
}
for (const path of ["og.jpg", "sitemap.xml", "robots.txt", "manifest.webmanifest", "icon.png"]) {
  const r = await api.get(base + path);
  check(r.ok(), `200 ${path}`, `${r.status()} ${path}`);
}
const missing = await api.get(base + "this-page-does-not-exist/");
check(missing.status() === 404, "404 for unknown page", `unknown page answered ${missing.status()}`);

// 1b. Production metadata and privacy of what the server actually returns.
// Generic leak signatures only — the private deny-list (names of internal documents, old hosts,
// original file names) is enforced before publishing by the private audit, and step 1c proves the
// live site serves exactly the audited files.
const INTERNAL = /\\?"(verify|quality|emotion|file|posterAt|maxWidth|loopFrom|audio)\\?":|localhost:\d|\/\/127\.0\.0\.1|sourceMapping(?=URL=)/;
for (const [path] of pages) {
  const html = await (await api.get(base + path)).text();
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const ogUrl = html.match(/<meta property="og:url" content="([^"]+)"/)?.[1];
  const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1];
  check(canonical === base + path, `canonical ${path || "/"}`, `canonical ${path}: ${canonical}`);
  check(ogUrl === base + path, `og:url ${path || "/"}`, `og:url ${path}: ${ogUrl}`);
  check(ogImage?.startsWith(origin) && (await api.get(ogImage)).ok(), `og:image ${path || "/"}`, `og:image ${path}: ${ogImage}`);
  const leak = html.match(INTERNAL);
  check(!leak, `no private data in ${path || "/"} HTML`, `${path} HTML contains "${leak?.[0]}"`);
  // The client-side navigation payloads (RSC) for the page.
  for (const m of html.matchAll(/__next[\w.]*\.txt/g)) {
    const t = await (await api.get(new URL(m[0], base + path).href)).text();
    const l = t.match(INTERNAL);
    if (l) fail(`${path} payload ${m[0]} contains "${l[0]}"`);
  }
}
const sitemap = await (await api.get(base + "sitemap.xml")).text();
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
check(locs.length === pages.length && locs.every((l) => l.startsWith(base)), `sitemap lists ${locs.length} production URLs`, `sitemap: ${locs.join(", ")}`);
const robots = await (await api.get(base + "robots.txt")).text();
check(robots.includes(`Sitemap: ${base}sitemap.xml`), "robots.txt points to the sitemap", `robots: ${robots}`);
const manifest = await (await api.get(base + "manifest.webmanifest")).json();
check(manifest.start_url === "/" || manifest.start_url === new URL(base).pathname, `manifest start_url ${manifest.start_url}`, `manifest start_url ${manifest.start_url}`);

// 1c. The live site serves exactly the audited publication, byte for byte.
if (process.env.PUBLISHED_TREE) {
  const { createHash } = await import("node:crypto");
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join, relative } = await import("node:path");
  const rootDir = process.env.PUBLISHED_TREE;
  const tree = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      if (n === ".git" || n === ".github" || n === "README.md" || n === ".nojekyll") continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else tree.push(p);
    }
  })(rootDir);
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  let same = 0;
  const queue = [...tree];
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      for (let f; (f = queue.shift()); ) {
        const rel = relative(rootDir, f).split("\\").join("/");
        const r = await api.get(base + rel.split("/").map(encodeURIComponent).join("/"));
        if (r.ok() && sha(await r.body()) === sha(readFileSync(f))) same++;
        else fail(`live file differs or missing: ${rel} (${r.status()})`);
      }
    }),
  );
  check(same === tree.length, `live site is byte-identical to the audited publication (${same}/${tree.length} files)`, "live/published mismatch");
}

// 2. Each page in a real browser, phone and desktop: renders, no errors, no broken images, refresh works.
const browser = await chromium.launch();
for (const [label, opts] of [
  ["phone", devices["iPhone 13"]],
  ["desktop", { viewport: { width: 1440, height: 900 } }],
]) {
  const ctx = await browser.newContext({ ...opts, locale: "he-IL" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(base) && !r.url().includes("_rsc")) errors.push(`${r.status()} ${r.url()}`);
  });
  for (const [path, h1] of pages) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    const title = (await page.locator("h1").first().textContent()) ?? "";
    check(h1.test(title.replace(/[\u0591-\u05C7]/g, "")), `${label} ${path || "/"} h1`, `${label} ${path} h1="${title}"`);
    const broken = await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 1500));
      return [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc);
    });
    check(!broken.length, `${label} ${path} images`, `${label} ${path} broken images ${broken.join(", ")}`);
    const credit = await page.locator("footer").getByText("נבנה ועוצב באהבה על ידי רונאל רגב").count();
    check(credit === 1, `${label} ${path} credit`, `${label} ${path} credit x${credit}`);
  }

  // 3. A visitor’s path: home → menu → story → words → memorial → location; each page opens at its top.
  await page.goto(base, { waitUntil: "networkidle" });
  for (const to of ["story/", "words/", "memorial/"]) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.getByRole("button", { name: "תפריט" }).click();
    await page.getByRole("dialog").locator(`a[href$="/${to}"]`).first().click();
    await page.waitForURL(base + to);
    await page.waitForTimeout(400);
    const y = await page.evaluate(() => window.scrollY);
    check(y < 5, `${label} menu → ${to} opens at top`, `${label} menu → ${to} opened at ${y}px`);
  }
  await page.goBack();
  await page.waitForURL(base + "words/");
  pass(`${label} back button`);
  await page.goto(base + "memorial/#visit", { waitUntil: "networkidle" });
  const osm = await page.locator("#visit iframe").getAttribute("src");
  check(
    osm?.startsWith("https://www.openstreetmap.org/export/embed.html?") && osm.includes("marker=31.5047333%2C34.5897333"),
    `${label} OpenStreetMap embed at the canonical point`,
    `osm src ${osm}`,
  );
  const maps = await page.locator('#visit a[data-nav="google-maps"]').getAttribute("href");
  const waze = await page.locator('#visit a[data-nav="waze"]').getAttribute("href");
  check(maps === "https://www.google.com/maps/search/?api=1&query=31.5047333%2C34.5897333", `${label} Google Maps href`, `maps href ${maps}`);
  check(waze === "https://waze.com/ul?ll=31.5047333%2C34.5897333&navigate=yes", `${label} Waze href`, `waze href ${waze}`);
  check(!errors.length, `${label} no runtime errors`, `${label} errors: ${[...new Set(errors)].join(" | ")}`);
  await ctx.close();
}
await browser.close();

// 4. The navigation services themselves answer for these exact links.
for (const [name, url, expect] of [
  [
    "OpenStreetMap embed",
    "https://www.openstreetmap.org/export/embed.html?bbox=34.58553%2C31.50146%2C34.59393%2C31.50801&layer=mapnik&marker=31.5047333%2C34.5897333",
    // The embed page reads bbox/marker from its own URL in the browser (the point is checked on the
    // site's iframe src above); here we confirm OpenStreetMap serves its real map page for it.
    /id="map"|OpenStreetMap/,
  ],
  ["Google Maps", "https://www.google.com/maps/search/?api=1&query=31.5047333%2C34.5897333", /31\.5047333/],
  ["Waze", "https://waze.com/ul?ll=31.5047333%2C34.5897333&navigate=yes", /31\.5047333/],
]) {
  const r = await api.get(url, { maxRedirects: 0, headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" } });
  const where = r.headers()["location"] ?? "";
  const body = r.status() < 300 ? await r.text() : "";
  const keepsPoint = expect.test(decodeURIComponent(where)) || expect.test(body);
  check(r.status() < 400 && keepsPoint, `${name} answers ${r.status()}${where ? " → " + where.slice(0, 120) : ""}`, `${name} answered ${r.status()} ${where.slice(0, 160)}`);
}

console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nLIVE SITE VERIFIED");
process.exit(failures.length ? 1 : 0);
