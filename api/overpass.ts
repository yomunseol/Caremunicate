// ---------------------------------------------------------------------------
// /api/overpass — Vercel serverless function (Node runtime).
//
// FULLY SELF-CONTAINED: zero relative imports, so an extensionless-import
// error (TS2835) cannot occur here. The mirror array and the whole loop are
// inlined in this one file.
//
//   GET /api/overpass?data=<encoded Overpass QL>
//   -> 200 JSON (Overpass payload), Cache-Control: public, s-maxage=600
//   -> 400 { error: 'missing data' }
//   -> 405 { error: 'method not allowed' }
//   -> 502 { error: 'all mirrors failed', reasons: [host:status, ...] }
//   -> 500 { error: 'route crash', detail }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs' };

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

const USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';
const MIRROR_TIMEOUT_MS = 15_000;
const CACHE_CONTROL = 'public, s-maxage=600';

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

/** `${host}:${status}` or `${host}:${ErrorName}` — one entry per failed mirror. */
const mirrorReason = (mirror: string, reason: string | number): string => {
  try {
    return `${new URL(mirror).host}:${reason}`;
  } catch {
    return `${mirror}:${reason}`;
  }
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

    // Mirrors are tried SEQUENTIALLY, 15s each, collecting every reason.
    const reasons: string[] = [];

    for (const mirror of MIRRORS) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MIRROR_TIMEOUT_MS);

        try {
          const upstream = await fetch(mirror, {
            method: 'POST',
            body: new URLSearchParams({ data }),
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT,
            },
            signal: controller.signal,
            cache: 'no-store',
          });

          if (upstream.ok) {
            const payload = await upstream.json();
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', CACHE_CONTROL);
            res.status(200).json(payload);
            return;
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

    res.status(502).json({ error: 'all mirrors failed', reasons });
  } catch (caught) {
    // Never throw out of the route: answer 500 with the detail.
    const detail = String((caught as { message?: unknown })?.message ?? caught);
    res.status(500).json({ error: 'route crash', detail });
  }
}
