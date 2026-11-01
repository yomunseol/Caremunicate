// ---------------------------------------------------------------------------
// /api/places — Mapbox Searchbox nearby medical POIs.
//
// One GET, one upstream, one 8s cap. Replaces the timeout-prone Overpass route.
//
//   GET /api/places?lat=<n>&lon=<n>&radius=<m>&categories=<csv>
//   -> 200 { results: [{ id, name, lat, lon, category, address }] }
//   -> 400 { error: 'lat and lon are required' }
//   -> 408 { error: 'Map data is temporarily unavailable. Please try again.' }
//   -> 500 { error: 'Failed to fetch map data' }
// ---------------------------------------------------------------------------

export const config = { runtime: 'nodejs' };

const MAPBOX_CATEGORY = 'medical';
const MAX_RADIUS_M = 5_000;
const TIMEOUT_MS = 8_000;
const MAP_UNAVAILABLE = 'Map data is temporarily unavailable. Please try again.';
const UPSTREAM_FAILED = 'Failed to fetch map data';

type ProxyRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};

type ProxyResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ProxyResponse;
  json: (body: unknown) => void;
};

type MapboxFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    name?: string;
    category?: string;
    poi_category?: string[];
    full_address?: string;
    mapbox_id?: string;
  };
};

type PlaceResult = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  category: string;
  address: string;
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
    res.status(400).json({ error: 'lat and lon are required' });
    return;
  }

  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    res.status(400).json({ error: 'lat and lon must be numbers' });
    return;
  }

  const radius = Math.min(Number(asString(req.query?.radius)) || 1_000, MAX_RADIUS_M);
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

  if (!token) {
    console.error('Mapbox token missing (NEXT_PUBLIC_MAPBOX_TOKEN)');
    res.status(500).json({ error: UPSTREAM_FAILED });
    return;
  }

  const url =
    `https://api.mapbox.com/search/searchbox/v1/category/${MAPBOX_CATEGORY}` +
    `?proximity=${lon},${lat}` +
    `&radius=${radius}` +
    `&limit=30` +
    `&access_token=${encodeURIComponent(token)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Mapbox API error: ${response.status}`);
    }

    const data = (await response.json()) as { features?: MapboxFeature[] };
    const results: PlaceResult[] = [];

    for (const feature of data.features ?? []) {
      const coords = feature.geometry?.coordinates;
      const placeLat = Number(coords?.[1]);
      const placeLon = Number(coords?.[0]);
      if (!Number.isFinite(placeLat) || !Number.isFinite(placeLon)) continue;

      const props = feature.properties ?? {};
      results.push({
        id: props.mapbox_id ?? `${placeLon.toFixed(5)},${placeLat.toFixed(5)}`,
        name: props.name || 'Unknown Medical Facility',
        lat: placeLat,
        lon: placeLon,
        category: props.poi_category?.[0] ?? props.category ?? MAPBOX_CATEGORY,
        address: props.full_address ?? '',
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ results });
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error as Error)?.name === 'AbortError') {
      console.warn('Places API request timed out');
      res.status(408).json({ error: MAP_UNAVAILABLE });
      return;
    }
    console.error('Places API error:', error);
    res.status(500).json({ error: UPSTREAM_FAILED });
  }
}
