import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  Hand,
  LayoutGrid,
  Lock,
  Maximize,
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Settings,
  ShieldCheck,
  Smile,
  Users,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useActiveSpeaker } from '../hooks/useActiveSpeaker';
import type { PeerConnState, Reaction } from '../hooks/useCall';
import { useLang } from '../i18n';
import CallPreJoin from './CallPreJoin';
import CallParticipantsPanel from './CallParticipantsPanel';
import CallSecurityPanel from './CallSecurityPanel';
import CallDevicePicker from './CallDevicePicker';

// ---------------------------------------------------------------------------
// CallLayer — the one and only call surface.
//
// Every call fragment renders here and nowhere else: the green room, the
// waiting room, the incoming modal, the adaptive grid (gallery / speaker), the
// top bar (name / timer / quality), the self-PiP (inside the stage), the
// auto-hiding control bar, the participants slide-over, the settings popover,
// reaction bursts and the end / reconnect toasts.
//
// Phase is derived from the single call store:
//   stage:  idle | prejoin | lobby
//   status: idle | outgoing | incoming | active | reconnecting | ended
// ---------------------------------------------------------------------------

const LAYER_Z_INDEX = 3000;
const CONTROLS_IDLE_MS = 3000;
const REACTION_EMOJI = ['👍', '❤️', '👏'];

/** Local + remote video never mirrors; only our own preview does. */
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
  reactions,
  self = false,
  videoSilent = false,
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
  reactions: Reaction[];
  self?: boolean;
  /** Connected, camera on, yet not a single inbound frame has decoded. */
  videoSilent?: boolean;
  onDoubleClick?: () => void;
}) {
  const initials = (name || '?').trim().charAt(0).toUpperCase();

  return (
    <div
      className={`call-tile${speaking ? ' is-speaking' : ''}${pinned ? ' is-pinned' : ''}`}
      style={styles.tile}
      onDoubleClick={onDoubleClick}
      data-self={self ? 'true' : undefined}
    >
      {/* object-contain on black: letterbox, never crop, never mirror remotes.
          Attached through a ref callback so the stream is bound the instant the
          element mounts, and only re-bound when the stream object changes. */}
      <video
        ref={(el) => {
          if (!el || !stream) return;
          if (el.srcObject !== stream) {
            el.srcObject = stream;
            void el.play().catch(() => {});
          }
        }}
        autoPlay
        playsInline
        muted={muted}
        style={{
          ...styles.video,
          ...(mirrored ? styles.videoMirrored : null),
          // While sharing, the video element carries the display track even if
          // the camera itself is off.
          opacity: camOn || sharing ? 1 : 0,
        }}
      />

      {/* Zero inbound frames only means trouble when video was expected: the
          camera is on and this tile is not carrying a screen share. */}
      {videoSilent && camOn && !sharing ? (
        <span style={styles.silentBadge}>Video unavailable — audio only</span>
      ) : null}

      {!camOn && !sharing ? (
        <span className="call-avatar" style={styles.avatar} aria-hidden="true">
          {initials}
        </span>
      ) : null}

      <span className="call-name" style={styles.nameChip}>{name}</span>

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
              ? '#2d9c78'
              : connection === 'failed'
                ? '#e0655a'
                : '#d8a13a',
        }}
        data-state={connection}
        aria-hidden="true"
      />

      {reactions.map((reaction) => (
        <span key={reaction.id} className="call-reaction" style={styles.reaction}>
          {reaction.emoji}
        </span>
      ))}
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
  const { t } = useLang();
  const {
    status,
    kind,
    roomId,
    roomCode,
    isHost,
    peerName,
    connectedAt,
    incoming,
    peers,
    peerInfo,
    peerStats,
    codeRoom,
    policy,
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
    devices,
    micId,
    camId,
    setLocalSpeaking,
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
    selectMic,
    selectCamera,
    admitGuest,
    denyGuest,
    commitJoin,
    notify,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  const duration = useElapsed(connectedAt);
  const activeSpeakerId = useActiveSpeaker(localStream, peers, inSession);

  // Code-chip source chain: the route param (captured by openRoom into
  // roomCode) -> store state -> the channel name split on ':'. For a code room
  // one of these always resolves, so the chip can never render empty.
  const codeChip = (roomCode || roomId || '').split(':').pop() ?? '';

  // Policy enforcement: the host can forbid screen sharing for the room.
  const shareAllowed = !policy || policy.allow_share;

  // Report our own voice activity so the spotlight guard can spare us.
  useEffect(() => {
    setLocalSpeaking(activeSpeakerId === 'me');
  }, [activeSpeakerId, setLocalSpeaking]);

  // A host who opened a room without the code in the URL gets it written back,
  // so a refresh — or a shared link — still lands on the right room.
  useEffect(() => {
    if (!codeRoom || !codeChip) return;
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

  // ---- auto-hiding control bar --------------------------------------------
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

  const showControls =
    controlsVisible || participantsOpen || settingsOpen || reactionsOpen || !inSession;

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

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => notify('copied')).catch(() => {});
  };

  const shareUrl =
    typeof window === 'undefined'
      ? ''
      : `${window.location.origin}${window.location.pathname}#call/${roomCode ?? ''}`;

  const title = useMemo(() => {
    if (emergency) return t('call.emergencyActive');
    if (roomCode) return roomCode;
    if (peerName) return peerName;
    return status === 'reconnecting' ? t('call.reconnecting') : t('call.connecting');
  }, [emergency, roomCode, peerName, status, t]);

  // ---- grid ----------------------------------------------------------------
  const remoteIds = peers.map((peer) => peer.id);

  const speakingId = activeSpeakerId === 'me' ? null : activeSpeakerId;
  const focusedId = pinnedId ?? speakingId ?? remoteIds[0] ?? null;
  const filmstripIds =
    view === 'speaker' ? remoteIds.filter((id) => id !== focusedId) : remoteIds;

  // cols = ceil(sqrt(n)); the self-PiP overlays the grid rather than taking a cell.
  const galleryColumns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, remoteIds.length))));

  const reactionsFor = (from: string) => reactions.filter((reaction) => reaction.from === from);
  const selfReactions = reactionsFor('me');

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
                : notice === 'continue-in-chat'
                  ? t('chat.messages')
                  : t('call.ended');

  const layer = (
    <div className="call-layer" style={styles.layer} data-call-phase={stage !== 'idle' ? stage : incomingPhase ? 'incoming' : inSession ? status : 'ended'}>
      {stage === 'prejoin' ? <CallPreJoin /> : null}

      {stage === 'lobby' ? (
        <div style={styles.backdrop}>
          <div style={styles.modal}>
            <strong style={styles.modalTitle}>{t('call.waitingForHost')}</strong>
            <CallDevicePicker
              mics={devices.mics}
              cams={devices.cams}
              micId={micId}
              camId={camId}
              onSelectMic={(id) => void selectMic(id)}
              onSelectCamera={(id) => void selectCamera(id)}
            />
            <div style={styles.modalActions}>
              <button type="button" className="ghost-button" onClick={endCall}>
                {t('call.leave')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {incomingPhase ? (
        <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label={emergency ? t('call.emergencyActive') : t('call.incoming')}>
          <div style={styles.modal}>
            <strong style={styles.modalTitle}>{emergency ? t('call.emergencyActive') : t('call.incoming')}</strong>
            <p style={styles.modalBody}>{incoming?.name || incoming?.from}</p>
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
          {/* The top bar always renders while in session: name, quality, timer,
              participant count, encryption, and (for code rooms) the code chip. */}
          <header style={{ ...styles.topBar, opacity: showControls ? 1 : 0.25 }}>
            <span style={styles.topTitle}>{title}</span>

            <span style={styles.topMeta}>
              <span
                role="img"
                aria-label={t('call.stats')}
                style={{
                  ...styles.qualityDot,
                  background: quality === 'good' ? '#2d9c78' : quality === 'fair' ? '#d8a13a' : '#e0655a',
                }}
              />
              {duration ? <span style={styles.timer} dir="ltr">{duration}</span> : null}
              <span style={styles.count}>{participants.length}</span>
              {isHost && policy ? (
                <button
                  type="button"
                  aria-pressed={securityOpen}
                  aria-label={t('call.security')}
                  title={t('call.security')}
                  onClick={() => setSecurityOpen((open) => !open)}
                  style={{ ...styles.topBarButton, ...(securityOpen ? styles.iconOn : null) }}
                >
                  <ShieldCheck size={15} aria-hidden="true" />
                </button>
              ) : null}
              <span style={styles.encrypted} aria-label="Encrypted">
                <Lock size={13} aria-hidden="true" />
              </span>
            </span>

            {!emergency && codeChip ? (
              <span style={styles.headerActions}>
                <span style={styles.codeChip} dir="ltr">{codeChip}</span>
                <button type="button" style={styles.headerButton} aria-label={t('call.copyCode')} onClick={() => copy(codeChip)}>
                  📋 {t('call.copyCode')}
                </button>
                <button type="button" style={styles.headerButton} aria-label={t('call.shareLink')} onClick={() => copy(shareUrl)}>
                  {t('call.shareLink')}
                </button>
              </span>
            ) : null}
          </header>

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
                    speaking={activeSpeakerId === focusedId}
                    pinned={pinnedId === focusedId}
                    reactions={reactionsFor(focusedId)}
                    onDoubleClick={() => setPinnedId((previous) => (previous === focusedId ? null : focusedId))}
                  />
                ) : (
                  <p style={styles.stageHint}>
                    {status === 'reconnecting' ? t('call.reconnecting') : t('call.connecting')}
                  </p>
                )}
                {/* Self-PiP lives INSIDE the stage, never outside it. */}
                <div style={styles.selfPip}>
                  <Tile
                    stream={sharing ? shareStream : localStream}
                    muted
                    mirrored={!sharing}
                    self
                    name={participants[0]?.name ?? ''}
                    micOn={!muted}
                    camOn={!cameraOff}
                    sharing={sharing}
                    hand={handRaised}
                    connection="connected"
                    speaking={activeSpeakerId === 'me'}
                    pinned={false}
                    reactions={selfReactions}
                  />
                </div>
              </div>

              {filmstripIds.length > 0 ? (
                <div style={styles.filmstrip}>
                  {filmstripIds.map((id) => (
                    <div key={id} style={styles.filmstripTile}>
                      <Tile
                        stream={peers.find((peer) => peer.id === id)?.stream ?? null}
                        name={infoFor(id)?.name || id}
                        micOn={infoFor(id)?.micOn ?? true}
                        camOn={infoFor(id)?.camOn ?? true}
                        sharing={infoFor(id)?.sharing ?? false}
                        hand={infoFor(id)?.hand ?? false}
                        connection={infoFor(id)?.connection ?? 'new'}
                        videoSilent={peerStats[id]?.videoSilent ?? false}
                        speaking={activeSpeakerId === id}
                        pinned={pinnedId === id}
                        reactions={reactionsFor(id)}
                        onDoubleClick={() => setPinnedId((previous) => (previous === id ? null : id))}
                      />
                    </div>
                  ))}
                </div>
              ) : null}
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
                      name={infoFor(id)?.name || id}
                      micOn={infoFor(id)?.micOn ?? true}
                      camOn={infoFor(id)?.camOn ?? true}
                      sharing={infoFor(id)?.sharing ?? false}
                      hand={infoFor(id)?.hand ?? false}
                      connection={infoFor(id)?.connection ?? 'new'}
                      videoSilent={peerStats[id]?.videoSilent ?? false}
                      speaking={activeSpeakerId === id}
                      pinned={pinnedId === id}
                      reactions={reactionsFor(id)}
                      onDoubleClick={() => setPinnedId((previous) => (previous === id ? null : id))}
                    />
                  </div>
                ))
              )}

              {/* Self-PiP lives INSIDE the stage, never outside it. */}
              <div style={styles.selfPip}>
                <Tile
                  stream={sharing ? shareStream : localStream}
                  muted
                  mirrored={!sharing}
                  self
                  name={participants[0]?.name ?? ''}
                  micOn={!muted}
                  camOn={!cameraOff}
                  sharing={sharing}
                  hand={handRaised}
                  connection="connected"
                  speaking={activeSpeakerId === 'me'}
                  pinned={false}
                  reactions={selfReactions}
                />
              </div>
            </div>
          )}

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

          {participantsOpen ? <CallParticipantsPanel onClose={() => setParticipantsOpen(false)} /> : null}

          {securityOpen && isHost ? <CallSecurityPanel onClose={() => setSecurityOpen(false)} /> : null}

          {settingsOpen ? (
            <div style={styles.settings} role="dialog" aria-label="Settings">
              <CallDevicePicker
                compact
                mics={devices.mics}
                cams={devices.cams}
                micId={micId}
                camId={camId}
                onSelectMic={(id) => void selectMic(id)}
                onSelectCamera={(id) => void selectCamera(id)}
              />
              <button
                type="button"
                style={{ ...styles.statsToggle, ...(diagOpen ? styles.statsToggleOn : null) }}
                aria-pressed={diagOpen}
                onClick={() => setDiagOpen((open) => !open)}
              >
                {diagOpen ? '▾' : '▸'} Call stats
              </button>
            </div>
          ) : null}

          {/* Diagnostics drawer: per-peer connection + video counters. */}
          {diagOpen ? (
            <div style={styles.diag} role="dialog" aria-label="Call stats">
              <div style={styles.diagHead}>
                <strong>Call stats</strong>
                <button
                  type="button"
                  style={styles.diagClose}
                  aria-label={t('common.close')}
                  onClick={() => setDiagOpen(false)}
                >
                  <X size={14} />
                </button>
              </div>

              <ul style={styles.diagList}>
                {Object.entries(peerStats).map(([id, entry]) => (
                  <li key={id} style={styles.diagRow}>
                    <strong style={styles.diagName}>{peerInfo[id]?.name || id}</strong>
                    <span style={styles.diagLine}>connectionState: {entry.connectionState}</span>
                    <span style={styles.diagLine}>iceConnectionState: {entry.iceConnectionState}</span>
                    <span style={styles.diagLine}>
                      out: {entry.outboundFrames} frames · {entry.outboundBytes} B sent
                    </span>
                    <span style={styles.diagLine}>
                      in: {entry.inboundFrames} frames · {entry.inboundBytes} B received
                    </span>
                    <span style={styles.diagLine}>
                      frame: {entry.frameWidth}×{entry.frameHeight}
                    </span>
                  </li>
                ))}
                {Object.keys(peerStats).length === 0 ? (
                  <li style={styles.diagLine}>No peer stats yet.</li>
                ) : null}
              </ul>
            </div>
          ) : null}

          <footer
            style={{ ...styles.bar, opacity: showControls ? 1 : 0, pointerEvents: showControls ? 'auto' : 'none' }}
            aria-hidden={!showControls}
          >
            <div style={styles.pill}>
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

              <button
                type="button"
                onClick={toggleMic}
                title="Microphone (Alt+M)"
                aria-label="Microphone"
                aria-pressed={!muted}
                style={{ ...styles.iconButton, ...(muted ? styles.iconOff : null) }}
              >
                {muted ? <MicOff size={18} /> : <Mic size={18} />}
              </button>

              <button
                type="button"
                onClick={toggleCamera}
                title="Camera (Alt+V)"
                aria-label="Camera"
                aria-pressed={!cameraOff}
                disabled={audioOnly}
                style={{ ...styles.iconButton, ...(cameraOff ? styles.iconOff : null) }}
              >
                {cameraOff || audioOnly ? <VideoOff size={18} /> : <Video size={18} />}
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
                  ...styles.iconButton,
                  ...(sharing ? styles.iconOn : null),
                  ...(!sharing && !shareAllowed ? styles.iconDisabled : null),
                }}
              >
                <MonitorUp size={18} />
              </button>

              <button
                type="button"
                onClick={() => {
                  setReactionsOpen((open) => !open);
                  setSettingsOpen(false);
                }}
                title="Reactions"
                aria-label="Reactions"
                aria-pressed={reactionsOpen}
                style={styles.iconButton}
              >
                <Smile size={18} />
              </button>

              <button
                type="button"
                onClick={toggleHand}
                title={t('call.raiseHand')}
                aria-pressed={handRaised}
                style={{ ...styles.iconButton, ...(handRaised ? styles.iconOn : null) }}
              >
                <Hand size={18} />
              </button>

              <button
                type="button"
                onClick={() => {
                  setParticipantsOpen((open) => !open);
                  setSettingsOpen(false);
                }}
                title={t('call.participants')}
                aria-pressed={participantsOpen}
                style={styles.iconButton}
              >
                <Users size={18} />
              </button>

              <button
                type="button"
                onClick={() => setView((previous) => (previous === 'gallery' ? 'speaker' : 'gallery'))}
                title={view === 'gallery' ? t('call.speakerView') : t('call.galleryView')}
                style={styles.iconButton}
              >
                {view === 'gallery' ? <LayoutGrid size={18} /> : <Users size={18} />}
              </button>

              <button
                type="button"
                onClick={toggleFullscreen}
                title="Fullscreen (F)"
                aria-label="Fullscreen"
                aria-pressed={fullscreen}
                style={styles.iconButton}
              >
                <Maximize size={18} />
              </button>

              <button
                type="button"
                onClick={() => {
                  setSettingsOpen((open) => !open);
                  setReactionsOpen(false);
                }}
                title="Settings"
                aria-label="Settings"
                aria-pressed={settingsOpen}
                style={styles.iconButton}
              >
                <Settings size={18} />
              </button>

              <button type="button" onClick={toggleStats} aria-label={t('call.stats')} style={styles.iconButton}>
                <Activity size={18} />
              </button>

              {isHost ? (
                <button type="button" onClick={endForAll} title={t('call.endForAll')} style={styles.endForAll}>
                  <PhoneOff size={16} aria-hidden="true" /> {t('call.endForAll')}
                </button>
              ) : (
                <button type="button" onClick={endCall} title={t('call.leave')} style={styles.endButton}>
                  <PhoneOff size={18} aria-hidden="true" />
                  <span style={styles.endLabel}>{t('call.leave')}</span>
                </button>
              )}
            </div>

            {showStats && stats ? (
              <span style={styles.statsChip}>
                {stats.width}×{stats.height} · {stats.fps}fps · {stats.kbps}kbps
                {stats.limit && stats.limit !== 'none' ? ` · ${stats.limit}` : ''}
              </span>
            ) : null}
          </footer>
        </div>
      ) : null}

      {notice ? (
        <div style={styles.notice} role="status" aria-live="polite">{noticeText}</div>
      ) : null}
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
    borderRadius: '1.15rem',
    background: '#f7fdf9',
    border: '1px solid rgba(62, 169, 133, 0.3)',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.4)',
  },
  modalTitle: { fontSize: '1.05rem' },
  modalBody: { margin: 0, color: '#557b76', fontSize: '0.86rem', overflowWrap: 'anywhere' },
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
    gap: '0.6rem',
    paddingBlock: '0.85rem',
    paddingInline: '0.85rem',
    background: '#061a16',
    color: '#f2fffa',
  },
  stageShellEmergency: { background: '#260a08' },
  topBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', flexWrap: 'wrap', transition: 'opacity 200ms ease' },
  topTitle: { fontWeight: 800, fontSize: '0.95rem', overflowWrap: 'anywhere', minWidth: 0 },
  topMeta: { display: 'inline-flex', alignItems: 'center', gap: '0.5rem' },
  timer: { fontWeight: 700, fontSize: '0.82rem', letterSpacing: '0.04em', color: '#cfe9df' },
  count: { fontSize: '0.78rem', color: '#cfe9df' },
  qualityDot: { width: '0.6rem', height: '0.6rem', borderRadius: '50%' },
  headerActions: { display: 'inline-flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' },
  codeChip: {
    paddingBlock: '0.35rem',
    paddingInline: '0.7rem',
    borderRadius: '0.7rem',
    background: 'rgba(255, 255, 255, 0.12)',
    border: '1px solid rgba(255, 255, 255, 0.28)',
    color: '#f2fffa',
    fontWeight: 800,
    letterSpacing: '0.04em',
    overflowWrap: 'anywhere',
    maxWidth: 'min(90vw, 22rem)',
  },
  headerButton: {
    paddingBlock: '0.35rem',
    paddingInline: '0.7rem',
    borderRadius: '999px',
    border: '1px solid rgba(255, 255, 255, 0.28)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#f2fffa',
    fontWeight: 700,
    fontSize: '0.74rem',
    cursor: 'pointer',
  },
  gallery: {
    position: 'relative',
    display: 'grid',
    gap: '0.5rem',
    alignContent: 'center',
    justifyItems: 'stretch',
    minHeight: 0,
  },
  galleryTile: { aspectRatio: '16 / 9', minHeight: 0 },
  speakerStage: { display: 'grid', gridTemplateRows: '1fr auto', gap: '0.5rem', minHeight: 0 },
  speakerMain: { position: 'relative', minHeight: 0 },
  filmstrip: { display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBlockEnd: '0.2rem' },
  filmstripTile: { flex: '0 0 auto', width: '10rem', aspectRatio: '16 / 9' },
  tile: {
    position: 'relative',
    width: '100%',
    height: '100%',
    minHeight: '5rem',
    background: '#000',
    borderRadius: '0.75rem',
    overflow: 'hidden',
    display: 'grid',
    placeItems: 'center',
  },
  // Letterbox on black; remotes are never mirrored.
  video: { width: '100%', height: '100%', objectFit: 'contain', background: '#000' },
  videoMirrored: { transform: 'scaleX(-1)' },
  avatar: {
    position: 'absolute',
    display: 'grid',
    placeItems: 'center',
    width: '3rem',
    height: '3rem',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3ea985, #8adbb0)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '1.2rem',
  },
  nameChip: {
    position: 'absolute',
    insetBlockEnd: '0.4rem',
    insetInlineStart: '0.4rem',
    maxWidth: '70%',
    paddingBlock: '0.15rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(6, 26, 22, 0.65)',
    color: '#f2fffa',
    fontSize: '0.7rem',
    fontWeight: 700,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tileFlags: {
    position: 'absolute',
    insetBlockEnd: '0.4rem',
    insetInlineEnd: '0.4rem',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.3rem',
    color: '#ffd9d4',
  },
  shareBadge: {
    paddingBlock: '0.1rem',
    paddingInline: '0.45rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.85)',
    color: '#06231d',
    fontSize: '0.64rem',
    fontWeight: 800,
  },
  connDot: { position: 'absolute', insetBlockStart: '0.4rem', insetInlineEnd: '0.4rem', width: '0.5rem', height: '0.5rem', borderRadius: '50%', background: '#2d9c78' },
  selfPip: {
    position: 'absolute',
    insetBlockEnd: '0.5rem',
    insetInlineEnd: '0.5rem',
    width: '9rem',
    aspectRatio: '16 / 9',
    pointerEvents: 'none',
  },
  reaction: { position: 'absolute', insetBlockEnd: '1.5rem', insetInlineStart: '50%', fontSize: '1.6rem' },
  stageHint: { margin: 0, textAlign: 'center', color: '#cfe9df', gridColumn: '1 / -1' },
  reconnectToast: {
    margin: 0,
    justifySelf: 'center',
    paddingBlock: '0.45rem',
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
    insetBlockStart: '3.4rem',
    insetInlineStart: '0.85rem',
    width: 'min(20rem, 90vw)',
    pointerEvents: 'auto',
    display: 'grid',
    gap: '0.4rem',
    padding: '0.75rem',
    borderRadius: '0.9rem',
    background: 'rgba(9, 32, 27, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
  },
  lobbyTitle: { fontSize: '0.82rem' },
  lobbyList: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.35rem' },
  lobbyRow: { display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem' },
  lobbyName: { overflowWrap: 'anywhere', minWidth: 0, marginInlineEnd: 'auto' },
  admit: { paddingBlock: '0.25rem', paddingInline: '0.6rem', borderRadius: '999px', border: 'none', background: 'linear-gradient(120deg, #48b58f, #7adab1)', color: '#06231d', fontWeight: 800, fontSize: '0.7rem', cursor: 'pointer' },
  deny: { paddingBlock: '0.25rem', paddingInline: '0.6rem', borderRadius: '999px', border: '1px solid rgba(224, 101, 90, 0.5)', background: 'transparent', color: '#ffd9d4', fontWeight: 700, fontSize: '0.7rem', cursor: 'pointer' },
  settings: {
    position: 'absolute',
    insetBlockEnd: '4.6rem',
    insetInline: '50%',
    transform: 'translateX(50%)',
    pointerEvents: 'auto',
    padding: '0.6rem',
    borderRadius: '0.9rem',
    background: 'rgba(9, 32, 27, 0.96)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
  },
  bar: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '0.4rem',
    transition: 'opacity 200ms ease',
  },
  pill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    flexWrap: 'wrap',
    justifyContent: 'center',
    paddingBlock: '0.4rem',
    paddingInline: '0.6rem',
    borderRadius: '999px',
    background: 'rgba(9, 32, 27, 0.92)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
  },
  emojiRow: { display: 'inline-flex', gap: '0.2rem', marginInlineEnd: '0.3rem' },
  emojiButton: { fontSize: '1.1rem', background: 'transparent', border: 'none', cursor: 'pointer' },
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 40,
    height: 40,
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  topBarButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  iconDisabled: { opacity: 0.4, cursor: 'not-allowed' },
  iconOff: { background: 'rgba(224, 101, 90, 0.22)', borderColor: 'rgba(224, 101, 90, 0.5)', color: '#ffd9d4' },
  iconOn: { background: 'rgba(62, 169, 133, 0.28)', borderColor: 'rgba(62, 169, 133, 0.6)', color: '#d9fff0' },
  endButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    height: 40,
    paddingInline: '0.9rem',
    border: 'none',
    borderRadius: '999px',
    background: 'linear-gradient(120deg, #e0655a, #f0a099)',
    color: '#4a1610',
    fontWeight: 800,
    cursor: 'pointer',
  },
  endLabel: { fontSize: '0.8rem' },
  endForAll: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    height: 40,
    paddingInline: '0.9rem',
    borderRadius: '999px',
    border: '1px solid rgba(224, 101, 90, 0.55)',
    background: 'rgba(224, 101, 90, 0.18)',
    color: '#ffd9d4',
    fontWeight: 800,
    fontSize: '0.78rem',
    cursor: 'pointer',
  },
  statsChip: {
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
  encrypted: { display: 'inline-flex', alignItems: 'center', color: '#8fd8bd' },
  silentBadge: {
    position: 'absolute',
    insetBlockStart: '0.4rem',
    insetInlineStart: '0.4rem',
    maxWidth: '85%',
    paddingBlock: '0.15rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(216, 161, 58, 0.92)',
    color: '#3a2b06',
    fontSize: '0.66rem',
    fontWeight: 800,
  },
  statsToggle: {
    display: 'block',
    width: '100%',
    marginBlockStart: '0.5rem',
    paddingBlock: '0.35rem',
    paddingInline: '0.5rem',
    borderRadius: '0.6rem',
    border: '1px solid rgba(255, 255, 255, 0.22)',
    background: 'transparent',
    color: '#f2fffa',
    fontSize: '0.76rem',
    textAlign: 'start',
    cursor: 'pointer',
  },
  statsToggleOn: { background: 'rgba(62, 169, 133, 0.25)', borderColor: 'rgba(62, 169, 133, 0.6)' },
  diag: {
    position: 'absolute',
    insetBlockStart: '3.4rem',
    insetInlineEnd: '0.85rem',
    width: 'min(26rem, 92vw)',
    maxHeight: '60vh',
    overflowY: 'auto',
    pointerEvents: 'auto',
    display: 'grid',
    gap: '0.4rem',
    padding: '0.75rem',
    borderRadius: '0.9rem',
    background: 'rgba(6, 22, 19, 0.97)',
    border: '1px solid rgba(255, 255, 255, 0.16)',
    color: '#f2fffa',
  },
  diagHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  diagClose: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255, 255, 255, 0.12)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  diagList: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.5rem' },
  diagRow: { display: 'grid', gap: '0.1rem', fontSize: '0.72rem', lineHeight: 1.45 },
  diagName: { fontSize: '0.78rem', overflowWrap: 'anywhere' },
  diagLine: { color: '#cfe9df', fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  notice: {
    position: 'absolute',
    insetBlockEnd: '1.5rem',
    insetInline: '50%',
    transform: 'translateX(50%)',
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
