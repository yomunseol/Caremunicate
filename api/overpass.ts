// ---------------------------------------------------------------------------
// /api/overpass — fast "nearby hospitals" with `out center qt 24`.
//
// The radius is dynamic (1km–50km, clamped) and the server stops after 24
// results via qt, so the payload stays small while still allowing Load More.
//
// Reliability:
//   - `maxDuration` is raised so the platform does not kill the function before
//     the upstream budget is spent.
//   - Each attempt aborts after 7s; a 429/5xx/timeout rolls to the fallback
//     endpoint. Two attempts stay under the client's 16s ceiling.
//
//   GET /api/overpass?lat=<n>&lon=<n>&radius=<metres>
//   -> 200 { results: [{ id, name, lat, lon, type }] } (max 24)
//   -> 400 { error: 'Missing coordinates' }
//   -> 408 { error: 'Search timed out' }
//   -> 503 { error: 'Failed to fetch map data', detail }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs', maxDuration: 60 };

const OVERPASS_URLS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const DEFAULT_RADIUS_M = 10_000;
const MIN_RADIUS_M = 1_000;
const MAX_RADIUS_M = 50_000;
const TIMEOUT_MS = 7_000;
const AMENITY_REGEX = 'hospital|clinic|pharmacy';

type ProxyRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};

type ProxyResponse = {
  status: (code: number) => ProxyResponse;
  json: (body: unknown) => void;
};

type OverpassElement = {
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type NearbyResult = {
  id: number | null;
  name: string;
  lat: number;
  lon: number;
  type: string;
};

const asString = (value: unknown): string => {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return typeof value === 'string' ? value : '';
};

export default async function handler(req: ProxyRequest, res: ProxyResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const latRaw = asString(req.query?.lat).trim();
  const lonRaw = asString(req.query?.lon).trim();
  if (!latRaw || !lonRaw) {
    res.status(400).json({ error: 'Missing coordinates' });
    return;
  }

  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'Missing coordinates' });
    return;
  }

  const rawRadius = Number(asString(req.query?.radius)) || DEFAULT_RADIUS_M;
  const radius = Math.max(MIN_RADIUS_M, Math.min(MAX_RADIUS_M, rawRadius));

  // Diagnostic: confirms the exact lat/lon + metre radius received from the UI.
  console.log('Overpass request:', { lat, lon, radius });

  const query = `
[out:json][timeout:10];
(
  node["amenity"~"${AMENITY_REGEX}"](around:${radius},${lat},${lon});
  way["amenity"~"${AMENITY_REGEX}"](around:${radius},${lat},${lon});
);
out center qt 24;`;

  let lastError: unknown = null;

  for (const url of OVERPASS_URLS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const isLast = url === OVERPASS_URLS[OVERPASS_URLS.length - 1];

    try {
      console.log('Using Overpass endpoint:', url);
      const response = await fetch(url, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Caremunicate/1.0 (healthcare platform)',
          Accept: 'application/json',
        },
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const status = response.status;
        // Out of capacity / temporary upstream failure → try the fallback.
        if ((status === 429 || status >= 500) && !isLast) {
          console.warn('Overpass primary failed; trying fallback:', status);
          lastError = new Error(`Overpass API error: ${status}`);
          continue;
        }
        throw new Error(`Overpass API error: ${status}`);
      }

      const data = (await response.json()) as { elements?: OverpassElement[] };
      const results: NearbyResult[] = [];

      for (const element of (data.elements ?? []).slice(0, 24)) {
        const placeLat = Number(element.center?.lat ?? element.lat);
        const placeLon = Number(element.center?.lon ?? element.lon);
        if (!Number.isFinite(placeLat) || !Number.isFinite(placeLon)) continue;
        const tags = element.tags ?? {};
        results.push({
          id: element.id ?? null,
          name: tags.name || tags['name:en'] || 'Unknown Facility',
          lat: placeLat,
          lon: placeLon,
          type: tags.amenity || 'medical',
        });
      }

      res.status(200).json({ results });
      return;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (!isLast) {
        console.warn('Overpass request failed; trying fallback:', error);
        continue;
      }
      if ((error as Error)?.name === 'AbortError') {
        res.status(408).json({ error: 'Search timed out' });
        return;
      }
      console.error('Overpass API error:', error);
      res.status(503).json({
        error: 'Failed to fetch map data',
        detail: lastError instanceof Error ? lastError.message : String(lastError ?? error),
      });
      return;
    }
  }
}
