// Cloudflare Worker — CORS proxy + "latest file" resolver for BGR ED-269 drone zones.
//
// caa.bg serves the zone ZIP and its listing page WITHOUT CORS headers, and there is no stable
// "latest" URL (each release is a new dated path .../bgr_zones_DDMMYYYY.zip). A browser therefore
// cannot fetch it directly. This Worker runs server-side (no CORS there): it scrapes the listing for
// the newest zip, fetches it, and streams the bytes back with CORS so the static viewer can read it.
//
// Deploy:  npx wrangler login   (once)   then   npx wrangler deploy
// The client (index.html) then fetches this Worker's URL.

const LISTING_URL = "https://www.caa.bg/bg/category/633/7062";
const ORIGIN = "https://www.caa.bg";
const UA = "bgr-zones-viewer (+https://github.com/)";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-expose-headers": "x-source-file, x-source-url",
};

const err = (status, message) =>
  new Response(message, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return err(405, "Method Not Allowed");

    try {
      // 1. Scrape the listing page for every bgr_zones_DDMMYYYY.zip link, pick the newest by date.
      const listing = await fetch(LISTING_URL, {
        headers: { "user-agent": UA },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!listing.ok) return err(502, `CAA listing fetch failed: ${listing.status}`);
      const html = await listing.text();

      const re = /href=["']([^"']*bgr_zones_(\d{2})(\d{2})(\d{4})\.zip)["']/gi;
      let best = null;
      let bestKey = -1;
      for (let m = re.exec(html); m !== null; m = re.exec(html)) {
        const key = Number(m[4] + m[3] + m[2]); // YYYYMMDD — sortable
        if (key > bestKey) {
          bestKey = key;
          best = m[1];
        }
      }
      if (!best) return err(502, "No bgr_zones_*.zip link found on the CAA listing page");

      // 2. Fetch the newest zip and stream it back with CORS headers.
      const zipUrl = best.startsWith("http") ? best : ORIGIN + best;
      const upstream = await fetch(zipUrl, {
        headers: { "user-agent": UA },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
      if (!upstream.ok) return err(502, `CAA zip fetch failed: ${upstream.status}`);

      return new Response(upstream.body, {
        status: 200,
        headers: {
          ...CORS,
          "content-type": "application/zip",
          "cache-control": "public, max-age=3600",
          "x-source-file": zipUrl.split("/").pop(),
          "x-source-url": zipUrl,
        },
      });
    } catch (e) {
      return err(500, `Worker error: ${e && e.message ? e.message : e}`);
    }
  },
};
