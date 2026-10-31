import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Search, Star } from 'lucide-react';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { useAuth } from '../context/AuthContext';
import { useRole } from '../context/RoleContext';
import { supabase } from '../lib/supabase';
import { isProvider } from '../lib/roles';
import { describeError } from '../lib/errors';
import { useLang } from '../i18n';
import { useDebouncedValue } from '../hooks/useDebouncedValue';

// ---------------------------------------------------------------------------
// Care Places — keyless, credit-card-free map stack.
//
//   Search : DIRECT browser POST to overpass-api.de (replies CORS: *), 25s
//            abort — no serverless proxy, so Cloudflare/Vercel 504s cannot
//            kill it. No key, no quota account, OSM data.
//   Tiles  : OpenStreetMap raster tiles — free forever, no key.
//   Routing: Google Maps directions links — free, keyless, opens in a new tab.
//
// Near me is proximity-based, so a radial Overpass query needs a centre point.
// Typed names go to Nominatim (see fetchNominatim) instead.
// ---------------------------------------------------------------------------

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const NEAR_RADIUS_M = 5000;
/** Direct browser request; the QL itself declares [timeout:25]. */
const OVERPASS_TIMEOUT_MS = 25_000;
/** A rate-limited mirror gets one automatic retry after this pause. */
const RATE_LIMIT_WAIT_MS = 2_000;
/** Geolocation must resolve or fail within 5s, or the UI reports a timeout. */
const GEOLOCATION_TIMEOUT_MS = 5_000;
/** Progressive text-search radii (km); the final pass is a global search. */
const TEXT_RADII_KM = [25, 200, 1000];
/** Space cascade passes to respect Nominatim's 1 request/second policy. */
const NOMINATIM_GAP_MS = 1_100;
/** The cascade may take several passes; allow more than the 8s nearby budget. */
const TEXT_SEARCH_TIMEOUT_MS = 15_000;
/** Results are cached per rounded centre + filter for ten minutes. */
const CACHE_PREFIX = 'cp:';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CENTER: [number, number] = [30, 0];
const DEFAULT_ZOOM = 2;
const FOCUS_ZOOM = 15;
/** ONE combined amenity regex — no type toggling, no per-type differentiation. */
const AMENITY_REGEX = 'hospital|clinic|doctors|pharmacy';

// Leaflet resolves its default marker images by URL at runtime, which bundlers
// rewrite out from under it. Point the icon at the files Vite gives us instead.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

type OsmElementType = 'node' | 'way' | 'relation';

type OverpassElement = {
  type: OsmElementType;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type PlaceFavorite = {
  id: string;
  user_id: string;
  place_id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  primary_type: string | null;
};

type PlaceView = {
  placeId: string;
  osmType: OsmElementType;
  name: string;
  amenity: string;
  address: string;
  lat: number;
  lon: number;
};

type LatLon = { lat: number; lon: number };

type CarePlacesProps = {
  /** Dashboard role (profiles.role). Drives the role-aware heading. */
  role?: string;
};

/** Strip quotes/backslashes and escape regex metacharacters for Overpass. */
const sanitizeNeedle = (needle: string): string =>
  needle
    .replace(/['\\]/g, ' ')
    .trim()
    .slice(0, 64)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Exact Overpass QL: medical amenities within 5 km of the centre. When a text
 * needle is supplied the SAME set is name-filtered server-side (local + English
 * names), so the list and the map always receive one identical array.
 */
const buildOverpassQuery = (lat: number, lon: number, needle = ''): string => {
  const name = sanitizeNeedle(needle);
  const around = `(around:${NEAR_RADIUS_M},${lat},${lon})`;

  // `[~'^name'~needle]` matches ANY name tag — name, name:en, name:ko, name:zh,
  // name:ja, … — so a facility is found by the name in whichever language was
  // typed, not only the current UI locale.
  const clauses = name
    ? [
        `node['amenity'~'${AMENITY_REGEX}'][~'^name'~'${name}',i]${around};`,
        `way['amenity'~'${AMENITY_REGEX}'][~'^name'~'${name}',i]${around};`,
      ]
    : [
        `node['amenity'~'${AMENITY_REGEX}']${around};`,
        `way['amenity'~'${AMENITY_REGEX}']${around};`,
      ];

  return `[out:json][timeout:25];\n(\n  ${clauses.join('\n  ')}\n);\nout center;`;
};

type CodedError = Error & { code?: string; detail?: string };

const overpassError = (code: string, detail: string, message?: string): CodedError => {
  const error = new Error(message ?? detail) as CodedError;
  error.code = code;
  error.detail = detail;
  return error;
};

/** Reads an error body ONCE: the mirror reasons and/or the detail/error text. */
const readFailure = async (
  response: Response,
): Promise<{ reasons: string[]; detail: string }> => {
  try {
    const body = (await response.json()) as {
      reasons?: unknown;
      detail?: unknown;
      error?: unknown;
    };
    return {
      reasons: Array.isArray(body?.reasons) ? body.reasons.map(describeError) : [],
      detail: describeError(body?.detail ?? body?.error ?? ''),
    };
  } catch {
    return { reasons: [], detail: '' };
  }
};

/**
 * Overpass fetched DIRECTLY from the browser (Overpass replies with
 * `Access-Control-Allow-Origin: *`), bypassing the serverless proxy and its
 * Cloudflare/Vercel 504s. POST form body; the 25s abort comes from the caller.
 * Failures carry a `code` so the caller can append the raw reason.
 */
const fetchOverpassOnce = async (
  query: string,
  signal: AbortSignal,
): Promise<{ elements?: OverpassElement[] }> => {
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ data: query }),
    signal,
  });

  if (response.ok) {
    return (await response.json()) as { elements?: OverpassElement[] };
  }

  // 429 / 5xx: read the body once and surface the real reasons.
  const { reasons, detail } = await readFailure(response);
  throw overpassError(
    String(response.status),
    reasons.join(', ') || detail || `Overpass responded ${response.status}`,
  );
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** A 429, or a 502 whose mirror reasons include one, is worth one retry. */
const isRateLimited = (error: unknown): boolean => {
  const coded = error as CodedError | null;
  if (!coded) return false;
  if (coded.code === '429') return true;
  return typeof coded.detail === 'string' && coded.detail.includes(':429');
};

/** One rate-limit retry (wait 2s) around a single Overpass attempt. */
const fetchOverpass = async (
  query: string,
  signal: AbortSignal,
): Promise<{ elements?: OverpassElement[] }> => {
  try {
    return await fetchOverpassOnce(query, signal);
  } catch (error) {
    if (isRateLimited(error)) {
      await sleep(RATE_LIMIT_WAIT_MS);
      return fetchOverpassOnce(query, signal);
    }
    throw error;
  }
};

const NOMINATIM_PROXY = '/api/nominatim';
/** Nominatim's usage policy is 1 request/second; 1100ms gives a margin. */
const DEBOUNCE_MS = 1_100;

type NominatimResult = {
  place_id?: number;
  display_name?: string;
  name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  class?: string;
};

/** Normalize a Nominatim result into the shared list/map view model. */
const nominatimToPlace = (item: NominatimResult): PlaceView | null => {
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const display = (item.display_name ?? '').trim();
  const name = item.name || display.split(',')[0]?.trim() || display;
  if (!name) return null;
  return {
    placeId: `nominatim/${item.place_id ?? `${lat},${lon}`}`,
    osmType: 'node',
    name,
    amenity: item.type ?? item.class ?? '',
    address: display,
    lat,
    lon,
  };
};

/** Typed-name search through the same-origin Nominatim proxy. */
type NominatimQuery = { at: LatLon | null; radiusKm?: number; country?: string | null };

const fetchNominatim = async (
  needle: string,
  lang: string,
  query: NominatimQuery,
  signal: AbortSignal,
): Promise<NominatimResult[]> => {
  const params = new URLSearchParams({ q: needle, lang });
  if (query.at) {
    params.set('lat', String(query.at.lat));
    params.set('lon', String(query.at.lon));
  }
  if (query.radiusKm) params.set('radius', String(query.radiusKm));
  if (query.country) params.set('country', query.country);
  const response = await fetch(`${NOMINATIM_PROXY}?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    const { reasons, detail } = await readFailure(response);
    throw overpassError(
      String(response.status),
      reasons.join(', ') || detail || `status ${response.status}`,
    );
  }
  const payload = await response.json().catch(() => []);
  return Array.isArray(payload) ? (payload as NominatimResult[]) : [];
};

/** The browser locale's region subtag (e.g. ko-KR -> kr), when present. */
const regionFromNavigator = (): string | null => {
  if (typeof navigator === 'undefined') return null;
  const parts = (navigator.language || '').split('-');
  const region = (parts[1] ?? '').toUpperCase();
  return /^[A-Z]{2}$/.test(region) ? region.toLowerCase() : null;
};

/** Cache key: `cp:{lat2},{lon2}:{needle}` — the text is part of the identity. */
const cacheKey = (lat: number, lon: number, needle = ''): string =>
  `${CACHE_PREFIX}${lat.toFixed(2)},${lon.toFixed(2)}:${sanitizeNeedle(needle).toLowerCase()}`;

/** Reads a cached element list, dropping entries older than the TTL. */
const readCache = (key: string): OverpassElement[] | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { at?: number; elements?: OverpassElement[] };
    if (typeof parsed?.at !== 'number') return null;

    if (Date.now() - parsed.at > CACHE_TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }

    return parsed.elements ?? [];
  } catch {
    // Corrupt JSON, or storage blocked (private mode) — behave as a miss.
    return null;
  }
};

const writeCache = (key: string, elements: OverpassElement[]): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), elements }));
  } catch {
    // Quota exceeded or storage blocked — caching is best-effort.
  }
};

const elementToPlace = (element: OverpassElement): PlaceView | null => {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;

  const tags = element.tags ?? {};
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');

  return {
    placeId: `${element.type}/${element.id}`,
    osmType: element.type,
    name: tags.name || tags['name:en'] || '',
    // Kept only for the client-side text filter; nothing renders it as a type.
    amenity: tags.amenity ?? '',
    address: street || tags['addr:city'] || tags['addr:suburb'] || '',
    lat,
    lon,
  };
};

const directionsUrl = (place: PlaceView): string =>
  `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lon}`;

/** Imperatively pans the map when the user picks a place or shares a location. */
function MapFocus({
  lat,
  lon,
  focusKey,
}: {
  lat: number | null;
  lon: number | null;
  focusKey: string | null;
}) {
  const map = useMap();
  const applied = useRef<string | null>(null);

  // Tiles render mis-aligned if the container was measured before layout settled.
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize(), 0);
    return () => window.clearTimeout(id);
  }, [map]);

  useEffect(() => {
    if (lat === null || lon === null || !focusKey || applied.current === focusKey) return;
    applied.current = focusKey;
    map.flyTo([lat, lon], FOCUS_ZOOM, { duration: 0.6 });
  }, [map, lat, lon, focusKey]);

  return null;
}

export default function CarePlaces({ role = '' }: CarePlacesProps) {
  const { user } = useAuth();
  const { t, tString, locale } = useLang();

  const { role: profileRole } = useRole();
  const effectiveRole = (role || profileRole).toLowerCase();
  // Provider accounts (doctor / department / hospital) get the network heading.
  const titleKey = isProvider(effectiveRole) ? 'places.titleDoctor' : 'places.titlePatient';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceView[]>([]);
  const [center, setCenter] = useState<LatLon | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState('');

  const [favorites, setFavorites] = useState<PlaceFavorite[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(true);
  const [favoritesError, setFavoritesError] = useState('');
  const [savingPlaceId, setSavingPlaceId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  /** The last search (kind + centre + text), so Retry can repeat it exactly. */
  const lastSearchRef = useRef<{
    kind: 'nearby' | 'text';
    at: LatLon | null;
    needle: string;
  } | null>(null);

  const placeName = useCallback(
    (place: PlaceView) => place.name || t('places.eyebrow'),
    [t],
  );

  // ---- Favorites (unchanged Supabase place_favorites logic) ---------------
  const loadFavorites = useCallback(async () => {
    if (!user) {
      setFavoritesLoading(false);
      return;
    }

    setFavoritesLoading(true);
    setFavoritesError('');

    const { data, error: loadError } = await supabase
      .from('place_favorites')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (loadError) {
      console.log('PLACES ERROR:', loadError);
      setFavoritesError(loadError.message);
      setFavorites([]);
      setFavoritesLoading(false);
      return;
    }

    setFavorites((data ?? []) as PlaceFavorite[]);
    setFavoritesLoading(false);
  }, [user]);

  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  // ---- Search -------------------------------------------------------------
  // Two sources, deliberately split:
  //   • Near me    → Overpass radial query (direct POST to overpass-api.de).
  //   • Typed name → Nominatim (/api/nominatim) — any-language name search that
  //                  does not depend on a 5 km radial scan.
  const lastTextRef = useRef('');

  const executeSearch = useCallback(
    async (
      kind: 'nearby' | 'text',
      at: LatLon | null,
      needle: string,
      load: (signal: AbortSignal) => Promise<PlaceView[]>,
      timeoutMs = OVERPASS_TIMEOUT_MS,
    ) => {
      lastSearchRef.current = { kind, at, needle };
      // Supersede any in-flight request so only the newest one settles state.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Hard ceiling per search; the text cascade gets a longer budget than the
      // 8s nearby query.
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      setIsLoading(true);
      setSearched(false);
      setError('');

      try {
        const places = await load(controller.signal);
        if (abortRef.current !== controller) return;
        setResults(places);
        setSelectedId(null);
        setSearched(true);
      } catch (caught) {
        if (abortRef.current !== controller) return;
        const code = (caught as CodedError)?.code;
        const detail = (caught as CodedError)?.detail ?? '';

        if ((caught as Error)?.name === 'AbortError') {
          // Only a timeout is worth surfacing; a superseded request or an
          // unmount must stay silent.
          if (timedOut) {
            console.error('SEARCH_ERROR:', caught);
            setError(`${t('places.searchFailed')} (timeout)`);
          }
          return;
        }

        console.error('SEARCH_ERROR:', caught);
        // Always name the raw cause — 429/504/500 plus the proxy detail — never
        // a bare, silent empty list.
        const reason = code === '404'
          ? '404 route missing'
          : code
            ? `${code}${detail ? `: ${detail}` : ''}`
            : '';
        setError(`${t('places.searchFailed')}${reason ? ` (${reason})` : ''}`);
        setResults([]);
      } finally {
        window.clearTimeout(timeoutId);
        if (abortRef.current === controller) setIsLoading(false);
      }
    },
    [t],
  );

  /** Near me → Overpass radial query around the given centre. */
  const runNearby = useCallback(
    async (at: LatLon) => {
      await executeSearch('nearby', at, '', async (signal) => {
        const key = cacheKey(at.lat, at.lon, '');
        const cached = readCache(key);
        // An EMPTY cached list is not a hit: re-query instead of pinning empty.
        if (cached !== null && cached.length > 0) {
          return cached
            .map(elementToPlace)
            .filter((place): place is PlaceView => place !== null);
        }
        const payload = await fetchOverpass(buildOverpassQuery(at.lat, at.lon), signal);
        const elements = payload.elements ?? [];
        if (elements.length > 0) writeCache(key, elements);
        return elements
          .map(elementToPlace)
          .filter((place): place is PlaceView => place !== null);
      });
    },
    [executeSearch],
  );

  /** Typed name → Nominatim: region → 200km → 1000km → global. */
  const runText = useCallback(
    async (needle: string) => {
      lastTextRef.current = needle;
      await executeSearch(
        'text',
        null,
        needle,
        async (signal) => {
          // Progressive expansion. With a centre: 25 → 200 → 1000 km, then a
          // global pass. Without: the browser region's country, then global.
          const passes: NominatimQuery[] = [];
          if (center) {
            for (const radiusKm of TEXT_RADII_KM) passes.push({ at: center, radiusKm });
            passes.push({ at: center });
          } else {
            const country = regionFromNavigator();
            if (country) passes.push({ at: null, country });
            passes.push({ at: null });
          }

          for (let i = 0; i < passes.length; i += 1) {
            const items = await fetchNominatim(needle, locale, passes[i], signal);
            if (items.length > 0) {
              return items
                .map(nominatimToPlace)
                .filter((place): place is PlaceView => place !== null);
            }
            if (i < passes.length - 1) await sleep(NOMINATIM_GAP_MS);
          }
          return [];
        },
        TEXT_SEARCH_TIMEOUT_MS,
      );
    },
    [executeSearch, locale, center],
  );

  // Abort any in-flight Overpass request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const requestLocation = (onSuccess?: (at: LatLon) => void) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationError(t('places.locationUnavailable'));
      return;
    }

    setLocating(true);
    setLocationError('');

    // Guard the whole flow: a hanging getCurrentPosition must not leave the UI
    // stuck on "Locating…". After 5s, surface a translated timeout notice.
    let settled = false;
    let timer: number | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      fn();
    };

    timer = window.setTimeout(() => {
      finish(() => {
        console.log('PLACES ERROR: geolocation timeout');
        setLocationError(t('places.locationTimeout'));
        setLocating(false);
      });
    }, GEOLOCATION_TIMEOUT_MS);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        finish(() => {
          const at = { lat: position.coords.latitude, lon: position.coords.longitude };
          setCenter(at);
          setLocating(false);
          onSuccess?.(at);
        });
      },
      (geoError) => {
        finish(() => {
          console.log('PLACES ERROR:', geoError);
          setLocationError(geoError.message || t('places.locationDenied'));
          setLocating(false);
        });
      },
      { enableHighAccuracy: false, timeout: GEOLOCATION_TIMEOUT_MS, maximumAge: 300000 },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const needle = query.trim();
    // A typed name goes to Nominatim; an empty submit means "find nearby".
    if (needle) {
      void runText(needle);
    } else if (center) {
      void runNearby(center);
    } else {
      requestLocation((at) => void runNearby(at));
    }
  };

  /** Retry the last search after a failure (inline error action). */
  const retrySearch = () => {
    const last = lastSearchRef.current;
    if (!last) return;
    if (last.kind === 'text') void runText(last.needle);
    else if (last.at) void runNearby(last.at);
  };

  // Typed text drives a debounced NOMINATIM search. 1100ms respects Nominatim's
  // strict 1 request/second usage policy (400ms would trip 429s).
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  useEffect(() => {
    const needle = debouncedQuery.trim();
    if (!needle) {
      lastTextRef.current = '';
      return;
    }
    // Skip when the submit/Retry path already searched this exact text.
    if (needle === lastTextRef.current) return;
    void runText(needle);
  }, [debouncedQuery, runText]);

  const focusLatLng = useMemo<{ lat: number | null; lon: number | null; focusKey: string | null }>(() => {
    const selected = results.find((place) => place.placeId === selectedId);
    if (selected) return { lat: selected.lat, lon: selected.lon, focusKey: selected.placeId };
    if (center) return { lat: center.lat, lon: center.lon, focusKey: 'me' };
    return { lat: null, lon: null, focusKey: null };
  }, [results, selectedId, center]);

  const selectedPlace = useMemo(
    () => results.find((place) => place.placeId === selectedId) ?? null,
    [results, selectedId],
  );

  // ---- Favorites toggle ---------------------------------------------------
  const isSaved = (placeId: string) => favorites.some((favorite) => favorite.place_id === placeId);

  const toggleFavorite = async (place: PlaceView) => {
    if (!user) return;

    const existing = favorites.find((favorite) => favorite.place_id === place.placeId);
    setSavingPlaceId(place.placeId);
    setFavoritesError('');

    try {
      if (existing) {
        const { error: deleteError } = await supabase
          .from('place_favorites')
          .delete()
          .eq('id', existing.id)
          .eq('user_id', user.id);

        if (deleteError) throw deleteError;
        setFavorites((previous) => previous.filter((favorite) => favorite.id !== existing.id));
      } else {
        const payload = {
          user_id: user.id,
          place_id: place.placeId,
          name: placeName(place),
          address: place.address,
          latitude: place.lat,
          longitude: place.lon,
          primary_type: place.amenity,
        };

        const { data, error: upsertError } = await supabase
          .from('place_favorites')
          .upsert(payload, { onConflict: 'user_id,place_id' })
          .select()
          .single();

        if (upsertError) throw upsertError;
        setFavorites((previous) => [data as PlaceFavorite, ...previous]);
      }
    } catch (caught) {
      console.log('PLACES ERROR:', caught);
      setFavoritesError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingPlaceId(null);
    }
  };

  const renderStar = (place: PlaceView) => {
    const saved = isSaved(place.placeId);
    const busy = savingPlaceId === place.placeId;
    const name = placeName(place);
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void toggleFavorite(place);
        }}
        disabled={busy}
        aria-pressed={saved}
        aria-label={saved ? tString('places.removeSaved', { name }) : tString('places.save', { name })}
        title={saved ? t('places.removeTitle') : t('places.saveTitle')}
        style={{
          ...styles.starButton,
          ...(saved ? styles.starButtonSaved : null),
          ...(busy ? styles.starButtonBusy : null),
        }}
      >
        <Star size={18} fill={saved ? 'currentColor' : 'none'} />
      </button>
    );
  };

  const renderPlaceCard = (place: PlaceView, key: string) => {
    const isSelected = selectedId === place.placeId;
    return (
      <li key={key}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setSelectedId(place.placeId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') setSelectedId(place.placeId);
          }}
          aria-pressed={isSelected}
          style={{ ...styles.card, ...(isSelected ? styles.cardSelected : null) }}
        >
          <span style={styles.cardTop}>
            <strong style={styles.cardName}>{placeName(place)}</strong>
            {renderStar(place)}
          </span>
          {place.address ? <span style={styles.cardAddress}>{place.address}</span> : null}
          <span style={styles.cardFooter}>
            <a
              href={directionsUrl(place)}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              style={styles.directionsLink}
            >
              {t('places.getDirections')}
            </a>
          </span>
        </div>
      </li>
    );
  };

  return (
    <section style={styles.panel} aria-labelledby="care-places-heading">
      <div>
        <p style={styles.eyebrow}>{t('places.eyebrow')}</p>
        <h3 id="care-places-heading" style={styles.title}>
          {t(titleKey)}
        </h3>
        <p style={styles.description}>{t('places.description')}</p>
      </div>

      {/* FAVORITES — newest first, above search. */}
      <div id="care-places-favorites" style={styles.section}>
        <div style={styles.sectionHeading}>
          <h4 style={styles.sectionTitle}>{t('places.favorites')}</h4>
          {!favoritesLoading && !favoritesError ? (
            <span style={styles.countPill}>{favorites.length}</span>
          ) : null}
        </div>

        {favoritesLoading ? (
          <p style={styles.muted} aria-busy="true">{t('places.loadingSaved')}</p>
        ) : favoritesError ? (
          <p role="alert" style={styles.error}>{favoritesError}</p>
        ) : favorites.length === 0 ? (
          <p style={styles.muted}>{t('places.noFavorites')}</p>
        ) : (
          <ul style={styles.favoritesGrid}>
            {favorites.map((favorite) => (
              <li key={favorite.id}>
                <div style={styles.card}>
                  <span style={styles.cardTop}>
                    <strong style={styles.cardName}>{favorite.name}</strong>
                    <button
                      type="button"
                      disabled={savingPlaceId === favorite.place_id}
                      aria-pressed
                      aria-label={tString('places.removeSaved', { name: favorite.name })}
                      title={t('places.removeTitle')}
                      onClick={() =>
                        void toggleFavorite({
                          placeId: favorite.place_id,
                          osmType: 'node',
                          name: favorite.name,
                          amenity: favorite.primary_type ?? '',
                          address: favorite.address ?? '',
                          lat: favorite.latitude ?? 0,
                          lon: favorite.longitude ?? 0,
                        })
                      }
                      style={{ ...styles.starButton, ...styles.starButtonSaved }}
                    >
                      <Star size={18} fill="currentColor" />
                    </button>
                  </span>
                  {favorite.address ? <span style={styles.cardAddress}>{favorite.address}</span> : null}
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${favorite.latitude ?? 0},${favorite.longitude ?? 0}`}
                    target="_blank"
                    rel="noreferrer"
                    style={styles.directionsLink}
                  >
                    {t('places.getDirections')}
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* SEARCH — Overpass is proximity-based, so a centre is required. */}
      <div style={styles.section}>
        <form onSubmit={handleSubmit} style={styles.searchRow}>
          <div style={styles.searchBox}>
            <Search size={16} style={styles.searchIcon} aria-hidden="true" />
            <input
              id="care-places-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('places.searchPlaceholder')}
              aria-label={t('places.searchAria')}
              autoComplete="off"
              style={styles.input}
            />
          </div>
          <button type="submit" disabled={isLoading} style={styles.nearMeButton}>
            {isLoading ? t('places.searching') : t('places.searchAria')}
          </button>
          <button
            type="button"
            onClick={() => requestLocation((at) => void runNearby(at))}
            disabled={locating}
            aria-pressed={center !== null}
            style={{ ...styles.nearMeButton, ...(center ? styles.nearMeButtonOn : null) }}
          >
            {t('places.nearMe')}
          </button>
        </form>

        <p style={styles.locationHint}>
          {center ? t('places.usingLocation') : t('places.needLocation')}
        </p>
        {locationError ? <p role="alert" style={styles.error}>{locationError}</p> : null}

        {isLoading ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}
        {!isLoading && error ? (
          <p role="alert" style={styles.error}>
            {error}{' '}
            <button type="button" className="ghost-button" onClick={retrySearch} style={styles.retryButton}>
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {!isLoading && !error && searched && results.length === 0 ? (
          <p style={styles.muted}>{t('places.noResults')}</p>
        ) : null}

        {!isLoading && !error && results.length > 0 ? (
          <>
            <ul style={styles.results}>{results.map((place) => renderPlaceCard(place, place.placeId))}</ul>
            <p style={styles.attribution}>
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
                style={styles.attributionLink}
              >
                {t('places.attribution')}
              </a>
            </p>
          </>
        ) : null}
      </div>

      {/* MAP — OpenStreetMap raster tiles, no key, no quota. */}
      <div style={styles.section}>
        <div style={styles.sectionHeading}>
          <h4 style={styles.sectionTitle}>{t('places.mapPreview')}</h4>
          {selectedPlace ? (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${selectedPlace.lat},${selectedPlace.lon}`}
              target="_blank"
              rel="noreferrer"
              style={styles.directionsLink}
            >
              {t('places.openInMaps')}
            </a>
          ) : null}
        </div>
        {/* Leaflet's own controls are physical-positioned, so keep the map LTR. */}
        <div dir="ltr" style={styles.mapWrap}>
          <MapContainer
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            scrollWheelZoom={false}
            style={styles.mapCanvas}
          >
            <TileLayer
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              attribution={t('places.attribution')}
            />
            {center ? (
              <Marker position={[center.lat, center.lon]}>
                <Popup>{t('places.usingLocation')}</Popup>
              </Marker>
            ) : null}
            {results.map((place) => (
              <Marker
                key={place.placeId}
                position={[place.lat, place.lon]}
                eventHandlers={{ click: () => setSelectedId(place.placeId) }}
              >
                <Popup>
                  <strong>{placeName(place)}</strong>
                  {place.address ? (
                    <>
                      <br />
                      {place.address}
                    </>
                  ) : null}
                  <br />
                  <a href={directionsUrl(place)} target="_blank" rel="noreferrer">
                    {t('places.getDirections')}
                  </a>
                </Popup>
              </Marker>
            ))}
            <MapFocus
              lat={focusLatLng.lat}
              lon={focusLatLng.lon}
              focusKey={focusLatLng.focusKey}
            />
          </MapContainer>
        </div>
        <p style={styles.attribution}>
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            style={styles.attributionLink}
          >
            {t('places.attribution')}
          </a>
        </p>
      </div>
    </section>
  );
}

// Spacing/positioning uses logical properties (inset-inline-start, paddingInline,
// marginInline) so the panel mirrors correctly under dir="rtl".
const styles: Record<string, CSSProperties> = {
  panel: {
    width: '100%',
    padding: '1.4rem',
    border: '1px solid rgba(62, 169, 133, 0.18)',
    borderRadius: '1.35rem',
    background: 'linear-gradient(180deg, rgba(250, 255, 252, 0.98), rgba(238, 249, 244, 0.92))',
    boxShadow: '0 22px 46px rgba(17, 55, 47, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
    color: '#133b35',
    display: 'grid',
    gap: '1.15rem',
  },
  eyebrow: {
    margin: 0,
    color: '#3ea985',
    fontSize: '0.7rem',
    fontWeight: 800,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },
  title: { margin: '0.2rem 0 0', fontSize: '1.15rem', lineHeight: 1.25 },
  description: { marginBlock: '0.35rem 0', marginInline: 0, color: '#557b76', fontSize: '0.86rem', lineHeight: 1.6 },
  section: { display: 'grid', gap: '0.6rem' },
  sectionHeading: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.6rem',
    flexWrap: 'wrap',
  },
  sectionTitle: { margin: 0, fontSize: '0.92rem', color: '#216e5d' },
  countPill: {
    paddingBlock: '0.15rem',
    paddingInline: '0.55rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.16)',
    color: '#216e5d',
    fontSize: '0.74rem',
    fontWeight: 800,
  },
  muted: { margin: 0, color: '#557b76', fontSize: '0.84rem', lineHeight: 1.5 },
  error: { margin: 0, color: '#9c3636', fontSize: '0.84rem', fontWeight: 600, lineHeight: 1.5 },
  searchRow: { display: 'flex', alignItems: 'stretch', gap: '0.5rem', flexWrap: 'wrap' },
  searchBox: { position: 'relative', display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 },
  searchIcon: { position: 'absolute', insetInlineStart: 12, color: '#557b76' },
  input: {
    width: '100%',
    border: '1px solid rgba(15, 58, 50, 0.12)',
    borderRadius: '999px',
    paddingBlock: '0.75rem',
    paddingInline: '2.3rem 1rem',
    background: '#fff',
    fontSize: '0.92rem',
    color: '#133b35',
  },
  nearMeButton: {
    flexShrink: 0,
    border: '1px solid rgba(62, 169, 133, 0.3)',
    borderRadius: '999px',
    paddingBlock: '0.65rem',
    paddingInline: '0.9rem',
    background: '#fff',
    color: '#216e5d',
    fontWeight: 700,
    fontSize: '0.84rem',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  nearMeButtonOn: {
    background: 'linear-gradient(120deg, #48b58f, #7adab1)',
    borderColor: 'rgba(62, 169, 133, 0.5)',
    color: '#072c2a',
  },
  locationHint: { margin: 0, color: '#557b76', fontSize: '0.76rem', fontStyle: 'italic' },
  favoritesGrid: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
    gap: '0.6rem',
  },
  results: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.5rem' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.3rem',
    width: '100%',
    textAlign: 'start',
    fontFamily: 'inherit',
    paddingBlock: '0.75rem',
    paddingInline: '0.85rem',
    border: '1px solid rgba(15, 58, 50, 0.1)',
    borderRadius: '0.9rem',
    background: '#fff',
    color: '#133b35',
    cursor: 'pointer',
  },
  cardSelected: {
    borderColor: 'rgba(62, 169, 133, 0.55)',
    boxShadow: '0 0 0 2px rgba(62, 169, 133, 0.18)',
    background: 'rgba(62, 169, 133, 0.06)',
  },
  cardTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.5rem' },
  cardName: { fontSize: '0.92rem', lineHeight: 1.35, overflowWrap: 'anywhere' },
  cardAddress: { color: '#557b76', fontSize: '0.78rem', lineHeight: 1.45, overflowWrap: 'anywhere' },
  cardFooter: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  directionsLink: { color: '#216e5d', fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' },
  starButton: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: '50%',
    border: '1px solid rgba(62, 169, 133, 0.25)',
    background: 'transparent',
    color: '#3ea985',
    cursor: 'pointer',
  },
  starButtonSaved: { background: 'rgba(62, 169, 133, 0.16)', color: '#216e5d' },
  starButtonBusy: { opacity: 0.55, cursor: 'wait' },
  retryButton: { padding: '0.1rem 0.55rem', fontSize: '0.76rem', marginInlineStart: '0.4rem' },
  mapWrap: { position: 'relative', isolation: 'isolate', overflow: 'hidden', width: '100%' },
  mapCanvas: { width: '100%', height: 320, borderRadius: '0.9rem', background: '#fff' },
  attribution: { margin: 0, color: '#557b76', fontSize: '0.72rem', textAlign: 'end' },
  attributionLink: { color: '#216e5d', textDecoration: 'underline' },
};
