import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Hospitals: the community map backed by public.hospitals, plus the nearby
// Overpass search that feeds the Add Hospital modal.
//
// The modal uses /api/overpass (qt 8, 50km) for nearby facilities. Care Places
// uses the same /api/overpass route; it is the only map API.
// ---------------------------------------------------------------------------

const HOSPITAL_COLUMNS = 'id, name, latitude, longitude, osm_id, added_by';

export const SEARCH_TIMEOUT_MS = 16_000;

export type Hospital = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  osm_id: string | null;
  added_by: string | null;
};

export type LatLon = { lat: number; lon: number };

export type NearbyPlace = {
  id: number | null;
  name: string;
  lat: number;
  lon: number;
  type: string;
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
 * Ask /api/overpass for up to 8 nearby hospitals/clinics/pharmacies.
 * The radius is in metres (route clamps 1km–50km); the route uses
 * `out center qt 8` and caps at 15s.
 */
export async function searchNearbyHospitals(
  at: LatLon,
  radius = 10_000,
  signal?: AbortSignal,
): Promise<NearbyPlace[]> {
  const params = new URLSearchParams({
    lat: String(at.lat),
    lon: String(at.lon),
    radius: String(radius),
  });

  const response = await fetch(`/api/overpass?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    const error = new Error(`Overpass ${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const payload = (await response.json()) as { results?: NearbyPlace[] };
  return (payload.results ?? [])
    .filter((place) => Number.isFinite(Number(place.lat)) && Number.isFinite(Number(place.lon)))
    .slice(0, 8);
}
