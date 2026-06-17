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
- Circles drawn as **true circles** (native radius); polygons drawn directly.
- Color-coded by restriction: 🔴 PROHIBITED · 🟠 REQ_AUTHORISATION · 🟡 CONDITIONAL.
- Click-for-metadata popups, per-restriction layer toggles, legend with counts.
- Auto-fixes a known lat/lon **transposition** (zone `0000502`) and flags an out-of-region **outlier**
  (zone `0001133`) without moving it.
- **Manual fallback:** if the Worker is unreachable, drag/drop or open a `.zip`/`.json` downloaded from
  caa.bg — works fully client-side (only map tiles need internet).

## Offline / static generator — `build_zone_map.mjs`

Turns a locally-downloaded ED-269 file into a standalone `.html` map + a `.geojson` export (for
geojson.io / QGIS). Circles in the GeoJSON are approximated as 64-point polygons (GeoJSON has no circle type).
```sh
node build_zone_map.mjs [input.json]   # defaults to bgr_zones_16062026.json
```
