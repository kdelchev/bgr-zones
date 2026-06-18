# BGR Drone Zones (ED-269) viewer

Visualizes Bulgarian CAA drone geographical zones (the **ED-269** standard) on an interactive map.

- **Source:** https://www.caa.bg/bg/category/633/7062 (a ZIP containing one ED-269 JSON, named
  `bgr_zones_DDMMYYYY.zip` with the data date).
- **Units:** meters (`uomDimensions: "M"`) — `radius` and the `lower/upperLimit` altitude band are in meters
  (e.g. `upperLimit: 120` = 120 m AGL).

## Live viewer — `index.html` + Cloudflare Worker

caa.bg sends **no CORS headers** and has **no stable "latest" URL**, so a browser page cannot fetch the file
directly. A tiny Cloudflare Worker (`worker.js`) runs server-side: it scrapes the listing for the newest
`bgr_zones_DDMMYYYY.zip`, fetches it, and re-serves the bytes with CORS. The static page (`index.html`)
then fetches the Worker, unzips it in the browser (fflate), and renders with Leaflet.

### 1. Deploy the Worker
```sh
npx wrangler login      # once
npx wrangler deploy     # → https://bgr-zones.<your-subdomain>.workers.dev
```

### 2. Point the page at it
Edit `DEFAULT_WORKER_URL` near the top of the `<script>` in `index.html`, or test without editing via the
query param: `index.html?worker=https://bgr-zones.<you>.workers.dev`.

### 3. Publish the page (GitHub Pages)
Push this repo to GitHub, then enable **Settings → Pages → Deploy from branch** (root). Opening the Pages URL
auto-loads and renders the latest zones. Use **Reload latest** to re-fetch.

### Features
- Circles drawn as **true circles** (native radius); polygons drawn directly. Canvas renderer
  (`preferCanvas`) keeps ~1,200 vectors smooth.
- **Grouped layer control** (doubles as the legend) with two sections — *CAA ED‑269* and *CAA airzones* —
  each with a master on/off plus per-category toggles and counts.
- Click-for-metadata popups; clicking an overlap lists **every** zone under the cursor (across both layers).
- Auto-fixes a known lat/lon **transposition** (zone `0000502`) and flags an out-of-region **outlier**
  (zone `0001133`) without moving it.
- **Manual fallback:** if the Worker is unreachable, drag/drop or open a `.zip`/`.json` downloaded from
  caa.bg — works fully client-side (only map tiles need internet).

### Color scheme (two orthogonal axes)
ED‑269 `restriction` (drone severity, warm ramp) and airzone `type` (zone purpose, cool/qualitative) are
independent classifications, so each source has its own palette:

| ED‑269 (severity) | Airzones (purpose) |
|---|---|
| 🔴 PROHIBITED `#d7191c` | 🟣 Security `#7c3aed` |
| 🟠 REQ_AUTHORISATION `#fdae61` | 🔵 Airport — restricted `#2563eb` |
| 🟡 CONDITIONAL `#f7e043` | 🟦 Airport — safety `#0891b2` · 🟢 Coordination `#15803d` · 🌸 Environmental `#be185d` |

## Second layer — CAA "airzones" (`bin/fetch-airzones.mjs` + `airzones/`)

The CAA also publishes an *Interactive Maps – Flight Zones* catalog
(https://www.caa.bg/bg/category/745) of **302 zones** (border "security areas", airport zones, prisons,
numbered restricted/danger areas, …) — a dataset **separate** from the ED-269 drone ZIP. The viewer shows
it as a second source, **split into one toggleable layer per type** (Security, Airport restricted/safety,
Coordination, Environmental), on by default, with its own source link.

`bin/fetch-airzones.mjs` builds the data — **fetch-only** (no git; commit/push yourself):
```sh
node bin/fetch-airzones.mjs
```
- Crawls the category-745 index, then downloads each `https://www.caa.bg/bg/airzones/{id}` GeoJSON.
- **Idempotent:** stores an md5 per zone in `airzones/manifest.json`; unchanged zones are left untouched
  (and stale ones removed), so re-runs produce no diff.
- Writes per-zone `airzones/{id}.geojson`, the `manifest.json`, and a combined **`airzones/all.geojson`**
  (the single file the viewer loads, same-origin via Pages — no Worker/CORS needed for this layer).

Run it before committing when you want fresh airzone data.

## Offline / static generator — `build_zone_map.mjs`

Turns a locally-downloaded ED-269 file into a standalone `.html` map + a `.geojson` export (for
geojson.io / QGIS). Circles in the GeoJSON are approximated as 64-point polygons (GeoJSON has no circle type).
```sh
node build_zone_map.mjs [input.json]   # defaults to bgr_zones_16062026.json
```
