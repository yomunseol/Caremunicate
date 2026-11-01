import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import type { ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Dev-only stand-in for api/overpass.ts.
//
// Geocoding is intentionally NOT proxied here: the browser calls Photon
// directly with a 3-second AbortController (src/lib/geocode.ts), so there is no
// serverless geocode route to time out behind Cloudflare.
// ---------------------------------------------------------------------------

const AMENITY_REGEX = '^(hospital|clinic|doctors|pharmacy)$';
const HEALTHCARE_REGEX = '^(hospital|clinic|doctor|pharmacy)$';
const CATEGORY_TAGS = new Set(['hospital', 'clinic', 'pharmacy', 'doctors']);

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
          ? Math.min(Math.max(radiusRaw, 100), 2_000)
          : 1_000;

        const rawCategories = (url.searchParams.get('categories') ?? '')
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => CATEGORY_TAGS.has(item));
        const single = (url.searchParams.get('category') ?? '').trim().toLowerCase();
        if (single && CATEGORY_TAGS.has(single)) rawCategories.push(single);
        const categories = [...new Set(rawCategories)].sort();

        const query = categories.length > 0
          ? `[out:json][timeout:10];
nwr["amenity"~"^(${categories.join('|')})$"](around:${radius},${lat},${lon});
out center;`
          : `[out:json][timeout:10];
(
  nwr['amenity'~'${AMENITY_REGEX}'](around:${radius},${lat},${lon});
  nwr['healthcare'~'${HEALTHCARE_REGEX}'](around:${radius},${lat},${lon});
);
out center;`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);

        console.log('Fetching Overpass with 15s timeout...');
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
              send(res, 500, { error: 'Failed to fetch map data' });
              return;
            }
            const payload = (await upstream.json()) as { elements?: unknown };
            if (!Array.isArray(payload?.elements)) {
              send(res, 500, { error: 'Failed to fetch map data' });
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
            if (name === 'AbortError' || name === 'TimeoutError') {
              console.warn('Overpass API request timed out');
              send(res, 408, { error: 'Map data is temporarily unavailable. Please try again.' });
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
