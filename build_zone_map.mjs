#!/usr/bin/env node
// Build an interactive map + GeoJSON export from an ED-269 UAS Geographical Zone file.
//
//   node build_zone_map.mjs [input.json]   (defaults to bgr_zones_16062026.json)
//
// Outputs (named after the input basename):
//   <name>.html     interactive Leaflet map  (true circles, color-coded, click-for-detail)
//   <name>.geojson  GeoJSON FeatureCollection (circles approximated as 64-pt polygons)
//
// Zero dependencies. Leaflet + OSM tiles are loaded from a CDN, so the HTML needs internet to view.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";

const inputPath = process.argv[2] ?? "bgr_zones_16062026.json";
const stem = basename(inputPath, extname(inputPath));
const htmlPath = `${stem}.html`;
const geojsonPath = `${stem}.geojson`;

// --- Restriction → color (used for both simplestyle GeoJSON and the Leaflet map) ---
const COLORS = {
  PROHIBITED: "#d7191c", // red
  REQ_AUTHORISATION: "#fdae61", // orange
  CONDITIONAL: "#f7e043", // amber
};
const DEFAULT_COLOR = "#3388ff";
const colorFor = (restriction) => COLORS[restriction] ?? DEFAULT_COLOR;

// --- Geodesic circle → polygon ring ([lon,lat]), closed. GeoJSON export only. ---
const EARTH_R = 6378137; // meters (WGS84 mean)
function circleToRing(lon, lat, radiusM, n = 64) {
  const d = radiusM / EARTH_R;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const brng = (2 * Math.PI * i) / n;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([(lon2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}

// --- Coordinate sanity: Bulgaria + neighbors box. Fix lat/lon transpositions; flag true outliers. ---
const inBox = (lon, lat) => lon >= 21 && lon <= 30 && lat >= 40.5 && lat <= 45;
const corrected = new Set();
const outliers = new Set();
function fixPoint(lon, lat, id) {
  if (inBox(lon, lat)) return [lon, lat];
  if (inBox(lat, lon)) {
    corrected.add(id); // coordinates stored [lat,lon] instead of [lon,lat]
    return [lat, lon];
  }
  outliers.add(id); // out of region and not a transposition — keep as-is, warn
  return [lon, lat];
}

// --- Read + normalize ---
const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const features = Array.isArray(raw.features) ? raw.features : [];

const zones = [];
let skipped = 0;
for (const f of features) {
  const g = f.geometry?.[0];
  const hp = g?.horizontalProjection;
  if (!hp) {
    skipped++;
    continue;
  }
  const meta = {
    identifier: f.identifier ?? "",
    name: f.name ?? "",
    type: f.type ?? "",
    restriction: f.restriction ?? "",
    reason: Array.isArray(f.reason) ? f.reason : [],
    otherReasonInfo: f.otherReasonInfo ?? "",
    uSpaceClass: f.uSpaceClass ?? "",
    message: f.message ?? "",
    lowerLimit: g.lowerLimit,
    upperLimit: g.upperLimit,
    lowerRef: g.lowerVerticalReference ?? "",
    upperRef: g.upperVerticalReference ?? "",
    uom: g.uomDimensions ?? "M",
    applicability: Array.isArray(f.applicability) ? f.applicability : [],
    regulationExemption: f.regulationExemption ?? "",
    zoneAuthority: Array.isArray(f.zoneAuthority) ? f.zoneAuthority : [],
  };

  if (hp.type === "Circle" && Array.isArray(hp.center)) {
    const [lon, lat] = fixPoint(hp.center[0], hp.center[1], meta.identifier);
    zones.push({ ...meta, shape: "circle", lon, lat, radius: hp.radius });
  } else if (hp.type === "Polygon" && Array.isArray(hp.coordinates)) {
    const rings = hp.coordinates.map((ring) =>
      ring.map(([lon, lat]) => fixPoint(lon, lat, meta.identifier)),
    );
    zones.push({ ...meta, shape: "polygon", rings });
  } else {
    skipped++;
  }
}

// --- GeoJSON export ---
const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmtApplicability(app) {
  if (!Array.isArray(app) || !app.length) return "";
  return app
    .map((a) =>
      a.permanent === "YES" ? "Permanent" : [a.startDateTime, a.endDateTime].filter(Boolean).join(" → "),
    )
    .filter(Boolean)
    .join("; ");
}

function popupHtml(z) {
  const band =
    z.lowerLimit != null && z.upperLimit != null
      ? `${z.lowerLimit}–${z.upperLimit} ${z.uom} (${z.lowerRef || "?"}→${z.upperRef || "?"})`
      : "";
  const za = (z.zoneAuthority && z.zoneAuthority[0]) || null;
  const rows = [
    ["ID", z.identifier],
    ["Name", z.name],
    ["Type", z.type],
    ["Restriction", z.restriction],
    ["Reason", z.reason.join(", ")],
    ["Other", z.otherReasonInfo],
    ["U-space", z.uSpaceClass],
    ["Vertical", band],
    z.shape === "circle" ? ["Radius", `${z.radius} m`] : null,
    ["Applicability", fmtApplicability(z.applicability)],
    ["Reg. exemption", z.regulationExemption],
    za ? ["Authority", [za.name, za.purpose].filter(Boolean).join(" · ")] : null,
    za ? ["Contact", za.contactName] : null,
    za ? ["Email", za.email] : null,
    za ? ["Phone", za.phone] : null,
    za ? ["Notify before", za.intervalBefore] : null,
    ["Message", z.message],
  ].filter((r) => r && r[1] !== "" && r[1] != null);
  const trs = rows
    .map(
      ([k, v]) =>
        `<tr><th style="text-align:left;padding-right:8px;vertical-align:top;white-space:nowrap">${escapeHtml(
          k,
        )}</th><td>${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return `<table style="font:12px/1.4 system-ui,sans-serif;max-width:320px">${trs}</table>`;
}

function toGeoJsonFeature(z) {
  const color = colorFor(z.restriction);
  const coordinates =
    z.shape === "circle" ? [circleToRing(z.lon, z.lat, z.radius)] : z.rings;
  const properties = {
    identifier: z.identifier,
    name: z.name,
    type: z.type,
    restriction: z.restriction,
    reason: z.reason.join(", "),
    otherReasonInfo: z.otherReasonInfo,
    uSpaceClass: z.uSpaceClass,
    lowerLimit: z.lowerLimit,
    upperLimit: z.upperLimit,
    lowerVerticalReference: z.lowerRef,
    upperVerticalReference: z.upperRef,
    message: z.message,
    originalShape: z.shape,
    // simplestyle-spec (rendered by geojson.io / many viewers)
    stroke: color,
    "stroke-width": 1,
    fill: color,
    "fill-opacity": 0.35,
    title: `${z.identifier} ${z.name}`.trim(),
    description: `${z.restriction} · ${z.lowerLimit}–${z.upperLimit} ${z.uom} ${z.upperRef}`,
  };
  if (z.shape === "circle") properties.radius_m = z.radius;
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates } };
}

const geojson = {
  type: "FeatureCollection",
  name: raw.title ?? stem,
  features: zones.map(toGeoJsonFeature),
};
writeFileSync(geojsonPath, JSON.stringify(geojson) + "\n");

// --- HTML map (Leaflet [lat,lon]; circles stay native) ---
const mapZones = zones.map((z) => {
  const base = {
    r: z.restriction,
    c: colorFor(z.restriction),
    p: popupHtml(z),
  };
  return z.shape === "circle"
    ? { ...base, t: "c", ll: [z.lat, z.lon], rad: z.radius }
    : { ...base, t: "p", rings: z.rings.map((ring) => ring.map(([lon, lat]) => [lat, lon])) };
});

// Fit-bounds computed from the data (robust — avoids projecting circles before a view is set).
let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
const extend = (lat, lon) => {
  if (lat < minLat) minLat = lat;
  if (lat > maxLat) maxLat = lat;
  if (lon < minLon) minLon = lon;
  if (lon > maxLon) maxLon = lon;
};
for (const z of zones) {
  if (z.shape === "circle") {
    const dLat = z.radius / 111320;
    const dLon = z.radius / (111320 * Math.cos((z.lat * Math.PI) / 180));
    extend(z.lat - dLat, z.lon - dLon);
    extend(z.lat + dLat, z.lon + dLon);
  } else {
    for (const ring of z.rings) for (const [lon, lat] of ring) extend(lat, lon);
  }
}
const bounds = [[minLat, minLon], [maxLat, maxLon]];

const counts = zones.reduce((acc, z) => ((acc[z.restriction] = (acc[z.restriction] ?? 0) + 1), acc), {});
const legendRows = Object.keys(COLORS)
  .map(
    (k) =>
      `<div><span style="display:inline-block;width:12px;height:12px;background:${COLORS[k]};border:1px solid #0006;margin-right:6px"></span>${k} (${counts[k] ?? 0})</div>`,
  )
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(raw.title ?? stem)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
  integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
  integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<style>
  html,body{margin:0;height:100%}
  #map{height:100%}
  .legend{background:#fff;padding:8px 10px;border-radius:6px;box-shadow:0 1px 4px #0003;font:13px/1.5 system-ui,sans-serif}
  .legend b{display:block;margin-bottom:4px}
</style>
</head>
<body>
<div id="map"></div>
<script>
const ZONES = ${JSON.stringify(mapZones)};
const BOUNDS = ${JSON.stringify(bounds)};
const map = L.map("map").fitBounds(BOUNDS, { padding: [20, 20] });
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const groups = {};
for (const z of ZONES) {
  const style = { color: z.c, weight: 1, fillColor: z.c, fillOpacity: 0.35 };
  const layer = z.t === "c" ? L.circle(z.ll, { radius: z.rad, ...style }) : L.polygon(z.rings, style);
  layer.bindPopup(z.p);
  (groups[z.r] = groups[z.r] || L.layerGroup().addTo(map)).addLayer(layer);
}

L.control.layers(null, groups, { collapsed: false }).addTo(map);
L.control.scale().addTo(map);

const legend = L.control({ position: "bottomright" });
legend.onAdd = function () {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML = '<b>${escapeHtml(raw.title ?? stem)} — ${zones.length} zones</b>${legendRows}';
  return div;
};
legend.addTo(map);
</script>
</body>
</html>
`;
writeFileSync(htmlPath, html);

const nCircle = zones.filter((z) => z.shape === "circle").length;
const nPoly = zones.filter((z) => z.shape === "polygon").length;
console.log(`Read ${features.length} features from ${inputPath}`);
console.log(`Mapped ${zones.length} zones (${nCircle} circles + ${nPoly} polygons)${skipped ? `, skipped ${skipped}` : ""}`);
console.log(`By restriction: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
if (corrected.size) console.log(`Fixed lat/lon transposition in: ${[...corrected].join(", ")}`);
if (outliers.size) console.log(`WARNING: out-of-region zone(s) kept as-is — verify with CAA: ${[...outliers].join(", ")}`);
console.log(`Wrote ${geojsonPath}`);
console.log(`Wrote ${htmlPath}  (open in a browser)`);
