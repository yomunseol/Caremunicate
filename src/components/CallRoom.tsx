import { useEffect, useRef, type CSSProperties } from 'react';
import { Mic, MicOff, Phone, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Calling UI: incoming-call modal + in-call overlay. Rendered once by
// CallProvider, so every "Video call" button in the app routes through it.
// ---------------------------------------------------------------------------

/** Binds a MediaStream to a <video> element. */
function VideoTile({ stream, muted = false }: { stream: MediaStream | null; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.srcObject = stream ?? null;
  }, [stream]);

  return <video ref={ref} autoPlay playsInline muted={muted} style={styles.tile} />;
}

export default function CallRoom() {
  const { t } = useLang();
  const {
    status,
    kind,
    incoming,
    peers,
    localStream,
    audioOnly,
    muted,
    cameraOff,
    quality,
    notice,
    acceptCall,
    declineCall,
    endCall,
    toggleMic,
    toggleCamera,
    clearNotice,
  } = useCallContext();

  const emergency = kind === 'emergency';
  const inSession =
    status === 'outgoing' || status === 'connecting' || status === 'active' || status === 'reconnecting';

  // Toast-style notices auto-dismiss so they can never trap the user.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(clearNotice, 6000);
    return () => window.clearTimeout(id);
  }, [notice, clearNotice]);

  if (incoming && status === 'incoming') {
    return (
      <div style={styles.backdrop} role="dialog" aria-modal="true" aria-label={t('call.incoming')}>
        <div style={styles.modal}>
          <strong style={styles.modalTitle}>
            {emergency ? t('call.emergencyActive') : t('call.incoming')}
          </strong>
          <p style={styles.modalBody}>{incoming.from}</p>
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
    );
  }

  if (!inSession && !notice) return null;

  return (
    <>
      {inSession ? (
        <div
          style={{ ...styles.overlay, ...(emergency ? styles.overlayEmergency : null) }}
          role="dialog"
          aria-modal="true"
          aria-label={emergency ? t('call.emergencyActive') : t('call.connecting')}
        >
          {emergency ? (
            <div style={styles.emergencyBanner}>
              <span className="emergency-pulse" aria-hidden="true" />
              {t('call.emergencyActive')}
            </div>
          ) : null}

          <div style={styles.stage}>
            {peers.length === 0 ? (
              <p style={styles.stageHint}>
                {status === 'reconnecting' ? t('call.reconnecting') : t('call.connecting')}
              </p>
            ) : (
              peers.map((peer) => <VideoTile key={peer.id} stream={peer.stream} />)
            )}
          </div>

          <div style={styles.selfWrap}>
            <VideoTile stream={localStream} muted />
            {cameraOff || audioOnly ? <span style={styles.selfOff}>{t('call.reconnecting')}</span> : null}
          </div>

          <div style={styles.bar}>
            <span
              style={{
                ...styles.qualityDot,
                background: quality === 'good' ? '#2d9c78' : quality === 'fair' ? '#d8a13a' : '#e0655a',
              }}
              aria-hidden="true"
            />

            <button
              type="button"
              onClick={toggleMic}
              aria-label={muted ? t('call.accept') : t('call.decline')}
              style={styles.iconButton}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
            </button>

            <button
              type="button"
              onClick={toggleCamera}
              aria-label={cameraOff ? t('call.accept') : t('call.decline')}
              style={styles.iconButton}
              disabled={audioOnly}
            >
              {cameraOff || audioOnly ? <VideoOff size={18} /> : <Video size={18} />}
            </button>

            <button type="button" onClick={endCall} aria-label={t('call.ended')} style={styles.endButton}>
              <PhoneOff size={18} />
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <div style={styles.notice} role="status" aria-live="polite">
          {notice === 'declined'
            ? t('call.ended')
            : notice === 'continue-in-chat'
              ? t('chat.messages')
              : t('call.ended')}
        </div>
      ) : null}
    </>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 120,
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
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 115,
    display: 'grid',
    gridTemplateRows: 'auto 1fr auto',
    gap: '0.75rem',
    paddingBlock: '1rem',
    paddingInline: '1rem',
    background: 'rgba(6, 26, 22, 0.86)',
    color: '#f2fffa',
  },
  overlayEmergency: { background: 'rgba(38, 10, 8, 0.9)' },
  emergencyBanner: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    justifySelf: 'center',
    paddingBlock: '0.5rem',
    paddingInline: '1rem',
    borderRadius: '999px',
    background: 'rgba(224, 101, 90, 0.22)',
    border: '1px solid rgba(224, 101, 90, 0.5)',
    color: '#ffd9d4',
    fontWeight: 800,
  },
  stage: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '0.6rem',
    alignContent: 'center',
    minHeight: 0,
  },
  stageHint: { margin: 0, textAlign: 'center', color: '#cfe9df', gridColumn: '1 / -1' },
  tile: { width: '100%', height: '100%', minHeight: '12rem', objectFit: 'cover', borderRadius: '0.9rem', background: '#0d1f1b' },
  selfWrap: { position: 'absolute', insetBlockEnd: '5.5rem', insetInlineEnd: '1rem', width: '9rem' },
  selfOff: { fontSize: '0.7rem', color: '#cfe9df' },
  bar: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem' },
  qualityDot: { width: '0.6rem', height: '0.6rem', borderRadius: '50%', marginInlineEnd: '0.4rem' },
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 46,
    height: 46,
    borderRadius: '50%',
    border: '1px solid rgba(255, 255, 255, 0.25)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  endButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 52,
    height: 52,
    border: 'none',
    borderRadius: '50%',
    background: 'linear-gradient(120deg, #e0655a, #f0a099)',
    color: '#4a1610',
    cursor: 'pointer',
  },
  notice: {
    position: 'fixed',
    insetBlockEnd: '1.5rem',
    insetInline: '50%',
    transform: 'translateX(50%)',
    zIndex: 121,
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
