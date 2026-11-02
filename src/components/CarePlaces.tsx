import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Star } from 'lucide-react';
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

// ---------------------------------------------------------------------------
// Care Places — OpenStreetMap tiles with Overpass nearby POIs.
//
//   Search : category pills → /api/overpass (categories filter client-side).
//   Tiles  : OpenStreetMap raster tiles — free forever, no key.
//   Routing: Google Maps directions links — free, keyless, opens in a new tab.
//
// Near me is proximity-based, so a nearby search needs a centre point; clicking
// a category without one asks for location first.
// ---------------------------------------------------------------------------

/** Near-me search radius; the Overpass route accepts 1–50km. */
const CASCADE_RADII = [2_000] as const;
/** Client guard, above the route's 15s Overpass budget so its 408 wins the race. */
const PLACES_TIMEOUT_MS = 16_000;
/** Geolocation must resolve or fail within 5s, or the UI reports a timeout. */
const GEOLOCATION_TIMEOUT_MS = 5_000;
/** Results are cached per rounded centre + filter for ten minutes. */
const CACHE_PREFIX = 'cp:';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CENTER: [number, number] = [30, 0];
const DEFAULT_ZOOM = 2;
const FOCUS_ZOOM = 15;

// Leaflet resolves its default marker images by URL at runtime, which bundlers
// rewrite out from under it. Point the icon at the files Vite gives us instead.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

type OsmElementType = 'node' | 'way' | 'relation';

type PlaceResult = {
  id?: string | number;
  name?: string;
  lat?: number;
  lon?: number;
  type?: string;
  /** Legacy field still present in cached/favourite rows. */
  category?: string;
  address?: string;
};

type PlacesResponse = {
  results?: PlaceResult[];
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
  /** Raw OSM tags, so the client filter can also match tags.name / name:en. */
  tags?: Record<string, string>;
};

type LatLon = { lat: number; lon: number };

/** The four categories the UI exposes. */
type Category = 'hospital' | 'clinic' | 'pharmacy' | 'doctors';

const CATEGORIES: Array<{ value: Category; labelKey: string }> = [
  { value: 'hospital', labelKey: 'places.catHospital' },
  { value: 'clinic', labelKey: 'places.catClinic' },
  { value: 'pharmacy', labelKey: 'places.catPharmacy' },
  { value: 'doctors', labelKey: 'places.catDoctor' },
];

const ALL_CATEGORIES = CATEGORIES.map((item) => item.value);

type CarePlacesProps = {
  /** Dashboard role (profiles.role). Drives the role-aware heading. */
  role?: string;
};

/** Strip quotes/backslashes and escape regex metacharacters for a cache key. */
const sanitizeNeedle = (needle: string): string =>
  needle
    .replace(/['\\]/g, ' ')
    .trim()
    .slice(0, 64)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type CodedError = Error & { code?: string; detail?: string };

const placesError = (code: string, detail: string, message?: string): CodedError => {
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

/** Category pills → the Overpass route; category filtering is client-side. */
const fetchPlacesNearby = async (
  at: LatLon,
  radius: number,
  signal: AbortSignal,
): Promise<PlacesResponse> => {
  const params = new URLSearchParams({
    lat: String(at.lat),
    lon: String(at.lon),
    radius: String(radius),
  });

  const response = await fetch(`/api/overpass?${params.toString()}`, {
    headers: { Accept: 'application/json' },
    signal,
  });

  // Explicitly treat a timed-out/upstream-failed map as a graceful state; the
  // caller shows the amber notice and keeps the rest of the page interactive.
  if (response.status === 408 || response.status === 500) {
    throw placesError(String(response.status), `overpass responded ${response.status}`);
  }

  if (!response.ok) {
    const { reasons, detail } = await readFailure(response);
    throw placesError(
      String(response.status),
      reasons.join(', ') || detail || `places responded ${response.status}`,
    );
  }

  return (await response.json()) as PlacesResponse;
};

/** Cache key: `cp:{lat2},{lon2}:{category-radius}` — the query is part of it. */
const cacheKey = (lat: number, lon: number, needle = ''): string =>
  `${CACHE_PREFIX}${lat.toFixed(2)},${lon.toFixed(2)}:${sanitizeNeedle(needle).toLowerCase()}`;

/** Reads a cached place list, dropping entries older than the TTL. */
const readCache = (key: string): PlaceView[] | null => {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { at?: number; places?: PlaceView[] };
    if (typeof parsed?.at !== 'number') return null;

    if (Date.now() - parsed.at > CACHE_TTL_MS) {
      window.localStorage.removeItem(key);
      return null;
    }

    return parsed.places ?? [];
  } catch {
    // Corrupt JSON, or storage blocked (private mode) — behave as a miss.
    return null;
  }
};

const writeCache = (key: string, places: PlaceView[]): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), places }));
  } catch {
    // Quota exceeded or storage blocked — caching is best-effort.
  }
};

const resultToPlace = (result: PlaceResult): PlaceView | null => {
  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = (result.name ?? '').trim();
  const placeId =
    result.id != null && String(result.id).trim()
      ? String(result.id)
      : `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return {
    placeId,
    osmType: 'node',
    name,
    amenity: result.type ?? result.category ?? '',
    address: result.address ?? '',
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

/**
 * Fit the map to the cascade's results when they came from a wider radius.
 * Narrow (5km) results keep the existing focus behaviour.
 */
function FitBounds({
  points,
  wide,
}: {
  points: Array<[number, number]>;
  wide: boolean;
}) {
  const map = useMap();

  useEffect(() => {
    if (!wide || points.length === 0) return;
    map.fitBounds(L.latLngBounds(points), { padding: [50, 50], maxZoom: 15 });
  }, [map, wide, points]);

  return null;
}

export default function CarePlaces({ role = '' }: CarePlacesProps) {
  const { user } = useAuth();
  const { t, tString } = useLang();

  const { role: profileRole } = useRole();
  const effectiveRole = (role || profileRole).toLowerCase();
  // Provider accounts (doctor / department / hospital) get the network heading.
  const titleKey = isProvider(effectiveRole) ? 'places.titleDoctor' : 'places.titlePatient';

  const [selectedCategories, setSelectedCategories] = useState<Category[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
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
  // True on 408/500 (or legacy 504): map data is unavailable; offer Retry.
  const [isMapUnavailable, setIsMapUnavailable] = useState(false);
  const [areaTooDense, setAreaTooDense] = useState(false);
  // Cascade feedback: true while trying a wider radius, and true once a wider
  // radius produced the current results.
  const [expanding, setExpanding] = useState(false);
  const [wide, setWide] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  /** The last search (centre + selected categories), so Retry repeats it. */
  const lastSearchRef = useRef<{ at: LatLon; categories: Category[] } | null>(null);

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
  // Multi-select category pills → /api/overpass?lat&lon&radius.
  // Category and text filters are client-side; neither touches the network.
  const executeSearch = useCallback(
    async (
      at: LatLon,
      categories: Category[],
      load: (signal: AbortSignal) => Promise<PlaceView[]>,
      timeoutMs = PLACES_TIMEOUT_MS,
    ) => {
      lastSearchRef.current = { at, categories };
      // Supersede any in-flight request so only the newest one settles state.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      // Hard ceiling per search; the client guard sits just above the route's
      // own budget.
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      setIsLoading(true);
      setSearched(false);
      setError('');
      setIsMapUnavailable(false);
      setAreaTooDense(false);
      setExpanding(false);
      setWide(false);

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

        // A 408/500 (or legacy 504) with no cached data: calm amber notice,
        // not a red raw error. Favourites above remain usable; Retry is offered.
        if (code === '408') {
          console.warn('Overpass search timed out; showing density notice.');
          setAreaTooDense(true);
          setIsMapUnavailable(true);
          setResults([]);
          return;
        }

        if (
          code === 'map_unavailable' ||
          code === '500' ||
          code === '504'
        ) {
          console.warn('Map data temporarily unavailable, using graceful fallback.');
          setAreaTooDense(false);
          setIsMapUnavailable(true);
          setResults([]);
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
        if (abortRef.current === controller) {
          setIsLoading(false);
          setExpanding(false);
        }
      }
    },
    [t],
  );

  /** Selected categories → one Overpass nearby query; filtering is client-side. */
  const runCategories = useCallback(
    async (categories: Category[], at: LatLon) => {
      const effective = categories.length > 0 ? categories : ALL_CATEGORIES;
      await executeSearch(at, effective, async (signal) => {
        for (let index = 0; index < CASCADE_RADII.length; index += 1) {
          const radius = CASCADE_RADII[index];
          if (index > 0) setExpanding(true);

          // Per-browser cache, keyed by the selected set + radius.
          const cacheTag = effective.slice().sort().join('-');
          const localKey = cacheKey(at.lat, at.lon, `${cacheTag}-${radius}`);
          const local = readCache(localKey);
          if (local !== null && local.length > 0) {
            setExpanding(false);
            setWide(false);
            return local;
          }

          const payload = await fetchPlacesNearby(at, radius, signal);
          const places = (payload.results ?? [])
            .map(resultToPlace)
            .filter((place): place is PlaceView => place !== null);

          if (places.length > 0) {
            writeCache(localKey, places);
            setExpanding(false);
            setWide(false);
            return places;
          }
        }
        return [];
      });
    },
    [executeSearch],
  );

  // Abort any in-flight places request on unmount.
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

  /** Toggle a category; any change re-queries with the selected set. */
  const handleCategory = (next: Category) => {
    const nextSelected = selectedCategories.includes(next)
      ? selectedCategories.filter((item) => item !== next)
      : [...selectedCategories, next];
    setSelectedCategories(nextSelected);
    const effective = nextSelected.length > 0 ? nextSelected : ALL_CATEGORIES;
    if (center) {
      void runCategories(effective, center);
      return;
    }
    requestLocation((at) => void runCategories(effective, at));
  };

  /** Retry the last search after a failure (inline error action). */
  const retrySearch = () => {
    const last = lastSearchRef.current;
    if (last) void runCategories(last.categories, last.at);
  };

  // Client-side only: filters the already-fetched array, never the network.
  // Both the results list and the Leaflet markers read filteredResults.
  const filteredResults = useMemo(() => {
    const lowerQuery = searchQuery.trim().toLowerCase();
    return results.filter((place) => {
      if (selectedCategories.length > 0 && !selectedCategories.includes(place.amenity as Category)) {
        return false;
      }
      if (!lowerQuery) return true;
      const names = [place.name, place.tags?.name, place.tags?.['name:en']];
      return names.some(
        (value) => typeof value === 'string' && value.toLowerCase().includes(lowerQuery),
      );
    });
  }, [results, searchQuery, selectedCategories]);

  const focusLatLng = useMemo<{ lat: number | null; lon: number | null; focusKey: string | null }>(() => {
    const selected = filteredResults.find((place) => place.placeId === selectedId);
    if (selected) return { lat: selected.lat, lon: selected.lon, focusKey: selected.placeId };
    if (center) return { lat: center.lat, lon: center.lon, focusKey: 'me' };
    return { lat: null, lon: null, focusKey: null };
  }, [filteredResults, selectedId, center]);

  const selectedPlace = useMemo(
    () => filteredResults.find((place) => place.placeId === selectedId) ?? null,
    [filteredResults, selectedId],
  );

  const resultPoints = useMemo<Array<[number, number]>>(
    () => filteredResults.map((place) => [place.lat, place.lon]),
    [filteredResults],
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
          {place.address ? (
            <span style={styles.cardAddress}>{place.address}</span>
          ) : place.amenity ? (
            <span style={styles.cardAddress}>{place.amenity}</span>
          ) : null}
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

      {/* SEARCH — category pills filter /api/overpass results client-side. */}
      <div style={styles.section}>
        <div style={styles.categoryRow} role="group" aria-label={t('places.selectCategories')}>
          {CATEGORIES.map((item) => {
            const active = selectedCategories.includes(item.value);
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                style={{ ...styles.categoryPill, ...(active ? styles.categoryPillActive : null) }}
                onClick={() => handleCategory(item.value)}
              >
                {t(item.labelKey)}
              </button>
            );
          })}
        </div>

        <div style={styles.categoryRow}>
          <button
            type="button"
            onClick={() =>
              requestLocation((at) =>
                void runCategories(
                  selectedCategories.length > 0 ? selectedCategories : ALL_CATEGORIES,
                  at,
                ),
              )
            }
            disabled={locating}
            aria-pressed={center !== null}
            style={{ ...styles.categoryPill, ...(center ? styles.categoryPillOn : null) }}
          >
            {t('places.nearMe')}
          </button>
        </div>

        <input
          className="input"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('places.filterResults')}
          aria-label={t('places.filterResults')}
        />

        <p style={styles.locationHint}>
          {center ? t('places.usingLocation') : t('places.needLocation')}
        </p>

        {isMapUnavailable ? (
          <p role="status" style={styles.fallbackBanner}>
            {t(areaTooDense ? 'hospitals.area_too_dense' : 'map_data_unavailable')}{' '}
            <button type="button" className="ghost-button" onClick={retrySearch} style={styles.retryButton}>
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {locationError ? <p role="alert" style={styles.error}>{locationError}</p> : null}

        {isLoading ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}
        {expanding ? (
          <p role="status" style={styles.expandingNotice}>{t('places.expandingSearch')}</p>
        ) : null}
        {!isLoading && error ? (
          <p role="alert" style={styles.error}>
            {error}{' '}
            <button type="button" className="ghost-button" onClick={retrySearch} style={styles.retryButton}>
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {!isLoading && !error && searched && (results.length === 0 || filteredResults.length === 0) ? (
          <p style={styles.muted}>{t('places.noResults')}</p>
        ) : null}

        {!isLoading && !error && filteredResults.length > 0 ? (
          <>
            {wide ? (
              <p role="status" style={styles.wideBadge}>{t('places.wideSearch')}</p>
            ) : null}
            <ul style={styles.results}>{filteredResults.map((place) => renderPlaceCard(place, place.placeId))}</ul>
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
            {filteredResults.map((place) => (
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
                  ) : place.amenity ? (
                    <>
                      <br />
                      {place.amenity}
                    </>
                  ) : null}
                  <br />
                  <a href={directionsUrl(place)} target="_blank" rel="noreferrer">
                    {t('places.getDirections')}
                  </a>
                </Popup>
              </Marker>
            ))}
            <FitBounds points={resultPoints} wide={wide} />
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
  fallbackBanner: {
    margin: 0,
    padding: '0.55rem 0.75rem',
    borderRadius: '0.7rem',
    border: '1px solid #f0d27a',
    background: '#fff7d6',
    color: '#8a6d1a',
    fontSize: '0.82rem',
    fontWeight: 600,
    lineHeight: 1.45,
  },
  expandingNotice: {
    margin: 0,
    color: '#8a6d1a',
    fontSize: '0.82rem',
    fontWeight: 600,
    lineHeight: 1.45,
  },
  wideBadge: {
    margin: 0,
    justifySelf: 'start',
    paddingInline: '0.55rem',
    paddingBlock: '0.15rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.16)',
    color: '#216e5d',
    fontSize: '0.74rem',
    fontWeight: 800,
  },
  categoryRow: { display: 'flex', flexWrap: 'wrap', gap: '0.45rem' },
  categoryPill: {
    border: '1px solid rgba(62, 169, 133, 0.3)',
    borderRadius: '999px',
    paddingBlock: '0.5rem',
    paddingInline: '0.9rem',
    background: '#fff',
    color: '#216e5d',
    fontWeight: 700,
    fontSize: '0.82rem',
    cursor: 'pointer',
  },
  categoryPillActive: {
    background: 'linear-gradient(120deg, #48b58f, #7adab1)',
    borderColor: 'transparent',
    color: '#072c2a',
  },
  categoryPillOn: {
    background: 'rgba(62, 169, 133, 0.18)',
    borderColor: 'rgba(62, 169, 133, 0.6)',
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
