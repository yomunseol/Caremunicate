// ---------------------------------------------------------------------------
// /api/nominatim — Vercel serverless function (Node runtime).
//
// FULLY SELF-CONTAINED (zero relative imports), matching api/overpass.ts, so an
// extensionless-import error cannot occur at deploy time.
//
//   GET /api/nominatim?q=<name>&lang=<locale>
//   -> 200 JSON array (Nominatim results), Cache-Control: public, s-maxage=600
//   -> 400 { error: 'missing q' }
//   -> 405 { error: 'method not allowed' }
//   -> 429 { error: 'rate limited' }
//   -> 504 { error: 'upstream timeout' }
//   -> 500 { error: 'nominatim failed' | 'invalid payload' | 'route crash' }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs' };

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';
const TIMEOUT_MS = 8_000;
const CACHE_CONTROL = 'public, s-maxage=600';
const NO_STORE = 'no-store';

type ProxyRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
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

export default async function handler(req: ProxyRequest, res: ProxyResponse): Promise<void> {
  try {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    const q = asString(req.query?.q).trim();
    if (!q) {
      res.status(400).json({ error: 'missing q' });
      return;
    }
    const lang = asString(req.query?.lang).trim() || 'en';
    const latRaw = asString(req.query?.lat).trim();
    const lonRaw = asString(req.query?.lon).trim();
    const lat = Number(latRaw);
    const lon = Number(lonRaw);

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '20');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', lang);
    if (latRaw && lonRaw && Number.isFinite(lat) && Number.isFinite(lon)) {
      // ~50 km box around the user: local results, never global.
      const dLat = 50 / 111;
      const dLon = 50 / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
      url.searchParams.set('viewbox', `${lon - dLon},${lat - dLat},${lon + dLon},${lat + dLat}`);
      url.searchParams.set('bounded', '1');
    } else {
      // No location: never return results from another continent.
      url.searchParams.set('countrycodes', 'kr');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          'Accept-Language': lang,
        },
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      console.error('Nominatim API error:', upstream.status);
      if (upstream.status === 429) {
        res.status(429).json({ error: 'rate limited' });
        return;
      }
      res.status(500).json({ error: 'nominatim failed', status: upstream.status });
      return;
    }

    const payload = await upstream.json();
    if (!Array.isArray(payload)) {
      console.error('Nominatim API error: invalid payload');
      res.status(500).json({ error: 'invalid payload' });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // An empty answer is a real "no results" but must not be edge-cached.
    res.setHeader('Cache-Control', payload.length > 0 ? CACHE_CONTROL : NO_STORE);
    res.status(200).json(payload);
  } catch (caught) {
    console.error('Nominatim API error:', caught);
    const name = caught instanceof Error ? caught.name : 'err';
    if (name === 'AbortError' || name === 'TimeoutError') {
      res.status(504).json({ error: 'upstream timeout' });
      return;
    }
    const detail = String((caught as { message?: unknown })?.message ?? caught);
    res.status(500).json({ error: 'route crash', detail });
  }
}
