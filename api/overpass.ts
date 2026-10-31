// ---------------------------------------------------------------------------
// /api/overpass — Vercel serverless function (Node runtime).
//
// FULLY SELF-CONTAINED: zero relative imports, so an extensionless-import
// error (TS2835) cannot occur here.
//
// POSTed as a form body (the public server drops long GET URLs) with a 25s
// budget matching the `[timeout:25]` in the query. Two endpoints are tried in
// order under ONE shared deadline, so a fast primary failure leaves the rest of
// the budget for the fallback.
//
//   GET/POST /api/overpass?data=<encoded Overpass QL>   (or form body `data`)
//   -> 200 JSON (Overpass payload), Cache-Control: public, s-maxage=600
//   -> 400 { error: 'missing data' }
//   -> 405 { error: 'method not allowed' }
//   -> 504 { error: 'Search timed out. Please try again.' | 'Search failed. Please try again.' }
//   -> 500 { error: 'route crash', detail }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs' };

const ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';
const TIMEOUT_MS = 25_000;
const CACHE_CONTROL = 'public, s-maxage=600';
const NO_STORE = 'no-store';
const TIMEOUT_ERROR = 'Search timed out. Please try again.';
const FAILED_ERROR = 'Search failed. Please try again.';

type ProxyRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  url?: string;
};

type ProxyResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ProxyResponse;
  json: (body: unknown) => void;
};

const asString = (value: unknown): string => {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return typeof value === 'string' ? value : '';
};

/** The Overpass QL, from the query string, the parsed body, or the raw URL. */
const readQuery = (req: ProxyRequest): string => {
  const fromQuery = asString(req.query?.data);
  if (fromQuery.trim()) return fromQuery;

  const body = req.body;
  if (body && typeof body === 'object' && 'data' in body) {
    const fromBody = asString((body as Record<string, unknown>).data);
    if (fromBody.trim()) return fromBody;
  }

  if (req.url) {
    try {
      return new URL(req.url, 'http://localhost').searchParams.get('data') ?? '';
    } catch {
      /* malformed request URL */
    }
  }

  return '';
};

export default async function handler(req: ProxyRequest, res: ProxyResponse): Promise<void> {
  try {
    if (req.method && req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const data = readQuery(req);
    if (!data.trim()) {
      res.status(400).json({ error: 'missing data' });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let lastReason = 'unknown';

    try {
      for (const endpoint of ENDPOINTS) {
        try {
          const upstream = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT,
              Accept: 'application/json',
            },
            body: new URLSearchParams({ data }),
            signal: controller.signal,
            cache: 'no-store',
          });

          if (upstream.ok) {
            const payload = (await upstream.json()) as { elements?: unknown };
            if (Array.isArray(payload?.elements)) {
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
              // Never cache an EMPTY answer — it would pin "no results".
              res.setHeader('Cache-Control', payload.elements.length > 0 ? CACHE_CONTROL : NO_STORE);
              res.status(200).json(payload);
              return;
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
      res.status(504).json({
        error: timedOut ? TIMEOUT_ERROR : FAILED_ERROR,
        detail: lastReason,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (caught) {
    console.error('Overpass API error:', caught);
    const detail = String((caught as { message?: unknown })?.message ?? caught);
    res.status(500).json({ error: 'route crash', detail });
  }
}
