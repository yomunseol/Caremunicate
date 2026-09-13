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
import 'leaflet/dist/leaflet.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Care Places — keyless, credit-card-free map stack.
//
//   Search : Overpass API (https://overpass-api.de/api/interpreter) — POST only,
//            no key, no quota account, OSM data.
//   Tiles  : OpenStreetMap raster tiles — free forever, no key.
//   Routing: Google Maps directions links — free, keyless, opens in a new tab.
//
// Nominatim is gone; Overpass is proximity-based, so a location is required
// before a query can run (the `around:` filter needs a centre point).
// ---------------------------------------------------------------------------

// Overpass is public and keyless. The canonical instance throttles heavy traffic,
// and throttled/failed replies can come back without the CORS header — which the
// browser then reports as a CORS error. Fall back to a verified keyless mirror
// instead of putting a third-party proxy (or an API key) in the path.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const NEAR_RADIUS_M = 5000;
const DEFAULT_CENTER: [number, number] = [30, 0];
const DEFAULT_ZOOM = 2;
const FOCUS_ZOOM = 15;
const AMENITIES = ['hospital', 'clinic', 'pharmacy'] as const;
type Amenity = (typeof AMENITIES)[number];

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

const AMENITY_KEYS: Record<string, string> = {
  hospital: 'places.filterHospital',
  pharmacy: 'places.filterPharmacy',
  clinic: 'places.filterClinic',
};

/** Exact Overpass QL: every medical facility within 5 km, globally. */
const buildOverpassQuery = (lat: number, lon: number, amenities: readonly string[]): string => {
  const filter = amenities.length > 0 ? amenities.join('|') : AMENITIES.join('|');
  return `[out:json][timeout:25];
(
  node['amenity'~'${filter}'](around:${NEAR_RADIUS_M},${lat},${lon});
  way['amenity'~'${filter}'](around:${NEAR_RADIUS_M},${lat},${lon});
);
out center;`;
};

/**
 * POSTs the query to each keyless Overpass endpoint until one answers.
 * `application/x-www-form-urlencoded` is CORS-safelisted, so this stays a simple
 * request (no preflight). Throws the last failure so the caller can show one
 * user-facing message while the technical detail stays in the console.
 */
const postOverpass = async (
  query: string,
  signal: AbortSignal,
): Promise<{ elements?: OverpassElement[] }> => {
  let lastError: unknown = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });

      if (!response.ok) {
        throw new Error(`${endpoint} responded ${response.status}`);
      }

      return (await response.json()) as { elements?: OverpassElement[] };
    } catch (caught) {
      // A real abort (unmount / superseded request) must not fall through.
      if ((caught as Error)?.name === 'AbortError') throw caught;
      console.log('PLACES ERROR:', endpoint, caught);
      lastError = caught;
    }
  }

  throw lastError ?? new Error('No Overpass endpoint reachable.');
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
  const { t } = useLang();

  const effectiveRole = (role || String(user?.user_metadata?.role ?? '')).toLowerCase();
  const titleKey =
    effectiveRole === 'doctor'
      ? 'places.titleDoctor'
      : effectiveRole === 'patient'
        ? 'places.titlePatient'
        : 'places.title';

  const [query, setQuery] = useState('');
  const [amenities, setAmenities] = useState<Amenity[]>([...AMENITIES]);
  const [results, setResults] = useState<PlaceView[]>([]);
  const [center, setCenter] = useState<LatLon | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState('');

  const [favorites, setFavorites] = useState<PlaceFavorite[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(true);
  const [favoritesError, setFavoritesError] = useState('');
  const [savingPlaceId, setSavingPlaceId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const placeName = useCallback(
    (place: PlaceView) => place.name || t(AMENITY_KEYS[place.amenity] ?? 'places.eyebrow'),
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

  // ---- Overpass search ----------------------------------------------------
  const runSearch = useCallback(
    async (at: LatLon, amenityFilter: readonly string[]) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError('');

      try {
        const payload = await postOverpass(
          buildOverpassQuery(at.lat, at.lon, amenityFilter),
          controller.signal,
        );

        const places = (payload.elements ?? [])
          .map(elementToPlace)
          .filter((place): place is PlaceView => place !== null);

        setResults(places);
        setSelectedId(null);
      } catch (caught) {
        if ((caught as Error)?.name === 'AbortError') return;
        console.log('PLACES ERROR:', caught);
        // Friendly copy for the user; the cause is already in the console.
        setError(t('places.loadFailed'));
        setResults([]);
      } finally {
        if (abortRef.current === controller) setLoading(false);
      }
    },
    [t],
  );

  // Abort any in-flight Overpass request on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const applyAmenities = (next: Amenity[]) => {
    setAmenities(next);
    if (center && next.length > 0) void runSearch(center, next);
  };

  const toggleAmenity = (amenity: Amenity) => {
    const next = amenities.includes(amenity)
      ? amenities.filter((item) => item !== amenity)
      : [...amenities, amenity];
    applyAmenities(next);
  };

  const requestLocation = (onSuccess?: (at: LatLon) => void) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationError(t('places.locationUnavailable'));
      return;
    }

    setLocating(true);
    setLocationError('');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const at = { lat: position.coords.latitude, lon: position.coords.longitude };
        setCenter(at);
        setLocating(false);
        onSuccess?.(at);
      },
      (geoError) => {
        console.log('PLACES ERROR:', geoError);
        setLocationError(geoError.message || t('places.locationDenied'));
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Overpass is proximity-based: make sure we have a centre, then query.
    if (center) {
      void runSearch(center, amenities);
    } else {
      requestLocation((at) => void runSearch(at, amenities));
    }
  };

  // Typed text narrows the already-loaded set client-side (no extra requests).
  const visibleResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return results;
    return results.filter(
      (place) =>
        place.name.toLowerCase().includes(needle) ||
        place.amenity.toLowerCase().includes(needle) ||
        place.address.toLowerCase().includes(needle),
    );
  }, [results, query]);

  const focusLatLng = useMemo<{ lat: number | null; lon: number | null; focusKey: string | null }>(() => {
    const selected = results.find((place) => place.placeId === selectedId);
    if (selected) return { lat: selected.lat, lon: selected.lon, focusKey: selected.placeId };
    if (center) return { lat: center.lat, lon: center.lon, focusKey: 'me' };
    return { lat: null, lon: null, focusKey: null };
  }, [results, selectedId, center]);

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
        aria-label={saved ? t('places.removeSaved', { name }) : t('places.save', { name })}
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
            {place.amenity ? (
              <span style={styles.typeBadge}>
                {t(AMENITY_KEYS[place.amenity] ?? 'places.eyebrow')}
              </span>
            ) : null}
            <a
              href={directionsUrl(place)}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              style={styles.directionsLink}
            >
              {t('places.directions')}
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
      <div style={styles.section}>
        <div style={styles.sectionHeading}>
          <h4 style={styles.sectionTitle}>{t('places.savedPlaces')}</h4>
          {!favoritesLoading && !favoritesError ? (
            <span style={styles.countPill}>{favorites.length}</span>
          ) : null}
        </div>

        {favoritesLoading ? (
          <p style={styles.muted} aria-busy="true">{t('places.loadingSaved')}</p>
        ) : favoritesError ? (
          <p role="alert" style={styles.error}>{favoritesError}</p>
        ) : favorites.length === 0 ? (
          <p style={styles.muted}>{t('places.noSaved')}</p>
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
                      aria-label={t('places.removeSaved', { name: favorite.name })}
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
                    {t('places.directions')}
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
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('places.searchPlaceholder')}
              aria-label={t('places.searchAria')}
              autoComplete="off"
              style={styles.input}
            />
          </div>
          <button type="submit" disabled={loading} style={styles.nearMeButton}>
            {loading ? t('places.searching') : t('places.searchAria')}
          </button>
          <button
            type="button"
            onClick={() => requestLocation((at) => void runSearch(at, amenities))}
            disabled={locating}
            aria-pressed={center !== null}
            style={{ ...styles.nearMeButton, ...(center ? styles.nearMeButtonOn : null) }}
          >
            {t('places.nearMe')}
          </button>
        </form>

        <div style={styles.filterRow}>
          {AMENITIES.map((amenity) => {
            const active = amenities.includes(amenity);
            return (
              <button
                key={amenity}
                type="button"
                onClick={() => toggleAmenity(amenity)}
                aria-pressed={active}
                style={{ ...styles.chip, ...(active ? styles.chipActive : null) }}
              >
                {t(AMENITY_KEYS[amenity])}
              </button>
            );
          })}
        </div>

        <p style={styles.locationHint}>
          {center ? t('places.usingLocation') : t('places.needLocation')}
        </p>
        {locationError ? <p role="alert" style={styles.error}>{locationError}</p> : null}

        {loading ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}
        {!loading && error ? <p role="alert" style={styles.error}>{error}</p> : null}
        {!loading && !error && results.length > 0 && visibleResults.length === 0 ? (
          <p style={styles.muted}>{t('places.noPlaces', { query: query.trim() })}</p>
        ) : null}

        {!loading && !error && visibleResults.length > 0 ? (
          <>
            <ul style={styles.results}>{visibleResults.map((place) => renderPlaceCard(place, place.placeId))}</ul>
            <p style={styles.attribution}>
              ©{' '}
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noreferrer"
                style={styles.attributionLink}
              >
                OpenStreetMap contributors
              </a>
            </p>
          </>
        ) : null}
      </div>

      {/* MAP — OpenStreetMap raster tiles, no key, no quota. */}
      <div style={styles.section}>
        <div style={styles.sectionHeading}>
          <h4 style={styles.sectionTitle}>{t('places.mapPreview')}</h4>
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
              attribution="© OpenStreetMap contributors"
            />
            {center ? (
              <Marker position={[center.lat, center.lon]}>
                <Popup>{t('places.usingLocation')}</Popup>
              </Marker>
            ) : null}
            {visibleResults.map((place) => (
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
                    {t('places.directions')}
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
          ©{' '}
          <a
            href="https://www.openstreetmap.org/copyright"
            target="_blank"
            rel="noreferrer"
            style={styles.attributionLink}
          >
            OpenStreetMap contributors
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
  filterRow: { display: 'flex', flexWrap: 'wrap', gap: '0.4rem' },
  chip: {
    border: '1px solid rgba(62, 169, 133, 0.28)',
    borderRadius: '999px',
    paddingBlock: '0.35rem',
    paddingInline: '0.8rem',
    background: 'transparent',
    color: '#216e5d',
    fontWeight: 700,
    fontSize: '0.78rem',
    cursor: 'pointer',
  },
  chipActive: {
    background: 'rgba(62, 169, 133, 0.16)',
    borderColor: 'rgba(62, 169, 133, 0.5)',
    color: '#133b35',
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
    justifyContent: 'space-between',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  typeBadge: {
    paddingBlock: '0.15rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.14)',
    color: '#216e5d',
    fontSize: '0.68rem',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
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
  mapWrap: { width: '100%' },
  mapCanvas: { width: '100%', height: 320, borderRadius: '0.9rem', background: '#fff' },
  attribution: { margin: 0, color: '#557b76', fontSize: '0.72rem', textAlign: 'end' },
  attributionLink: { color: '#216e5d', textDecoration: 'underline' },
};
