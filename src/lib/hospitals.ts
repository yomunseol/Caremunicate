import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Hospitals: the community map backed by public.hospitals, plus the location
// search that feeds it.
//
// The search reuses the SAME same-origin /api/overpass proxy Care Places uses —
// no Nominatim, no third-party geocoder, no key. Overpass is proximity-based,
// so a search needs a centre point (the caller supplies the user's location).
// ---------------------------------------------------------------------------

const HOSPITAL_COLUMNS = 'id, name, latitude, longitude, osm_id, added_by';

const OVERPASS_PROXY = '/api/overpass';
/** Name search radius around the supplied centre. */
const SEARCH_RADIUS_M = 10_000;
export const SEARCH_TIMEOUT_MS = 15_000;

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

type OsmElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
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

/**
 * Named medical places within the search radius of a centre.
 *
 * The two medical-tag clauses rank true facilities first; the `name:en` and
 * broad `name` clauses are the safety net so an OSM element whose tags differ
 * (or that is named in another script) still resolves. Results are de-duped by
 * element id and capped at 20 by the caller.
 */
const buildSearchQuery = (needle: string, at: LatLon): string => `[out:json][timeout:25];
(
  nwr["name"~"${needle}",i]["amenity"~"hospital|clinic|doctors"](around:${SEARCH_RADIUS_M},${at.lat},${at.lon});
  nwr["name"~"${needle}",i]["healthcare"~"hospital|clinic|doctor"](around:${SEARCH_RADIUS_M},${at.lat},${at.lon});
  nwr["name:en"~"${needle}",i](around:${SEARCH_RADIUS_M},${at.lat},${at.lon});
  nwr["name"~"${needle}",i](around:${SEARCH_RADIUS_M},${at.lat},${at.lon});
);
out center 20;`;

const elementToPlace = (element: OsmElement): OsmPlace | null => {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const tags = element.tags ?? {};
  const name = tags.name || tags['name:en'] || '';
  if (!name) return null;

  return { id: `${element.type}/${element.id}`, name, lat, lon };
};

/**
 * Search named hospitals/clinics around `at` through the same-origin Overpass
 * proxy. Results are de-duplicated by OSM element id. Throws on a non-ok
 * response so the caller can surface the raw reason.
 */
export async function searchPlaces(
  query: string,
  at: LatLon,
  signal?: AbortSignal,
): Promise<OsmPlace[]> {
  const needle = sanitizeQuery(query);
  if (!needle) return [];

  const response = await fetch(
    `${OVERPASS_PROXY}?data=${encodeURIComponent(buildSearchQuery(needle, at))}`,
    { headers: { Accept: 'application/json' }, signal },
  );

  if (!response.ok) {
    throw new Error(`Overpass ${response.status}`);
  }

  const payload = (await response.json()) as { elements?: OsmElement[] };
  const byId = new Map<string, OsmPlace>();

  for (const element of payload.elements ?? []) {
    const place = elementToPlace(element);
    if (place && !byId.has(place.id)) byId.set(place.id, place);
  }

  return [...byId.values()];
}
