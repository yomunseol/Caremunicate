import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { OVERPASS_CACHE_CONTROL, proxyOverpass } from './server/overpass.ts';

// ---------------------------------------------------------------------------
// Dev-only stand-in for the Vercel function in api/overpass.ts.
//
// `vite dev` has no serverless runtime, so without this /api/overpass would be
// answered by the SPA fallback (index.html) and Care Places would break in dev.
// Both runtimes share server/overpass.ts, so mirror order has one definition.
// ---------------------------------------------------------------------------
const overpassDevProxy = (): Plugin => ({
  name: 'caremunicate-overpass-dev-proxy',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/api/overpass', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const query = url.searchParams.get('data') ?? '';

      const send = (status: number, body: unknown, cache = false) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (cache) res.setHeader('Cache-Control', OVERPASS_CACHE_CONTROL);
        res.end(JSON.stringify(body));
      };

      if (!query.trim()) {
        send(400, { error: 'Missing "data" query parameter' });
        return;
      }

      void proxyOverpass(query)
        .then((result) => {
          if ('error' in result) {
            send(result.status, { error: result.error, detail: result.detail });
            return;
          }
          send(200, result.body, true);
        })
        .catch((error: unknown) => {
          console.error('OVERPASS_ERROR:', error);
          send(502, { error: 'Overpass proxy failed', detail: String(error) });
        });
    });
  },
});

export default defineConfig({
  plugins: [react(), overpassDevProxy()],
});
