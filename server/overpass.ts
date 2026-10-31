// ---------------------------------------------------------------------------
// Overpass proxy core — SERVER-SIDE ONLY.
//
// ONE fast, less-congested mirror (lz4.overpass-api.de), POSTed as a form body
// — the public server drops long GET URLs — behind a strict 8s AbortController.
// A timeout is a 504 with a human message so the frontend shows its Retry state
// instead of hanging or a false "no results".
//
// Consumed by both runtimes so the transport has exactly one definition:
//   • api/overpass.ts  — the Vercel serverless function (production)
//   • vite.config.ts   — a dev-only middleware standing in for it
// ---------------------------------------------------------------------------

export const OVERPASS_ENDPOINT = 'https://lz4.overpass-api.de/api/interpreter';

/** Identifies the app and its purpose to the Overpass operators. */
export const OVERPASS_USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';

/** Strict server-side ceiling (8s). */
export const OVERPASS_TIMEOUT_MS = 8_000;

export const OVERPASS_CACHE_CONTROL = 'public, s-maxage=600';

/** Shown by the frontend when the upstream never answers in time. */
export const OVERPASS_TIMEOUT_ERROR = 'Search timed out. Please try again.';

export type OverpassProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; reasons: string[]; detail: string };

/**
 * POSTs the Overpass QL to the one mirror.
 *
 * `application/x-www-form-urlencoded` is what the interpreter expects; `data`
 * carries the query. Nothing throws: failures come back as a status + reason so
 * the route can answer 504/429/500 with them.
 */
export const proxyOverpass = async (query: string): Promise<OverpassProxyResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

  try {
    const upstream = await fetch(OVERPASS_ENDPOINT, {
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

    if (!upstream.ok) {
      console.error('Overpass API error:', upstream.status);
      if (upstream.status === 429) {
        return { ok: false, status: 429, error: 'rate limited', reasons: ['429'], detail: '' };
      }
      return {
        ok: false,
        status: 500,
        error: 'overpass failed',
        reasons: [String(upstream.status)],
        detail: '',
      };
    }

    const payload = (await upstream.json()) as { elements?: unknown };
    // A well-formed Overpass payload always carries an `elements` array.
    if (!Array.isArray(payload?.elements)) {
      console.error('Overpass API error: invalid payload');
      return { ok: false, status: 500, error: 'invalid payload', reasons: ['invalid payload'], detail: '' };
    }

    return { ok: true, status: 200, body: payload };
  } catch (error) {
    console.error('Overpass API error:', error);
    const name = error instanceof Error ? error.name : 'err';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { ok: false, status: 504, error: OVERPASS_TIMEOUT_ERROR, reasons: ['timeout'], detail: '' };
    }
    return { ok: false, status: 500, error: 'overpass failed', reasons: [String(error)], detail: '' };
  } finally {
    clearTimeout(timer);
  }
};
