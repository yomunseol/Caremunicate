import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Hospitals: the community map backed by public.hospitals, plus the location
// search that feeds it.
//
// Text search goes through /api/geocode (MapTiler); Overpass stays reserved for
// the radial "Near me" query. A centre point is still required.
// ---------------------------------------------------------------------------

const HOSPITAL_COLUMNS = 'id, name, latitude, longitude, osm_id, added_by';

export const SEARCH_TIMEOUT_MS = 25_000;

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
 * Characters that would break Overpass QL or the regex itself. Non-Latin text
 * (Korean, Arabic, Hebrew, …) is preserved — only syntax characters are dropped.
 */
const sanitizeQuery = (value: string): string =>
  value.replace(/["'\\|{}[\];]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

type GeocodeFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    id?: string | number;
    name?: string;
    text?: string;
    place_name?: string;
  };
};

/** Normalize a geocoder feature into the map's OsmPlace shape. */
const featureToPlace = (feature: GeocodeFeature): OsmPlace | null => {
  const coords = feature?.geometry?.coordinates;
  const lat = Number(coords?.[1]);
  const lon = Number(coords?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const props = feature.properties ?? {};
  const display = props.place_name ?? '';
  const name = props.name || props.text || display.split(',')[0]?.trim() || display;
  if (!name) return null;

  return { id: `geocode/${props.id ?? `${lat},${lon}`}`, name, lat, lon };
};

/**
 * Search named places around `at` through the geocoder route. Text search is
 * NEVER sent to Overpass; Overpass is reserved for the radial "Near me" query.
 */
export async function searchPlaces(
  query: string,
  at: LatLon,
  signal?: AbortSignal,
  lang = 'en',
): Promise<OsmPlace[]> {
  const needle = sanitizeQuery(query);
  if (!needle) return [];

  const params = new URLSearchParams({
    q: needle,
    lang,
    lat: String(at.lat),
    lon: String(at.lon),
  });
  const response = await fetch(`/api/geocode?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Geocoder ${response.status}`);
  }

  const payload = (await response.json()) as { features?: GeocodeFeature[] };
  const byId = new Map<string, OsmPlace>();
  for (const feature of payload.features ?? []) {
    const place = featureToPlace(feature);
    if (place && !byId.has(place.id)) byId.set(place.id, place);
  }

  return [...byId.values()];
}
