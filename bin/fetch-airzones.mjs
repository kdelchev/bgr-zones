#!/usr/bin/env node
// Fetch the CAA "Интерактивни карти – Летателни зони" catalog (category 745) and download every
// zone's GeoJSON into ./airzones/. Fetch-only: NO git. Idempotent via md5 stored in manifest.json —
// unchanged zones are left untouched so re-runs produce no diff.
//
//   node bin/fetch-airzones.mjs
//
// Outputs (repo root):
//   airzones/<id>.geojson   one raw FeatureCollection per zone
//   airzones/manifest.json  [{id,title,type,file,hash,etag,source}] sorted by id
//   airzones/all.geojson    combined FeatureCollection (props id/title/type/source) for the viewer

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "airzones");
const MANIFEST = resolve(OUT_DIR, "manifest.json");
const COMBINED = resolve(OUT_DIR, "all.geojson");

const ORIGIN = "https://www.caa.bg";
const INDEX = (p) => `${ORIGIN}/bg/category/745?page=${p}`;
const ZONE = (id) => `${ORIGIN}/bg/airzones/${id}`;
const DETAIL = (id) => `${ORIGIN}/bg/category/745/${id}`;
const UA = "bgr-zones airzones fetcher (+https://github.com/kdelchev/bgr-zones)";
const CONCURRENCY = 8;
const MAX_PAGES = 40; // safety cap; loop stops earlier when a page yields nothing new

const md5 = (buf) => createHash("md5").update(buf).digest("hex");

// Trim coordinates to 6 decimals (~0.11 m): big size win, no visible change, and makes the md5
// immune to insignificant sub-decimetre jitter from the source.
const round6 = (n) => (typeof n === "number" ? Math.round(n * 1e6) / 1e6 : n);
const trimCoords = (c) => (Array.isArray(c[0]) ? c.map(trimCoords) : c.map(round6));
function trimGeojson(data) {
  for (const f of data.features || []) {
    if (f.geometry && f.geometry.coordinates) f.geometry.coordinates = trimCoords(f.geometry.coordinates);
  }
  return data;
}

async function fetchText(url, headers = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, ...headers } });
      return res;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
}

// 1. Crawl the paginated index → ordered list of { id, title }.
async function crawlIndex() {
  const seen = new Map(); // id -> title
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchText(INDEX(page));
    if (!res.ok) throw new Error(`index page ${page} → HTTP ${res.status}`);
    const html = await res.text();
    const re = /href="\/bg\/category\/745\/(\d+)"[^>]*>\s*([^<]+?)\s*</g;
    let added = 0;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const [, id, title] = m;
      if (!seen.has(id)) { seen.set(id, title.trim()); added++; }
    }
    process.stdout.write(`  index page ${page}: +${added} (total ${seen.size})\n`);
    if (added === 0) break; // past the last populated page
  }
  return [...seen].map(([id, title]) => ({ id, title }));
}

// Run async tasks with a fixed concurrency cap.
async function pool(items, worker) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await worker(items[idx], idx);
      }
    }),
  );
  return results;
}

async function loadManifest() {
  try {
    const arr = JSON.parse(await readFile(MANIFEST, "utf8"));
    return new Map(arr.map((e) => [e.id, e]));
  } catch {
    return new Map();
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log("Crawling category-745 index…");
  const list = await crawlIndex();
  console.log(`Found ${list.length} zones. Downloading GeoJSON (concurrency ${CONCURRENCY})…`);

  const prev = await loadManifest();
  const counts = { added: 0, changed: 0, unchanged: 0, empty: 0, error: 0 };

  const entries = await pool(list, async ({ id, title }) => {
    const old = prev.get(id);
    try {
      const res = await fetchText(ZONE(id));
      if (!res.ok) { counts.error++; console.warn(`  ! ${id} HTTP ${res.status}`); return old ? { ...old, title } : null; }

      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch { counts.error++; console.warn(`  ! ${id} invalid JSON`); return null; }
      if (!data || !Array.isArray(data.features) || data.features.length === 0) {
        counts.empty++; return { id, title, type: "", file: null, hash: "", source: DETAIL(id), empty: true };
      }

      const body = JSON.stringify(trimGeojson(data)); // trimmed canonical form
      const hash = md5(body);
      const type = data.features[0]?.properties?.route || "";
      const file = `${id}.geojson`;
      if (old && old.hash === hash && !old.empty) {
        counts.unchanged++;
      } else {
        await writeFile(resolve(OUT_DIR, file), body + "\n");
        old ? counts.changed++ : counts.added++;
      }
      return { id, title, type, file, hash, source: DETAIL(id) };
    } catch (e) {
      counts.error++; console.warn(`  ! ${id} ${e.message}`);
      return old ? { ...old, title } : null;
    }
  });

  const manifest = entries.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  const keepFiles = new Set(manifest.filter((e) => e.file).map((e) => e.file));

  // Reconcile: delete stale .geojson files no longer referenced.
  let removed = 0;
  for (const f of await readdir(OUT_DIR)) {
    if (f.endsWith(".geojson") && f !== "all.geojson" && !keepFiles.has(f)) {
      await unlink(resolve(OUT_DIR, f)); removed++;
    }
  }

  // Combined FeatureCollection for the viewer (deterministic order + metadata in properties).
  const features = [];
  for (const e of manifest) {
    if (!e.file) continue;
    const fc = JSON.parse(await readFile(resolve(OUT_DIR, e.file), "utf8"));
    for (const feat of fc.features) {
      features.push({
        type: "Feature",
        properties: { id: e.id, title: e.title, type: e.type, source: e.source, ...(feat.properties || {}) },
        geometry: feat.geometry,
      });
    }
  }
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(COMBINED, JSON.stringify({ type: "FeatureCollection", features }) + "\n");

  console.log(
    `\nDone. added=${counts.added} changed=${counts.changed} unchanged=${counts.unchanged} ` +
    `empty=${counts.empty} error=${counts.error} removed=${removed}`,
  );
  console.log(`Manifest: ${manifest.length} zones (${features.length} features) → airzones/all.geojson`);
}

main().catch((e) => { console.error(e); process.exit(1); });
