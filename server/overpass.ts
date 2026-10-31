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

// Global mirrors only. Regional extracts (e.g. overpass.osm.ch, which only holds
// Swiss data) answer 200 with an EMPTY `elements` array everywhere else, which
// the proxy would otherwise accept as a genuine "no results" — the bug that left
// the Care Places list empty.
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;

/** Identifies the app and its purpose to the Overpass operators. */
export const OVERPASS_USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';

/** Per-mirror ceiling (C-01b spec: 8s). Each mirror gets its own controller. */
export const MIRROR_TIMEOUT_MS = 8_000;

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
/** 429 if a mirror rate-limited, 504 if every attempt timed out, else 500. */
const failureStatus = (reasons: string[]): number => {
  if (reasons.some((reason) => reason.endsWith(':429'))) return 429;
  if (reasons.length > 0 && reasons.every((reason) => /:(AbortError|TimeoutError)$/.test(reason))) {
    return 504;
  }
  return 500;
};

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
          const payload = (await upstream.json()) as { elements?: unknown };
          // A well-formed Overpass payload always carries an `elements` array.
          // Anything else (an HTML page, a wrong-region mirror) is not an answer.
          if (Array.isArray(payload?.elements)) {
            return { ok: true, status: 200, body: payload };
          }
          reasons.push(mirrorReason(mirror, 'invalid payload'));
          continue;
        }

        reasons.push(mirrorReason(mirror, upstream.status));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      console.error('Overpass API error:', error);
      const name = error instanceof Error && error.name ? error.name : 'err';
      reasons.push(mirrorReason(mirror, name));
    }
  }

  const status = failureStatus(reasons);
  console.error('Overpass API error:', reasons.join(', '));
  return {
    ok: false,
    status,
    error: status === 504 ? 'upstream timeout' : status === 429 ? 'rate limited' : 'all mirrors failed',
    reasons,
    detail: reasons.join(', '),
  };
};
