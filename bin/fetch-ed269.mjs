#!/usr/bin/env node
// Fetch the latest ED-269 drone-zone ZIP from caa.bg and store it as a static file the page serves.
// Fetch-only: NO git. Idempotent by the dated filename (caa.bg publishes bgr_zones_DDMMYYYY.zip per
// release), so re-runs don't re-download or churn git when the latest file is unchanged.
//
//   node bin/fetch-ed269.mjs
//
// Outputs (repo root):
//   ed269/latest.zip      the newest ED-269 ZIP, served as-is (the browser unzips it with fflate)
//   ed269/manifest.json   { sourceFile, url, listing } — drives filename-based idempotency

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "ed269");
const ZIP = resolve(OUT_DIR, "latest.zip");
const MANIFEST = resolve(OUT_DIR, "manifest.json");

const LISTING = "https://www.caa.bg/bg/category/633/7062";
const ORIGIN = "https://www.caa.bg";
const UA = "bgr-zones ed269 fetcher (+https://github.com/kdelchev/bgr-zones)";

async function fetchRes(url, asText = false) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asText ? await res.text() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Resolve the newest bgr_zones_DDMMYYYY.zip on the listing page.
  const html = await fetchRes(LISTING, true);
  const re = /href="([^"]*bgr_zones_(\d{2})(\d{2})(\d{4})\.zip)"/g;
  let best = null;
  let bestKey = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const key = Number(m[4] + m[3] + m[2]); // YYYYMMDD
    if (key > bestKey) { bestKey = key; best = m[1]; }
  }
  if (!best) throw new Error("No bgr_zones_*.zip link found on the CAA ED-269 listing");
  const url = best.startsWith("http") ? best : ORIGIN + best;
  const sourceFile = url.split("/").pop();

  // 2. Filename-based idempotency.
  let prev = null;
  try { prev = JSON.parse(await readFile(MANIFEST, "utf8")); } catch {}
  if (prev && prev.sourceFile === sourceFile && existsSync(ZIP)) {
    console.log(`Unchanged: latest is still ${sourceFile}.`);
    return;
  }

  // 3. Download + store.
  const zip = await fetchRes(url);
  await writeFile(ZIP, zip);
  await writeFile(MANIFEST, JSON.stringify({ sourceFile, url, listing: LISTING }, null, 2) + "\n");
  console.log(`Updated: ${sourceFile} (${zip.length} bytes) → ed269/latest.zip`);
}

main().catch((e) => { console.error(e); process.exit(1); });
