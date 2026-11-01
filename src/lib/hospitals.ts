import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Hospitals: the community map backed by public.hospitals, plus the location
// search that feeds it.
//
// The modal's search and Care Places' nearby search both go through
// /api/places (Mapbox). A centre point is still required for "Near me".
// ---------------------------------------------------------------------------

const HOSPITAL_COLUMNS = 'id, name, latitude, longitude, osm_id, added_by';

export const SEARCH_TIMEOUT_MS = 9_000;

export type Hospital = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  osm_id: string | null;
  added_by: string | null;
};

export type LatLon = { lat: number; lon: number };

export type SearchPlace = {
  name: string;
  address: string;
  lat: number;
  lon: number;
};

/** Every hospital, alphabetical. Throws on a PostgREST error. */
export async function listHospitals(): Promise<Hospital[]> {
  const { data, error } = await supabase
    .from('hospitals')
    .select(HOSPITAL_COLUMNS)
    .order('name', { ascending: true });

  if (error) throw error;
  return (data ?? []) as Hospital[];
}

/** Insert one hospital, stamped with the caller's id as `added_by`. */
export async function addHospital(input: {
  name: string;
  latitude: number;
  longitude: number;
  osmId?: string | null;
  userId: string;
}): Promise<Hospital> {
  const { data, error } = await supabase
    .from('hospitals')
    .insert({
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      osm_id: input.osmId ?? null,
      added_by: input.userId,
    })
    .select(HOSPITAL_COLUMNS)
    .single();

  if (error) throw error;
  return data as Hospital;
}

/**
 * Characters that would break the search query or the regex itself. Non-Latin
 * text (Korean, Arabic, Hebrew, …) is preserved — only syntax characters are
 * dropped.
 */
const sanitizeQuery = (value: string): string =>
  value.replace(/["'\\|{}[\];]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

/**
 * Search Mapbox Geocoding through /api/places for a hospital or address.
 * The caller owns the abort signal; the route itself caps at 8s.
 */
export async function searchPlacesByQuery(
  query: string,
  signal?: AbortSignal,
): Promise<SearchPlace[]> {
  const needle = sanitizeQuery(query);
  if (!needle) return [];

  const response = await fetch(`/api/places?q=${encodeURIComponent(needle)}`, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Places ${response.status}`);
  }

  const payload = (await response.json()) as { results?: SearchPlace[] };
  return (payload.results ?? []).filter(
    (place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)),
  );
}
