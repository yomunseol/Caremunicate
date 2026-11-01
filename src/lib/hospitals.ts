import { supabase } from './supabase';
import { photonSearch } from './geocode';

// ---------------------------------------------------------------------------
// Hospitals: the community map backed by public.hospitals, plus the location
// search that feeds it.
//
// Text search goes straight from the browser to Photon with a 3-second abort.
// The Care Places nearby search uses /api/places (Mapbox); a centre point is
// still required.
// ---------------------------------------------------------------------------

const HOSPITAL_COLUMNS = 'id, name, latitude, longitude, osm_id, added_by';

export const SEARCH_TIMEOUT_MS = 3000;

export type Hospital = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  osm_id: string | null;
  added_by: string | null;
};

export type LatLon = { lat: number; lon: number };

export type OsmPlace = {
  id: string;
  name: string;
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
 * Search named places around `at` through Photon (client-side, 3s abort).
 * Nearby category discovery uses /api/places (Mapbox).
 */
export async function searchPlaces(
  query: string,
  at: LatLon,
  signal?: AbortSignal,
  lang = 'en',
): Promise<OsmPlace[]> {
  const needle = sanitizeQuery(query);
  if (!needle) return [];

  return photonSearch(needle, {
    limit: 5,
    lat: at.lat,
    lon: at.lon,
    lang,
    signal,
  });
}
