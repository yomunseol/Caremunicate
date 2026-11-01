import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Client-side geocoding.
//
// All location lookups go straight from the browser to Photon (komoot) with a
// hard 3-second AbortController limit. No serverless function sits in the save
// or search lifecycle, so a slow upstream can never become a Cloudflare 504.
// ---------------------------------------------------------------------------

export const PHOTON_TIMEOUT_MS = 3000;
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';

export type PhotonPlace = {
  id: string;
  name: string;
  lat: number;
  lon: number;
};

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_id?: string | number;
    osm_type?: string;
    name?: string;
    text?: string;
    place_name?: string;
  };
};

export type PhotonSearchOptions = {
  limit?: number;
  lat?: number;
  lon?: number;
  lang?: string;
  signal?: AbortSignal;
};

/** Search Photon from the browser. Throws AbortError on the 3s / caller abort. */
export async function photonSearch(
  query: string,
  options: PhotonSearchOptions = {},
): Promise<PhotonPlace[]> {
  const needle = query.trim();
  if (!needle) return [];

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), PHOTON_TIMEOUT_MS);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onCallerAbort);

  try {
    const params = new URLSearchParams({
      q: needle,
      limit: String(options.limit ?? 5),
    });
    if (Number.isFinite(options.lat)) params.set('lat', String(options.lat));
    if (Number.isFinite(options.lon)) params.set('lon', String(options.lon));
    if (options.lang) params.set('lang', options.lang);

    const response = await fetch(`${PHOTON_ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { features?: PhotonFeature[] };
    const seen = new Set<string>();
    const places: PhotonPlace[] = [];

    for (const feature of payload.features ?? []) {
      const coords = feature.geometry?.coordinates;
      const lat = Number(coords?.[1]);
      const lon = Number(coords?.[0]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const props = feature.properties ?? {};
      const name =
        props.name || props.text || props.place_name?.split(',')[0]?.trim() || '';
      if (!name) continue;

      const id = `photon/${props.osm_type ?? ''}${props.osm_id ?? `${lat},${lon}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      places.push({ id, name, lat, lon });
    }

    return places;
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Fire-and-forget coordinate repair for a saved record. The caller must invoke
 * this only after the save UI has closed and the success toast is showing.
 *
 * The only location table in this app is public.hospitals. `onlyIfMissing`
 * preserves a user-picked map pin; it only fills records whose coordinates are
 * still null (the failure mode this helper exists for).
 */
export async function geocodeInBackground(
  address: string,
  recordId: string,
  options: { onlyIfMissing?: boolean } = {},
): Promise<void> {
  if (!address || !recordId) return;

  try {
    if (options.onlyIfMissing) {
      const { data, error } = await supabase
        .from('hospitals')
        .select('latitude, longitude')
        .eq('id', recordId)
        .maybeSingle();

      if (error) {
        console.warn('Background geocoding skipped or failed:', error.message);
        return;
      }

      if (data && data.latitude !== null && data.longitude !== null) return;
    }

    const [place] = await photonSearch(address, { limit: 1 });
    if (!place) return;

    const { error } = await supabase
      .from('hospitals')
      .update({ latitude: place.lat, longitude: place.lon })
      .eq('id', recordId);

    if (error) {
      console.warn('Background geocoding skipped or failed:', error.message);
    }
  } catch (error) {
    // Graceful degradation: the record is already saved. Never surface this.
    console.warn('Background geocoding skipped or failed:', error);
  }
}
