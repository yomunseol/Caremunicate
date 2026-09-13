// ---------------------------------------------------------------------------
// /api/overpass — Vercel serverless function (Node runtime).
//
// The browser calls this same-origin route; this function is what actually
// reaches the Overpass mirrors (see server/overpass.ts). Deployed by Vercel from
// the api/ directory; it is intentionally NOT part of any tsconfig project, so
// `tsc -b` neither compiles nor emits it.
//
//   GET /api/overpass?data=<encoded Overpass QL>
//   -> 200 JSON (Overpass payload), Cache-Control: public, s-maxage=600
//   -> 400 missing data | 405 wrong method | 502 every mirror failed
// ---------------------------------------------------------------------------

import { OVERPASS_CACHE_CONTROL, proxyOverpass } from '../server/overpass';

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
  if (req.method && req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const query = readQuery(req);
  if (!query.trim()) {
    res.status(400).json({ error: 'Missing "data" query parameter' });
    return;
  }

  const result = await proxyOverpass(query);

  if ('error' in result) {
    res.status(result.status).json({ error: result.error, detail: result.detail });
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', OVERPASS_CACHE_CONTROL);
  res.status(200).json(result.body);
}
