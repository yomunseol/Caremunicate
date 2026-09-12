import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Star, MapPin, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Care Places — OpenStreetMap place finder for every signed-in user.
//
// No API keys, no env vars: the only network call is the public Nominatim
// search endpoint. Favorites persist in public.place_favorites (one row per
// user/place). Layout uses logical CSS properties throughout so the whole
// panel mirrors correctly under dir="rtl".
// ---------------------------------------------------------------------------

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const DEBOUNCE_MS = 500;
const MIN_QUERY_LENGTH = 2;
// Nominatim's usage policy: at most one request per second.
const MIN_REQUEST_INTERVAL_MS = 1000;
// Viewbox half-extents used to bias (never restrict) results around the user.
const NEAR_ME_LON_DELTA = 0.5;
const NEAR_ME_LAT_DELTA = 0.25;

// Quick filters. Clicking a chip sets the search query to its (translated) term.
const CHIP_KEYS = ['places.filterHospital', 'places.filterPharmacy', 'places.filterClinic'] as const;

type NominatimPlace = {
  place_id: number;
  osm_id: number | string;
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
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

// One normalized shape for both search results and saved favorites, so the map
// preview and "Open in OSM" link work from either source.
type PlaceView = {
  placeId: string;
  name: string;
  address: string;
  type: string;
  lat: number;
  lon: number;
};

type CarePlacesProps = {
  /** Dashboard role (profiles.role). Drives the role-aware heading. */
  role?: string;
};

const shortName = (displayName: string): string => displayName.split(',')[0]?.trim() || displayName;

const toPlaceView = (place: NominatimPlace): PlaceView => ({
  placeId: String(place.osm_id),
  name: shortName(place.display_name),
  address: place.display_name,
  type: place.type ?? '',
  lat: parseFloat(place.lat),
  lon: parseFloat(place.lon),
});

const favoriteToPlaceView = (favorite: PlaceFavorite): PlaceView => ({
  placeId: favorite.place_id,
  name: favorite.name,
  address: favorite.address ?? '',
  type: favorite.primary_type ?? '',
  lat: favorite.latitude ?? 0,
  lon: favorite.longitude ?? 0,
});

const mapEmbedSrc = (lat: number, lon: number): string =>
  `https://www.openstreetmap.org/export/embed.html?bbox=${lon - 0.008},${lat - 0.004},${
    lon + 0.008
  },${lat + 0.004}&layer=mapnik&marker=${lat},${lon}`;

const osmPageUrl = (lat: number, lon: number): string =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;

export default function CarePlaces({ role = '' }: CarePlacesProps) {
  const { user } = useAuth();
  const { locale, t } = useLang();

  // Prefer the role passed in from the dashboard; fall back to sign-up metadata.
  const effectiveRole = (role || String(user?.user_metadata?.role ?? '')).toLowerCase();
  const titleKey =
    effectiveRole === 'doctor'
      ? 'places.titleDoctor'
      : effectiveRole === 'patient'
        ? 'places.titlePatient'
        : 'places.title';

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceView[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<PlaceView | null>(null);

  const [favorites, setFavorites] = useState<PlaceFavorite[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(true);
  const [favoritesError, setFavoritesError] = useState('');
  const [savingPlaceId, setSavingPlaceId] = useState<string | null>(null);

  // "Near me" location bias.
  const [nearMe, setNearMe] = useState(false);
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState('');

  // Timestamp of the last Nominatim request, used to enforce 1 req/sec.
  const lastRequestAt = useRef(0);

  const loadFavorites = useCallback(async () => {
    if (!user) {
      setFavoritesLoading(false);
      return;
    }

    setFavoritesLoading(true);
    setFavoritesError('');

    // Newest first, always scoped to the signed-in user.
    const { data, error } = await supabase
      .from('place_favorites')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.log('PLACES ERROR:', error);
      setFavoritesError(error.message);
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

  // Debounced search with a 1 req/sec throttle. Global (no country filter), with
  // an optional viewbox bias when "Near me" has coords.
  useEffect(() => {
    const trimmed = query.trim();

    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setSearchError('');
      setSearching(false);
      setSearched(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setSearching(true);
    setSearchError('');

    const timer = setTimeout(async () => {
      // Wait out any remaining 1s window before issuing the request.
      const elapsed = Date.now() - lastRequestAt.current;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
      }
      if (cancelled) return;

      lastRequestAt.current = Date.now();

      try {
        const url = new URL(NOMINATIM_SEARCH_URL);
        url.searchParams.set('q', trimmed);
        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('limit', '8');
        url.searchParams.set('accept-language', `${locale},en`);

        // Bias (not restrict) results around the user when "Near me" is on.
        if (coords) {
          url.searchParams.set(
            'viewbox',
            `${coords.lon - NEAR_ME_LON_DELTA},${coords.lat + NEAR_ME_LAT_DELTA},${
              coords.lon + NEAR_ME_LON_DELTA
            },${coords.lat - NEAR_ME_LAT_DELTA}`,
          );
        }

        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(t('places.searchFailed', { status: response.status }));
        }

        const data = (await response.json()) as NominatimPlace[];
        if (cancelled) return;

        setResults(data.map(toPlaceView));
        setSearched(true);
      } catch (error) {
        if (cancelled || (error as Error)?.name === 'AbortError') return;
        console.log('PLACES ERROR:', error);
        setSearchError(error instanceof Error ? error.message : String(error));
        setResults([]);
        setSearched(true);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, coords, locale, t]);

  // Toggle the location bias. On success we keep the coordinates to build a
  // viewbox; on denial (or off) we search globally with no viewbox.
  const toggleNearMe = () => {
    if (nearMe) {
      setNearMe(false);
      setCoords(null);
      setLocationError('');
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocationError(t('places.locationUnavailable'));
      return;
    }

    setLocating(true);
    setLocationError('');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoords({ lat: position.coords.latitude, lon: position.coords.longitude });
        setNearMe(true);
        setLocating(false);
      },
      (error) => {
        console.log('PLACES ERROR:', error);
        setNearMe(false);
        setCoords(null);
        setLocationError(error.message || t('places.locationDenied'));
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  const isSaved = (placeId: string) => favorites.some((favorite) => favorite.place_id === placeId);

  const toggleFavorite = async (place: PlaceView) => {
    if (!user) return;

    const existing = favorites.find((favorite) => favorite.place_id === place.placeId);
    setSavingPlaceId(place.placeId);
    setFavoritesError('');

    try {
      if (existing) {
        // Unstar: delete the exact row, still scoped to this user.
        const { error } = await supabase
          .from('place_favorites')
          .delete()
          .eq('id', existing.id)
          .eq('user_id', user.id);

        if (error) throw error;
        setFavorites((previous) => previous.filter((favorite) => favorite.id !== existing.id));
      } else {
        const payload = {
          user_id: user.id,
          place_id: place.placeId,
          name: place.name,
          address: place.address,
          latitude: place.lat,
          longitude: place.lon,
          primary_type: place.type,
        };

        const { data, error } = await supabase
          .from('place_favorites')
          .upsert(payload, { onConflict: 'user_id,place_id' })
          .select()
          .single();

        if (error) throw error;
        setFavorites((previous) => [data as PlaceFavorite, ...previous]);
      }
    } catch (error) {
      console.log('PLACES ERROR:', error);
      setFavoritesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingPlaceId(null);
    }
  };

  const attribution = (
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
  );

  const renderStar = (place: PlaceView) => {
    const saved = isSaved(place.placeId);
    const busy = savingPlaceId === place.placeId;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void toggleFavorite(place);
        }}
        disabled={busy}
        aria-pressed={saved}
        aria-label={saved ? t('places.removeSaved', { name: place.name }) : t('places.save', { name: place.name })}
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
            {favorites.map((favorite) => {
              const view = favoriteToPlaceView(favorite);
              const isSelected = selected?.placeId === view.placeId;
              return (
                <li key={favorite.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(view)}
                    aria-pressed={isSelected}
                    style={{ ...styles.card, ...(isSelected ? styles.cardSelected : null) }}
                  >
                    <span style={styles.cardTop}>
                      <strong style={styles.cardName}>{view.name}</strong>
                      {renderStar(view)}
                    </span>
                    {view.address ? <span style={styles.cardAddress}>{view.address}</span> : null}
                    {view.type ? <span style={styles.typeBadge}>{view.type}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* SEARCH */}
      <div style={styles.section}>
        <div style={styles.searchRow}>
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
          <button
            type="button"
            onClick={toggleNearMe}
            aria-pressed={nearMe}
            disabled={locating}
            style={{ ...styles.nearMeButton, ...(nearMe ? styles.nearMeButtonOn : null) }}
          >
            {t('places.nearMe')}
          </button>
        </div>

        <div style={styles.filterRow}>
          {CHIP_KEYS.map((chipKey) => {
            const label = t(chipKey);
            const active = query.trim() === label;
            return (
              <button
                key={chipKey}
                type="button"
                onClick={() => {
                  // Chips drive the query; clicking the active chip clears it.
                  setQuery(active ? '' : label);
                }}
                aria-pressed={active}
                style={{ ...styles.chip, ...(active ? styles.chipActive : null) }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <p style={styles.locationHint}>{nearMe && coords ? t('places.usingLocation') : t('places.globalSearch')}</p>
        {locationError ? <p role="alert" style={styles.error}>{locationError}</p> : null}

        {searching ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}
        {!searching && searchError ? <p role="alert" style={styles.error}>{searchError}</p> : null}
        {!searching && !searchError && query.trim().length < MIN_QUERY_LENGTH ? (
          <p style={styles.muted}>{t('places.minChars', { count: MIN_QUERY_LENGTH })}</p>
        ) : null}
        {!searching && !searchError && searched && results.length === 0 ? (
          <p style={styles.muted}>{t('places.noPlaces', { query: query.trim() })}</p>
        ) : null}

        {!searching && !searchError && results.length > 0 ? (
          <>
            <ul style={styles.results}>
              {results.map((place) => {
                const isSelected = selected?.placeId === place.placeId;
                return (
                  <li key={place.placeId}>
                    <button
                      type="button"
                      onClick={() => setSelected(place)}
                      aria-pressed={isSelected}
                      style={{ ...styles.card, ...(isSelected ? styles.cardSelected : null) }}
                    >
                      <span style={styles.cardTop}>
                        <strong style={styles.cardName}>{place.name}</strong>
                        {renderStar(place)}
                      </span>
                      <span style={styles.cardAddress}>{place.address}</span>
                      {place.type ? <span style={styles.typeBadge}>{place.type}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {attribution}
          </>
        ) : null}
      </div>

      {/* MAP PREVIEW */}
      <div style={styles.section}>
        <div style={styles.sectionHeading}>
          <h4 style={styles.sectionTitle}>{t('places.mapPreview')}</h4>
          {selected ? (
            <a
              href={osmPageUrl(selected.lat, selected.lon)}
              target="_blank"
              rel="noreferrer"
              style={styles.osmLink}
            >
              {t('places.openInOsm')}
            </a>
          ) : null}
        </div>

        {selected ? (
          <>
            <p style={styles.selectedName}>
              <MapPin size={14} aria-hidden="true" /> {selected.name}
            </p>
            <iframe
              title={t('places.mapOf', { name: selected.name })}
              src={mapEmbedSrc(selected.lat, selected.lon)}
              style={styles.map}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
            {attribution}
          </>
        ) : (
          <div style={styles.mapPlaceholder}>
            <MapPin size={22} aria-hidden="true" />
            <span>{t('places.mapPlaceholder')}</span>
          </div>
        )}
      </div>
    </section>
  );
}

// All spacing/positioning below uses logical properties (inline-start/end,
// paddingInline, marginInline, insetInline) so the panel mirrors under RTL with
// no [dir='rtl'] overrides.
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
  // Icon pinned to the inline start so it flips to the right side under RTL.
  searchIcon: { position: 'absolute', insetInlineStart: 12, color: '#557b76' },
  input: {
    width: '100%',
    border: '1px solid rgba(15, 58, 50, 0.12)',
    borderRadius: '999px',
    // Start padding leaves room for the icon; end padding is the visual gutter.
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
  results: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: '0.5rem',
  },
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
  cardTop: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '0.5rem',
  },
  cardName: { fontSize: '0.92rem', lineHeight: 1.35, overflowWrap: 'anywhere' },
  cardAddress: { color: '#557b76', fontSize: '0.78rem', lineHeight: 1.45, overflowWrap: 'anywhere' },
  typeBadge: {
    alignSelf: 'flex-start',
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
  osmLink: { color: '#216e5d', fontSize: '0.8rem', fontWeight: 700, textDecoration: 'none' },
  selectedName: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    margin: 0,
    color: '#133b35',
    fontSize: '0.84rem',
    fontWeight: 600,
  },
  map: {
    width: '100%',
    height: 260,
    border: '1px solid rgba(15, 58, 50, 0.12)',
    borderRadius: '0.9rem',
    background: '#fff',
  },
  mapPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    height: 160,
    padding: '1rem',
    textAlign: 'center',
    borderRadius: '0.9rem',
    border: '1px dashed rgba(62, 169, 133, 0.4)',
    background: 'linear-gradient(135deg, rgba(62, 169, 133, 0.1), rgba(138, 219, 176, 0.16))',
    color: '#216e5d',
    fontSize: '0.85rem',
    fontWeight: 600,
  },
  attribution: { margin: 0, color: '#557b76', fontSize: '0.72rem', textAlign: 'end' },
  attributionLink: { color: '#216e5d', textDecoration: 'underline' },
};
