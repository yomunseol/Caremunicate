// ---------------------------------------------------------------------------
// Overpass proxy core — SERVER-SIDE ONLY.
//
// The browser never talks to an Overpass mirror. It calls the same-origin
// /api/overpass route, which runs this: mirrors are tried in order with a 15s
// AbortController each, a descriptive User-Agent attached, and the JSON result
// cached at the edge (Cache-Control: public, s-maxage=600).
//
// Consumed by both runtimes so the mirror order has exactly one definition:
//   • api/overpass.ts  — the Vercel serverless function (production)
//   • vite.config.ts   — a dev-only middleware standing in for it
// ---------------------------------------------------------------------------

export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;

/** Identifies the app and its purpose to the Overpass operators. */
export const OVERPASS_USER_AGENT = 'Caremunicate/1.0 (Care Places Overpass proxy)';

/** Per-mirror ceiling. Each mirror gets its own controller. */
export const MIRROR_TIMEOUT_MS = 15_000;

export const OVERPASS_CACHE_CONTROL = 'public, s-maxage=600';

export type OverpassProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; detail: string };

/**
 * POSTs the Overpass QL to each mirror in order until one answers.
 *
 * `application/x-www-form-urlencoded` is what the Overpass interpreter expects;
 * `data` carries the query. Throws nothing — the last failure is returned so the
 * caller can answer 502 with a reason.
 */
export const proxyOverpass = async (query: string): Promise<OverpassProxyResult> => {
  let lastError = '';

  for (const mirror of OVERPASS_MIRRORS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);

    try {
      const upstream = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': OVERPASS_USER_AGENT,
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });

      if (!upstream.ok) {
        lastError = `${mirror} responded ${upstream.status}`;
        continue;
      }

      return { ok: true, status: 200, body: await upstream.json() };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 502, error: 'All Overpass mirrors failed', detail: lastError };
};
