import { useEffect, useMemo, useState } from 'react';
import { CalendarOff, Check, X } from 'lucide-react';
import {
  formatTime,
  loadAvailability,
  loadBusySlots,
  requestAppointment,
  slotsForDate,
  stashAppointment,
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
  // A request was sent — no room exists yet, so there is no code to show.
  const [sent, setSent] = useState(false);

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

  const book = async () => {
    if (!provider || !chosen || saving) return;
    setSaving(true);
    setError(null);
    // A REQUEST, not a booking: the host decides. The server creates the row
    // (status 'requested') and, on approval, mints the room code — so nothing
    // room-related happens here.
    const minutes = Math.round((chosen.end.getTime() - chosen.start.getTime()) / 60_000);
    const result = await requestAppointment({
      hostId: provider.id,
      start: chosen.start,
      durationMin: minutes,
    });

    if (!result.ok) {
      // Self-reporting: the raw code, never a softened reason.
      console.error('CALENDAR ERROR:', result.code);
      setError(result.code);
      setSaving(false);
      return;
    }

    // Hand the returned row to the calendar so it renders immediately, without
    // assuming a refetch will find it. Then go to the schedule view.
    stashAppointment(result.appointment);
    setSent(true);
    setSaving(false);
    onBooked();
    window.location.hash = '#calendar';
  };

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return '';
    }
  }, []);

  const duration = chosen ? Math.round((chosen.end.getTime() - chosen.start.getTime()) / 60_000) : 0;

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
        {/* ---- Request sent: NO room code exists yet ---- */}
        {sent ? (
          <div className="cal-booked">
            <span className="cal-booked-icon" aria-hidden="true">
              <Check size={22} />
            </span>
            <h3 className="cal-booked-title">{t('cal.requestSent')}</h3>
            <p className="cal-muted">
              {provider?.name}
              {chosen
                ? ` · ${new Intl.DateTimeFormat(locale, {
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                    hour: '2-digit',
                    minute: '2-digit',
                    hourCycle: 'h23',
                  }).format(chosen.start)}`
                : ''}
            </p>

            <div className="cal-modal-footer">
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  window.location.hash = '#calendar';
                }}
              >
                {t('cal.calendar')}
              </button>
              <button type="button" className="ghost-button" onClick={onClose}>
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
