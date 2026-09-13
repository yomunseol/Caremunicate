import { useState, type CSSProperties } from 'react';
import { Mic, MicOff, Video, VideoOff } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';
import CallDevicePicker from './CallDevicePicker';

// ---------------------------------------------------------------------------
// The green room.
//
// Rendered after room auth and BEFORE any peer connection exists: all we hold
// is a local getUserMedia preview. Nothing is announced to the room and no
// RTCPeerConnection is created until "Join now" (commitJoin).
// ---------------------------------------------------------------------------

export default function CallPreJoin() {
  const { t } = useLang();
  const {
    localStream,
    roomCode,
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

  // Toggling here flips the preview track itself; the same track is handed to
  // the peer connections on join, so the choice carries into the call.
  const toggleTrack = (kind: 'audio' | 'video') => {
    const track = kind === 'audio' ? localStream?.getAudioTracks()[0] : localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    if (kind === 'audio') setMicOn(track.enabled);
    else setCamOn(track.enabled);
  };

  return (
    <div style={styles.shell} role="dialog" aria-modal="true" aria-label={t('call.prejoinTitle')}>
      <div style={styles.card}>
        <h2 style={styles.title}>{t('call.prejoinTitle')}</h2>

        {roomCode ? (
          <p style={styles.codeRow}>
            <span style={styles.codeLabel}>{t('call.callCode')}</span>
            <span style={styles.code} dir="ltr">{roomCode}</span>
          </p>
        ) : null}

        <div style={styles.previewWrap}>
          {/* Ref-callback attach: the element is bound to the stream the moment
              it mounts, and only re-attached when the stream object changes. */}
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
          {!camOn ? <span style={styles.cameraOff}>{t('call.prejoinTitle')}</span> : null}
        </div>

        <div style={styles.toggles}>
          <button
            type="button"
            onClick={() => toggleTrack('audio')}
            aria-pressed={micOn}
            style={{ ...styles.toggle, ...(micOn ? null : styles.toggleOff) }}
          >
            {micOn ? <Mic size={16} /> : <MicOff size={16} />}
          </button>
          <button
            type="button"
            onClick={() => toggleTrack('video')}
            aria-pressed={camOn}
            style={{ ...styles.toggle, ...(camOn ? null : styles.toggleOff) }}
          >
            {camOn ? <Video size={16} /> : <VideoOff size={16} />}
          </button>
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
    background: 'rgba(6, 26, 22, 0.86)',
    overflowY: 'auto',
  },
  card: {
    display: 'grid',
    gap: '0.8rem',
    width: 'min(32rem, 100%)',
    padding: '1.25rem',
    borderRadius: '1.15rem',
    background: '#f7fdf9',
    border: '1px solid rgba(62, 169, 133, 0.3)',
    boxShadow: '0 28px 64px rgba(6, 26, 22, 0.4)',
  },
  title: { margin: 0, fontSize: '1.15rem', color: '#133b35' },
  codeRow: { display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0, flexWrap: 'wrap' },
  codeLabel: { color: '#557b76', fontSize: '0.76rem', fontWeight: 700 },
  code: {
    paddingBlock: '0.25rem',
    paddingInline: '0.6rem',
    borderRadius: '0.6rem',
    background: 'rgba(62, 169, 133, 0.14)',
    color: '#216e5d',
    fontWeight: 800,
    letterSpacing: '0.04em',
    overflowWrap: 'anywhere',
  },
  previewWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16 / 9',
    background: '#0d1f1b',
    borderRadius: '0.9rem',
    overflow: 'hidden',
  },
  // Local preview is always mirrored; remote video never is.
  preview: { width: '100%', height: '100%', objectFit: 'contain', transform: 'scaleX(-1)' },
  cameraOff: {
    position: 'absolute',
    insetBlockEnd: '0.5rem',
    insetInlineStart: '0.5rem',
    color: '#cfe9df',
    fontSize: '0.72rem',
  },
  toggles: { display: 'flex', gap: '0.5rem' },
  toggle: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    borderRadius: '50%',
    border: '1px solid rgba(62, 169, 133, 0.3)',
    background: 'rgba(62, 169, 133, 0.12)',
    color: '#216e5d',
    cursor: 'pointer',
  },
  toggleOff: { background: 'rgba(224, 101, 90, 0.16)', borderColor: 'rgba(224, 101, 90, 0.4)', color: '#9c3636' },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' },
};
