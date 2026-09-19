import { useEffect, useRef } from 'react';
import { CalendarPlus, Phone, X } from 'lucide-react';
import { useLang } from '../i18n';
import { roleLabelKey } from '../lib/roles';
import {
  canJoin,
  effectiveStatus,
  formatAppointmentRange,
  statusChipClass,
  type Appointment,
} from '../lib/appointments';
import { useFocusTrap } from '../hooks/useFocusTrap';

// ---------------------------------------------------------------------------
// Anchored detail popover for a time-grid block. Deliberately a popover, not a
// modal: it opens next to the event you clicked, closes on Escape or an outside
// click, and never blocks the grid behind it.
// ---------------------------------------------------------------------------

export type Anchor = { x: number; y: number };

const WIDTH = 268;
const MARGIN = 12;

/** Same labels the appointment card uses, so chip copy reads identically. */
const STATUS_LABEL: Record<string, string> = {
  requested: 'Requested',
  scheduled: 'Scheduled',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

type CalendarEventPopoverProps = {
  appointment: Appointment;
  anchor: Anchor;
  title: string;
  role: string;
  verified: boolean;
  side: 'patient' | 'provider';
  onClose: () => void;
  onJoin: (appointment: Appointment) => void;
  onCancel: (appointment: Appointment) => void;
  onConfirm: (appointment: Appointment) => void;
  onReschedule: (appointment: Appointment) => void;
  onAddToCalendar: (appointment: Appointment) => void;
  /** Provider-only triage for a 'requested' appointment. */
  onApprove: (appointment: Appointment) => void;
  onDecline: (appointment: Appointment) => void;
};

export default function CalendarEventPopover({
  appointment,
  anchor,
  title,
  role,
  verified,
  side,
  onClose,
  onJoin,
  onCancel,
  onConfirm,
  onReschedule,
  onAddToCalendar,
  onApprove,
  onDecline,
}: CalendarEventPopoverProps) {
  const { t, locale } = useLang();
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  const nodeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const onDown = (event: MouseEvent) => {
      if (!nodeRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);

  const status = effectiveStatus(appointment);
  // canJoin enforces scheduled/confirmed + a real room + the T−10min window.
  const joinable = canJoin(appointment);
  const left = Math.max(MARGIN, Math.min(anchor.x, window.innerWidth - WIDTH - MARGIN));
  const top = Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - 260));

  return (
    <div
      ref={(node) => {
        nodeRef.current = node;
        trapRef.current = node;
      }}
      className="cal-popover"
      role="dialog"
      aria-modal="false"
      aria-label={title}
      style={{ top, insetInlineStart: left, width: WIDTH }}
    >
      <div className="cal-popover-head">
        <span className="cal-popover-title">
          {title}
          {verified ? (
            <span className="cal-verified-dot" title="Verified" aria-label="Verified">
              ✓
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="cal-icon-btn ghost-button"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <span className={`cal-status ${statusChipClass(status)}`}>
        {STATUS_LABEL[status] ?? status}
      </span>
      <p className="cal-popover-when">
        {formatAppointmentRange(appointment, locale)}
      </p>
      {role ? <p className="cal-popover-role">{t(roleLabelKey(role))}</p> : null}
      {appointment.note ? <p className="cal-popover-note">{appointment.note}</p> : null}

      <div className="cal-popover-actions">
        <button
          type="button"
          className="primary-button"
          disabled={!joinable}
          title={joinable ? t('cal.joinCall') : t('cal.joinTooEarly')}
          onClick={() => onJoin(appointment)}
        >
          <Phone size={14} aria-hidden="true" /> {t('cal.joinCall')}
        </button>

        {side === 'provider' && status === 'requested' ? (
          <>
            <button type="button" className="primary-button" onClick={() => onApprove(appointment)}>
              {t('notif.approveRequest')}
            </button>
            <button type="button" className="ghost-button" onClick={() => onDecline(appointment)}>
              {t('notif.declineRequest')}
            </button>
          </>
        ) : null}

        {status !== 'cancelled' && status !== 'completed' && status !== 'requested' ? (
          <>
            {side === 'provider' && status === 'scheduled' ? (
              <button type="button" className="ghost-button" onClick={() => onConfirm(appointment)}>
                Confirm
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={() => onReschedule(appointment)}>
              {t('cal.reschedule')}
            </button>
            <button type="button" className="ghost-button" onClick={() => onCancel(appointment)}>
              {t('cal.cancelAppointment')}
            </button>
          </>
        ) : null}

        <button
          type="button"
          className="ghost-button"
          aria-label="Add to calendar"
          title="Add to calendar"
          onClick={() => onAddToCalendar(appointment)}
        >
          <CalendarPlus size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
