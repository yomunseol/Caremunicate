// ---------------------------------------------------------------------------
// /api/overpass — Vercel serverless function (Node runtime).
//
// "Near me" ONLY. It never accepts free text: it requires lat/lon and builds a
// bounded radial query itself. A missing lat/lon is an immediate 400.
//
// The WHOLE route runs under a 9s global deadline (Promise.race) so a hanging
// Supabase cache or slow upstream can never let Cloudflare/Vercel kill the
// process and return an HTML 504 page — we always answer with clean JSON.
//
//   GET /api/overpass?lat=<n>&lon=<n>&radius=<m>
//   -> 200 { version, elements: [...] }
//   -> 400 { error: 'lat and lon are required for Overpass' }
//   -> 504 { error: 'Search timed out. Please try again.' }
// ---------------------------------------------------------------------------

import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'nodejs' };

const ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';
const USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';
const FETCH_TIMEOUT_MS = 8_000;
// Under Cloudflare/Vercel's ~10s hard limit.
const GLOBAL_TIMEOUT_MS = 9_000;
/** Smaller radius = much faster Overpass response. */
const DEFAULT_RADIUS_M = 3_000;
const CACHE_CONTROL = 'public, s-maxage=600';
const NO_STORE = 'no-store';
const AMENITY_REGEX = 'hospital|clinic|doctors|pharmacy';
const TIMEOUT_ERROR = 'Search timed out. Please try again.';

// Server-side Supabase for the shared cache. Either env name works; a missing
// env simply disables the cache and never blocks the route.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

type ProxyRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
};

type ProxyResponse = {
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ProxyResponse;
  json: (body: unknown) => void;
};

type Outcome = { status: number; body: unknown; cacheControl?: string };

const asString = (value: unknown): string => {
  if (Array.isArray(value)) return String(value[0] ?? '');
  return typeof value === 'string' ? value : '';
};

const outcome = (status: number, body: unknown, cacheControl?: string): Outcome => ({
  status,
  body,
  cacheControl,
});

/** The route's actual work: guard, cache, fetch, cache-save. */
async function runOverpass(req: ProxyRequest): Promise<Outcome> {
  if (req.method && req.method !== 'GET' && req.method !== 'POST') {
    return outcome(405, { error: 'method not allowed' });
  }

  // HARD GUARD: no coordinates, no query.
  const latRaw = asString(req.query?.lat).trim();
  const lonRaw = asString(req.query?.lon).trim();
  if (!latRaw || !lonRaw) {
    return outcome(400, { error: 'lat and lon are required for Overpass' });
  }

  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return outcome(400, { error: 'lat and lon must be numbers' });
  }

  const radiusRaw = Number(asString(req.query?.radius).trim());
  const radius = Number.isFinite(radiusRaw) && radiusRaw > 0
    ? Math.min(Math.max(radiusRaw, 100), 50_000)
    : DEFAULT_RADIUS_M;

  const query = `[out:json][timeout:25];
(
  node['amenity'~'${AMENITY_REGEX}'](around:${radius},${lat},${lon});
  way['amenity'~'${AMENITY_REGEX}'](around:${radius},${lat},${lon});
);
out center;`;

  const cacheKey = `${radius}:${lat.toFixed(2)},${lon.toFixed(2)}`;

  // Cache is a performance optimization only: never let it crash or block.
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('get_overpass_cache', { p_key: cacheKey });
      if (error) {
        console.error('Cache failed, fetching direct:', error);
      } else if (data && Array.isArray((data as { elements?: unknown }).elements)) {
        return outcome(200, data);
      }
    } catch (error) {
      console.error('Cache failed, fetching direct:', error);
    }
  } else {
    console.error('Cache unavailable (Supabase env missing), fetching direct');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  console.log('Fetching Overpass with 8s timeout...');
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
  } catch (error) {
    const name = error instanceof Error ? error.name : 'err';
    console.error('Overpass API error:', error);
    if (name === 'AbortError' || name === 'TimeoutError') {
      return outcome(504, { error: TIMEOUT_ERROR });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    console.error('Overpass API error:', upstream.status);
    if (upstream.status === 429) {
      return outcome(429, { error: 'rate limited' });
    }
    return outcome(500, { error: 'overpass failed', status: upstream.status });
  }

  const payload = (await upstream.json()) as { elements?: unknown };
  if (!Array.isArray(payload?.elements)) {
    console.error('Overpass API error: invalid payload');
    return outcome(500, { error: 'invalid payload' });
  }

  // Persist for everyone else; a failed save never blocks the response.
  if (supabase && payload.elements.length > 0) {
    try {
      const { error } = await supabase.rpc('save_overpass_cache', {
        p_key: cacheKey,
        p_data: payload,
      });
      if (error) console.error('Cache save failed:', error);
    } catch (error) {
      console.error('Cache save failed:', error);
    }
  }

  return outcome(200, payload, payload.elements.length > 0 ? CACHE_CONTROL : NO_STORE);
}

/** Race `task` against a hard deadline, clearing the timer when either settles. */
const withGlobalTimeout = async <T>(task: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Global Timeout')), ms);
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export default async function handler(req: ProxyRequest, res: ProxyResponse): Promise<void> {
  try {
    const result = await withGlobalTimeout(runOverpass(req), GLOBAL_TIMEOUT_MS);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (result.cacheControl) res.setHeader('Cache-Control', result.cacheControl);
    res.status(result.status).json(result.body);
  } catch (error) {
    // Includes the global 9s deadline: always a clean JSON 504, never HTML.
    console.error('Overpass Route Error:', error);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(504).json({ error: TIMEOUT_ERROR });
  }
}
