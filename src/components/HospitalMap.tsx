import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import { MapContainer, Marker, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet';
import { LocateFixed, MapPin, Plus, Search, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRole } from '../context/RoleContext';
import { isProvider } from '../lib/roles';
import { describeError } from '../lib/errors';
import { useLang } from '../i18n';
import {
  SEARCH_TIMEOUT_MS,
  listHospitals,
  searchNearbyHospitals,
  type Hospital,
  type LatLon,
  type NearbyPlace,
} from '../lib/hospitals';

// ---------------------------------------------------------------------------
// Hospitals — the community OpenStreetMap view.
//
//   Tiles  : OpenStreetMap raster tiles, no key.
//   Pins   : a custom MINT DivIcon (never Leaflet's default blue marker).
//   Search : typed name → client-side Photon with a 3s abort.
//   Add    : providers only; click the map or pick a search result, name it,
//            then insert into public.hospitals with the current user as author.
// ---------------------------------------------------------------------------

const MINT = '#52b788';
const MINT_DARK = '#216e5d';
const DEFAULT_CENTER: [number, number] = [37.5665, 126.978];
const DEFAULT_ZOOM = 10;
const FOCUS_ZOOM = 14;
/** The modal's pick map opens on a city-level view, not the country view. */
const PICK_DEFAULT_ZOOM = 12;
/** Nearby search fallback when geolocation is unavailable or denied. */
const FALLBACK_AT: LatLon = { lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1] };
const RADIUS_OPTIONS = [1_000, 5_000, 10_000, 25_000, 50_000] as const;

/** The pin: a mint teardrop with a white disc and a mint medical cross. */
const pinSvg = (fill: string): string => `
<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
  <path d="M15 1C7.3 1 1 7.3 1 15c0 10.5 14 26 14 26s14-15.5 14-26C29 7.3 22.7 1 15 1z"
        fill="${fill}" stroke="#ffffff" stroke-width="2"/>
  <circle cx="15" cy="15" r="6" fill="#ffffff"/>
  <path d="M15 11.5v7M11.5 15h7" stroke="${fill}" stroke-width="2" stroke-linecap="round"/>
</svg>`;

// className is the custom one (not Leaflet's default) so no white box is drawn.
const hospitalIcon = L.divIcon({
  className: 'cm-hospital-pin',
  html: pinSvg(MINT),
  iconSize: [30, 42],
  iconAnchor: [15, 42],
  popupAnchor: [0, -38],
});
const draftIcon = L.divIcon({
  className: 'cm-hospital-pin',
  html: pinSvg(MINT_DARK),
  iconSize: [30, 42],
  iconAnchor: [15, 42],
  popupAnchor: [0, -38],
});

/** Pans the map to the newest focus target (a search pick, a geolocation). */
function MapFocus({ target }: { target: { lat: number; lon: number; key: string } | null }) {
  const map = useMap();
  const applied = useRef<string | null>(null);

  // Tiles render mis-aligned if the container was measured before layout settled.
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize(), 0);
    return () => window.clearTimeout(id);
  }, [map]);

  useEffect(() => {
    if (!target || applied.current === target.key) return;
    applied.current = target.key;
    map.flyTo([target.lat, target.lon], Math.max(map.getZoom(), FOCUS_ZOOM), { duration: 0.6 });
  }, [map, target]);

  return null;
}

/** The pick map inside the dialog: re-measure after the portal lays out, and
 *  follow the selected point so a picked result is actually on screen. */
function PickMapFocus({ target }: { target: LatLon | null }) {
  const map = useMap();
  const applied = useRef<string | null>(null);

  // A portaled dialog measures late — invalidate on the next frame AND shortly
  // after, so the tiles are never stretched from a zero-size container.
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => map.invalidateSize());
    const id = window.setTimeout(() => map.invalidateSize(), 180);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(id);
    };
  }, [map]);

  useEffect(() => {
    if (!target) return;
    const key = `${target.lat},${target.lon}`;
    if (applied.current === key) return;
    applied.current = key;
    map.flyTo([target.lat, target.lon], Math.max(map.getZoom(), PICK_DEFAULT_ZOOM), { duration: 0.5 });
  }, [map, target]);

  return null;
}

/** Click-to-drop-pin, used inside the add modal's map. */
function PickOnMap({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click(event) {
      onPick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

export default function HospitalMap() {
  const { user } = useAuth();
  const { t } = useLang();

  // Adding a hospital is a provider action (doctor / department / hospital).
  const { provider } = useRole();

  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<LatLon | null>(null);
  const [osmId, setOsmId] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  const [draftError, setDraftError] = useState('');

  const [results, setResults] = useState<NearbyPlace[]>([]);
  const [visibleCount, setVisibleCount] = useState(8);
  const [selectedRadius, setSelectedRadius] = useState(10_000);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [center, setCenter] = useState<LatLon | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState('');

  const [focus, setFocus] = useState<{ lat: number; lon: number; key: string } | null>(null);
  /** Page-level filter: narrows the list AND the pins by hospital name. */
  const [nameQuery, setNameQuery] = useState('');

  const needle = nameQuery.trim().toLowerCase();
  const visible = needle
    ? hospitals.filter((hospital) => hospital.name.toLowerCase().includes(needle))
    : hospitals;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setHospitals(await listHospitals());
    } catch (error) {
      console.error('HOSPITAL_ERROR:', error);
      setLoadError(`${t('hospital.loadError')} (${describeError(error)})`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const requestLocation = (
    onSuccess?: (at: LatLon) => void,
    onFailure?: () => void,
  ) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoError(t('places.locationUnavailable'));
      onFailure?.();
      return;
    }

    setLocating(true);
    setGeoError('');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const at = { lat: position.coords.latitude, lon: position.coords.longitude };
        setCenter(at);
        setLocating(false);
        onSuccess?.(at);
      },
      (error) => {
        console.log('HOSPITAL_ERROR:', error);
        setGeoError(error.message || t('places.locationDenied'));
        setLocating(false);
        onFailure?.();
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  const abortRef = useRef<AbortController | null>(null);
  const openedSearchRef = useRef(false);

  const runNearby = useCallback(
    async (at: LatLon, radius = selectedRadius) => {
      // Supersede any in-flight request so only the newest one settles state.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, SEARCH_TIMEOUT_MS);

      setSearching(true);
      setSearchError('');
      setSearched(false);
      setResults([]);
      setVisibleCount(8);

      try {
        const places = await searchNearbyHospitals(at, radius, controller.signal);
        if (abortRef.current !== controller) return;
        setResults(places);
        setSearched(true);
      } catch (error) {
        if (abortRef.current !== controller) return;
        if ((error as Error)?.name === 'AbortError') {
          if (timedOut) setSearchError(t('places.searchUnavailable'));
        } else {
          const status = (error as Error & { status?: number }).status;
          if (status === 408) {
            console.error('HOSPITAL_ERROR:', error);
            setSearchError(t('hospitals.area_too_dense'));
            setResults([]);
            return;
          }
          console.error('HOSPITAL_ERROR:', error);
          // Friendly copy; the raw status stays in the console.
          setSearchError(t('places.searchUnavailable'));
          setResults([]);
        }
      } finally {
        window.clearTimeout(timeoutId);
        if (abortRef.current === controller) setSearching(false);
      }
    },
    [t, selectedRadius],
  );

  const handleRadiusChange = (radius: number) => {
    setSelectedRadius(radius);
    setVisibleCount(8);
    if (center) {
      void runNearby(center, radius);
      return;
    }
    requestLocation(
      (at) => {
        void runNearby(at, radius);
      },
      () => {
        void runNearby(FALLBACK_AT, radius);
      },
    );
  };

  const searchNearby = () => {
    if (center) {
      void runNearby(center);
      return;
    }
    requestLocation(
      (at) => {
        void runNearby(at);
      },
      () => {
        void runNearby(FALLBACK_AT);
      },
    );
  };

  const retrySearch = () => {
    if (center) void runNearby(center);
    else searchNearby();
  };

  // Auto-load nearby facilities once when the modal opens. The browser may ask
  // for location permission; "Use my location" and "Search Nearby" are the
  // explicit fallbacks if it is denied.
  useEffect(() => {
    if (!formOpen) {
      openedSearchRef.current = false;
      return;
    }
    if (openedSearchRef.current) return;
    openedSearchRef.current = true;
    if (center) {
      void runNearby(center);
      return;
    }
    requestLocation(
      (at) => {
        void runNearby(at);
      },
      () => {
        void runNearby(FALLBACK_AT);
      },
    );
    // requestLocation is intentionally not a dependency: it is a stable event
    // handler and including it would restart the effect on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formOpen, center, runNearby]);

  // Abort any in-flight search on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const pickResult = (place: NearbyPlace) => {
    setDraft({ lat: place.lat, lon: place.lon });
    setOsmId(place.id != null ? String(place.id) : null);
    setDraftError('');
    if (!name.trim()) setName(place.name);
    setFocus({ lat: place.lat, lon: place.lon, key: `${place.lat},${place.lon}` });
    setResults([]);
    setSearched(false);
  };

  const dropPin = (lat: number, lon: number) => {
    setDraft({ lat, lon });
    // A hand-placed pin is not tied to an OSM element.
    setOsmId(null);
    setDraftError('');
  };

  const closeForm = () => {
    setFormOpen(false);
    setName('');
    setDraft(null);
    setOsmId(null);
    setResults([]);
    setSearched(false);
    setSearchError('');
    setNameError('');
    setDraftError('');
    setVisibleCount(8);
    abortRef.current?.abort();
  };

  const handleSave = () => {
    const trimmed = name.trim();
    const nextNameError = trimmed ? '' : t('hospital.nameRequired');
    const nextDraftError = draft ? '' : t('hospital.locationRequired');
    setNameError(nextNameError);
    setDraftError(nextDraftError);
    if (nextNameError || nextDraftError || !draft) return;

    // UI-only run: no Supabase insert. Persistence is wired manually later.
    console.log('HOSPITAL_SAVE_PAYLOAD:', {
      name: trimmed,
      latitude: draft.lat,
      longitude: draft.lon,
      osm_id: osmId,
    });
    closeForm();
  };

  const modal =
    formOpen &&
    createPortal(
      <div className="cal-modal-backdrop" role="presentation" onClick={closeForm}>
        <div
          className="cal-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t('hospital.formTitle')}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="cal-modal-head">
            <h3 className="cal-modal-title">{t('hospital.formTitle')}</h3>
            <button
              type="button"
              className="ghost-button"
              aria-label={t('common.close')}
              onClick={closeForm}
              style={styles.closeButton}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <div style={styles.field}>
            <div style={styles.searchRow}>
              <button
                type="button"
                className="ghost-button"
                onClick={searchNearby}
                disabled={searching || locating}
                style={styles.searchButton}
              >
                <Search size={15} aria-hidden="true" />
                {searching ? t('places.searching') : t('hospitals.search_nearby')}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  requestLocation(
                    (at) => {
                      void runNearby(at);
                    },
                    () => {
                      void runNearby(FALLBACK_AT);
                    },
                  )
                }
                disabled={locating}
                aria-pressed={center !== null}
                style={styles.searchButton}
              >
                <LocateFixed size={15} aria-hidden="true" />
                {t('hospitals.use_my_location')}
              </button>
            </div>
            {geoError ? <p role="alert" style={styles.error}>{geoError}</p> : null}
            {searchError ? (
              <p role="alert" style={styles.error}>
                {searchError}{' '}
                <button type="button" className="text-action" onClick={retrySearch}>
                  {t('common.retry')}
                </button>
              </p>
            ) : null}
            {!searching && !searchError && searched && results.length === 0 ? (
              <p style={styles.muted}>{t('hospital.noResultsHint')}</p>
            ) : null}
            {results.length > 0 ? (
              <>
                <p style={styles.hint}>{t('hospitals.select_result')}</p>
                <ul style={styles.results}>
                  {results.slice(0, visibleCount).map((place) => {
                    const active = draft?.lat === place.lat && draft?.lon === place.lon;
                    return (
                      <li key={place.id ?? `${place.lat},${place.lon}`}>
                        <button
                          type="button"
                          style={{
                            ...styles.resultRow,
                            ...(active ? styles.resultRowActive : null),
                          }}
                          onClick={() => pickResult(place)}
                        >
                          <MapPin size={15} aria-hidden="true" />
                          <span style={styles.resultCopy}>
                            <span>{place.name}</span>
                            {place.type ? <small style={styles.resultAddress}>{place.type}</small> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {visibleCount < results.length ? (
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() =>
                      setVisibleCount((prev) => Math.min(prev + 8, results.length))
                    }
                    style={styles.loadMore}
                  >
                    {t('hospitals.load_more')}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>

          <div style={styles.field}>
            <label htmlFor="hospital-name" style={styles.label}>{t('hospital.nameLabel')}</label>
            <input
              id="hospital-name"
              className="input"
              value={name}
              placeholder={t('hospital.namePlaceholder')}
              aria-invalid={Boolean(nameError)}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) setNameError('');
              }}
            />
            {nameError ? <span className="field-error">{nameError}</span> : null}
          </div>

          <div style={styles.field}>
            <div dir="ltr" style={styles.pickMapWrap}>
              <MapContainer
                center={draft ? [draft.lat, draft.lon] : DEFAULT_CENTER}
                zoom={draft ? FOCUS_ZOOM : PICK_DEFAULT_ZOOM}
                scrollWheelZoom
                style={styles.pickMapCanvas}
              >
                <TileLayer
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  attribution={t('places.attribution')}
                />
                {draft ? <Marker position={[draft.lat, draft.lon]} icon={draftIcon} /> : null}
                <PickMapFocus target={draft} />
                <PickOnMap onPick={dropPin} />
                <MapFocus target={focus} />
              </MapContainer>
            </div>
            <p style={styles.hint}>{t('hospitals.click_map')}</p>
            <p style={styles.muted}>
              <strong>{t('hospital.selectedLocation')}: </strong>
              {draft ? (
                <bdi dir="ltr">{`${draft.lat.toFixed(5)}, ${draft.lon.toFixed(5)}`}</bdi>
              ) : (
                t('hospital.noLocation')
              )}
            </p>
            {draftError ? <p role="alert" style={styles.error}>{draftError}</p> : null}
          </div>

          <div className="cal-modal-footer">
            <button type="button" className="ghost-button" onClick={closeForm}>
              {t('common.cancel')}
            </button>
            <button type="button" className="primary-button" onClick={handleSave}>
              {t('hospitals.save')}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );

  return (
    <section className="section" style={styles.page}>
      <div>
        <p style={styles.eyebrow}>{t('hospital.eyebrow')}</p>
        <h2 style={styles.title}>{t('hospitals.title')}</h2>
        <p style={styles.description}>{t('hospital.description')}</p>
      </div>

      <div style={styles.toolbar}>
        <input
          className="input"
          style={styles.search}
          value={nameQuery}
          placeholder={t('hospital.search')}
          aria-label={t('hospital.search')}
          onChange={(event) => setNameQuery(event.target.value)}
        />
        <select
          className="input"
          value={selectedRadius}
          onChange={(event) => handleRadiusChange(Number(event.target.value))}
          disabled={searching}
          aria-label={t('hospitals.radius_selector')}
          style={styles.radiusInline}
        >
          {RADIUS_OPTIONS.map((radius) => (
            <option key={radius} value={radius}>
              {t(`hospitals.radius_${radius / 1000}km`)}
            </option>
          ))}
        </select>
        {loading ? (
          <span style={styles.muted} aria-busy="true">{t('hospital.loading')}</span>
        ) : (
          <span style={styles.count}>
            {t('hospital.title')}: <strong>{hospitals.length}</strong>
          </span>
        )}
        {provider ? (
          <button type="button" className="primary-button" onClick={() => setFormOpen(true)}>
            <Plus size={15} aria-hidden="true" /> {t('hospitals.add_button')}
          </button>
        ) : null}
      </div>

      {loadError ? <p role="alert" style={styles.error}>{loadError}</p> : null}

      {/* Leaflet's panes/controls are physically positioned, so keep the map LTR
          and isolate it so its z-index cannot escape above the app chrome. */}
      <div dir="ltr" style={styles.mapWrap}>
        <MapContainer center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM} scrollWheelZoom style={styles.mapCanvas}>
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution={t('places.attribution')}
          />
          {visible.map((hospital) => (
            <Marker
              key={hospital.id}
              position={[hospital.latitude, hospital.longitude]}
              icon={hospitalIcon}
            >
              <Popup>
                <strong>{hospital.name}</strong>
                {user && hospital.added_by === user.id ? (
                  <>
                    <br />
                    {t('hospital.youAdded')}
                  </>
                ) : null}
              </Popup>
            </Marker>
          ))}
          <MapFocus target={focus} />
        </MapContainer>
      </div>

      {!loading && !loadError && hospitals.length === 0 ? (
        <p style={styles.muted}>{t('hospitals.no_hospitals')}</p>
      ) : null}

      {/* Filtered to nothing: say so rather than show a blank list. */}
      {!loading && !loadError && hospitals.length > 0 && visible.length === 0 ? (
        <p style={styles.muted}>{t('hospital.noMatch')}</p>
      ) : null}

      {hospitals.length > 0 ? (
        <ul style={styles.list}>
          {visible.map((hospital) => (
            <li key={hospital.id} style={styles.card}>
              <MapPin size={16} aria-hidden="true" style={styles.cardIcon} />
              <div style={styles.cardCopy}>
                <strong style={styles.cardName}>{hospital.name}</strong>
                <bdi dir="ltr" style={styles.cardCoords}>
                  {`${hospital.latitude.toFixed(5)}, ${hospital.longitude.toFixed(5)}`}
                </bdi>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {modal}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { display: 'grid', gap: '1rem' },
  eyebrow: {
    margin: 0,
    color: MINT,
    fontSize: '0.7rem',
    fontWeight: 800,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },
  title: { margin: '0.2rem 0 0', fontSize: '1.35rem' },
  description: { marginBlock: '0.4rem 0', marginInline: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.88rem', lineHeight: 1.6 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.75rem',
    flexWrap: 'wrap',
  },
  count: { color: 'var(--accent-strong, #216e5d)', fontSize: '0.86rem' },
  muted: { margin: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.84rem', lineHeight: 1.5 },
  error: { margin: 0, color: '#9c3636', fontSize: '0.84rem', fontWeight: 600, lineHeight: 1.5 },
  mapWrap: { position: 'relative', isolation: 'isolate', overflow: 'hidden', width: '100%' },
  search: { maxWidth: '22rem' },
  mapCanvas: { width: '100%', height: 500, borderRadius: '1rem', background: '#fff' },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
    gap: '0.6rem',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.6rem',
    paddingBlock: '0.7rem',
    paddingInline: '0.85rem',
    border: '1px solid rgba(15, 58, 50, 0.1)',
    borderRadius: '0.9rem',
    background: '#fff',
  },
  cardIcon: { color: MINT, flexShrink: 0 },
  cardCopy: { display: 'grid', gap: '0.1rem', minWidth: 0 },
  cardName: { fontSize: '0.9rem', color: 'var(--text, #133b35)', overflowWrap: 'anywhere' },
  cardCoords: { color: 'var(--text-muted, #557b76)', fontSize: '0.74rem' },
  closeButton: { padding: '0.35rem', lineHeight: 0 },
  field: { display: 'grid', gap: '0.4rem' },
  label: { fontSize: '0.78rem', fontWeight: 700, color: 'var(--accent-strong, #216e5d)' },
  searchRow: { display: 'flex', alignItems: 'stretch', gap: '0.5rem', flexWrap: 'wrap' },
  searchButton: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 },
  results: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: '0.4rem',
    maxHeight: 168,
    overflowY: 'auto',
  },
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    paddingBlock: '0.55rem',
    paddingInline: '0.7rem',
    border: '1px solid rgba(15, 58, 50, 0.12)',
    borderRadius: '0.7rem',
    background: '#fff',
    fontFamily: 'inherit',
    fontSize: '0.84rem',
    textAlign: 'start',
    color: 'var(--text, #133b35)',
    cursor: 'pointer',
  },
  resultRowActive: {
    borderColor: 'rgba(82, 183, 136, 0.65)',
    boxShadow: '0 0 0 2px rgba(82, 183, 136, 0.2)',
    background: 'rgba(82, 183, 136, 0.08)',
  },
  resultCopy: { display: 'grid', gap: '0.1rem', minWidth: 0, textAlign: 'start' },
  resultAddress: { color: 'var(--text-muted, #557b76)', fontSize: '0.74rem', lineHeight: 1.3, overflowWrap: 'anywhere' },
  loadMore: { justifySelf: 'center', marginBlockStart: '0.35rem', fontSize: '0.8rem' },
  radiusInline: {
    width: '7.5rem',
    maxWidth: '7.5rem',
    flex: '0 0 auto',
    borderRadius: '999px',
    paddingInline: '0.9rem',
  },
  pickMapWrap: { position: 'relative', isolation: 'isolate', overflow: 'hidden', width: '100%' },
  pickMapCanvas: { width: '100%', height: 300, borderRadius: '0.8rem', background: '#fff' },
  hint: { margin: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.76rem', fontStyle: 'italic' },
};
