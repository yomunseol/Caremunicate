import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Calendar, CheckCircle2, MessageCircle, ShieldCheck, Video, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { isProvider, roleLabelKey } from '../lib/roles';
import { useLang } from '../i18n';
import { useCallContext } from '../context/CallContext';
import VerificationBadge from './VerificationBadge';
import EmergencyAlertBanner from './EmergencyAlertBanner';
import EmergencyCard from './EmergencyCard';

// ---------------------------------------------------------------------------
// Dashboard overview — the left column of the profile dashboard.
//
// Everything below is backed by real tables (profiles, conversations,
// conversation_participants, messages, place_favorites). There is no notes,
// certification or assigned-doctor schema in this project, so those cards are
// derived from what actually exists rather than faked — see the comments on
// each section.
// ---------------------------------------------------------------------------

type Peer = {
  conversationId: string;
  userId: string;
  role: string;
  name: string;
};

type Overview = {
  conversationIds: string[];
  peers: Peer[];
  messagesToday: number;
  favoriteCount: number;
  hasProfile: boolean;
  verificationStatus: string;
  isAdmin: boolean;
};

const EMPTY_OVERVIEW: Overview = {
  conversationIds: [],
  peers: [],
  messagesToday: 0,
  favoriteCount: 0,
  hasProfile: false,
  verificationStatus: 'unverified',
  isAdmin: false,
};

const startOfToday = (): string => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
};

type DashboardOverviewProps = {
  /** Persisted profiles.role (falls back to sign-up metadata). */
  role?: string;
};

export default function DashboardOverview({ role = '' }: DashboardOverviewProps) {
  const { user } = useAuth();
  const { t } = useLang();

  const effectiveRole = (role || String(user?.user_metadata?.role ?? '')).toLowerCase();
  // Provider-side cards cover doctor, department and hospital accounts.
  const provider = isProvider(effectiveRole);
  const displayName = String(user?.user_metadata?.fullName ?? user?.email ?? '');

  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [loading, setLoading] = useState(true);
  const { startCall } = useCallContext();

  const load = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      // 1) The conversations I am part of.
      const { data: mine, error: mineError } = await supabase
        .from('conversation_participants')
        .select('conversation_id')
        .eq('user_id', user.id);

      if (mineError) throw mineError;

      const conversationIds = [...new Set((mine ?? []).map((row) => row.conversation_id as string))];

      // 2) Profile row (drives the onboarding step) — a missing row is normal.
      const { data: profileRow, error: profileError } = await supabase
        .from('profiles')
        .select('user_id, verification_status, is_admin')
        .eq('user_id', user.id)
        .maybeSingle();

      if (profileError) throw profileError;

      const selfRow = profileRow as
        | { user_id: string; verification_status?: string | null; is_admin?: boolean | null }
        | null;

      // 3) Saved places count.
      const { data: favorites, error: favoritesError } = await supabase
        .from('place_favorites')
        .select('id')
        .eq('user_id', user.id);

      if (favoritesError) throw favoritesError;

      if (conversationIds.length === 0) {
        setOverview({
          conversationIds,
          peers: [],
          messagesToday: 0,
          favoriteCount: (favorites ?? []).length,
          hasProfile: Boolean(profileRow),
          verificationStatus: String(selfRow?.verification_status ?? 'unverified'),
          isAdmin: Boolean(selfRow?.is_admin),
        });
        return;
      }

      // 4) Everyone else in those conversations.
      const { data: others, error: othersError } = await supabase
        .from('conversation_participants')
        .select('conversation_id, user_id, role')
        .in('conversation_id', conversationIds)
        .neq('user_id', user.id);

      if (othersError) throw othersError;

      const peerRows = (others ?? []) as Array<{
        conversation_id: string;
        user_id: string;
        role: string;
      }>;

      // 5) Their display names.
      const peerIds = [...new Set(peerRows.map((row) => row.user_id))];
      const names = new Map<string, string>();
      if (peerIds.length > 0) {
        const { data: profiles, error: peersError } = await supabase
          .from('profiles')
          .select('user_id, username, email')
          .in('user_id', peerIds);

        if (peersError) throw peersError;

        for (const row of (profiles ?? []) as Array<{
          user_id: string;
          username: string | null;
          email: string | null;
        }>) {
          names.set(row.user_id, row.username?.trim() || row.email?.split('@')[0] || '');
        }
      }

      const peers: Peer[] = peerRows.map((row) => ({
        conversationId: row.conversation_id,
        userId: row.user_id,
        role: row.role,
        name: names.get(row.user_id) || t('chat.participant'),
      }));

      // 6) Messages received today across my conversations.
      const { data: today, error: todayError } = await supabase
        .from('messages')
        .select('id, sender_id')
        .in('conversation_id', conversationIds)
        .gte('created_at', startOfToday());

      if (todayError) throw todayError;

      const messagesToday = ((today ?? []) as Array<{ sender_id: string }>).filter(
        (row) => row.sender_id !== user.id,
      ).length;

      setOverview({
        conversationIds,
        peers,
        messagesToday,
        favoriteCount: (favorites ?? []).length,
        hasProfile: Boolean(profileRow),
        verificationStatus: String(selfRow?.verification_status ?? 'unverified'),
        isAdmin: Boolean(selfRow?.is_admin),
      });
    } catch (error) {
      // Degrade to zeros rather than blocking the dashboard.
      console.error('DASHBOARD_ERROR:', error);
      setOverview(EMPTY_OVERVIEW);
    } finally {
      setLoading(false);
    }
  }, [user, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // "Care team" is derived: providers I already have an open conversation with.
  const careTeam = useMemo(() => {
    const byRole = (role: string) => overview.peers.filter((peer) => peer.role === role);
    return [...byRole('doctor'), ...byRole('department'), ...byRole('hospital')][0] ?? null;
  }, [overview.peers]);

  // "Active patients" = distinct patients I share a conversation with. There is
  // no roster table.
  const activePatients = useMemo(
    () => new Set(overview.peers.filter((peer) => peer.role === 'patient').map((peer) => peer.userId)).size,
    [overview.peers],
  );

  const onboarding = [
    { key: 'stepProfile', done: overview.hasProfile },
    { key: 'stepEmail', done: Boolean(user?.email_confirmed_at) },
    { key: 'stepFavorite', done: overview.favoriteCount > 0 },
    { key: 'stepChat', done: overview.conversationIds.length > 0 },
  ];
  const doneCount = onboarding.filter((step) => step.done).length;

  const focusCarePlaces = () => {
    document.getElementById('care-places-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const openChat = (peer?: Peer) => {
    // FloatingChatWidget listens for this and opens the widget (and thread).
    window.dispatchEvent(
      new CustomEvent('caremunicate:open-chat', {
        detail: peer
          ? { conversationId: peer.conversationId, peerName: peer.name, peerRole: peer.role }
          : null,
      }),
    );
  };

  const startVideo = (peerId?: string) => {
    if (peerId) void startCall(peerId, 'video');
  };

  return (
    <div className="dashboard-main">
      <div className="profile-card">
        <div className="eyebrow">{t('profile.eyebrow')}</div>
        <h2>{t('profile.welcome', { name: displayName })}</h2>
        <p className="hero-copy">{t('profile.copy', { role: t(roleLabelKey(effectiveRole)) })}</p>
      </div>

      {/* ------------------------------- PATIENT ------------------------------ */}
      {!provider ? (
        <>
          <div className="panel">
            <div className="eyebrow">{t('dash.careTeamTitle')}</div>
            {careTeam ? (
              <div style={styles.teamRow}>
                <span style={styles.avatar} aria-hidden="true">
                  {careTeam.name.charAt(0).toUpperCase()}
                </span>
                <div style={styles.teamCopy}>
                  <strong>{careTeam.name}</strong>
                  <span style={styles.roleBadge}>{t(roleLabelKey(careTeam.role))}</span>
                </div>
                <div style={styles.teamActions}>
                  <button type="button" className="ghost-button" onClick={() => openChat(careTeam)}>
                    <MessageCircle size={15} aria-hidden="true" /> {t('dash.message')}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => startVideo(careTeam.userId)}
                  >
                    <Video size={15} aria-hidden="true" /> {t('dash.videoCall')}
                  </button>
                </div>
              </div>
            ) : (
              <p style={styles.muted}>{t('dash.careTeamEmpty')}</p>
            )}
          </div>

          <EmergencyCard />

          <div className="panel">
            <div className="eyebrow">{t('dash.quickActions')}</div>
            <div style={styles.actionGrid}>
              <button type="button" className="ghost-button" onClick={() => openChat()}>
                <MessageCircle size={15} aria-hidden="true" /> {t('chat.newChat')}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => startVideo(careTeam?.userId)}
                disabled={!careTeam}
              >
                <Video size={15} aria-hidden="true" /> {t('dash.videoCall')}
              </button>
              <button type="button" className="ghost-button" onClick={focusCarePlaces}>
                <ShieldCheck size={15} aria-hidden="true" /> {t('dash.findCare')}
              </button>
              <button type="button" className="ghost-button" onClick={focusCarePlaces}>
                <CheckCircle2 size={15} aria-hidden="true" /> {t('places.favorites')}
              </button>
            </div>
          </div>

          <div className="panel">
            <div style={styles.progressHead}>
              <span className="eyebrow" style={{ margin: 0 }}>{t('dash.onboarding')}</span>
              <span style={styles.progressLabel}>
                {t('dash.progress', { done: doneCount, total: onboarding.length })}
              </span>
            </div>
            <div style={styles.progressTrack} aria-hidden="true">
              <span style={{ ...styles.progressFill, width: `${(doneCount / onboarding.length) * 100}%` }} />
            </div>
            <ul style={styles.checklist}>
              {onboarding.map((step) => (
                <li key={step.key} style={styles.checkRow}>
                  <CheckCircle2
                    size={16}
                    aria-hidden="true"
                    style={{ color: step.done ? '#216e5d' : '#b9cdc7', flexShrink: 0 }}
                  />
                  <span style={step.done ? styles.checkDone : styles.checkTodo}>{t(`dash.${step.key}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : (
        /* -------------------------------- DOCTOR ------------------------------ */
        <>
          <EmergencyAlertBanner />

          <div className="panel">
            <div className="eyebrow">{t('dash.todaysStats')}</div>
            <div style={styles.statGrid}>
              <div style={styles.statTile}>
                <strong style={styles.statValue}>{activePatients}</strong>
                <span style={styles.statLabel}>{t('dash.activePatients')}</span>
              </div>
              <div style={styles.statTile}>
                <strong style={styles.statValue}>{overview.messagesToday}</strong>
                <span style={styles.statLabel}>{t('dash.messagesToday')}</span>
              </div>
              <div style={styles.statTile}>
                <strong style={styles.statValue}>{overview.conversationIds.length}</strong>
                <span style={styles.statLabel}>{t('dash.conversations')}</span>
              </div>
            </div>
            {loading ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}
          </div>

          <div className="panel">
            <div className="eyebrow">{t('dash.videoTitle')}</div>
            <button
              type="button"
              className="primary-button"
              style={{ width: '100%' }}
              onClick={() => startVideo(overview.peers[0]?.userId)}
              disabled={overview.peers.length === 0}
            >
              <Video size={16} aria-hidden="true" /> {t('dash.startVideoConsult')}
            </button>
            <p style={styles.hint}>{t('dash.videoHint')}</p>
          </div>

          <div className="panel">
            <div className="eyebrow">{t('dash.certificationTitle')}</div>
            {/* Driven solely by profiles.verification_status — never by email
                confirmation or profile completeness. */}
            <div style={styles.badgeRow}>
              <VerificationBadge status={overview.verificationStatus} ownerView />
            </div>
            {overview.isAdmin ? (
              <p style={styles.hint}>{t('verify.reviewQueue')}</p>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  muted: { margin: 0, color: '#557b76', fontSize: '0.86rem', lineHeight: 1.6 },
  hint: { margin: '0.6rem 0 0', color: '#557b76', fontSize: '0.76rem', lineHeight: 1.5 },
  teamRow: { display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' },
  avatar: {
    display: 'grid',
    placeItems: 'center',
    width: '2.6rem',
    height: '2.6rem',
    flexShrink: 0,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3ea985, #8adbb0)',
    color: '#fff',
    fontWeight: 800,
  },
  teamCopy: { display: 'grid', gap: '0.15rem', marginInlineEnd: 'auto' },
  roleBadge: {
    justifySelf: 'start',
    paddingBlock: '0.1rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.14)',
    color: '#216e5d',
    fontSize: '0.68rem',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  teamActions: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap' },
  actionGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.5rem' },
  progressHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  progressLabel: { color: '#216e5d', fontSize: '0.74rem', fontWeight: 700 },
  progressTrack: {
    height: '0.4rem',
    marginBlock: '0.7rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.16)',
    overflow: 'hidden',
  },
  progressFill: { display: 'block', height: '100%', borderRadius: 'inherit', background: 'linear-gradient(120deg, #48b58f, #7adab1)' },
  checklist: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.45rem' },
  checkRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.84rem' },
  checkDone: { color: '#557b76', textDecoration: 'line-through' },
  checkTodo: { color: '#133b35', fontWeight: 600 },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.5rem' },
  statTile: {
    display: 'grid',
    gap: '0.15rem',
    paddingBlock: '0.7rem',
    paddingInline: '0.6rem',
    borderRadius: '0.85rem',
    background: 'rgba(255, 255, 255, 0.7)',
    border: '1px solid rgba(15, 58, 50, 0.1)',
    textAlign: 'center',
  },
  statValue: { fontSize: '1.35rem', color: '#216e5d' },
  statLabel: { color: '#557b76', fontSize: '0.68rem', fontWeight: 700, lineHeight: 1.3 },
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  statusBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    paddingBlock: '0.45rem',
    paddingInline: '0.75rem',
    borderRadius: '999px',
    fontSize: '0.78rem',
    fontWeight: 800,
  },
  statusOk: { background: 'rgba(62, 169, 133, 0.16)', color: '#216e5d' },
  statusPending: { background: 'rgba(240, 210, 122, 0.28)', color: '#8a6d1a' },
  modalBackdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 80,
    display: 'grid',
    placeItems: 'center',
    padding: '1rem',
    background: 'rgba(6, 26, 22, 0.55)',
  },
  modal: {
    width: 'min(52rem, 100%)',
    padding: '1rem',
    borderRadius: '1.15rem',
    background: '#f7fdf9',
    border: '1px solid rgba(62, 169, 133, 0.25)',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.35)',
  },
  modalHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' },
  modalClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(15, 58, 50, 0.08)',
    color: '#216e5d',
    cursor: 'pointer',
  },
  videoFrame: {
    width: '100%',
    height: 'min(60vh, 30rem)',
    marginTop: '0.7rem',
    border: '1px solid rgba(15, 58, 50, 0.12)',
    borderRadius: '0.9rem',
    background: '#000',
  },
};
