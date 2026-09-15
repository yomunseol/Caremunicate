import { useEffect, useMemo, useState } from 'react';
import { CalendarOff, CalendarPlus, Check, Copy, X } from 'lucide-react';
import { createRoom } from '../lib/callRooms';
import {
  buildIcs,
  createAppointment,
  downloadIcs,
  formatTime,
  loadAvailability,
  loadBusySlots,
  slotsForDate,
  BOOKING_WINDOW_DAYS,
  type Appointment,
  type Availability,
  type Slot,
} from '../lib/appointments';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { roleLabelKey } from '../lib/roles';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Booking modal.
//
//   header  provider name + role chip + certified badge
//   strip   the next 14 days, horizontally scrollable, Intl labels
//   grid    slot chips for the selected date (mint fill when chosen)
//   footer  duration · timezone · Cancel / Book
//
// Slots come from lib/appointments#slotsForDate: the weekday rule expanded from
// start to end in slot_minutes steps, minus past times and minus anything
// overlapping a live appointment (cancelled ones do not block), with a 5-minute
// buffer so back-to-back bookings are not jammed together.
//
// Booking is two writes: a call room created with the lobby on, then the
// appointment row that points at it. The success panel shows the room's 4-word
// code so the patient can read it out, plus .ics and a link into the calendar.
// ---------------------------------------------------------------------------

export type BookableProvider = { id: string; name: string; role: string; verified: boolean };

type BookingFlowProps = {
  patientId: string;
  providers: BookableProvider[];
  /** Preselects and skips the provider step (used by the dashboard sheet). */
  initialProvider?: BookableProvider | null;
  onClose: () => void;
  onBooked: () => void;
};

const startOfDay = (date: Date): Date => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

export default function BookingFlow({
  patientId,
  providers,
  initialProvider = null,
  onClose,
  onBooked,
}: BookingFlowProps) {
  const { t, locale } = useLang();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const [provider, setProvider] = useState<BookableProvider | null>(initialProvider);
  const [rules, setRules] = useState<Availability[]>([]);
  const [booked, setBooked] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(false);
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ code: string; appointment: Appointment } | null>(null);
  const [copied, setCopied] = useState(false);

  // The next 14 days, today first.
  const days = useMemo(() => {
    const today = startOfDay(new Date());
    return Array.from({ length: BOOKING_WINDOW_DAYS }, (_, index) => {
      const date = new Date(today);
      date.setDate(date.getDate() + index);
      return date;
    });
  }, []);

  // Load the provider's rules and their booked appointments once chosen.
  useEffect(() => {
    if (!provider) return;
    let cancelled = false;
    setLoading(true);
    setChosen(null);
    void (async () => {
      const [nextRules, nextBusy] = await Promise.all([
        loadAvailability(provider.id),
        loadBusySlots(provider.id),
      ]);
      if (cancelled) return;
      setRules(nextRules);
      setBooked(nextBusy);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const slots = useMemo(
    () => (provider ? slotsForDate(day, rules, booked) : []),
    [provider, day, rules, booked],
  );

  // No availability rows at all, or nothing open anywhere in the window.
  const nothingOpen = useMemo(() => {
    if (!provider || loading) return false;
    if (rules.length === 0) return true;
    return days.every((date) => slotsForDate(date, rules, booked).length === 0);
  }, [provider, loading, rules, booked, days]);

  const book = async () => {
    if (!provider || !chosen || saving) return;
    setSaving(true);
    setError(null);
    try {
      // The room is created with the lobby on: the patient waits until the
      // provider admits them.
      const room = await createRoom({
        password: '',
        lobbyEnabled: true,
        autoMute: true,
        allowShare: true,
      });

      const appointment = await createAppointment({
        patientId,
        providerId: provider.id,
        roomId: room.id,
        roomCode: room.code,
        start: chosen.start,
        end: chosen.end,
      });

      if (!appointment) throw new Error('appointment insert returned null');

      setDone({ code: room.code, appointment });
      onBooked();
    } catch (caught) {
      // Self-reporting: the raw code first, then the message. Never masked.
      console.error('CALENDAR ERROR:', caught);
      const failure = caught as { code?: string; message?: string } | null;
      setError(failure?.code ?? failure?.message ?? String(caught));
    } finally {
      setSaving(false);
    }
  };

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  }, []);

  const duration = chosen ? Math.round((chosen.end.getTime() - chosen.start.getTime()) / 60_000) : 0;

  const copyCode = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — the code is visible anyway */
    }
  };

  const downloadBooking = () => {
    if (!done || !provider) return;
    const ics = buildIcs(
      done.appointment,
      `${t('cal.appointments')} — ${provider.name}`,
      `${window.location.origin}/call/${done.code}`,
    );
    downloadIcs(`caremunicate-${done.appointment.id.slice(0, 8)}`, ics);
  };

  return (
    <div className="cal-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={trapRef}
        className="cal-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('cal.bookAppointment')}
        onClick={(event) => event.stopPropagation()}
      >
        {/* ---- Booked: the success panel ---- */}
        {done ? (
          <div className="cal-booked">
            <span className="cal-booked-icon" aria-hidden="true">
              <Check size={22} />
            </span>
            <h3 className="cal-booked-title">{t('cal.booked')}</h3>
            <p className="cal-muted">
              {provider?.name} ·{' '}
              {new Intl.DateTimeFormat(locale, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                hour: 'numeric',
                minute: '2-digit',
              }).format(new Date(done.appointment.start_at))}
            </p>

            <div className="cal-booked-code">
              <span className="call-code-chip" dir="ltr" title={done.code}>
                {done.code}
              </span>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void copyCode()}
                aria-label={t('call.copyCode')}
                title={t('call.copyCode')}
              >
                <Copy size={14} aria-hidden="true" /> {copied ? t('call.copied') : t('call.copyCode')}
              </button>
            </div>

            <div className="cal-modal-footer">
              <button type="button" className="ghost-button" onClick={downloadBooking}>
                <CalendarPlus size={14} aria-hidden="true" /> .ics
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  window.location.hash = '#calendar';
                }}
              >
                {t('cal.calendar')}
              </button>
              <button type="button" className="primary-button" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </div>
        ) : !provider ? (
          /* ---- Step 1: which provider ---- */
          <>
            <div className="cal-modal-head">
              <h3 className="cal-modal-title">{t('cal.bookAppointment')}</h3>
              <button type="button" className="cal-icon-btn ghost-button" aria-label={t('common.close')} onClick={onClose}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            <ul className="cal-provider-list">
              {providers.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className="cal-provider-row"
                    onClick={() => setProvider(option)}
                  >
                    <span className="cal-provider-name">
                      {option.name || option.id}
                      {option.verified ? <span className="cal-verified-dot" aria-label="Verified">✓</span> : null}
                    </span>
                    {option.role ? (
                      <span className="cal-provider-role">{t(roleLabelKey(option.role))}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          /* ---- Step 2: date + slot ---- */
          <>
            <div className="cal-modal-head">
              <div>
                <h3 className="cal-modal-title">
                  {provider.name}
                  {provider.verified ? (
                    <span className="cal-verified-dot" title="Verified" aria-label="Verified">
                      ✓
                    </span>
                  ) : null}
                </h3>
                {provider.role ? (
                  <span className="cal-provider-role">{t(roleLabelKey(provider.role))}</span>
                ) : null}
              </div>
              <button type="button" className="cal-icon-btn ghost-button" aria-label={t('common.close')} onClick={onClose}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>

            {/* Date strip — Intl labels, today filled mint. */}
            <div className="cal-date-strip" role="tablist" aria-label={t('cal.selectSlot')}>
              {days.map((date) => {
                const isToday = date.getTime() === startOfDay(new Date()).getTime();
                const active = date.getTime() === day.getTime();
                const open = slotsForDate(date, rules, booked).length;
                return (
                  <button
                    key={date.toISOString()}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    className={[
                      'cal-date-cell',
                      isToday ? 'is-today' : '',
                      active ? 'is-active' : '',
                      open === 0 ? 'is-empty' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      setDay(date);
                      setChosen(null);
                    }}
                  >
                    <span className="cal-date-wd">
                      {new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(date)}
                    </span>
                    <span className="cal-date-num">{date.getDate()}</span>
                  </button>
                );
              })}
            </div>

            {/* Slot chips */}
            <div className="cal-slot-grid">
              {loading ? (
                <p className="cal-muted" aria-busy="true">{t('places.searching')}</p>
              ) : slots.length === 0 ? (
                <div className="cal-empty-state">
                  <CalendarOff size={22} aria-hidden="true" />
                  <p>{t('cal.noSlotsYet')}</p>
                </div>
              ) : (
                slots.map((slot) => {
                  const active = chosen?.start.getTime() === slot.start.getTime();
                  return (
                    <button
                      key={slot.start.toISOString()}
                      type="button"
                      dir="ltr"
                      className={active ? 'cal-slot is-active' : 'cal-slot'}
                      aria-pressed={active}
                      onClick={() => setChosen(slot)}
                    >
                      {formatTime(slot.start, locale)}
                    </button>
                  );
                })
              )}
            </div>

            {/* The window is empty even though rules exist: say so, never '—'. */}
            {nothingOpen && slots.length > 0 ? (
              <div className="cal-empty-state">
                <CalendarOff size={22} aria-hidden="true" />
                <p>{t('cal.noSlotsYet')}</p>
              </div>
            ) : null}

            {error ? (
              <span className="field-error">
                {/* Not yet translated — needs the 10-locale string. */}
                Booking failed
                <span className="error-detail">({error})</span>
              </span>
            ) : null}

            <div className="cal-modal-footer">
              <span className="cal-footer-note">
                {chosen ? `${duration} min · ` : ''}
                {timezone}
              </span>
              <button type="button" className="ghost-button" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!chosen || saving}
                aria-busy={saving}
                title={chosen ? undefined : t('cal.selectSlot')}
                onClick={() => void book()}
              >
                {t('cal.bookAppointment')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
