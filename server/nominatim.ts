// ---------------------------------------------------------------------------
// Nominatim proxy core — SERVER-SIDE ONLY.
//
// Typed-name search goes here (the radial "Near me" stays on Overpass). A
// same-origin proxy keeps the public app from calling Nominatim directly:
//   • we can send the identifying User-Agent its usage policy asks for;
//   • the browser locale becomes the `accept-language` header, so local names
//     (Korean, Chinese, …) match;
//   • one 8s AbortController and one place to map failures to 429/504/500.
//
// Consumed by:
//   • api/nominatim.ts  — the Vercel serverless function (production)
//   • vite.config.ts    — a dev-only middleware standing in for it
// ---------------------------------------------------------------------------

export const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
export const NOMINATIM_USER_AGENT = 'Caremunicate/1.0 (healthcare platform)';
export const NOMINATIM_TIMEOUT_MS = 8_000;
export const NOMINATIM_CACHE_CONTROL = 'public, s-maxage=600';

export type NominatimProxyResult =
  | { ok: true; status: number; body: unknown; empty: boolean }
  | { ok: false; status: number; error: string };

type LatLon = { lat: number; lon: number };

/** ~50 km bounding box around a point, for Nominatim's `viewbox`. */
const viewboxFor = (at: LatLon): string => {
  const dLat = 50 / 111;
  const dLon = 50 / (111 * Math.max(Math.cos((at.lat * Math.PI) / 180), 0.01));
  return `${at.lon - dLon},${at.lat - dLat},${at.lon + dLon},${at.lat + dLat}`;
};

export const proxyNominatim = async (
  query: string,
  lang: string,
  at: LatLon | null = null,
): Promise<NominatimProxyResult> => {
  const url = new URL(NOMINATIM_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '20');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('accept-language', lang || 'en');
  if (at && Number.isFinite(at.lat) && Number.isFinite(at.lon)) {
    // Constrain to ~50 km around the user, so results are local, not global.
    url.searchParams.set('viewbox', viewboxFor(at));
    url.searchParams.set('bounded', '1');
  } else {
    // No location: never return results from another continent.
    url.searchParams.set('countrycodes', 'kr');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOMINATIM_TIMEOUT_MS);

  try {
    const upstream = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': NOMINATIM_USER_AGENT,
        'Accept-Language': lang || 'en',
      },
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!upstream.ok) {
      console.error('Nominatim API error:', upstream.status);
      if (upstream.status === 429) return { ok: false, status: 429, error: 'rate limited' };
      return { ok: false, status: 500, error: `nominatim ${upstream.status}` };
    }

    const payload = await upstream.json();
    if (!Array.isArray(payload)) {
      console.error('Nominatim API error: invalid payload');
      return { ok: false, status: 500, error: 'invalid payload' };
    }

    return { ok: true, status: 200, body: payload, empty: payload.length === 0 };
  } catch (error) {
    console.error('Nominatim API error:', error);
    const name = error instanceof Error ? error.name : 'err';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { ok: false, status: 504, error: 'upstream timeout' };
    }
    return { ok: false, status: 500, error: 'nominatim failed' };
  } finally {
    clearTimeout(timer);
  }
};
