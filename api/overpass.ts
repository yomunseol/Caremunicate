// ---------------------------------------------------------------------------
// /api/overpass — Vercel serverless function (Node runtime).
//
// The hardened route, expressed in the Vercel `(req, res)` shape this repo uses
// (the app is Vite — there is no `next/server` here). Behaviour is identical:
//
//   GET /api/overpass?data=<encoded Overpass QL>
//   -> 200 JSON (Overpass payload), Cache-Control: public, s-maxage=600
//   -> 400 { error: 'missing data' }
//   -> 405 { error: 'method not allowed' }
//   -> 502 { error: 'all mirrors failed', reasons: [...] }
//   -> 500 { error: 'route crash', detail }
//
// The mirror loop, per-mirror 15s abort and the `reasons` list live in
// server/overpass.ts, shared with the dev middleware in vite.config.ts.
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

    const result = await proxyOverpass(data);

    if ('error' in result) {
      // "all mirrors failed" + the per-mirror reasons, so the client can show
      // `Search failed (mirrors: …)` instead of a bare status.
      res.status(result.status).json({ error: result.error, reasons: result.reasons });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', OVERPASS_CACHE_CONTROL);
    res.status(200).json(result.body);
  } catch (caught) {
    const detail = String((caught as { message?: unknown })?.message ?? caught);
    res.status(500).json({ error: 'route crash', detail });
  }
}
