import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Hand,
  LayoutGrid,
  Link2,
  Mic,
  MicOff,
  MonitorUp,
  MoreVertical,
  Phone,
  PhoneOff,
  Settings,
  Smile,
  Users,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useActiveSpeaker } from '../hooks/useActiveSpeaker';
import type { PeerConnState } from '../hooks/useCall';
import { looksLikeUuid, resolveRoom } from '../lib/callRooms';
import { playHandChime, playJoinChime, playLeaveChime } from '../lib/chime';
import { roleLabelKey } from '../lib/roles';
import { useLang } from '../i18n';
import CallPreJoin from './CallPreJoin';
import CallParticipantsPanel from './CallParticipantsPanel';
import CallInviteDrawer from './CallInviteDrawer';
import CallOverflowMenu from './CallOverflowMenu';
import ShortcutsOverlay from './ShortcutsOverlay';

// ---------------------------------------------------------------------------
// CallLayer — the one and only call surface.
//
// IA (Meet-style):
//   top bar    : code chip (click to copy) + timer · people chip + gear
//   stage      : equal grid (gallery) or main tile + filmstrip (speaker)
//   bottom bar : single centered pill — [mic cam share] [reactions hand]
//                [people ⋮] — plus a separated red leave pill
//   overflow ⋮ : view toggle, fullscreen, device settings, call stats and the
//                host-only controls (waiting room, lock, password, removal)
//
// Behaviour is unchanged from before the restyle: portaled to document.body at
// z-index 3000, body scroll lock, one state machine driven by the call store,
// 3s auto-hide, Alt+M/V/S + F shortcuts, policy enforcement, stats polling.
// ---------------------------------------------------------------------------

const LAYER_Z_INDEX = 3000;
const CONTROLS_IDLE_MS = 3000;
const REACTION_EMOJI = ['👍', '❤️', '👏'];

/** A single video tile. Remote video is never mirrored; only our own is. */
function Tile({
  stream,
  muted = false,
  mirrored = false,
  name,
  micOn,
  camOn,
  sharing,
  hand,
  connection,
  speaking,
  pinned,
  videoSilent = false,
  role = '',
  verified = false,
  sinkId = null,
  onDoubleClick,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirrored?: boolean;
  name: string;
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  hand: boolean;
  connection: PeerConnState | 'connected';
  speaking: boolean;
  pinned: boolean;
  videoSilent?: boolean;
  /** profiles.role — rendered as a small badge when known. */
  role?: string;
  /** Only ever true when verification_status === 'verified'. */
  verified?: boolean;
  /** Chosen audio output; applied where setSinkId is supported. */
  sinkId?: string | null;
  onDoubleClick?: () => void;
}) {
  const { t, tString } = useLang();
  const initials = (name || '?').trim().charAt(0).toUpperCase();

  return (
    <div
      className={`call-tile${speaking ? ' is-speaking' : ''}${pinned ? ' is-pinned' : ''}`}
      style={styles.tile}
      onDoubleClick={onDoubleClick}
    >
      {/* object-contain on black: letterbox, never crop. Attached through a ref
          callback so the stream binds the moment the element mounts. */}
      <video
        ref={(el) => {
          if (!el) return;
          if (stream && el.srcObject !== stream) {
            el.srcObject = stream;
            void el.play().catch(() => {});
          }
          // Route audio to the chosen output where the browser allows it.
          const sinkable = el as HTMLVideoElement & {
            setSinkId?: (id: string) => Promise<void>;
          };
          if (sinkId && typeof sinkable.setSinkId === 'function') {
            void sinkable.setSinkId(sinkId).catch(() => {});
          }
        }}
        autoPlay
        playsInline
        muted={muted}
        style={{
          ...styles.video,
          ...(mirrored ? styles.videoMirrored : null),
          // While sharing, the element carries the display track even if the
          // camera itself is off.
          opacity: camOn || sharing ? 1 : 0,
        }}
      />

      {/* Zero inbound frames only means trouble when video was expected. */}
      {videoSilent && camOn && !sharing ? (
        <span style={styles.silentBadge}>Video unavailable — audio only</span>
      ) : null}

      {!camOn && !sharing ? (
        <span className="call-avatar" style={styles.avatar} aria-hidden="true">
          {initials}
        </span>
      ) : null}

      <span className="call-name" style={styles.nameChip}>
        {name}
        {/* Role badge, then the mint certified badge — only ever lit by an
            explicit verified flag from the peer's profile row. */}
        {role ? (
          <span className="call-role-badge" style={styles.roleBadge}>
            {t(roleLabelKey(role))}
          </span>
        ) : null}
        {verified ? (
          <span className="call-verified-badge" style={styles.verifiedBadge} title="Verified">
            ✓
          </span>
        ) : null}
      </span>

      <span style={styles.tileFlags}>
        {hand ? <Hand size={14} aria-label="hand" /> : null}
        {sharing ? <span style={styles.shareBadge}>Sharing</span> : null}
        {!micOn ? <MicOff size={14} aria-label="muted" /> : null}
      </span>

      <span
        style={{
          ...styles.connDot,
          background:
            connection === 'connected'
              ? 'var(--accent, #3ea985)'
              : connection === 'failed'
                ? '#e0655a'
                : '#d8a13a',
        }}
        aria-hidden="true"
      />
    </div>
  );
}

/** m:ss since the call first went active. */
function useElapsed(connectedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (connectedAt === null) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [connectedAt]);

  if (connectedAt === null) return '';
  const total = Math.max(0, Math.floor((now - connectedAt) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function CallLayer() {
  const { t, tString } = useLang();
  const {
    status,
    kind,
    roomCode,
    personal,
    isHost,
    peerName,
    connectedAt,
    incoming,
    peers,
    peerInfo,
    peerStats,
    codeRoom,
    policy,
    sounds,
    sinkId,
    localStream,
    shareStream,
    audioOnly,
    muted,
    cameraOff,
    sharing,
    handRaised,
    reactions,
    quality,
    notice,
    stats,
    showStats,
    toggleStats,
    stage,
    lobby,
    participants,
    acceptCall,
    declineCall,
    endCall,
    endForAll,
    toggleMic,
    toggleCamera,
    toggleHand,
    sendReaction,
    startShare,
    stopShare,
    admitGuest,
    denyGuest,
    notify,
    setLocalSpeaking,
    clearNotice,
  } = useCallContext();

  const emergency = kind === 'emergency';
  const incomingPhase = status === 'incoming' && Boolean(incoming);
  const inSession =
    status === 'outgoing' ||
    status === 'connecting' ||
    status === 'active' ||
    status === 'reconnecting';
  const visible = incomingPhase || inSession || stage === 'prejoin' || stage === 'lobby' || Boolean(notice);

  // ---- local UI state (presentation only) ---------------------------------
  const [view, setView] = useState<'gallery' | 'speaker'>('gallery');
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  /** Set only if a UUID is caught in the chip slot and the code is recovered. */
  const [recoveredCode, setRecoveredCode] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Transient join/leave/hand toast, translated at the call site. */
  const [liveToast, setLiveToast] = useState<{ id: number; text: string } | null>(null);
  /** Screen-reader announcements (join / leave / mute), aria-live polite. */
  const [announcement, setAnnouncement] = useState('');
  /** Who was in the call last render, so we can tell joins from leaves. */
  const peerSnapshot = useRef(new Map<string, { name: string; hand: boolean }>());

  const duration = useElapsed(connectedAt);
  const activeSpeakerId = useActiveSpeaker(localStream, peers, inSession);

  // The chip shows WORDS. The transport key (a UUID) is deliberately NOT part
  // of this chain — it must never be rendered.
  const rawChip = roomCode ?? '';

  // Dev guard: a UUID in the chip slot means the wrong identifier reached the
  // UI. Shout, then recover the public code from the row by id.
  useEffect(() => {
    if (!rawChip || !looksLikeUuid(rawChip)) {
      setRecoveredCode('');
      return;
    }

    console.error('CODE LEAK: UUID rendered in UI');

    let cancelled = false;
    void (async () => {
      const resolution = await resolveRoom(rawChip);
      if (!cancelled && resolution.code && !looksLikeUuid(resolution.code)) {
        setRecoveredCode(resolution.code);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rawChip]);

  const codeChip = looksLikeUuid(rawChip) ? recoveredCode : rawChip;

  // Policy enforcement: the host can forbid screen sharing for the room.
  const shareAllowed = !policy || policy.allow_share;

  // Report our own voice activity so the spotlight guard can spare us.
  useEffect(() => {
    setLocalSpeaking(activeSpeakerId === 'me');
  }, [activeSpeakerId, setLocalSpeaking]);

  // Keep the room code in the URL so a refresh or a shared link still works.
  useEffect(() => {
    if (!codeRoom || !codeChip) return;
    // A path-style invite (/call/<words>) is already canonical.
    if (window.location.pathname.endsWith(`/call/${codeChip}`)) return;
    const wanted = `#call/${codeChip}`;
    if (window.location.hash !== wanted) {
      window.history.replaceState({}, '', `${window.location.pathname}${wanted}`);
    }
  }, [codeRoom, codeChip]);

  // ---- scroll lock ---------------------------------------------------------
  const locksScroll = incomingPhase || inSession || stage === 'prejoin' || stage === 'lobby';
  useEffect(() => {
    if (!locksScroll) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [locksScroll]);

  // ---- auto-hide (top bar + control bar together) --------------------------
  const hideTimer = useRef<number | null>(null);

  const pokeControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_IDLE_MS);
  }, []);

  useEffect(() => {
    if (!inSession) {
      setControlsVisible(true);
      return;
    }
    pokeControls();
    const onMove = () => pokeControls();
    const onKey = () => pokeControls();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('keydown', onKey);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [inSession, pokeControls]);

  // An open menu keeps both bars pinned.
  const showControls =
    controlsVisible || participantsOpen || statsOpen || overflowOpen || reactionsOpen || !inSession;

  // ---- fullscreen ----------------------------------------------------------
  const toggleFullscreen = useCallback(() => {
    if (typeof document === 'undefined') return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    if (!inSession) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      const key = event.key.toLowerCase();
      if (event.altKey && key === 'm') {
        event.preventDefault();
        toggleMic();
      } else if (event.altKey && key === 'v') {
        event.preventDefault();
        toggleCamera();
      } else if (event.altKey && key === 's') {
        event.preventDefault();
        // Respect the room policy: no share while the host has it disabled.
        if (sharing || shareAllowed) void (sharing ? stopShare() : startShare());
      } else if (!event.altKey && key === 'f') {
        event.preventDefault();
        toggleFullscreen();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inSession, sharing, shareAllowed, stopShare, startShare, toggleCamera, toggleFullscreen, toggleMic]);

  // ---- notices -------------------------------------------------------------
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(clearNotice, 6000);
    return () => window.clearTimeout(id);
  }, [notice, clearNotice]);

  // A live toast is purely local: it carries an already-translated string so it
  // can say "Ada joined" rather than a fixed key.
  useEffect(() => {
    if (!liveToast) return;
    const id = window.setTimeout(() => setLiveToast(null), 4000);
    return () => window.clearTimeout(id);
  }, [liveToast]);

  // Join / leave / hand-raise cues: a WebAudio chime plus a toast, diffed
  // against the previous peer snapshot so each event fires exactly once.
  useEffect(() => {
    const previous = peerSnapshot.current;
    const current = new Map<string, { name: string; hand: boolean }>();

    for (const peer of peers) {
      current.set(peer.id, {
        name: peerInfo[peer.id]?.name || t('chat.participant'),
        hand: peerInfo[peer.id]?.hand === true,
      });
    }

    const joined = [...current].find(([id]) => !previous.has(id));
    const left = [...previous].find(([id]) => !current.has(id));
    const raised = [...current].find(([id, info]) => info.hand && !previous.get(id)?.hand);

    // The toast itself carries role="status", so it IS the announcement —
    // announcing twice would double-speak every event.
    if (joined) {
      if (sounds) playJoinChime();
      setLiveToast({ id: Date.now(), text: tString('call.personJoined', { name: joined[1].name }) });
    } else if (left) {
      if (sounds) playLeaveChime();
      setLiveToast({ id: Date.now(), text: tString('call.personLeft', { name: left[1].name }) });
    } else if (raised) {
      if (sounds) playHandChime();
      setLiveToast({ id: Date.now(), text: t('call.raiseHand') });
    }

    peerSnapshot.current = current;
  }, [peers, peerInfo, sounds, t]);

  // Announce our own mute state for screen readers.
  useEffect(() => {
    setAnnouncement(muted ? 'Microphone muted' : 'Microphone on');
  }, [muted]);

  // "?" opens the shortcuts overlay; Escape closes whatever is open.
  useEffect(() => {
    if (!inSession) return;

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen(true);
      } else if (event.key === 'Escape') {
        setShortcutsOpen(false);
        setInviteOpen(false);
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inSession]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => notify('copied')).catch(() => {});
  };

  // The public link addresses the room by its WORDS, and by path rather than
  // hash so it reads like a normal invite URL.
  const shareUrl =
    typeof window === 'undefined' || !codeChip
      ? ''
      : `${window.location.origin}/call/${codeChip}`;

  const title = useMemo(() => {
    if (emergency) return t('call.emergencyActive');
    if (codeChip) return codeChip;
    if (peerName) return peerName;
    return status === 'reconnecting' ? t('call.reconnecting') : t('call.connecting');
  }, [emergency, codeChip, peerName, status, t]);

  // ---- layout --------------------------------------------------------------
  const remoteIds = peers.map((peer) => peer.id);
  const speakingId = activeSpeakerId === 'me' ? null : activeSpeakerId;
  const focusedId = pinnedId ?? speakingId ?? remoteIds[0] ?? null;
  const filmstripIds = view === 'speaker' ? remoteIds.filter((id) => id !== focusedId) : remoteIds;

  // cols = ceil(sqrt(n)) for the equal gallery grid.
  const galleryColumns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, remoteIds.length))));

  const infoFor = (id: string) => peerInfo[id];

  if (!visible || typeof document === 'undefined') return null;

  const noticeText =
    notice === 'copied'
      ? t('call.copied')
      : notice === 'room-ended'
        ? t('call.roomEnded')
        : notice === 'room-not-found'
          ? t('call.roomNotFound')
          : notice === 'meeting-locked'
            ? t('call.meetingLocked')
            : notice === 'meeting-full'
              ? t('call.meetingFull')
              : notice === 'kicked'
                ? 'You were removed from the meeting.'
                : notice === 'line-closed'
                  ? t('call.lineClosed')
                  : notice === 'continue-in-chat'
                  ? t('chat.messages')
                  : t('call.ended');

  const selfTileProps = {
    stream: sharing ? shareStream : localStream,
    muted: true,
    mirrored: !sharing,
    name: participants[0]?.name ?? '',
    micOn: !muted,
    camOn: !cameraOff,
    sharing,
    hand: handRaised,
    connection: 'connected' as const,
    speaking: activeSpeakerId === 'me',
    pinned: false,
  };

  const layer = (
    <div
      className="call-layer"
      style={styles.layer}
      data-call-phase={stage !== 'idle' ? stage : incomingPhase ? 'incoming' : inSession ? status : 'ended'}
    >
      {stage === 'prejoin' ? <CallPreJoin /> : null}

      {stage === 'lobby' ? (
        <div style={styles.backdrop}>
          <div style={styles.modal}>
            <strong style={styles.modalTitle}>{t('call.waitingForHost')}</strong>
            <div style={styles.modalActions}>
              <button type="button" className="ghost-button" onClick={endCall}>
                {t('call.leave')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {incomingPhase ? (
        <div
          style={styles.backdrop}
          role="dialog"
          aria-modal="true"
          aria-label={emergency ? t('call.emergencyActive') : t('call.incoming')}
        >
          <div style={styles.modal}>
            <strong style={styles.modalTitle}>{emergency ? t('call.emergencyActive') : t('call.incoming')}</strong>
            {/* Never fall back to the caller's user id — it is a UUID. */}
            <p style={styles.modalBody}>{incoming?.name || t('chat.participant')}</p>
            <div style={styles.modalActions}>
              <button type="button" style={styles.accept} onClick={() => void acceptCall()}>
                <Phone size={16} aria-hidden="true" /> {t('call.accept')}
              </button>
              <button type="button" className="ghost-button" onClick={declineCall}>
                <PhoneOff size={16} aria-hidden="true" /> {t('call.decline')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {inSession ? (
        <div
          style={{ ...styles.stageShell, ...(emergency ? styles.stageShellEmergency : null) }}
          role="dialog"
          aria-modal="true"
          aria-label={emergency ? t('call.emergencyActive') : t('call.connecting')}
        >
          {/* ---- minimal top bar ---- */}
          <header className="call-topbar" style={{ ...styles.topBar, opacity: showControls ? 1 : 0 }}>
            <div style={styles.topLeft}>
              {!emergency && codeChip ? (
                <button
                  type="button"
                  className="call-code-chip"
                  style={styles.codeChip}
                  dir="ltr"
                  // Tooltip carries the FULL code; the chip itself truncates.
                  title={codeChip}
                  aria-label={`${t('call.copyCode')} — ${codeChip}`}
                  onClick={() => copy(codeChip)}
                >
                  {codeChip}
                </button>
              ) : null}

              {/* Share icon sits between the code chip and the timer and opens
                  the invite drawer (code, copy, link, QR). */}
              {!emergency && codeChip ? (
                <button
                  type="button"
                  className="call-chip"
                  style={styles.chip}
                  aria-label={t('call.invite')}
                  title={t('call.invite')}
                  aria-haspopup="dialog"
                  aria-expanded={inviteOpen}
                  onClick={() => setInviteOpen(true)}
                >
                  <Link2 size={15} aria-hidden="true" />
                </button>
              ) : null}

              {duration ? <span style={styles.timer} dir="ltr">{duration}</span> : null}
            </div>

            <div style={styles.topRight}>
              <button
                type="button"
                className="call-chip"
                style={styles.chip}
                aria-label={t('call.participants')}
                title={t('call.participants')}
                onClick={() => setParticipantsOpen(true)}
              >
                <Users size={15} aria-hidden="true" />
                {participants.length}
              </button>
              <button
                type="button"
                className="call-chip"
                style={styles.chip}
                aria-label="Settings"
                title="Settings"
                onClick={() => {
                  setOverflowOpen((open) => !open);
                  setReactionsOpen(false);
                }}
              >
                <Settings size={15} aria-hidden="true" />
              </button>
            </div>
          </header>

          {/* ---- stage ---- */}
          <div style={styles.stageArea}>
            {view === 'speaker' ? (
              <div style={styles.speakerStage}>
                <div style={styles.speakerMain}>
                  {focusedId ? (
                    <Tile
                      stream={peers.find((peer) => peer.id === focusedId)?.stream ?? null}
                      name={infoFor(focusedId)?.name || focusedId}
                      micOn={infoFor(focusedId)?.micOn ?? true}
                      camOn={infoFor(focusedId)?.camOn ?? true}
                      sharing={infoFor(focusedId)?.sharing ?? false}
                      hand={infoFor(focusedId)?.hand ?? false}
                      connection={infoFor(focusedId)?.connection ?? 'new'}
                      videoSilent={peerStats[focusedId]?.videoSilent ?? false}
                      role={infoFor(focusedId)?.role ?? ''}
                      verified={infoFor(focusedId)?.verified ?? false}
                      sinkId={sinkId}
                      speaking={activeSpeakerId === focusedId}
                      pinned={pinnedId === focusedId}
                      onDoubleClick={() => setPinnedId((previous) => (previous === focusedId ? null : focusedId))}
                    />
                  ) : (
                    <p style={styles.stageHint}>
                      {status === 'reconnecting' ? t('call.reconnecting') : t('call.connecting')}
                    </p>
                  )}
                </div>

                {/* Meet-style strip of 96px thumbs along the bottom. */}
                <div style={styles.filmstrip}>
                  {filmstripIds.map((id) => (
                    <div key={id} style={styles.filmstripTile}>
                      <Tile
                        stream={peers.find((peer) => peer.id === id)?.stream ?? null}
                        name={infoFor(id)?.name || t('chat.participant')}
                        micOn={infoFor(id)?.micOn ?? true}
                        camOn={infoFor(id)?.camOn ?? true}
                        sharing={infoFor(id)?.sharing ?? false}
                        hand={infoFor(id)?.hand ?? false}
                        connection={infoFor(id)?.connection ?? 'new'}
                        videoSilent={peerStats[id]?.videoSilent ?? false}
                        role={infoFor(id)?.role ?? ''}
                        verified={infoFor(id)?.verified ?? false}
                        sinkId={sinkId}
                        speaking={activeSpeakerId === id}
                        pinned={pinnedId === id}
                        onDoubleClick={() => setPinnedId((previous) => (previous === id ? null : id))}
                      />
                    </div>
                  ))}
                  <div style={styles.filmstripTile}>
                    <Tile {...selfTileProps} />
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ ...styles.gallery, gridTemplateColumns: `repeat(${galleryColumns}, minmax(0, 1fr))` }}>
                {remoteIds.length === 0 ? (
                  <p style={styles.stageHint}>
                    {status === 'reconnecting' ? t('call.reconnecting') : t('call.connecting')}
                  </p>
                ) : (
                  remoteIds.map((id) => (
                    <div key={id} style={styles.galleryTile}>
                      <Tile
                        stream={peers.find((peer) => peer.id === id)?.stream ?? null}
                        name={infoFor(id)?.name || t('chat.participant')}
                        micOn={infoFor(id)?.micOn ?? true}
                        camOn={infoFor(id)?.camOn ?? true}
                        sharing={infoFor(id)?.sharing ?? false}
                        hand={infoFor(id)?.hand ?? false}
                        connection={infoFor(id)?.connection ?? 'new'}
                        videoSilent={peerStats[id]?.videoSilent ?? false}
                        role={infoFor(id)?.role ?? ''}
                        verified={infoFor(id)?.verified ?? false}
                        sinkId={sinkId}
                        speaking={activeSpeakerId === id}
                        pinned={pinnedId === id}
                        onDoubleClick={() => setPinnedId((previous) => (previous === id ? null : id))}
                      />
                    </div>
                  ))
                )}
              </div>
            )}

            {/* Reactions float up from bottom-centre over the stage. */}
            <div style={styles.reactionLayer} aria-hidden="true">
              {reactions.map((reaction) => (
                <span key={reaction.id} className="call-reaction" style={styles.reaction}>
                  {reaction.emoji}
                </span>
              ))}
            </div>
          </div>

          {status === 'reconnecting' ? (
            <p style={styles.reconnectToast} role="status">{t('call.reconnecting')}</p>
          ) : null}

          {isHost && lobby.length > 0 ? (
            <div style={styles.lobbyPanel} role="dialog" aria-label={t('call.waitingForHost')}>
              <strong style={styles.lobbyTitle}>{t('call.waitingForHost')}</strong>
              <ul style={styles.lobbyList}>
                {lobby.map((guest) => (
                  <li key={guest.id} style={styles.lobbyRow}>
                    <span style={styles.lobbyName}>{guest.name}</span>
                    <button type="button" style={styles.admit} onClick={() => admitGuest(guest.id)}>
                      {t('call.admit')}
                    </button>
                    <button type="button" style={styles.deny} onClick={() => denyGuest(guest.id)}>
                      {t('call.deny')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* ---- bottom bar: one pill + a separated red leave pill ---- */}
          <footer
            className="call-bar"
            style={{ ...styles.bar, opacity: showControls ? 1 : 0, pointerEvents: showControls ? 'auto' : 'none' }}
            aria-hidden={!showControls}
          >
            {reactionsOpen ? (
              <div style={styles.emojiRow}>
                {REACTION_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    style={styles.emojiButton}
                    onClick={() => {
                      sendReaction(emoji);
                      setReactionsOpen(false);
                    }}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}

            {overflowOpen ? (
              <CallOverflowMenu
                view={view}
                statsOpen={statsOpen}
                onToggleView={() => setView((previous) => (previous === 'gallery' ? 'speaker' : 'gallery'))}
                onFullscreen={toggleFullscreen}
                onToggleStats={() => setStatsOpen((open) => !open)}
                onClose={() => setOverflowOpen(false)}
              />
            ) : null}

            <div style={styles.pill}>
              {/* media */}
              <div style={styles.cluster}>
                <button
                  type="button"
                  onClick={toggleMic}
                  title="Microphone (Alt+M)"
                  aria-label="Microphone"
                  aria-pressed={!muted}
                  style={{ ...styles.circleButton, ...(muted ? styles.circleOff : null) }}
                >
                  {muted ? <MicOff size={19} /> : <Mic size={19} />}
                </button>

                <button
                  type="button"
                  onClick={toggleCamera}
                  title="Camera (Alt+V)"
                  aria-label="Camera"
                  aria-pressed={!cameraOff}
                  disabled={audioOnly}
                  style={{ ...styles.circleButton, ...(cameraOff ? styles.circleOff : null) }}
                >
                  {cameraOff || audioOnly ? <VideoOff size={19} /> : <Video size={19} />}
                </button>

                <button
                  type="button"
                  onClick={() => void (sharing ? stopShare() : startShare())}
                  disabled={!sharing && !shareAllowed}
                  title={
                    !sharing && !shareAllowed
                      ? t('call.allowScreenShare')
                      : `${sharing ? t('call.stopShare') : t('call.screenShare')} (Alt+S)`
                  }
                  aria-label={sharing ? t('call.stopShare') : t('call.screenShare')}
                  aria-pressed={sharing}
                  style={{
                    ...styles.circleButton,
                    ...(sharing ? styles.circleOn : null),
                    ...(!sharing && !shareAllowed ? styles.circleDisabled : null),
                  }}
                >
                  <MonitorUp size={19} />
                </button>
              </div>

              <span style={styles.clusterDivider} aria-hidden="true" />

              {/* engage */}
              <div style={styles.cluster}>
                <button
                  type="button"
                  onClick={() => {
                    setReactionsOpen((open) => !open);
                    setOverflowOpen(false);
                  }}
                  title="Reactions"
                  aria-label="Reactions"
                  aria-pressed={reactionsOpen}
                  style={styles.circleButton}
                >
                  <Smile size={19} />
                </button>

                <button
                  type="button"
                  onClick={toggleHand}
                  title={t('call.raiseHand')}
                  aria-label={t('call.raiseHand')}
                  aria-pressed={handRaised}
                  style={{ ...styles.circleButton, ...(handRaised ? styles.circleOn : null) }}
                >
                  <Hand size={19} />
                </button>
              </div>

              <span style={styles.clusterDivider} aria-hidden="true" />

              {/* info */}
              <div style={styles.cluster}>
                <button
                  type="button"
                  onClick={() => setParticipantsOpen(true)}
                  title={t('call.participants')}
                  aria-label={t('call.participants')}
                  style={styles.circleButton}
                >
                  <Users size={19} />
                  <span style={styles.countBadge}>{participants.length}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setOverflowOpen((open) => !open);
                    setReactionsOpen(false);
                  }}
                  title="More"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                  style={{ ...styles.circleButton, ...(overflowOpen ? styles.circleOn : null) }}
                >
                  <MoreVertical size={19} />
                </button>
              </div>
            </div>

            {/* separated red leave pill */}
            <button
              type="button"
              className="call-leave-pill"
              onClick={isHost ? endForAll : endCall}
              title={isHost ? t('call.endForAll') : t('call.leave')}
              style={styles.leavePill}
            >
              <PhoneOff size={17} aria-hidden="true" />
              <span>{isHost ? t('call.endForAll') : t('call.leave')}</span>
            </button>
          </footer>

          {showStats && stats ? (
            <span style={styles.statsChip}>
              {stats.width}×{stats.height} · {stats.fps}fps · {stats.kbps}kbps
              {stats.limit && stats.limit !== 'none' ? ` · ${stats.limit}` : ''}
            </span>
          ) : null}
        </div>
      ) : null}

          {participantsOpen ? <CallParticipantsPanel onClose={() => setParticipantsOpen(false)} /> : null}

          {inviteOpen ? <CallInviteDrawer onClose={() => setInviteOpen(false)} /> : null}

      {/* Diagnostics slide-over (same panel chrome as the participant list). */}
      {statsOpen ? (
        <aside className="call-participants call-stats-panel" role="dialog" aria-label="Call stats">
          <header style={styles.panelHead}>
            <strong>Call stats</strong>
            <button type="button" className="call-panel-close" aria-label={t('common.close')} onClick={() => setStatsOpen(false)}>
              <X size={16} />
            </button>
          </header>
          <ul style={styles.diagList}>
            {Object.entries(peerStats).map(([id, entry]) => (
              <li key={id} style={styles.diagRow}>
                <strong style={styles.diagName}>{peerInfo[id]?.name || t('chat.participant')}</strong>
                <span style={styles.diagLine}>connectionState: {entry.connectionState}</span>
                <span style={styles.diagLine}>iceConnectionState: {entry.iceConnectionState}</span>
                <span style={styles.diagLine}>out: {entry.outboundFrames} frames · {entry.outboundBytes} B sent</span>
                <span style={styles.diagLine}>in: {entry.inboundFrames} frames · {entry.inboundBytes} B received</span>
                <span style={styles.diagLine}>frame: {entry.frameWidth}×{entry.frameHeight}</span>
              </li>
            ))}
            {Object.keys(peerStats).length === 0 ? <li style={styles.diagLine}>No peer stats yet.</li> : null}
          </ul>
        </aside>
      ) : null}

      {notice ? (
        <div style={styles.notice} role="status" aria-live="polite">{noticeText}</div>
      ) : null}

      {/* Join / leave / hand events. role="status" makes this the announcement. */}
      {liveToast ? (
        <div style={styles.notice} role="status" aria-live="polite">{liveToast.text}</div>
      ) : null}

      {shortcutsOpen ? <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} /> : null}

      {/* Screen-reader only: mic state, which has no visible toast. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
    </div>
  );

  return createPortal(layer, document.body);
}

const styles: Record<string, CSSProperties> = {
  layer: { position: 'fixed', inset: 0, zIndex: LAYER_Z_INDEX, pointerEvents: 'none' },
  backdrop: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'auto',
    display: 'grid',
    placeItems: 'center',
    padding: '1rem',
    background: 'rgba(6, 26, 22, 0.6)',
  },
  modal: {
    display: 'grid',
    gap: '0.6rem',
    width: 'min(28rem, 100%)',
    padding: '1.2rem',
    borderRadius: '1rem',
    background: '#f7fdf9',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.4)',
  },
  modalTitle: { fontSize: '1.05rem' },
  modalBody: { margin: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.86rem', overflowWrap: 'anywhere' },
  modalActions: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  accept: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    paddingBlock: '0.7rem',
    paddingInline: '1.1rem',
    border: 'none',
    borderRadius: '999px',
    background: 'linear-gradient(120deg, #48b58f, #7adab1)',
    color: '#072c2a',
    fontWeight: 800,
    cursor: 'pointer',
  },

  stageShell: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'auto',
    display: 'grid',
    gridTemplateRows: 'auto 1fr auto',
    gap: '0.5rem',
    paddingBlock: '0.75rem',
    paddingInline: '0.75rem',
    background: '#061a16',
    color: '#f2fffa',
  },
  stageShellEmergency: { background: '#260a08' },

  // Minimal top bar: code chip + timer on the left, people + gear on the right.
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    transition: 'opacity 200ms ease',
  },
  topLeft: { display: 'inline-flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 },
  topRight: { display: 'inline-flex', alignItems: 'center', gap: '0.4rem' },
  // Layout (mono, single line, truncation) comes from .call-code-chip; this is
  // only the dark-surface skin.
  codeChip: {
    paddingBlock: '0.3rem',
    paddingInline: '0.65rem',
    borderRadius: '999px',
    border: '1px solid rgba(255, 255, 255, 0.22)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  timer: { fontWeight: 600, fontSize: '0.78rem', color: '#cfe9df', fontVariantNumeric: 'tabular-nums' },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    paddingBlock: '0.3rem',
    paddingInline: '0.6rem',
    borderRadius: '999px',
    border: '1px solid rgba(255, 255, 255, 0.22)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    fontSize: '0.78rem',
    fontWeight: 700,
    cursor: 'pointer',
  },

  // Stage
  stageArea: { position: 'relative', minHeight: 0 },
  gallery: {
    position: 'relative',
    display: 'grid',
    gap: '10px',
    alignContent: 'center',
    height: '100%',
    minHeight: 0,
  },
  galleryTile: { aspectRatio: '16 / 9', minHeight: 0 },
  speakerStage: { display: 'grid', gridTemplateRows: '1fr auto', gap: '10px', height: '100%', minHeight: 0 },
  speakerMain: { position: 'relative', minHeight: 0 },
  filmstrip: { display: 'flex', gap: '10px', overflowX: 'auto', paddingBlockEnd: '0.2rem' },
  filmstripTile: { flex: '0 0 auto', width: '96px', height: '96px' },

  tile: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '4rem',
    background: '#000',
    borderRadius: '1rem',
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
    boxShadow: '0 10px 26px rgba(0, 0, 0, 0.34)',
  },
  video: { width: '100%', height: '100%', objectFit: 'contain', background: '#000' },
  videoMirrored: { transform: 'scaleX(-1)' },
  avatar: {
    position: 'absolute',
    display: 'grid',
    placeItems: 'center',
    width: '3rem',
    height: '3rem',
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '1.2rem',
  },
  nameChip: {
    position: 'absolute',
    insetBlockEnd: '0.5rem',
    insetInlineStart: '0.5rem',
    maxWidth: '70%',
    paddingBlock: '0.15rem',
    paddingInline: '0.55rem',
    borderRadius: '999px',
    background: 'rgba(6, 26, 22, 0.62)',
    color: '#f2fffa',
    fontSize: '0.7rem',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  roleBadge: {
    marginInlineStart: '0.35rem',
    paddingBlock: '0.05rem',
    paddingInline: '0.4rem',
    borderRadius: '999px',
    background: 'rgba(255, 255, 255, 0.18)',
    fontSize: '0.6rem',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  verifiedBadge: {
    marginInlineStart: '0.3rem',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#06231d',
    fontSize: '0.6rem',
    fontWeight: 900,
  },
  tileFlags: {
    position: 'absolute',
    insetBlockEnd: '0.5rem',
    insetInlineEnd: '0.5rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    color: '#ffd9d4',
  },
  shareBadge: {
    paddingBlock: '0.1rem',
    paddingInline: '0.45rem',
    borderRadius: '999px',
    background: 'var(--accent, #3ea985)',
    color: '#06231d',
    fontSize: '0.64rem',
    fontWeight: 800,
  },
  connDot: { position: 'absolute', insetBlockStart: '0.5rem', insetInlineEnd: '0.5rem', width: '0.45rem', height: '0.45rem', borderRadius: '50%' },
  silentBadge: {
    position: 'absolute',
    insetBlockStart: '0.5rem',
    insetInlineStart: '0.5rem',
    maxWidth: '85%',
    paddingBlock: '0.15rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(216, 161, 58, 0.92)',
    color: '#3a2b06',
    fontSize: '0.66rem',
    fontWeight: 800,
  },
  stageHint: { margin: 0, textAlign: 'center', color: '#cfe9df', gridColumn: '1 / -1' },

  reactionLayer: {
    position: 'absolute',
    insetBlockEnd: '0.75rem',
    insetInline: 0,
    height: 0,
    pointerEvents: 'none',
  },
  reaction: {
    position: 'absolute',
    insetBlockEnd: 0,
    // Centred with auto margins, so the float stays over the tile in RTL too.
    insetInline: 0,
    marginInline: 'auto',
    width: 'fit-content',
    fontSize: '1.7rem',
  },

  reconnectToast: {
    margin: 0,
    justifySelf: 'center',
    paddingBlock: '0.4rem',
    paddingInline: '0.9rem',
    borderRadius: '999px',
    background: 'rgba(216, 161, 58, 0.22)',
    border: '1px solid rgba(216, 161, 58, 0.5)',
    color: '#ffe9bd',
    fontWeight: 700,
    fontSize: '0.78rem',
  },
  lobbyPanel: {
    position: 'absolute',
    insetBlockStart: '3.2rem',
    insetInlineStart: '0.75rem',
    width: 'min(20rem, 90vw)',
    pointerEvents: 'auto',
    display: 'grid',
    gap: '0.4rem',
    padding: '0.75rem',
    borderRadius: '1rem',
    background: 'rgba(9, 32, 27, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
  },
  lobbyTitle: { fontSize: '0.82rem' },
  lobbyList: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.35rem' },
  lobbyRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' },
  lobbyName: { overflowWrap: 'anywhere', minWidth: 0, marginInlineEnd: 'auto' },
  admit: { paddingBlock: '0.25rem', paddingInline: '0.6rem', borderRadius: '999px', border: 'none', background: 'linear-gradient(120deg, #48b58f, #7adab1)', color: '#06231d', fontWeight: 800, fontSize: '0.7rem', cursor: 'pointer' },
  deny: { paddingBlock: '0.25rem', paddingInline: '0.6rem', borderRadius: '999px', border: '1px solid rgba(224, 101, 90, 0.5)', background: 'transparent', color: '#ffd9d4', fontWeight: 700, fontSize: '0.7rem', cursor: 'pointer' },

  // Bottom bar: one pill, cluster dividers, separated leave pill.
  bar: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.6rem',
    flexWrap: 'wrap',
    transition: 'opacity 200ms ease',
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    paddingBlock: '0.4rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(9, 32, 27, 0.92)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
    boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
  },
  cluster: { display: 'inline-flex', alignItems: 'center', gap: '0.3rem' },
  clusterDivider: { width: 1, height: 24, background: 'rgba(255, 255, 255, 0.16)', marginInline: '0.15rem' },
  circleButton: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.2)',
    background: 'rgba(255, 255, 255, 0.08)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  circleOff: { background: 'rgba(224, 101, 90, 0.22)', borderColor: 'rgba(224, 101, 90, 0.5)', color: '#ffd9d4' },
  circleOn: { background: 'rgba(62, 169, 133, 0.28)', borderColor: 'rgba(62, 169, 133, 0.6)', color: '#d9fff0' },
  circleDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  countBadge: {
    position: 'absolute',
    insetBlockStart: '-2px',
    insetInlineEnd: '-2px',
    minWidth: 16,
    height: 16,
    paddingInline: 4,
    borderRadius: '999px',
    background: 'var(--accent, #3ea985)',
    color: '#06231d',
    fontSize: '0.62rem',
    fontWeight: 800,
    lineHeight: '16px',
    textAlign: 'center',
  },
  leavePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    height: 44,
    paddingInline: '1.1rem',
    borderRadius: '999px',
    border: 'none',
    background: 'linear-gradient(120deg, #e0655a, #f0a099)',
    color: '#4a1610',
    fontWeight: 800,
    fontSize: '0.84rem',
    cursor: 'pointer',
    boxShadow: '0 12px 30px rgba(0, 0, 0, 0.35)',
  },
  emojiRow: {
    position: 'absolute',
    insetBlockEnd: '3.4rem',
    insetInline: 0,
    marginInline: 'auto',
    width: 'fit-content',
    display: 'inline-flex',
    gap: '0.3rem',
    padding: '0.35rem 0.5rem',
    borderRadius: '999px',
    background: 'rgba(9, 32, 27, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
  },
  emojiButton: { fontSize: '1.2rem', background: 'transparent', border: 'none', cursor: 'pointer' },

  statsChip: {
    justifySelf: 'center',
    paddingBlock: '0.3rem',
    paddingInline: '0.6rem',
    borderRadius: '999px',
    background: 'rgba(255, 255, 255, 0.14)',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    color: '#f2fffa',
    fontSize: '0.7rem',
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },

  panelHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  diagList: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.6rem' },
  diagRow: { display: 'grid', gap: '0.1rem', fontSize: '0.72rem', lineHeight: 1.45 },
  diagName: { fontSize: '0.78rem', overflowWrap: 'anywhere' },
  diagLine: { color: '#cfe9df', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },

  notice: {
    position: 'absolute',
    insetBlockEnd: '5.5rem',
    insetInline: 0,
    marginInline: 'auto',
    width: 'fit-content',
    textAlign: 'center',
    pointerEvents: 'auto',
    maxWidth: 'min(92vw, 30rem)',
    paddingBlock: '0.8rem',
    paddingInline: '1.1rem',
    borderRadius: '999px',
    background: 'linear-gradient(120deg, #48b58f, #7adab1)',
    color: '#072c2a',
    fontWeight: 700,
    boxShadow: '0 18px 40px rgba(17, 55, 47, 0.28)',
  },
};
