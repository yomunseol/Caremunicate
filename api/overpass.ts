// ---------------------------------------------------------------------------
// /api/overpass — Vercel serverless function (Node runtime).
//
// "Near me" ONLY. It never accepts free text: it requires lat/lon and builds a
// bounded radial query itself, so it can never scan the whole world. A missing
// lat/lon is an immediate 400.
//
//   GET /api/overpass?lat=<n>&lon=<n>&radius=<m>
//   -> 200 { version, elements: [...] }
//   -> 400 { error: 'lat and lon are required for Overpass' }
//   -> 504 { error: 'Search timed out. Please try again.' }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs' };

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';
const TIMEOUT_MS = 25_000;
const CACHE_CONTROL = 'public, s-maxage=600';
const NO_STORE = 'no-store';
const AMENITY_REGEX = 'hospital|clinic|doctors|pharmacy';

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
    if (req.method && req.method !== 'GET' && req.method !== 'POST') {
      res.status(405).json({ error: 'method not allowed' });
      return;
    }

    // HARD GUARD: no coordinates, no query.
    const latRaw = asString(req.query?.lat).trim();
    const lonRaw = asString(req.query?.lon).trim();
    if (!latRaw || !lonRaw) {
      res.status(400).json({ error: 'lat and lon are required for Overpass' });
      return;
    }

    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({ error: 'lat and lon must be numbers' });
      return;
    }

    const radiusRaw = Number(asString(req.query?.radius).trim());
    const radius = Number.isFinite(radiusRaw) && radiusRaw > 0
      ? Math.min(Math.max(radiusRaw, 100), 50_000)
      : 5_000;

    const query = `[out:json][timeout:25];
(
  node['amenity'~'${AMENITY_REGEX}'](around:${radius},${lat},${lon});
  way['amenity'~'${AMENITY_REGEX}'](around:${radius},${lat},${lon});
);
out center;`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let upstream: Response;
    try {
      upstream = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      console.error('Overpass API error:', upstream.status);
      if (upstream.status === 429) {
        res.status(429).json({ error: 'rate limited' });
        return;
      }
      res.status(500).json({ error: 'overpass failed', status: upstream.status });
      return;
    }

    const payload = (await upstream.json()) as { elements?: unknown };
    if (!Array.isArray(payload?.elements)) {
      console.error('Overpass API error: invalid payload');
      res.status(500).json({ error: 'invalid payload' });
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', payload.elements.length > 0 ? CACHE_CONTROL : NO_STORE);
    res.status(200).json(payload);
  } catch (caught) {
    console.error('Overpass API error:', caught);
    const name = caught instanceof Error ? caught.name : 'err';
    if (name === 'AbortError' || name === 'TimeoutError') {
      res.status(504).json({ error: 'Search timed out. Please try again.' });
      return;
    }
    const detail = String((caught as { message?: unknown })?.message ?? caught);
    res.status(500).json({ error: 'route crash', detail });
  }
}
