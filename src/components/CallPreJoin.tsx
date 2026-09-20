import { useEffect, useState, type CSSProperties } from 'react';
import { Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import CallDevicePicker from './CallDevicePicker';

// ---------------------------------------------------------------------------
// The green room — Meet-style layout.
//
//   heading
//   self preview (rounded-2xl): a mint shimmer while acquiring, the mirrored
//     live feed once it lands, or a named device-blocked tile — never black
//   circular mic/cam toggles that flip the REAL tracks
//   info card: room code · who you are joining as · waiting-room state
//   primary "Join now" mint pill + secondary "Join without video"
//
// getUserMedia runs exactly ONCE, here; commitJoin hands this very stream to the
// peer connections, so no second capture is ever opened. Nothing here opens a
// peer connection — the RTC layer starts only on join.
// ---------------------------------------------------------------------------

export default function CallPreJoin() {
  const { t } = useLang();
  const {
    localStream,
    previewAcquiring,
    previewBlocked,
    roomCode,
    isHost,
    peerName,
    participants,
    lobbyEnabled,
    devices,
    micId,
    camId,
    selectMic,
    selectCamera,
    commitJoin,
    cancelPrejoin,
  } = useCallContext();

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [copied, setCopied] = useState(false);

  // The pressed state mirrors the REAL track, not a local wish: a track that
  // never arrived (permission refused) reads as off, instantly and without a
  // second source of truth.
  useEffect(() => {
    const audio = localStream?.getAudioTracks()[0] ?? null;
    const video = localStream?.getVideoTracks()[0] ?? null;
    setMicOn(Boolean(audio && audio.enabled));
    setCamOn(Boolean(video && video.enabled && video.readyState === 'live'));
  }, [localStream]);

  const copyCode = () => {
    if (!roomCode) return;
    setCopied(true);
    void navigator.clipboard
      ?.writeText(roomCode)
      .catch(() => {})
      .finally(() => window.setTimeout(() => setCopied(false), 2000));
  };

  // Toggling flips the preview track itself; the same track is handed to the
  // peer connections on join, so the choice carries into the call.
  const toggleTrack = (kind: 'audio' | 'video') => {
    const track = kind === 'audio' ? localStream?.getAudioTracks()[0] : localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    if (kind === 'audio') setMicOn(track.enabled);
    else setCamOn(track.enabled && track.readyState === 'live');
  };

  /** Joins with the camera stopped — audio only, same session. */
  const joinWithoutVideo = () => {
    // Stop the camera FIRST so the LED goes out and nothing is captured. The
    // ended track stays on the stream, so its transceiver still gets negotiated.
    for (const track of localStream?.getVideoTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    setCamOn(false);
    void commitJoin();
  };

  // The host's own name for the host; the partner's name when we know it.
  const displayName = (isHost ? participants[0]?.name : peerName) || participants[0]?.name || '';
  const initial = (displayName || '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="call-prejoin" style={styles.shell} role="dialog" aria-modal="true" aria-label={t('call.prejoinTitle')}>
      <div style={styles.card}>
        <h2 style={styles.title}>{t('call.prejoinTitle')}</h2>

        <div style={styles.previewWrap}>
          {previewBlocked ? (
            /* The browser refused a device: name it and keep the rest working. */
            <span className="call-preview-blocked" role="status">
              {previewBlocked === 'camera' ? (
                <VideoOff size={22} aria-hidden="true" />
              ) : (
                <MicOff size={22} aria-hidden="true" />
              )}
              <span>{t(previewBlocked === 'camera' ? 'call.cameraBlocked' : 'call.micBlocked')}</span>
            </span>
          ) : previewAcquiring || !localStream ? (
            /* Acquiring: a mint shimmer, never a black rectangle. */
            <span className="call-preview-skeleton" aria-hidden="true" />
          ) : (
            <>
              <video
                ref={(el) => {
                  if (!el || !localStream) return;
                  if (el.srcObject !== localStream) {
                    el.srcObject = localStream;
                    void el.play().catch(() => {});
                  }
                }}
                autoPlay
                playsInline
                muted
                style={styles.preview}
              />
              {!camOn ? (
                <span className="call-avatar" style={styles.avatar} aria-hidden="true">
                  {initial}
                </span>
              ) : null}
            </>
          )}
        </div>

        {/* Circular toggles sit beneath the preview, Meet-style. */}
        <div style={styles.toggles}>
          <button
            type="button"
            onClick={() => toggleTrack('audio')}
            aria-pressed={micOn}
            aria-label="Microphone"
            style={{ ...styles.toggle, ...(micOn ? null : styles.toggleOff) }}
          >
            {micOn ? <Mic size={18} /> : <MicOff size={18} />}
          </button>
          <button
            type="button"
            onClick={() => toggleTrack('video')}
            aria-pressed={camOn}
            aria-label="Camera"
            style={{ ...styles.toggle, ...(camOn ? null : styles.toggleOff) }}
          >
            {camOn ? <Video size={18} /> : <VideoOff size={18} />}
          </button>
        </div>

        <div style={styles.infoCard}>
          {/* The code leads the card, top-left (inline-start), with its own copy. */}
          {roomCode ? (
            <span style={styles.codeRow}>
              <span className="call-code-chip" style={styles.codeChip} dir="ltr" title={roomCode}>
                {roomCode}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={copyCode}
                title={t('call.copyCode')}
                aria-label={`${t('call.copyCode')} — ${roomCode}`}
              >
                {copied ? t('call.copied') : `📋 ${t('call.copyCode')}`}
              </button>
            </span>
          ) : null}
          {displayName ? (
            <span style={styles.infoRow}>
              <span style={styles.infoLabel}>{t('chat.participant')}</span>
              <span style={styles.infoValue}>{displayName}</span>
            </span>
          ) : null}
          <span style={styles.infoRow}>
            <span style={styles.infoLabel}>{t('call.waitingRoom')}</span>
            <span className={lobbyEnabled ? 'call-state-chip is-on' : 'call-state-chip is-off'}>
              {t(lobbyEnabled ? 'call.stateOn' : 'call.stateOff')}
            </span>
          </span>
        </div>

        <CallDevicePicker
          mics={devices.mics}
          cams={devices.cams}
          micId={micId}
          camId={camId}
          onSelectMic={(id) => void selectMic(id)}
          onSelectCamera={(id) => void selectCamera(id)}
        />

        <div style={styles.actions}>
          <button type="button" className="ghost-button" onClick={cancelPrejoin}>
            {t('common.cancel')}
          </button>
          <button type="button" className="ghost-button" onClick={joinWithoutVideo}>
            {t('call.joinWithoutVideo')}
          </button>
          <button type="button" className="primary-button" onClick={() => void commitJoin()}>
            {t('call.joinNow')}
          </button>
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'auto',
    display: 'grid',
    placeItems: 'center',
    padding: '1rem',
    background: 'rgba(6, 26, 22, 0.88)',
    overflowY: 'auto',
  },
  card: {
    display: 'grid',
    gap: '0.85rem',
    width: 'min(34rem, 100%)',
    padding: '1.25rem',
    borderRadius: '1.25rem',
    background: '#f7fdf9',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.4)',
  },
  title: { margin: 0, fontSize: '1.2rem', color: 'var(--text, #133b35)' },
  previewWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    // Mint, never black: the surface is only ever covered by the skeleton, the
    // blocked tile or the live feed.
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    borderRadius: '1rem',
    overflow: 'hidden',
    boxShadow: '0 12px 30px rgba(6, 26, 22, 0.28)',
    display: 'grid',
    placeItems: 'center',
  },
  // Local preview is always mirrored; remote video never is.
  preview: { width: '100%', height: '100%', objectFit: 'contain', transform: 'scaleX(-1)' },
  avatar: {
    position: 'absolute',
    display: 'grid',
    placeItems: 'center',
    width: '3.4rem',
    height: '3.4rem',
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '1.4rem',
  },
  toggles: { display: 'flex', justifyContent: 'center', gap: '0.6rem' },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
    borderRadius: '50%',
    border: '1px solid rgba(62, 169, 133, 0.35)',
    background: 'rgba(62, 169, 133, 0.12)',
    color: 'var(--accent-strong, #216e5d)',
    cursor: 'pointer',
  },
  toggleOff: { background: 'rgba(224, 101, 90, 0.16)', borderColor: 'rgba(224, 101, 90, 0.4)', color: '#9c3636' },
  infoCard: {
    display: 'grid',
    gap: '0.4rem',
    padding: '0.8rem 0.9rem',
    borderRadius: '1rem',
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
  },
  // The code row leads the card and hugs the inline-start edge.
  codeRow: { display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: '0.5rem', flexWrap: 'wrap' },
  codeChip: {
    // Light-surface skin; layout comes from .call-code-chip.
    background: '#fff',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    color: 'var(--accent-strong, #216e5d)',
  },
  infoRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' },
  infoLabel: { color: 'var(--text-muted, #557b76)', fontSize: '0.78rem', fontWeight: 700 },
  infoValue: {
    color: 'var(--text, #133b35)',
    fontSize: '0.84rem',
    fontWeight: 700,
    overflowWrap: 'anywhere',
    textAlign: 'end',
  },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' },
};
