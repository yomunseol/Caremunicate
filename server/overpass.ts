// ---------------------------------------------------------------------------
// Overpass proxy core — SERVER-SIDE ONLY.
//
// POSTed as a form body (the public server drops long GET URLs), with a 25s
// budget that matches the `[timeout:25]` inside the query. Two endpoints are
// tried in order under ONE shared deadline: a fast failure of the primary (e.g.
// 502 "at capacity") leaves the rest of the budget for the fallback. A timeout
// is a 504 with a human message so the frontend shows its Retry state instead
// of hanging or a false "no results".
//
// Consumed by both runtimes so the transport has exactly one definition:
//   • api/overpass.ts  — the Vercel serverless function (production)
//   • vite.config.ts   — a dev-only middleware standing in for it
// ---------------------------------------------------------------------------

export const OVERPASS_ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

/** Identifies the app and its purpose to the Overpass operators. */
export const OVERPASS_USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';

/** Overall ceiling across both attempts (matches `[timeout:25]`). */
export const OVERPASS_TIMEOUT_MS = 25_000;

export const OVERPASS_CACHE_CONTROL = 'public, s-maxage=600';

/** Shown by the frontend when neither upstream answers in time. */
export const OVERPASS_TIMEOUT_ERROR = 'Search timed out. Please try again.';

export type OverpassProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; reasons: string[]; detail: string };

/**
 * POSTs the Overpass QL to each endpoint in order until one answers, all under
 * one 25s AbortController. Nothing throws: failures come back as a 504.
 */
export const proxyOverpass = async (query: string): Promise<OverpassProxyResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

  let lastReason = 'unknown';

  try {
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const upstream = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': OVERPASS_USER_AGENT,
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
          cache: 'no-store',
        });

        if (upstream.ok) {
          const payload = (await upstream.json()) as { elements?: unknown };
          // A well-formed Overpass payload always carries an `elements` array.
          if (Array.isArray(payload?.elements)) {
            return { ok: true, status: 200, body: payload };
          }
          lastReason = 'invalid payload';
          console.error('Overpass API error: invalid payload');
          continue;
        }

        lastReason = String(upstream.status);
        console.error('Overpass API error:', upstream.status);
      } catch (error) {
        console.error('Overpass API error:', error);
        lastReason = error instanceof Error ? error.name : 'err';
        // The shared 25s deadline fired: no budget left for another endpoint.
        if (controller.signal.aborted) break;
      }
    }

    const timedOut = controller.signal.aborted;
    return {
      ok: false,
      status: 504,
      error: timedOut ? OVERPASS_TIMEOUT_ERROR : 'Search failed. Please try again.',
      reasons: [lastReason],
      detail: lastReason,
    };
  } finally {
    clearTimeout(timer);
  }
};
