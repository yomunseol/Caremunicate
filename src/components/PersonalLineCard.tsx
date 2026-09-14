import { useEffect, useState, type CSSProperties } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { ensurePersonalRoom, setPersonalRoomStatus, type PersonalRoom } from '../lib/callRooms';

// ---------------------------------------------------------------------------
// Personal line.
//
// Every user has ONE personal room, created lazily on first view. Its code is
// derived deterministically from their user id (see lib/wordcode.ts), so it is
// stable without a lookup, and it is the identifier people type to reach them.
//
// "Open my line" flips the room between status 'active' and 'waiting'. A caller
// joining while it is 'waiting' is told the person is unavailable and nothing
// rings — no lobby, no offer.
// ---------------------------------------------------------------------------

export default function PersonalLineCard() {
  const { user } = useAuth();
  const { t } = useLang();

  const [room, setRoom] = useState<PersonalRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!user?.id) {
        setLoading(false);
        return;
      }
      const created = await ensurePersonalRoom(user.id);
      if (cancelled) return;
      setRoom(created);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const isOpen = room?.status === 'active';

  const toggleLine = async () => {
    if (!room || busy) return;
    setBusy(true);
    try {
      const next = isOpen ? 'waiting' : 'active';
      await setPersonalRoomStatus(room.id, next);
      setRoom({ ...room, status: next });
    } catch (error) {
      console.error('CALL ERROR:', error);
    } finally {
      setBusy(false);
    }
  };

  const copyCode = () => {
    if (!room) return;
    setCopied(true);
    void navigator.clipboard
      ?.writeText(room.code)
      .catch(() => {})
      .finally(() => window.setTimeout(() => setCopied(false), 2000));
  };

  // Nothing to show until the line exists (and there is nothing to show if the
  // project has no `personal` column — the card simply stays hidden).
  if (loading || !room) return null;

  return (
    <div className="panel">
      <div className="eyebrow">{t('call.personalCode')}</div>

      <div style={styles.row}>
        <span className="call-code-chip" style={styles.chip} dir="ltr" title={room.code}>
          {room.code}
        </span>
        <button type="button" className="ghost-button" onClick={copyCode} title={t('call.copyCode')}>
          {copied ? t('call.copied') : `📋 ${t('call.copyCode')}`}
        </button>
      </div>

      <div style={styles.toggleRow}>
        <span className="call-switch-label">{t('call.openLine')}</span>
        <button
          type="button"
          role="switch"
          aria-checked={isOpen}
          aria-label={t('call.openLine')}
          className={isOpen ? 'call-switch is-on' : 'call-switch'}
          disabled={busy}
          onClick={() => void toggleLine()}
        >
          <span className="call-switch-knob" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  chip: {
    // Light-surface variant; the layout (mono, single line, truncation) comes
    // from .call-code-chip.
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    color: 'var(--accent-strong, #216e5d)',
  },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' },
};
