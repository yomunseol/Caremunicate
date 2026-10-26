import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { CalendarOff, CalendarPlus, X } from 'lucide-react';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { describeError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { slotDate } from '../lib/time';
import {
  createAppointment,
  createAppointmentRoom,
  findConflict,
  formatDayLong,
  formatTime,
  loadAvailability,
  loadBusySlots,
  localDayKey,
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
// appointments; patients keep the full booking flow instead.
//
// CF-4 — two fallbacks when the provider's own data is thin:
//   TIME  — with no availability rows the slot dropdown would be dead, so it is
//           replaced by a 15-minute time picker (07:00–22:00) plus a duration
//           select, and a one-click "Apply default weekly hours" button
//           (Mon–Fri 09:00–18:00) that writes availability rows and refreshes
//           the slot dropdown.
//   GUEST — the patient field is a combobox over linked patients with an
//           always-available "+ Guest patient" option (name required, ≥2 chars),
//           which books with patient_id NULL and guest_name set.
// ---------------------------------------------------------------------------

const WIDTH = 288;
const MARGIN = 12;

/** The ad-hoc time picker's bounds and step (used only with no availability). */
const ADHOC_FIRST_MINUTES = 7 * 60; // 07:00
const ADHOC_LAST_MINUTES = 22 * 60; // 22:00
const ADHOC_STEP_MINUTES = 15;

/** The one-click default week: Mon–Fri 09:00–18:00. */
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
const DEFAULT_START = '09:00';
const DEFAULT_END = '18:00';

const toHhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

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
  const patientBoxRef = useRef<HTMLDivElement | null>(null);

  const [title, setTitle] = useState('');
  const [rules, setRules] = useState<Availability[]>([]);
  const [booked, setBooked] = useState<Appointment[]>([]);
  const [slotStart, setSlotStart] = useState('');
  const [adhocTime, setAdhocTime] = useState(DEFAULT_START);
  const [duration, setDuration] = useState<number>(slotMinutes);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientId, setPatientId] = useState<string>(patients[0]?.id ?? '');
  const [guestMode, setGuestMode] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [comboOpen, setComboOpen] = useState(false);
  const [applyingHours, setApplyingHours] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /** Any availability rows at all decide the TIME path. */
  const hasAvailability = rules.length > 0;

  // The provider's own slot length may not be one of the standard durations, so
  // offer the union — otherwise the select would show a blank value. The ad-hoc
  // path offers exactly 15/30/45/60.
  const durationChoices = useMemo(
    () =>
      hasAvailability
        ? [...new Set([...SLOT_CHOICES, slotMinutes])].sort((a, b) => a - b)
        : [...SLOT_CHOICES],
    [hasAvailability, slotMinutes],
  );

  // The ad-hoc time options: 15-minute steps from 07:00 to 22:00.
  const adhocTimes = useMemo(() => {
    const options: string[] = [];
    for (let mins = ADHOC_FIRST_MINUTES; mins <= ADHOC_LAST_MINUTES; mins += ADHOC_STEP_MINUTES) {
      options.push(toHhmm(mins));
    }
    return options;
  }, []);

  // The provider's availability + live busy ranges.
  const load = useMemo(
    () => async () => {
      const [nextRules, nextBusy] = await Promise.all([
        loadAvailability(providerId),
        loadBusySlots(providerId),
      ]);
      setRules(nextRules);
      setBooked(nextBusy);
    },
    [providerId],
  );

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

  // Default the slot dropdown to the clicked slot (if open), else the first open
  // one — only relevant when the provider HAS availability.
  useEffect(() => {
    if (!hasAvailability || slotStart) return;
    const clicked = slotStates.find(
      (state) =>
        state.available && state.start.getHours() * 60 + state.start.getMinutes() === minutes,
    );
    const pick = clicked ?? slotStates.find((state) => state.available);
    if (pick) setSlotStart(pick.start.toISOString());
  }, [hasAvailability, slotStates, minutes, slotStart]);

  // The chosen START, from whichever time path is active.
  const startDate = useMemo(() => {
    if (hasAvailability) {
      return slotStates.find((state) => state.start.toISOString() === slotStart)?.start ?? null;
    }
    const key = localDayKey(day);
    return key ? slotDate(key, adhocTime) : null;
  }, [hasAvailability, slotStates, slotStart, day, adhocTime]);

  // The linked patients that match the typed query.
  const patientMatches = useMemo(() => {
    const query = patientQuery.trim().toLowerCase();
    if (!query) return patients;
    return patients.filter((patient) => (patient.name || patient.id).toLowerCase().includes(query));
  }, [patients, patientQuery]);

  const guestNameValid = guestName.trim().length >= 2;
  const canCreate = Boolean(startDate) && !saving && (guestMode ? guestNameValid : Boolean(patientId));

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
  const top = Math.max(MARGIN, Math.min(anchor.y, window.innerHeight - 360));

  /** Writes the default week (Mon–Fri 09:00–18:00) through the CF-1 availability
   *  table, then refreshes so the slot dropdown takes over. */
  const applyDefaultHours = async () => {
    if (applyingHours || !providerId) return;
    setApplyingHours(true);
    setError('');
    try {
      const payload = DEFAULT_WEEKDAYS.map((weekday) => ({
        host_id: providerId,
        weekday,
        start_time: DEFAULT_START,
        end_time: DEFAULT_END,
        slot_min: duration,
        buffer_min: 0,
      }));

      const { error: upsertError } = await supabase
        .from('availability')
        .upsert(payload, { onConflict: 'host_id,weekday,start_time' });
      if (upsertError) throw upsertError;

      await load();
      notify(t('cal.availabilitySaved'), 'success');
    } catch (caught) {
      console.error('CALENDAR ERROR:', caught);
      setError(describeError(caught));
    } finally {
      setApplyingHours(false);
    }
  };

  const selectPatient = (patient: PersonInfo) => {
    setGuestMode(false);
    setPatientId(patient.id);
    setPatientQuery(patient.name || patient.id);
    setComboOpen(false);
  };

  const selectGuest = () => {
    setGuestMode(true);
    setPatientId('');
    setPatientQuery(t('cal.guestPatient'));
    setComboOpen(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate || !startDate) return;

    const start = startDate;
    const end = new Date(start.getTime() + duration * 60_000);

    setSaving(true);
    setError('');
    try {
      // Client pre-check: never fire an obviously-overlapping block.
      if (findConflict({ start, end }, booked, ruleBuffer)) {
        setError(OVERLAP_MESSAGE_KEY);
        return;
      }

      const created = await createAppointment({
        patientId: guestMode ? null : patientId,
        guestName: guestMode ? guestName.trim() : null,
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
          <span>{t('cal.time')}</span>
          {hasAvailability ? (
            <select
              className="input"
              dir="ltr"
              aria-label={t('cal.time')}
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
                    {state.available
                      ? ''
                      : state.reason === 'buffer'
                        ? ` · ${tString('cal.bufferBlocked', { n: ruleBuffer })}`
                        : ` · ${t('cal.slotUnavailable')}`}
                  </option>
                ))
              )}
            </select>
          ) : (
            /* No availability rows: a live 15-minute picker, never a dead dropdown. */
            <select
              className="input"
              dir="ltr"
              aria-label={t('cal.time')}
              value={adhocTime}
              onChange={(event) => setAdhocTime(event.target.value)}
            >
              {adhocTimes.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          )}
        </label>

        <label className="cal-field">
          <span>{t('cal.duration')}</span>
          <select
            className="input"
            value={duration}
            aria-label={t('cal.duration')}
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

      {/* No availability: explain the fallback and offer the one-click fix. */}
      {!hasAvailability ? (
        <>
          <p className="cal-hint">{t('cal.noAvailabilityHint')}</p>
          <button
            type="button"
            className="ghost-button cal-inline-cta"
            disabled={applyingHours}
            aria-busy={applyingHours}
            onClick={() => void applyDefaultHours()}
          >
            <CalendarPlus size={15} aria-hidden="true" /> {t('cal.applyDefaultHours')}
          </button>
        </>
      ) : null}

      {/* Patient: combobox over linked patients + an always-available guest row. */}
      <div className="cal-field" ref={patientBoxRef}>
        <span>{t('cal.bookAppointment')}</span>
        <input
          className="input"
          value={patientQuery}
          role="combobox"
          aria-expanded={comboOpen}
          aria-label={t('cal.bookAppointment')}
          onFocus={() => setComboOpen(true)}
          onChange={(event) => {
            setPatientQuery(event.target.value);
            setGuestMode(false);
            setPatientId('');
            setComboOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setComboOpen(false), 120)}
        />

        {comboOpen ? (
          <ul className="cal-combo-list" role="listbox" aria-label={t('cal.bookAppointment')}>
            {patientMatches.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={!guestMode && patientId === patient.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectPatient(patient)}
                >
                  {patient.name || patient.id}
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={guestMode}
                onMouseDown={(event) => event.preventDefault()}
                onClick={selectGuest}
              >
                + {t('cal.guestPatient')}
              </button>
            </li>
          </ul>
        ) : null}

        {patients.length === 0 && !guestMode ? (
          <span className="cal-hint">
            <CalendarOff size={14} aria-hidden="true" /> {t('cal.noLinkedPatients')}
          </span>
        ) : null}

        {guestMode ? (
          <input
            className="input"
            value={guestName}
            required
            minLength={2}
            placeholder={t('cal.guestNamePlaceholder')}
            aria-label={t('cal.guestNamePlaceholder')}
            aria-invalid={guestName.length > 0 && !guestNameValid}
            onChange={(event) => setGuestName(event.target.value)}
          />
        ) : null}
      </div>

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
        <button type="submit" className="primary-button" disabled={!canCreate} aria-busy={saving}>
          {t('cal.create')}
        </button>
      </div>
    </form>
  );
}
