import type { CSSProperties } from 'react';
import { Crown, Hand, MicOff, UserMinus, VideoOff, X } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Participants slide-over. Reads the single call store; the host can lower
// someone else's raised hand.
// ---------------------------------------------------------------------------

type CallParticipantsPanelProps = {
  onClose: () => void;
};

export default function CallParticipantsPanel({ onClose }: CallParticipantsPanelProps) {
  const { t } = useLang();
  const { participants, isHost, lowerPeerHand, kickPeer } = useCallContext();

  return (
    <aside className="call-participants" style={styles.panel} role="dialog" aria-label={t('call.participants')}>
      <header style={styles.head}>
        <strong>{t('call.participants')}</strong>
        <button type="button" onClick={onClose} aria-label={t('common.close')} style={styles.close}>
          <X size={16} />
        </button>
      </header>

      <ul style={styles.list}>
        {participants.map((person) => (
          <li key={person.id} style={styles.row}>
            <span style={styles.dot} data-state={person.connection} aria-hidden="true" />
            <span style={styles.name}>
              {person.name}
              {person.host ? (
                <span style={styles.hostBadge} title={t('call.participants')}>
                  <Crown size={12} aria-hidden="true" />
                </span>
              ) : null}
            </span>

            <span style={styles.flags}>
              {person.hand ? <Hand size={15} aria-label={t('call.raiseHand')} /> : null}
              {!person.micOn ? <MicOff size={15} aria-hidden="true" /> : null}
              {!person.camOn ? <VideoOff size={15} aria-hidden="true" /> : null}
              {isHost && !person.self && person.hand ? (
                <button
                  type="button"
                  onClick={() => lowerPeerHand(person.id)}
                  style={styles.lower}
                >
                  {t('call.raiseHand')}
                </button>
              ) : null}

              {isHost && !person.self ? (
                <button
                  type="button"
                  onClick={() => kickPeer(person.id)}
                  style={styles.remove}
                  title={t('call.removeParticipant')}
                  aria-label={`${t('call.removeParticipant')} — ${person.name}`}
                >
                  <UserMinus size={14} aria-hidden="true" />
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineEnd: 0,
    zIndex: 1,
    width: 'min(22rem, 88vw)',
    pointerEvents: 'auto',
    display: 'grid',
    gridTemplateRows: 'auto 1fr',
    gap: '0.5rem',
    padding: '0.9rem',
    background: 'rgba(9, 32, 27, 0.96)',
    borderInlineStart: '1px solid rgba(255, 255, 255, 0.16)',
    color: '#f2fffa',
    overflowY: 'auto',
  },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' },
  close: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(255, 255, 255, 0.12)',
    color: '#f2fffa',
    cursor: 'pointer',
  },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.4rem', alignContent: 'start' },
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' },
  dot: { width: '0.5rem', height: '0.5rem', borderRadius: '50%', background: '#2d9c78', flexShrink: 0 },
  name: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', overflowWrap: 'anywhere', minWidth: 0 },
  hostBadge: { display: 'inline-flex', alignItems: 'center', color: '#f0d27a' },
  flags: { display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginInlineStart: 'auto', color: '#cfe9df' },
  lower: {
    paddingBlock: '0.2rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    border: '1px solid rgba(255, 255, 255, 0.28)',
    background: 'rgba(255, 255, 255, 0.1)',
    color: '#f2fffa',
    fontSize: '0.68rem',
    cursor: 'pointer',
  },
  remove: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: '50%',
    border: '1px solid rgba(224, 101, 90, 0.5)',
    background: 'rgba(224, 101, 90, 0.18)',
    color: '#ffd9d4',
    cursor: 'pointer',
  },
};
