import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { isProvider } from '../lib/roles';
import {
  buildIcs,
  downloadIcs,
  formatDayShort,
  formatMonth,
  loadAppointments,
  loadPeople,
  loadProviders,
  localDayKey,
  setAppointmentStatus,
  effectiveStatus,
  weekStartsOn,
  approveAppointment,
  respondToAppointment,
  takeStashedAppointment,
  type Appointment,
  type PersonInfo,
} from '../lib/appointments';
import { addDays, startOfDay } from '../lib/calendarLayout';
import { useToast } from '../context/ToastContext';
import { useLang } from '../i18n';
import CalendarToolbar, { type CalendarView } from './CalendarToolbar';
import CalendarSidebar from './CalendarSidebar';
import CalendarWeekView from './CalendarWeekView';
import CalendarMonthView from './CalendarMonthView';
import CalendarScheduleView from './CalendarScheduleView';
import CalendarEventPopover, { type Anchor } from './CalendarEventPopover';
import QuickCreatePopover from './QuickCreatePopover';
import BookingFlow from './BookingFlow';
import AvailabilityEditor from './AvailabilityEditor';

// ---------------------------------------------------------------------------
// /calendar — role aware, Google Calendar design language.
//
//   Sidebar   mint Create + mini month
//   Toolbar   Today · ‹ › · Intl range label · Day/Week/Month/Schedule
//   Views     time grid (Day/Week), month grid, and the Schedule list
//
// Every date goes through Intl with the active locale; weeks start on the
// locale's first day; stored UTC renders in local time; the whole layout uses
// logical properties so it mirrors under RTL.
// ---------------------------------------------------------------------------

type Side = 'patient' | 'provider';

/** Last view per user, so the choice survives a reload. */
const VIEW_STORAGE_PREFIX = 'caremunicate:calendar:view:';

const readStoredView = (userId: string | undefined): CalendarView | null => {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${VIEW_STORAGE_PREFIX}${userId}`);
    return raw === 'week' || raw === 'month' || raw === 'schedule' ? raw : null;
  } catch {
    return null;
  }
};

export default function CalendarPage() {
  const { t, tString, locale } = useLang();
  const { notify } = useToast();
  const { user } = useAuth();

  const [role, setRole] = useState('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [people, setPeople] = useState<Map<string, PersonInfo>>(new Map());
  const [providers, setProviders] = useState<PersonInfo[]>([]);
  const [view, setView] = useState<CalendarView>('schedule');
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [bookingOpen, setBookingOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [detail, setDetail] = useState<{ appointment: Appointment; anchor: Anchor } | null>(null);
  const [quickCreate, setQuickCreate] = useState<{ anchor: Anchor; day: Date; minutes: number } | null>(null);

  const side: Side = isProvider(role) ? 'provider' : 'patient';

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user?.id) return;
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();
      if (cancelled) return;
      const next = String((data as { role?: string } | null)?.role ?? user.user_metadata?.role ?? '');
      setRole(next);
      // The stored choice wins; otherwise the role default — providers open on
      // the week grid, patients on the schedule list.
      setView(readStoredView(user.id) ?? (isProvider(next) ? 'week' : 'schedule'));
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.user_metadata?.role]);

  // Persist the active view per user.
  useEffect(() => {
    if (!user?.id) return;
    try {
      window.localStorage.setItem(`${VIEW_STORAGE_PREFIX}${user.id}`, view);
    } catch {
      // Best-effort; the in-memory view still applies.
    }
  }, [view, user?.id]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user?.id) return;
      setLoading(true);
      const list = await loadAppointments(user.id, side);

      // A write just handed us its row: render it immediately rather than
      // assuming the refetch has caught up. No hand-off → plain refetched list.
      const handedOff = takeStashedAppointment();
      const merged =
        handedOff && !list.some((item) => item.id === handedOff.id)
          ? [...list, handedOff]
          : list;

      if (cancelled) return;
      setAppointments(merged);
      if (handedOff) setView('schedule');
      setPeople(
        await loadPeople(merged.map((a) => (side === 'patient' ? a.provider_id : a.patient_id))),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, side, refreshKey]);

  useEffect(() => {
    void (async () => setProviders(await loadProviders()))();
  }, []);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const counterpartFor = useCallback(
    (appointment: Appointment): PersonInfo =>
      people.get(side === 'patient' ? appointment.provider_id : appointment.patient_id) ?? {
        id: '',
        name: '',
        role: '',
        verified: false,
      },
    [people, side],
  );

  /** Patients this provider already has appointments with — the quick-create list. */
  const patients = useMemo(() => {
    const seen = new Map<string, PersonInfo>();
    for (const appointment of appointments) {
      if (!appointment.patient_id) continue;
      seen.set(
        appointment.patient_id,
        people.get(appointment.patient_id) ?? {
          id: appointment.patient_id,
          name: '',
          role: '',
          verified: false,
        },
      );
    }
    return [...seen.values()];
  }, [appointments, people]);

  const titleFor = useCallback(
    (appointment: Appointment) => counterpartFor(appointment).name || t('chat.participant'),
    [counterpartFor, t],
  );

  const join = (appointment: Appointment) => {
    if (!appointment.room_code) return;
    window.location.hash = `#call/${appointment.room_code}`;
  };

  const cancel = async (appointment: Appointment) => {
    await setAppointmentStatus(appointment.id, 'cancelled');
    setDetail(null);
    refresh();
  };

  const confirm = async (appointment: Appointment) => {
    await setAppointmentStatus(appointment.id, 'confirmed');
    setDetail(null);
    refresh();
  };

  const reschedule = async (appointment: Appointment) => {
    // Slots are immutable, so rescheduling is cancel + rebook.
    await setAppointmentStatus(appointment.id, 'cancelled');
    setDetail(null);
    refresh();
    setBookingOpen(true);
  };

  // Provider triage — the SAME RPC path the bell uses.
  const approve = async (appointment: Appointment) => {
    setDetail(null);
    const result = await approveAppointment(appointment.id);
    if (!result.ok) {
      notify(`${t('auth.toast.planError')} (${result.code})`, 'error');
      return;
    }
    notify(tString('notif.notifApproved', { code: result.code }), 'success');
    refresh();
  };

  const decline = async (appointment: Appointment) => {
    setDetail(null);
    const result = await respondToAppointment(appointment.id, false);
    if (!result.ok) {
      notify(`${t('auth.toast.planError')} (${result.code})`, 'error');
      return;
    }
    notify(t('notif.notifDeclined'), 'info');
    refresh();
  };

  const addToCalendar = (appointment: Appointment) => {
    const person = counterpartFor(appointment);
    const ics = buildIcs(
      appointment,
      `${t('cal.appointments')} — ${person.name}`,
      appointment.room_code ? `${window.location.origin}/call/${appointment.room_code}` : '',
    );
    downloadIcs(`caremunicate-${appointment.id.slice(0, 8)}`, ics);
  };

  // An empty slot: providers quick-create, patients get the booking flow.
  const onSlotClick = (day: Date, minutes: number, anchor: Anchor) => {
    if (side === 'provider') setQuickCreate({ anchor, day, minutes });
    else setBookingOpen(true);
  };

  const step = (direction: number) => {
    // week = ±7 days; month and schedule = ±1 month.
    if (view === 'week') setCursor(addDays(cursor, direction * 7));
    else setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
  };

  const weekDays = useMemo(() => {
    const firstDay = new Date(cursor);
    // Same first-day-of-week the mini month uses, so the two grids agree.
    const offset = (firstDay.getDay() - weekStartsOn(locale) + 7) % 7;
    const start = addDays(firstDay, -offset);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [cursor, locale]);

  const rangeLabel = useMemo(() => {
    if (view === 'week') {
      const first = weekDays[0];
      const last = weekDays[6];
      // Same month → "September 2026"; straddling two → a short range.
      if (first.getMonth() === last.getMonth()) return formatMonth(first, locale);
      return `${formatDayShort(first, locale)} – ${formatDayShort(last, locale)}`;
    }
    return formatMonth(cursor, locale);
  }, [view, cursor, weekDays, locale]);

  const counterpart = (appointment: Appointment) => {
    const person = counterpartFor(appointment);
    return { name: person.name, role: person.role, verified: person.verified };
  };

  return (
    <section className="section cal-page" aria-labelledby="cal-heading">
      <div className="cal-shell">
        <CalendarSidebar
          cursor={cursor}
          onPickDay={(day) => {
            setCursor(day);
            setView(side === 'provider' ? 'week' : 'schedule');
          }}
          onMonth={(direction) =>
            setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1))
          }
          onCreate={() => (side === 'provider' ? setQuickCreate({
            anchor: { x: window.innerWidth / 2, y: 140 },
            day: cursor,
            minutes: 9 * 60,
          }) : setBookingOpen(true))}
          showCreate
        />

        <div className="cal-main">
          <h2 id="cal-heading" className="sr-only">{t('cal.calendar')}</h2>

          <CalendarToolbar
            view={view}
            onView={setView}
            label={rangeLabel}
            onToday={() => setCursor(startOfDay(new Date()))}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
            onCreate={() => (side === 'provider' ? setQuickCreate({
              anchor: { x: window.innerWidth / 2, y: 140 },
              day: cursor,
              minutes: 9 * 60,
            }) : setBookingOpen(true))}
            showCreate={side === 'patient'}
          />

          {loading ? <p className="cal-muted" aria-busy="true">{t('places.searching')}</p> : null}

          {view === 'week' ? (
            <CalendarWeekView
              days={weekDays}
              appointments={appointments}
              titleFor={titleFor}
              statusOf={(appointment) => effectiveStatus(appointment)}
              onEventClick={(appointment, anchor) => setDetail({ appointment, anchor })}
              onSlotClick={onSlotClick}
            />
          ) : null}

          {view === 'month' ? (
            <CalendarMonthView
              cursor={cursor}
              appointments={appointments}
              titleFor={titleFor}
              onPickDay={(day) => {
                setCursor(day);
                // A month cell opens that day inside the week grid.
                setView('week');
              }}
              onEventClick={(appointment, anchor) => setDetail({ appointment, anchor })}
            />
          ) : null}

          {view === 'schedule' ? (
            <CalendarScheduleView
              appointments={appointments}
              side={side}
              counterpartFor={counterpart}
              onJoin={join}
              onCancel={(a) => void cancel(a)}
              onConfirm={(a) => void confirm(a)}
              onReschedule={(a) => void reschedule(a)}
              onAddToCalendar={addToCalendar}
              onApprove={(a) => void approve(a)}
              onDecline={(a) => void decline(a)}
            />
          ) : null}

          {side === 'provider' && user?.id ? <AvailabilityEditor providerId={user.id} /> : null}
        </div>
      </div>

      {detail ? (
        <CalendarEventPopover
          appointment={detail.appointment}
          anchor={detail.anchor}
          title={titleFor(detail.appointment)}
          role={counterpartFor(detail.appointment).role}
          verified={counterpartFor(detail.appointment).verified}
          side={side}
          onClose={() => setDetail(null)}
          onJoin={(a) => {
            setDetail(null);
            join(a);
          }}
          onCancel={(a) => void cancel(a)}
          onConfirm={(a) => void confirm(a)}
          onReschedule={(a) => void reschedule(a)}
          onAddToCalendar={addToCalendar}
          onApprove={(a) => void approve(a)}
          onDecline={(a) => void decline(a)}
        />
      ) : null}

      {quickCreate && user?.id ? (
        <QuickCreatePopover
          anchor={quickCreate.anchor}
          day={quickCreate.day}
          minutes={quickCreate.minutes}
          providerId={user.id}
          patients={patients}
          onClose={() => setQuickCreate(null)}
          onCreated={refresh}
        />
      ) : null}

      {bookingOpen && user?.id ? (
        <BookingFlow
          patientId={user.id}
          providers={providers.map((p) => ({ id: p.id, name: p.name, role: p.role, verified: p.verified }))}
          onClose={() => setBookingOpen(false)}
          onBooked={refresh}
        />
      ) : null}
    </section>
  );
}
