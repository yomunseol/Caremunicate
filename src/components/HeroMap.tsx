import { useEffect } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Decorative map behind the landing hero.
//
// Purely visual: every Leaflet interaction is disabled and the `.hero-map`
// wrapper is pointer-events:none (see globals.css), so it can never be panned
// or zoomed. OSM attribution stays visible per the tile terms. The gradient
// scrim (`.hero-scrim`) sits above it and the hero copy above that.
// ---------------------------------------------------------------------------

const HERO_CENTER: [number, number] = [37.5665, 126.978];
const HERO_ZOOM = 12;

/** Tiles render misaligned if the container was measured before layout settled. */
function InvalidateOnMount() {
  const map = useMap();
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => map.invalidateSize());
    const id = window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(id);
    };
  }, [map]);
  return null;
}

export default function HeroMap() {
  const { t } = useLang();
  return (
    <div className="hero-map">
      <MapContainer
        center={HERO_CENTER}
        zoom={HERO_ZOOM}
        zoomControl={false}
        dragging={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution={t('places.attribution')}
        />
        <InvalidateOnMount />
      </MapContainer>
    </div>
  );
}
