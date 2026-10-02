import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Heart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useRole } from '../context/RoleContext';
import { useToast } from '../context/ToastContext';
import { isProvider, roleLabelKey } from '../lib/roles';
import { resolveDisplayName } from '../lib/displayName';
import { describeError } from '../lib/errors';
import { useLang } from '../i18n';
import {
  addDoctorFavorite,
  listDoctors,
  listFavoriteDoctorIds,
  removeDoctorFavorite,
  type DoctorEntry,
} from '../lib/doctors';
import VerificationBadge from './VerificationBadge';

// ---------------------------------------------------------------------------
// Doctor directory — the public list of doctors on the network.
//
// The heart toggles public.doctor_favorites for the signed-in patient. The
// state flips OPTIMISTICALLY (never waiting on the round-trip) and rolls back
// with a toast if the write fails, so the icon is instant and honest.
//
// "My favourites" is a client-side filter over the loaded directory — a
// favourite can only be created from a row in this list, so the intersection
// is complete.
// ---------------------------------------------------------------------------

type Tab = 'all' | 'favorites';

export default function DoctorList() {
  const { user } = useAuth();
  const { notify } = useToast();
  const { t, tString } = useLang();

  const { role, provider } = useRole();
  // Favourites are a patient concept; providers see the directory with no tabs.
  const isPatient = !provider;

  const [doctors, setDoctors] = useState<DoctorEntry[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadDoctors = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      setDoctors(await listDoctors());
    } catch (error) {
      console.error('DOCTORS_ERROR:', error);
      setLoadError(`${t('doctors.loadError')} (${describeError(error)})`);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadDoctors();
  }, [loadDoctors]);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setFavoriteIds(new Set());
      return;
    }

    void (async () => {
      try {
        const ids = await listFavoriteDoctorIds(user.id);
        if (!cancelled) setFavoriteIds(new Set(ids));
      } catch (error) {
        // Favourites being unavailable must not take the directory down.
        console.log('DOCTORS_ERROR:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const toggleFavorite = async (doctorId: string) => {
    if (!user || busyId !== null) return;

    const wasFavorite = favoriteIds.has(doctorId);
    console.log('DOCTOR FAVORITE:', { doctorId, wasFavorite });

    setBusyId(doctorId);
    // Optimistic: flip now, reconcile only on failure.
    setFavoriteIds((previous) => {
      const next = new Set(previous);
      if (wasFavorite) next.delete(doctorId);
      else next.add(doctorId);
      return next;
    });

    try {
      if (wasFavorite) await removeDoctorFavorite(user.id, doctorId);
      else await addDoctorFavorite(user.id, doctorId);
    } catch (error) {
      console.error('DOCTORS_ERROR:', error);
      // Roll back to the pre-click state.
      setFavoriteIds((previous) => {
        const next = new Set(previous);
        if (wasFavorite) next.add(doctorId);
        else next.delete(doctorId);
        return next;
      });
      notify(`${t('doctors.favoriteError')} (${describeError(error)})`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const visibleDoctors = useMemo(
    () => (tab === 'favorites' ? doctors.filter((doctor) => favoriteIds.has(doctor.user_id)) : doctors),
    [tab, doctors, favoriteIds],
  );

  const renderHeart = (doctorId: string) => {
    const active = favoriteIds.has(doctorId);
    return (
      <button
        type="button"
        onClick={() => void toggleFavorite(doctorId)}
        disabled={busyId !== null}
        aria-pressed={active}
        aria-label={active ? tString('doctors.removeSaved') : tString('doctors.save')}
        title={active ? t('doctors.removeSaved') : t('doctors.save')}
        style={{ ...styles.heart, ...(active ? styles.heartActive : null) }}
      >
        <Heart size={18} fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
    );
  };

  const renderCard = (doctor: DoctorEntry) => {
    const name = resolveDisplayName(doctor.username, doctor.email, t('chat.participant'));
    const specialty = (doctor.specialty ?? '').trim();
    const clinic = (doctor.clinic ?? '').trim();

    return (
      <li key={doctor.user_id} style={styles.card}>
        <span style={styles.avatar} aria-hidden="true">{name.charAt(0).toUpperCase()}</span>

        <div style={styles.copy}>
          <div style={styles.nameRow}>
            <strong style={styles.name}>{name}</strong>
            {doctor.verification_status === 'verified' ? (
              <VerificationBadge status="verified" />
            ) : null}
          </div>
          {specialty ? <span style={styles.specialty}>{specialty}</span> : null}
          {clinic ? (
            <span style={styles.sub}>{clinic}</span>
          ) : specialty ? null : (
            <span style={styles.sub}>{t(roleLabelKey(doctor.role))}</span>
          )}
        </div>

        {renderHeart(doctor.user_id)}
      </li>
    );
  };

  return (
    <section className="section" style={styles.page}>
      <div>
        <p style={styles.eyebrow}>{t('doctors.eyebrow')}</p>
        <h2 style={styles.title}>{t('doctors.title')}</h2>
        <p style={styles.description}>{t('doctors.description')}</p>
      </div>

      {isPatient ? (
        <div style={styles.tabs} role="tablist" aria-label={t('doctors.title')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'all'}
            style={{ ...styles.tab, ...(tab === 'all' ? styles.tabActive : null) }}
            onClick={() => setTab('all')}
          >
            {t('doctors.tabAll')}
            <span style={styles.countPill}>{doctors.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'favorites'}
            style={{ ...styles.tab, ...(tab === 'favorites' ? styles.tabActive : null) }}
            onClick={() => setTab('favorites')}
          >
            {t('doctors.tabFavorites')}
            <span style={styles.countPill}>{favoriteIds.size}</span>
          </button>
        </div>
      ) : null}

      {loading ? <p style={styles.muted} aria-busy="true">{t('doctors.loading')}</p> : null}
      {!loading && loadError ? <p role="alert" style={styles.error}>{loadError}</p> : null}

      {!loading && !loadError && visibleDoctors.length === 0 ? (
        <p style={styles.muted}>
          {tab === 'favorites' ? t('doctors.favoritesEmpty') : t('doctors.empty')}
        </p>
      ) : null}

      {!loading && !loadError && visibleDoctors.length > 0 ? (
        <ul style={styles.list}>{visibleDoctors.map(renderCard)}</ul>
      ) : null}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { display: 'grid', gap: '1rem' },
  eyebrow: {
    margin: 0,
    color: '#3ea985',
    fontSize: '0.7rem',
    fontWeight: 800,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
  },
  title: { margin: '0.2rem 0 0', fontSize: '1.35rem' },
  description: { marginBlock: '0.4rem 0', marginInline: 0, color: '#557b76', fontSize: '0.88rem', lineHeight: 1.6 },
  muted: { margin: 0, color: '#557b76', fontSize: '0.86rem', lineHeight: 1.6 },
  error: { margin: 0, color: '#9c3636', fontSize: '0.84rem', fontWeight: 600, lineHeight: 1.5 },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.45rem',
    paddingBlock: '0.55rem',
    paddingInline: '0.9rem',
    border: '1px solid rgba(15, 58, 50, 0.14)',
    borderRadius: '999px',
    background: '#fff',
    fontFamily: 'inherit',
    fontSize: '0.86rem',
    fontWeight: 700,
    color: '#133b35',
    cursor: 'pointer',
  },
  tabActive: {
    borderColor: 'rgba(62, 169, 133, 0.6)',
    background: 'rgba(62, 169, 133, 0.14)',
    color: '#216e5d',
  },
  countPill: {
    paddingBlock: '0.05rem',
    paddingInline: '0.45rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.16)',
    color: '#216e5d',
    fontSize: '0.72rem',
    fontWeight: 800,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
    gap: '0.6rem',
  },
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.7rem',
    paddingBlock: '0.8rem',
    paddingInline: '0.9rem',
    border: '1px solid rgba(15, 58, 50, 0.1)',
    borderRadius: '1rem',
    background: '#fff',
    boxShadow: '0 8px 20px rgba(17, 55, 47, 0.05)',
  },
  avatar: {
    display: 'grid',
    placeItems: 'center',
    width: '2.5rem',
    height: '2.5rem',
    flexShrink: 0,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3ea985, #8adbb0)',
    color: '#fff',
    fontWeight: 800,
  },
  copy: { display: 'grid', gap: '0.15rem', minWidth: 0, marginInlineEnd: 'auto' },
  nameRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' },
  name: { fontSize: '0.95rem', color: '#133b35', overflowWrap: 'anywhere' },
  specialty: {
    justifySelf: 'start',
    paddingBlock: '0.1rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.14)',
    color: '#216e5d',
    fontSize: '0.72rem',
    fontWeight: 700,
  },
  sub: { color: '#557b76', fontSize: '0.78rem', lineHeight: 1.4, overflowWrap: 'anywhere' },
  heart: {
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 38,
    height: 38,
    borderRadius: '50%',
    border: '1px solid rgba(62, 169, 133, 0.25)',
    background: '#fff',
    color: '#557b76',
    cursor: 'pointer',
    transition: 'color 120ms ease, background 120ms ease, transform 120ms ease',
  },
  heartActive: { background: 'rgba(62, 169, 133, 0.16)', color: '#3ea985' },
};
