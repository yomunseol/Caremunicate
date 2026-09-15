import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CalendarOff, X } from 'lucide-react';
import { useLang } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  createAppointment,
  formatDayLong,
  SLOT_CHOICES,
  type PersonInfo,
} from '../lib/appointments';
import type { Anchor } from './CalendarEventPopover';

// ---------------------------------------------------------------------------
// Quick-create — an ANCHORED popover, not a modal.
//
// Click any empty slot in the time grid and this opens where you clicked, with
// the time already filled from the slot. Providers save straight to
// appointments; patients keep the full booking flow instead (they have to pick
// a provider first), so this is only ever mounted for a provider.
// ---------------------------------------------------------------------------

const WIDTH = 288;
const MARGIN = 12;

const pad = (value: number): string => String(value).padStart(2, '0');

type QuickCreatePopoverProps = {
  anchor: Anchor;
  day: Date;
  /** Minutes from local midnight, from the clicked slot. */
  minutes: number;
  providerId: string;
  patients: PersonInfo[];
  onClose: () => void;
  onCreated: () => void;
};

export default function QuickCreatePopover({
  anchor,
  day,
  minutes,
  providerId,
  patients,
  onClose,
  onCreated,
}: QuickCreatePopoverProps) {
  const { t, locale } = useLang();
  const trapRef = useFocusTrap<HTMLFormElement>(true);
  const nodeRef = useRef<HTMLFormElement | null>(null);

  const [title, setTitle] = useState('');
  const [time, setTime] = useState(`${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`);
  const [duration, setDuration] = useState<number>(SLOT_CHOICES[1]);
  const [patientId, setPatientId] = useState(patients[0]?.id ?? '');
  const [saving, setSaving] = useState(false);

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

  const left = Math.max(MARGIN, Math.min(anchor.x, window.innerWidth - WIDTH - MARGIN));
  const top = Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - 330));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!patientId || saving) return;

    const [hours, mins] = time.split(':').map(Number);
    const start = new Date(day);
    start.setHours(hours || 0, mins || 0, 0, 0);
    const end = new Date(start.getTime() + duration * 60_000);

    setSaving(true);
    const created = await createAppointment({
      patientId,
      providerId,
      roomId: null,
      roomCode: null,
      start,
      end,
      note: title.trim() || undefined,
    });
    setSaving(false);

    if (created) {
      onCreated();
      onClose();
    }
  };

  return (
    <form
      ref={(node) => {
        nodeRef.current = node;
        trapRef.current = node;
      }}
      className="cal-popover cal-quickcreate"
      role="dialog"
      aria-modal="false"
      aria-label={t('cal.bookAppointment')}
      style={{ top, insetInlineStart: left, width: WIDTH }}
      onSubmit={(event) => void submit(event)}
    >
      <div className="cal-popover-head">
        <span className="cal-popover-title">{formatDayLong(day, locale)}</span>
        <button
          type="button"
          className="cal-icon-btn ghost-button"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <label className="cal-field">
        <span>{t('cal.appointments')}</span>
        <input
          className="input"
          value={title}
          autoFocus
          placeholder="—"
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>

      <div className="cal-field-row">
        <label className="cal-field">
          <span>Time</span>
          <input
            className="input"
            type="time"
            dir="ltr"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </label>

        <label className="cal-field">
          <span>Duration</span>
          <select
            className="input"
            value={duration}
            aria-label="Duration"
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            {SLOT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} min
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="cal-field">
        <span>{t('cal.bookAppointment')}</span>
        {patients.length > 0 ? (
          <select
            className="input"
            value={patientId}
            onChange={(event) => setPatientId(event.target.value)}
          >
            {patients.map((patient) => (
              <option key={patient.id} value={patient.id}>
                {patient.name || patient.id}
              </option>
            ))}
          </select>
        ) : (
          /* No bare '—': say why there is nothing to pick. */
          <span className="cal-empty-state cal-empty-state-inline">
            <CalendarOff size={18} aria-hidden="true" />
            {/* Not yet translated — needs the 10-locale string. */}
            <span>No patients to book with yet.</span>
          </span>
        )}
      </label>

      <div className="cal-popover-actions">
        <button type="button" className="ghost-button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="primary-button"
          disabled={saving || !patientId}
          aria-busy={saving}
        >
          {t('cal.create')}
        </button>
      </div>
    </form>
  );
}
