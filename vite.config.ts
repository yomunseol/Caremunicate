import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Dev-only stand-in for api/overpass.ts — the only map API.
//
// The browser calls /api/overpass; this mirrors the Vercel function.
// ---------------------------------------------------------------------------

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_DEFAULT_RADIUS_M = 10_000;
const OVERPASS_MIN_RADIUS_M = 1_000;
const OVERPASS_MAX_RADIUS_M = 50_000;
const OVERPASS_TIMEOUT_MS = 15_000;
const OVERPASS_AMENITY_REGEX = 'hospital|clinic|pharmacy';

export default defineConfig(() => {
  const apiDevProxy = (): Plugin => ({
    name: 'caremunicate-api-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      const send = (res: ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };

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
[out:json][timeout:10];
(
  node["amenity"~"${OVERPASS_AMENITY_REGEX}"](around:${radius},${lat},${lon});
  way["amenity"~"${OVERPASS_AMENITY_REGEX}"](around:${radius},${lat},${lon});
);
out center qt 8;`;

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
            for (const element of (data.elements ?? []).slice(0, 8)) {
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
