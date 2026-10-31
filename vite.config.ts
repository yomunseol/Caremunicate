import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Dev-only stand-ins for api/geocode.ts and api/overpass.ts.
//
// `vite dev` has no serverless runtime, so these mirror the production
// functions: text search -> MapTiler (key read from the environment, never the
// bundle); "Near me" -> Overpass with a required lat/lon radial query.
// ---------------------------------------------------------------------------

const AMENITY_REGEX = 'hospital|clinic|doctors|pharmacy';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiKey = env.NEXT_PUBLIC_GEOCODER_API_KEY || env.GEOCODER_API_KEY || '';

  const apiDevProxy = (): Plugin => ({
    name: 'caremunicate-api-dev-proxy',
    apply: 'serve',
    configureServer(server) {
      const send = (res: ServerResponse, status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(body));
      };

      server.middlewares.use('/api/geocode', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const query = (url.searchParams.get('q') ?? '').trim();
        const rawLang = (url.searchParams.get('lang') ?? '').trim();
        const lang = rawLang ? rawLang.split('-')[0] : 'en';
        const lat = url.searchParams.get('lat') ?? '';
        const lon = url.searchParams.get('lon') ?? '';

        if (!query) {
          send(res, 400, { error: 'Query is required' });
          return;
        }
        console.log('Geocoding query:', query, 'lang:', lang);
        if (!apiKey) {
          console.error(
            '[GEOCODE] API key missing (dev) — set NEXT_PUBLIC_GEOCODER_API_KEY or GEOCODER_API_KEY in .env.local',
          );
          send(res, 500, { error: 'Geocoder API key is missing in environment variables' });
          return;
        }

        let target =
          `https://api.maptiler.com/geocoding/${encodeURIComponent(query.trim())}.json` +
          `?key=${encodeURIComponent(apiKey)}` +
          `&language=${encodeURIComponent(lang)}` +
          '&limit=20';
        if (lat && lon) target += `&proximity=${encodeURIComponent(lon)},${encodeURIComponent(lat)}`;

        void fetch(target, { headers: { Accept: 'application/json' } })
          .then(async (upstream) => {
            if (!upstream.ok) {
              const errorText = await upstream.text().catch(() => '');
              console.error('Maptiler Error:', upstream.status, errorText);
              send(res, upstream.status, { error: `Geocoder failed: ${upstream.status}` });
              return;
            }
            const payload = (await upstream.json()) as { features?: unknown };
            if (!payload || !Array.isArray(payload.features)) {
              send(res, 500, { error: 'invalid payload' });
              return;
            }
            send(res, 200, payload);
          })
          .catch((error: unknown) => {
            console.error('Geocoder API error:', error);
            send(res, 500, { error: 'route crash', detail: String(error) });
          });
      });

      server.middlewares.use('/api/overpass', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const latRaw = url.searchParams.get('lat') ?? '';
        const lonRaw = url.searchParams.get('lon') ?? '';

        if (!latRaw || !lonRaw) {
          send(res, 400, { error: 'lat and lon are required for Overpass' });
          return;
        }
        const lat = Number(latRaw);
        const lon = Number(lonRaw);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          send(res, 400, { error: 'lat and lon must be numbers' });
          return;
        }

        const radiusRaw = Number(url.searchParams.get('radius') ?? '');
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
        const timer = setTimeout(() => controller.abort(), 8_000);

        console.log('Fetching Overpass with 8s timeout...');
        void fetch('https://overpass.kumi.systems/api/interpreter', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Caremunicate/1.0 (healthcare platform)',
            Accept: 'application/json',
          },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
        })
          .then(async (upstream) => {
            if (!upstream.ok) {
              console.error('Overpass API error:', upstream.status);
              send(res, upstream.status === 429 ? 429 : 500, {
                error: 'overpass failed',
                status: upstream.status,
              });
              return;
            }
            const payload = (await upstream.json()) as { elements?: unknown };
            if (!Array.isArray(payload?.elements)) {
              send(res, 500, { error: 'invalid payload' });
              return;
            }
            send(res, 200, payload);
          })
          .catch((error: unknown) => {
            const name = error instanceof Error ? error.name : 'err';
            console.error('Overpass API error:', error);
            if (name === 'AbortError' || name === 'TimeoutError') {
              send(res, 504, { error: 'Search timed out. Please try again.' });
              return;
            }
            send(res, 500, { error: 'route crash', detail: String(error) });
          })
          .finally(() => clearTimeout(timer));
      });
    },
  });

  return {
    plugins: [react(), apiDevProxy()],
  };
});
