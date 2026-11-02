import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Dev-only stand-in for api/places.ts.
//
// The browser calls /api/places; this mirrors the Vercel function exactly and
// keeps the Mapbox token server-side (read from .env.local). No Overpass or
// server-side geocoder remains.
// ---------------------------------------------------------------------------

const MAPBOX_CATEGORY = 'medical';
const MAX_RADIUS_M = 5_000;
const TIMEOUT_MS = 8_000;
const MAP_UNAVAILABLE = 'Map data is temporarily unavailable. Please try again.';
const UPSTREAM_FAILED = 'Failed to fetch map data';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_DEFAULT_RADIUS_M = 10_000;
const OVERPASS_MIN_RADIUS_M = 1_000;
const OVERPASS_MAX_RADIUS_M = 100_000;
const OVERPASS_TIMEOUT_MS = 15_000;
const OVERPASS_AMENITY_REGEX = 'hospital|clinic|pharmacy';

type MapboxFeature = {
  geometry?: { coordinates?: [number, number] };
  center?: [number, number];
  text?: string;
  place_name?: string;
  properties?: {
    name?: string;
    category?: string;
    poi_category?: string[];
    full_address?: string;
    mapbox_id?: string;
  };
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const mapboxToken = env.NEXT_PUBLIC_MAPBOX_TOKEN || process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

  const apiDevProxy = (): Plugin => ({
    name: 'caremunicate-api-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      const send = (res: ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };

      server.middlewares.use('/api/places', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        console.log('Mapbox Token exists in env:', !!mapboxToken);

        const query = (url.searchParams.get('q') ?? '').trim();

        if (!mapboxToken) {
          send(res, 500, {
            error: query ? 'Mapbox token missing in environment' : UPSTREAM_FAILED,
          });
          return;
        }

        if (query) {
          const searchTarget =
            `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json` +
            `?access_token=${encodeURIComponent(mapboxToken)}` +
            `&limit=5` +
            `&types=poi,address`;

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

          void fetch(searchTarget, {
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          })
            .then(async (upstream) => {
              if (!upstream.ok) {
                const errorText = await upstream.text().catch(() => '');
                console.error('Mapbox API Error:', upstream.status, errorText);
                throw new Error(`Mapbox API error: ${upstream.status}`);
              }
              const data = (await upstream.json()) as { features?: MapboxFeature[] };
              const results: Array<{ name: string; address: string; lat: number; lon: number }> = [];
              for (const feature of data.features ?? []) {
                const lat = Number(feature.center?.[1]);
                const lon = Number(feature.center?.[0]);
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                results.push({
                  name: feature.text || feature.place_name || 'Unknown place',
                  address: feature.place_name ?? '',
                  lat,
                  lon,
                });
              }
              send(res, 200, { results });
            })
            .catch((error: unknown) => {
              const name = error instanceof Error ? error.name : 'err';
              if (name === 'AbortError' || name === 'TimeoutError') {
                send(res, 408, { error: 'Search timed out' });
                return;
              }
              console.error('Places API error:', error);
              send(res, 500, { error: 'Failed to fetch search results' });
            })
            .finally(() => clearTimeout(timer));
          return;
        }

        const latRaw = url.searchParams.get('lat') ?? '';
        const lonRaw = url.searchParams.get('lon') ?? '';

        if (!latRaw || !lonRaw) {
          send(res, 400, { error: 'lat and lon are required' });
          return;
        }
        const lat = Number(latRaw);
        const lon = Number(lonRaw);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          send(res, 400, { error: 'lat and lon must be numbers' });
          return;
        }

        const radius = Math.min(Number(url.searchParams.get('radius')) || 1_000, MAX_RADIUS_M);

        const target =
          `https://api.mapbox.com/search/searchbox/v1/category/${MAPBOX_CATEGORY}` +
          `?proximity=${lon},${lat}` +
          `&radius=${radius}` +
          `&limit=30` +
          `&access_token=${encodeURIComponent(mapboxToken)}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        void fetch(target, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
          .then(async (upstream) => {
            if (!upstream.ok) {
              throw new Error(`Mapbox API error: ${upstream.status}`);
            }
            const data = (await upstream.json()) as { features?: MapboxFeature[] };
            const results = [];
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
            send(res, 200, { results });
          })
          .catch((error: unknown) => {
            const name = error instanceof Error ? error.name : 'err';
            if (name === 'AbortError' || name === 'TimeoutError') {
              console.warn('Places API request timed out');
              send(res, 408, { error: MAP_UNAVAILABLE });
              return;
            }
            console.error('Places API error:', error);
            send(res, 500, { error: UPSTREAM_FAILED });
          })
          .finally(() => clearTimeout(timer));
      });

      server.middlewares.use('/api/overpass', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const latRaw = (url.searchParams.get('lat') ?? '').trim();
        const lonRaw = (url.searchParams.get('lon') ?? '').trim();

        if (!latRaw || !lonRaw) {
          send(res, 400, { error: 'Missing coordinates' });
          return;
        }

        const lat = Number(latRaw);
        const lon = Number(lonRaw);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          send(res, 400, { error: 'Missing coordinates' });
          return;
        }

        const rawRadius = Number(url.searchParams.get('radius')) || OVERPASS_DEFAULT_RADIUS_M;
        const radius = Math.max(
          OVERPASS_MIN_RADIUS_M,
          Math.min(OVERPASS_MAX_RADIUS_M, rawRadius),
        );

        const query = `
[out:json][timeout:15];
(
  node["amenity"~"${OVERPASS_AMENITY_REGEX}"](around:${radius},${lat},${lon});
  way["amenity"~"${OVERPASS_AMENITY_REGEX}"](around:${radius},${lat},${lon});
);
out center qt 30;`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);

        void fetch(OVERPASS_URL, {
          method: 'POST',
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Caremunicate/1.0 (healthcare platform)',
            Accept: 'application/json',
          },
        })
          .then(async (upstream) => {
            if (!upstream.ok) {
              throw new Error(`Overpass API error: ${upstream.status}`);
            }
            const data = (await upstream.json()) as {
              elements?: Array<{
                id?: number;
                lat?: number;
                lon?: number;
                center?: { lat: number; lon: number };
                tags?: Record<string, string>;
              }>;
            };
            const results: Array<{ id: number | null; name: string; lat: number; lon: number; type: string }> = [];
            for (const element of (data.elements ?? []).slice(0, 30)) {
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
            send(res, 200, { results });
          })
          .catch((error: unknown) => {
            const name = error instanceof Error ? error.name : 'err';
            if (name === 'AbortError' || name === 'TimeoutError') {
              send(res, 408, { error: 'Search timed out' });
              return;
            }
            console.error('Overpass API error:', error);
            send(res, 500, { error: 'Failed to fetch map data' });
          })
          .finally(() => clearTimeout(timer));
      });
    },
  });

  return {
    plugins: [react(), apiDevProxy()],
  };
});
