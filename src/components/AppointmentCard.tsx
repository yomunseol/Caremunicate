import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CalendarPlus, Phone } from 'lucide-react';
import Icon from './Icon';
import {
  canJoin,
  effectiveStatus,
  formatAppointmentRange,
  formatDayLong,
  isLive,
  statusChipClass,
  type Appointment,
} from '../lib/appointments';
import { roleLabelKey } from '../lib/roles';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// One appointment.
//
// Time range, the other party (name + role badge + mint certified badge when
// their verification_status is 'verified'), a status chip, an overflow with
// reschedule/cancel, and a Join call button that stays disabled until T−10min
// and pulses mint while the call is open.
// ---------------------------------------------------------------------------

export type Counterpart = { name: string; role: string; verified: boolean };

type AppointmentCardProps = {
  appointment: Appointment;
  counterpart: Counterpart;
  /** Which side of the appointment the current user is on. */
  side: 'patient' | 'provider';
  onJoin: (appointment: Appointment) => void;
  onCancel: (appointment: Appointment) => void;
  onConfirm: (appointment: Appointment) => void;
  onReschedule: (appointment: Appointment) => void;
  onAddToCalendar: (appointment: Appointment) => void;
  /** Provider-only triage for a 'requested' row. */
  onApprove: (appointment: Appointment) => void;
  onDecline: (appointment: Appointment) => void;
};

export default function AppointmentCard({
  appointment,
  counterpart,
  side,
  onJoin,
  onCancel,
  onConfirm,
  onReschedule,
  onAddToCalendar,
  onApprove,
  onDecline,
}: AppointmentCardProps) {
  const { t, locale } = useLang();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // The Join gate is time-based, so re-evaluate it on a timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Dev guard: no glyph rendered in this card may measure under 16px.
  useEffect(() => {
    if (!import.meta.env?.DEV) return;
    document.querySelectorAll<SVGElement>('.appt-card svg').forEach((glyph) => {
      const box = glyph.getBoundingClientRect();
      console.assert(
        box.width >= 16 && box.height >= 16,
        'icon size',
        `${box.width.toFixed(1)}x${box.height.toFixed(1)}`,
      );
    });
  }, []);

  const status = effectiveStatus(appointment, now);
  // canJoin already requires status scheduled/confirmed, a real room_id, and
  // the T−10min window — so a 'requested' row can never light the button up.
  const joinable = canJoin(appointment, now);
  const live = isLive(appointment, now);
  const cancelled = status === 'cancelled';

  const statusLabel: Record<string, string> = {
    requested: 'Requested',
    scheduled: 'Scheduled',
    confirmed: 'Confirmed',
    completed: 'Completed',
    cancelled: 'Cancelled',
  };

  return (
    <article className={`appt-card status-${status}`} style={styles.card}>
      <div style={styles.head}>
        <strong style={cancelled ? styles.strike : undefined}>
          {formatDayLong(appointment.start_at, locale)} ·{' '}
          {formatAppointmentRange(appointment, locale)}
        </strong>

        <span className={`appt-status ${statusChipClass(status)}`} style={styles.statusChip}>
          {statusLabel[status] ?? status}
        </span>
      </div>

      <div style={styles.who}>
        <span style={cancelled ? styles.strike : undefined}>{counterpart.name}</span>
        {counterpart.role ? (
          <span style={styles.roleBadge}>{t(roleLabelKey(counterpart.role))}</span>
        ) : null}
        {counterpart.verified ? (
          <span style={styles.verifiedBadge} title={t('verify.verified')} aria-label={t('verify.verified')}>
            ✓
          </span>
        ) : null}
      </div>

      <div style={styles.actions}>
        {status === 'requested' && side === 'patient' ? (
          /* No room exists yet: an amber chip instead of a Join button. */
          <span className="awaiting-chip">{t('cal.awaitingApproval')}</span>
        ) : (
          <button
            type="button"
            className={live ? 'appt-join is-live' : 'appt-join'}
            style={{ ...styles.join, ...(joinable ? styles.joinReady : null) }}
            disabled={!joinable}
            title={joinable ? t('cal.joinCall') : t('cal.joinTooEarly')}
            aria-label={t('cal.joinCall')}
            onClick={() => onJoin(appointment)}
          >
            <Phone size={15} aria-hidden="true" /> {t('cal.joinCall')}
          </button>
        )}

        {side === 'provider' && status === 'requested' ? (
          <>
            <button
              type="button"
              className="primary-button"
              style={styles.triageButton}
              onClick={() => onApprove(appointment)}
            >
              {t('notif.approveRequest')}
            </button>
            <button
              type="button"
              className="ghost-button"
              style={styles.triageButton}
              onClick={() => onDecline(appointment)}
            >
              {t('notif.declineRequest')}
            </button>
          </>
        ) : null}

        <button
          type="button"
          className="ghost-button appt-icon-btn"
          aria-label={t('cal.reschedule')}
          title={t('cal.reschedule')}
          onClick={() => onReschedule(appointment)}
        >
          {/* A 20px glyph, centred in its circle. */}
          <Icon name="calendar-edit" size={20} />
        </button>

        <div ref={menuRef} style={styles.menuWrap}>
          <button
            type="button"
            className="ghost-button appt-icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More"
            title="More"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {/* Three SOLID dots at 20px. */}
            <Icon name="ellipsis-vertical" size={20} />
          </button>

          {menuOpen ? (
            <div className="appt-menu" role="menu" style={styles.menu}>
              {side === 'provider' && status === 'scheduled' ? (
                <button
                  type="button"
                  role="menuitem"
                  style={styles.menuItem}
                  onClick={() => {
                    setMenuOpen(false);
                    onConfirm(appointment);
                  }}
                >
                  Confirm
                </button>
              ) : null}

              {/* Reschedule is the row's own button now, so the menu keeps the
                  .ics export instead of duplicating it. */}
              <button
                type="button"
                role="menuitem"
                style={styles.menuItem}
                onClick={() => {
                  setMenuOpen(false);
                  onAddToCalendar(appointment);
                }}
              >
                <CalendarPlus size={20} aria-hidden="true" /> Add to calendar
              </button>

              {!cancelled ? (
                <button
                  type="button"
                  role="menuitem"
                  style={{ ...styles.menuItem, ...styles.menuDanger }}
                  onClick={() => {
                    setMenuOpen(false);
                    onCancel(appointment);
                  }}
                >
                  {t('cal.cancelAppointment')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    display: 'grid',
    gap: '0.5rem',
    paddingBlock: '0.85rem',
    paddingInline: '0.95rem',
    borderRadius: '1rem',
    background: '#fff',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    boxShadow: '0 10px 24px rgba(17, 55, 47, 0.07)',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
    flexWrap: 'wrap',
    fontSize: '0.86rem',
  },
  strike: { textDecoration: 'line-through', color: 'var(--text-muted, #557b76)' },
  statusChip: {
    paddingBlock: '0.15rem',
    paddingInline: '0.55rem',
    borderRadius: '999px',
    fontSize: '0.68rem',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  who: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' },
  roleBadge: {
    paddingBlock: '0.1rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.14)',
    color: 'var(--accent-strong, #216e5d)',
    fontSize: '0.68rem',
    fontWeight: 800,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  verifiedBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#06231d',
    fontSize: '0.66rem',
    fontWeight: 900,
  },
  actions: { display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' },
  triageButton: {
    paddingBlock: '0.5rem',
    paddingInline: '0.9rem',
    borderRadius: '999px',
    fontWeight: 800,
    fontSize: '0.8rem',
    minHeight: 44,
  },
  join: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.35rem',
    paddingBlock: '0.5rem',
    paddingInline: '0.9rem',
    borderRadius: '999px',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    background: 'var(--bg-panel-strong, #edf9f2)',
    color: 'var(--text-muted, #557b76)',
    fontWeight: 800,
    fontSize: '0.8rem',
    cursor: 'not-allowed',
    minHeight: 44,
  },
  joinReady: {
    background: 'linear-gradient(120deg, #48b58f, #7adab1)',
    borderColor: 'rgba(62, 169, 133, 0.5)',
    color: '#072c2a',
    cursor: 'pointer',
  },
  menuWrap: { position: 'relative' },
  menu: {
    position: 'absolute',
    insetBlockStart: 'calc(100% + 0.3rem)',
    insetInlineEnd: 0,
    zIndex: 20,
    display: 'grid',
    minWidth: '11rem',
    padding: '0.3rem',
    borderRadius: '0.8rem',
    background: '#fff',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    boxShadow: '0 18px 40px rgba(17, 55, 47, 0.18)',
  },
  menuItem: {
    paddingBlock: '0.5rem',
    paddingInline: '0.6rem',
    border: 'none',
    borderRadius: '0.55rem',
    background: 'transparent',
    color: 'var(--text, #133b35)',
    fontSize: '0.82rem',
    fontWeight: 600,
    textAlign: 'start',
    cursor: 'pointer',
  },
  menuDanger: { color: '#9c3636' },
};
