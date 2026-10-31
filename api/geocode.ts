// ---------------------------------------------------------------------------
// /api/geocode — Vercel serverless function (Node runtime).
//
// Text search only. Proxies MapTiler so the API key stays server-side and is
// read at RUNTIME (process.env), which fixes the "nokey: geocoder key missing"
// error that came from the build-time import.meta.env lookup.
//
//   GET /api/geocode?q=<name>&lang=<locale>&lat=&lon=
//   -> 200 MapTiler GeoJSON ({ features: [...] })
//   -> 400 { error: 'missing q' }
//   -> 405 { error: 'method not allowed' }
//   -> 500 { error: 'Geocoder API key is missing in environment variables' }
//   -> 504 { error: 'upstream timeout' }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs' };

const ENDPOINT = 'https://api.maptiler.com/geocoding';
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
    const lat = asString(req.query?.lat).trim();
    const lon = asString(req.query?.lon).trim();

    // Read at runtime, exactly as specified. Either name works on Vercel.
    const apiKey = process.env.NEXT_PUBLIC_GEOCODER_API_KEY || process.env.GEOCODER_API_KEY;
    if (!apiKey) {
      // Server-side diagnosis: report WHICH env names are present (never values).
      console.error(
        '[GEOCODE] API key missing — NEXT_PUBLIC_GEOCODER_API_KEY:',
        Boolean(process.env.NEXT_PUBLIC_GEOCODER_API_KEY),
        '| GEOCODER_API_KEY:',
        Boolean(process.env.GEOCODER_API_KEY),
        '| vercel:',
        Boolean(process.env.VERCEL),
      );
      res.status(500).json({ error: 'Geocoder API key is missing in environment variables' });
      return;
    }

    // Strictly encode the query for the path segment.
    const encodedQuery = encodeURIComponent(q);
    let url =
      `${ENDPOINT}/${encodedQuery}.json` +
      `?key=${encodeURIComponent(apiKey)}` +
      `&language=${encodeURIComponent(lang)}` +
      '&limit=20';
    if (lat && lon) url += `&proximity=${encodeURIComponent(lon)},${encodeURIComponent(lat)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => '');
      console.error('Maptiler Error:', upstream.status, errorText);
      res.status(upstream.status).json({ error: `Geocoder failed: ${upstream.status}` });
      return;
    }

    const payload = (await upstream.json()) as { features?: unknown };
    if (!payload || !Array.isArray(payload.features)) {
      console.error('Geocoder API error: invalid payload');
      res.status(500).json({ error: 'invalid payload' });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', payload.features.length > 0 ? CACHE_CONTROL : NO_STORE);
    res.status(200).json(payload);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error('Maptiler Error:', message, (caught as { status?: number })?.status);
    if (caught instanceof Error && (caught.name === 'AbortError' || caught.name === 'TimeoutError')) {
      res.status(504).json({ error: 'upstream timeout' });
      return;
    }
    res.status(500).json({ error: 'Geocoder request failed', detail: message });
  }
}
