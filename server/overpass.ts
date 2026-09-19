// ---------------------------------------------------------------------------
// Overpass proxy core — SERVER-SIDE ONLY.
//
// Mirrors are tried IN ORDER, each with its own 15s AbortController, and the
// reason for every failure is collected. On total failure the caller answers
// 502 with that `reasons` array; a thrown crash inside the route answers 500.
//
// Consumed by both runtimes so the mirror order has exactly one definition:
//   • api/overpass.ts  — the Vercel serverless function (production)
//   • vite.config.ts   — a dev-only middleware standing in for it
// ---------------------------------------------------------------------------

export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
] as const;

/** Identifies the app and its purpose to the Overpass operators. */
export const OVERPASS_USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';

/** Per-mirror ceiling. Each mirror gets its own controller. */
export const MIRROR_TIMEOUT_MS = 15_000;

export const OVERPASS_CACHE_CONTROL = 'public, s-maxage=600';

export type OverpassProxyResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string; reasons: string[]; detail: string };

/** `${host}:${status}` or `${host}:${ErrorName}` — one entry per failed mirror. */
const mirrorReason = (mirror: string, reason: string | number): string => {
  try {
    return `${new URL(mirror).host}:${reason}`;
  } catch {
    return `${mirror}:${reason}`;
  }
};

/**
 * POSTs the Overpass QL to each mirror in order until one answers.
 *
 * `application/x-www-form-urlencoded` is what the Overpass interpreter expects;
 * `data` carries the query. Nothing is thrown: when every mirror fails the
 * collected `reasons` come back so the route can answer 502 with them.
 */
export const proxyOverpass = async (query: string): Promise<OverpassProxyResult> => {
  const reasons: string[] = [];

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);

      try {
        const upstream = await fetch(mirror, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': OVERPASS_USER_AGENT,
          },
          signal: controller.signal,
          cache: 'no-store',
        });

        if (upstream.ok) {
          return { ok: true, status: 200, body: await upstream.json() };
        }

        reasons.push(mirrorReason(mirror, upstream.status));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const name = error instanceof Error && error.name ? error.name : 'err';
      reasons.push(mirrorReason(mirror, name));
    }
  }

  return {
    ok: false,
    status: 502,
    error: 'all mirrors failed',
    reasons,
    detail: reasons.join(', '),
  };
};
