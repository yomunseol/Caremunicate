import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarOff, X } from 'lucide-react';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  createAppointment,
  createAppointmentRoom,
  findConflict,
  formatDayLong,
  formatTime,
  loadAvailability,
  loadBusySlots,
  slotStatesForDate,
  SLOT_BUFFER_MINUTES,
  SLOT_CHOICES,
  OVERLAP_MESSAGE_KEY,
  type Appointment,
  type Availability,
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

type QuickCreatePopoverProps = {
  anchor: Anchor;
  day: Date;
  /** Minutes from local midnight, from the clicked slot. */
  minutes: number;
  providerId: string;
  patients: PersonInfo[];
  /** The provider's saved slot length — the default duration. */
  slotMinutes: number;
  onClose: () => void;
  onCreated: () => void;
};

export default function QuickCreatePopover({
  anchor,
  day,
  minutes,
  providerId,
  patients,
  slotMinutes,
  onClose,
  onCreated,
}: QuickCreatePopoverProps) {
  const { t, tString, locale } = useLang();
  const { notify } = useToast();
  const trapRef = useFocusTrap<HTMLFormElement>(true);
  const nodeRef = useRef<HTMLFormElement | null>(null);

  const [title, setTitle] = useState('');
  const [rules, setRules] = useState<Availability[]>([]);
  const [booked, setBooked] = useState<Appointment[]>([]);
  const [slotStart, setSlotStart] = useState('');
  const [duration, setDuration] = useState<number>(slotMinutes);
  const [patientId, setPatientId] = useState(patients[0]?.id ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // The provider's own slot length may not be one of the standard durations, so
  // offer the union — otherwise the select would show a blank value.
  const durationChoices = useMemo(
    () => [...new Set([...SLOT_CHOICES, slotMinutes])].sort((a, b) => a - b),
    [slotMinutes],
  );

  // The provider's availability + live busy ranges, so the time picker offers
  // exactly the open slots (and shows the taken ones disabled).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [nextRules, nextBusy] = await Promise.all([
        loadAvailability(providerId),
        loadBusySlots(providerId),
      ]);
      if (cancelled) return;
      setRules(nextRules);
      setBooked(nextBusy);
    })();
    return () => {
      cancelled = true;
    };
  }, [providerId]);

  const ruleBuffer = useMemo(() => {
    const rule = rules.find((item) => Number(item.weekday) === day.getDay());
    const value = Number(rule?.buffer_minutes);
    return Number.isFinite(value) ? value : SLOT_BUFFER_MINUTES;
  }, [rules, day]);

  const slotStates = useMemo(
    () => slotStatesForDate(day, rules, booked),
    [day, rules, booked],
  );

  // Default to the slot that was clicked (if it is open), else the first open
  // one — never a slot the provider cannot actually take.
  useEffect(() => {
    if (slotStart) return;
    const clicked = slotStates.find(
      (state) =>
        state.available && state.start.getHours() * 60 + state.start.getMinutes() === minutes,
    );
    const pick = clicked ?? slotStates.find((state) => state.available);
    if (pick) setSlotStart(pick.start.toISOString());
  }, [slotStates, minutes, slotStart]);

  const chosen = useMemo(
    () => slotStates.find((state) => state.start.toISOString() === slotStart) ?? null,
    [slotStates, slotStart],
  );

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
    if (!patientId || saving || !chosen) return;

    const start = chosen.start;
    const end = new Date(start.getTime() + duration * 60_000);

    setSaving(true);
    setError('');
    try {
      // Client pre-check: never fire an obviously-overlapping block.
      if (findConflict({ start, end }, booked, 0, ruleBuffer)) {
        setError(OVERLAP_MESSAGE_KEY);
        return;
      }

      const created = await createAppointment({
        patientId,
        providerId,
        roomId: null,
        roomCode: null,
        start,
        end,
        note: title.trim() || undefined,
      });

      if (!created.ok) {
        setError(created.code);
        return;
      }
      if (!created.appointment) {
        setError('createFailed');
        return;
      }

      // The room is minted SERVER-side, which is also what notifies the patient.
      const linked = await createAppointmentRoom(created.appointment.id);

      if (!linked.ok) {
        console.error('CALENDAR ERROR: create_appointment_room', linked.code);

        if (linked.missing) {
          // The FUNCTION is absent. Say so loudly with the raw code and stop —
          // never silently skip room linking, and never claim success.
          notify(`server function missing: create_appointment_room (${linked.code})`, 'error');
          setError('createRoomMissing');
          onCreated();
          return;
        }

        setError(linked.code);
        onCreated();
        return;
      }

      notify(tString('notif.notifApproved', { code: linked.code }), 'success');
      onCreated();
      onClose();
    } finally {
      setSaving(false);
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
          <select
            className="input"
            dir="ltr"
            aria-label="Time"
            value={slotStart}
            disabled={slotStates.length === 0}
            onChange={(event) => setSlotStart(event.target.value)}
          >
            {slotStates.length === 0 ? (
              <option value="">{t('cal.noSlotsYet')}</option>
            ) : (
              slotStates.map((state) => (
                <option
                  key={state.start.toISOString()}
                  value={state.start.toISOString()}
                  disabled={!state.available}
                >
                  {formatTime(state.start, locale)}
                  {state.available ? '' : ` · ${t('cal.slotUnavailable')}`}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="cal-field">
          <span>Duration</span>
          <select
            className="input"
            value={duration}
            aria-label="Duration"
            onChange={(event) => setDuration(Number(event.target.value))}
          >
            {durationChoices.map((choice) => (
              <option key={choice} value={choice}>
                {t('cal.minUnit', { count: choice })}
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

      {/* Overlap → the translated line; anything else self-reports its raw code. */}
      {error ? (
        <span className="field-error" role="alert">
          {error === OVERLAP_MESSAGE_KEY ? (
            t('cal.slotTaken')
          ) : (
            <span className="error-detail">{error}</span>
          )}
        </span>
      ) : null}

      <div className="cal-popover-actions">
        <button type="button" className="ghost-button" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          className="primary-button"
          disabled={saving || !patientId || !chosen}
          aria-busy={saving}
        >
          {t('cal.create')}
        </button>
      </div>
    </form>
  );
}
