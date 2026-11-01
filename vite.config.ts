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

const AMENITY_REGEX = '^(hospital|clinic|doctors|pharmacy)$';
const HEALTHCARE_REGEX = '^(hospital|clinic|doctor|pharmacy)$';
const CATEGORY_TAGS = new Set(['hospital', 'clinic', 'pharmacy', 'doctors']);

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

        const target =
          `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json` +
          `?key=${apiKey}` +
          `&lang=${lang}`;
        console.log('Maptiler Request URL:', target);

        void fetch(target, { headers: { Accept: 'application/json' } })
          .then(async (upstream) => {
            if (!upstream.ok) {
              const raw = await upstream.text().catch(() => '');
              console.error('Maptiler Raw Error:', raw);
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
          : 3_000;

        const rawCategories = (url.searchParams.get('categories') ?? '')
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => CATEGORY_TAGS.has(item));
        const single = (url.searchParams.get('category') ?? '').trim().toLowerCase();
        if (single && CATEGORY_TAGS.has(single)) rawCategories.push(single);
        const categories = [...new Set(rawCategories)].sort();

        const query = categories.length > 0
          ? `[out:json][timeout:25];
nwr["amenity"~"^(${categories.join('|')})$"](around:${radius},${lat},${lon});
out center;`
          : `[out:json][timeout:25];
(
  nwr['amenity'~'${AMENITY_REGEX}'](around:${radius},${lat},${lon});
  nwr['healthcare'~'${HEALTHCARE_REGEX}'](around:${radius},${lat},${lon});
);
out center;`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 14_000);

        console.log('Fetching Overpass with 14s timeout...');
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
            const seen = new Set<string>();
            const elements = payload.elements.filter((element) => {
              const candidate = element as { type?: unknown; id?: unknown };
              if (typeof candidate?.type !== 'string' || candidate.id === undefined) return true;
              const key = `${candidate.type}:${String(candidate.id)}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            // Match the production route's envelope exactly.
            send(res, 200, { data: { elements }, source: 'live' });
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
