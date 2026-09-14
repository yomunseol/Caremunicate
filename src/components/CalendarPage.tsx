import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { isProvider } from '../lib/roles';
import {
  buildIcs,
  downloadIcs,
  effectiveStatus,
  formatDayLong,
  formatDayShort,
  formatMonth,
  formatRange,
  formatTime,
  formatWeekdayNarrow,
  loadAppointments,
  loadPeople,
  loadProviders,
  localDayKey,
  setAppointmentStatus,
  weekStartsOn,
  type Appointment,
  type PersonInfo,
} from '../lib/appointments';
import { useLang } from '../i18n';
import AppointmentCard from './AppointmentCard';
import BookingFlow from './BookingFlow';
import AvailabilityEditor from './AvailabilityEditor';

// ---------------------------------------------------------------------------
// /calendar — role aware.
//
//   patient  : agenda list, with a month toggle
//   provider : week grid by default, plus day and agenda
//
// Every date goes through Intl.DateTimeFormat with the active locale, weeks
// start on the locale's first day, stored UTC is rendered in local time, and
// the grids mirror under RTL because they are laid out with logical properties.
// ---------------------------------------------------------------------------

type View = 'agenda' | 'month' | 'week' | 'day';

const startOfDay = (date: Date): Date => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const addDays = (date: Date, days: number): Date => {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
};

export default function CalendarPage() {
  const { t, locale } = useLang();
  const { user } = useAuth();

  const [role, setRole] = useState('');
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [people, setPeople] = useState<Map<string, PersonInfo>>(new Map());
  const [providers, setProviders] = useState<PersonInfo[]>([]);
  const [view, setView] = useState<View>('agenda');
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [bookingOpen, setBookingOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const side: 'patient' | 'provider' = isProvider(role) ? 'provider' : 'patient';
  const firstDay = weekStartsOn(locale);

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
      const next = String(
        (data as { role?: string } | null)?.role ?? user.user_metadata?.role ?? '',
      );
      setRole(next);
      // Providers open on the week grid; patients on the agenda.
      setView(isProvider(next) ? 'week' : 'agenda');
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.user_metadata?.role]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user?.id) return;
      setLoading(true);
      const list = await loadAppointments(user.id, side);
      if (cancelled) return;
      setAppointments(list);
      setPeople(await loadPeople(list.map((a) => (side === 'patient' ? a.provider_id : a.patient_id))));
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

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const appointment of appointments) {
      const key = localDayKey(new Date(appointment.start_at));
      map.set(key, [...(map.get(key) ?? []), appointment]);
    }
    return map;
  }, [appointments]);

  const upcoming = useMemo(
    () => appointments.filter((a) => effectiveStatus(a) !== 'completed').slice(0, 40),
    [appointments],
  );

  const join = (appointment: Appointment) => {
    if (!appointment.room_code) return;
    window.location.hash = `#call/${appointment.room_code}`;
  };

  const cancel = async (appointment: Appointment) => {
    await setAppointmentStatus(appointment.id, 'cancelled');
    refresh();
  };

  const confirm = async (appointment: Appointment) => {
    await setAppointmentStatus(appointment.id, 'confirmed');
    refresh();
  };

  const reschedule = async (appointment: Appointment) => {
    // Slots are immutable, so rescheduling is cancel + rebook.
    await setAppointmentStatus(appointment.id, 'cancelled');
    refresh();
    setBookingOpen(true);
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

  const renderCard = (appointment: Appointment) => (
    <AppointmentCard
      key={appointment.id}
      appointment={appointment}
      counterpart={{
        name: counterpartFor(appointment).name,
        role: counterpartFor(appointment).role,
        verified: counterpartFor(appointment).verified,
      }}
      side={side}
      onJoin={join}
      onCancel={(a) => void cancel(a)}
      onConfirm={(a) => void confirm(a)}
      onReschedule={(a) => void reschedule(a)}
      onAddToCalendar={addToCalendar}
    />
  );

  const weekDays = useMemo(() => {
    const offset = (cursor.getDay() - firstDay + 7) % 7;
    const start = addDays(cursor, -offset);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }, [cursor, firstDay]);

  const monthCells = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() - firstDay + 7) % 7;
    const start = addDays(first, -offset);
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  }, [cursor, firstDay]);

  const monthAppointments = (day: Date) => byDay.get(localDayKey(day)) ?? [];

  const step = (direction: number) => {
    if (view === 'month') {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1));
    } else if (view === 'week') {
      setCursor(addDays(cursor, direction * 7));
    } else {
      setCursor(addDays(cursor, direction));
    }
  };

  const heading =
    view === 'month' ? formatMonth(cursor, locale) : view === 'week'
      ? `${formatDayShort(weekDays[0], locale)} – ${formatDayShort(weekDays[6], locale)}`
      : formatDayLong(cursor, locale);

  const tabs: View[] = side === 'provider' ? ['week', 'day', 'agenda'] : ['agenda', 'month'];

  return (
    <section className="section cal-page" aria-labelledby="cal-heading">
      <div className="section-heading">
        <div className="eyebrow">{t('common.appName')}</div>
        <h2 id="cal-heading">{t('cal.calendar')}</h2>
      </div>

      <div style={styles.toolbar}>
        <div role="tablist" aria-label={t('cal.calendar')} style={styles.tabs}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              className={view === tab ? 'cal-tab is-active' : 'cal-tab'}
              style={{ ...styles.tab, ...(view === tab ? styles.tabActive : null) }}
              onClick={() => setView(tab)}
            >
              {tab === 'agenda' ? t('cal.appointments') : tab === 'month' ? t('cal.calendar') : t('cal.calendar')}
            </button>
          ))}
        </div>

        {view !== 'agenda' ? (
          <div style={styles.pager}>
            <button type="button" className="ghost-button" style={styles.icon} aria-label="Previous" onClick={() => step(-1)}>
              <ChevronLeft size={16} aria-hidden="true" />
            </button>
            <span style={styles.pagerLabel}>{heading}</span>
            <button type="button" className="ghost-button" style={styles.icon} aria-label="Next" onClick={() => step(1)}>
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        ) : null}

        {side === 'patient' ? (
          <button type="button" className="primary-button" onClick={() => setBookingOpen(true)}>
            <Plus size={15} aria-hidden="true" /> {t('cal.bookAppointment')}
          </button>
        ) : null}
      </div>

      {loading ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}

      {view === 'agenda' ? (
        upcoming.length === 0 ? (
          <p style={styles.muted}>{t('cal.appointments')} —</p>
        ) : (
          <ul style={styles.list}>{upcoming.map(renderCard)}</ul>
        )
      ) : null}

      {view === 'week' || view === 'month' ? (
        <div className="cal-grid" style={styles.grid} role="grid">
          {Array.from({ length: 7 }, (_, index) => {
            const day = view === 'week' ? weekDays[index] : addDays(monthCells[0], index);
            return (
              <div key={`head-${index}`} style={styles.gridHead} role="columnheader">
                {formatWeekdayNarrow(day, locale)}
              </div>
            );
          })}

          {(view === 'week' ? weekDays : monthCells).map((day) => {
            const items = monthAppointments(day);
            const inMonth = view === 'week' || day.getMonth() === cursor.getMonth();
            return (
              <div key={localDayKey(day)} style={{ ...styles.cell, opacity: inMonth ? 1 : 0.45 }} role="gridcell">
                <span style={styles.cellDay}>{day.getDate()}</span>
                {items.slice(0, 3).map((appointment) => (
                  <span key={appointment.id} style={styles.cellItem} dir="ltr">
                    {formatTime(appointment.start_at, locale)}
                  </span>
                ))}
                {items.length > 3 ? <span style={styles.cellMore}>+{items.length - 3}</span> : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {view === 'day' ? (
        (byDay.get(localDayKey(cursor)) ?? []).length === 0 ? (
          <p style={styles.muted}>—</p>
        ) : (
          <ul style={styles.list}>{(byDay.get(localDayKey(cursor)) ?? []).map(renderCard)}</ul>
        )
      ) : null}

      {/* Appointments for the focused week / month, so the grid stays scannable. */}
      {view === 'week' ? (
        <ul style={styles.list}>
          {weekDays
            .flatMap((day) => monthAppointments(day))
            .map(renderCard)}
        </ul>
      ) : null}

      {side === 'provider' && user?.id ? <AvailabilityEditor providerId={user.id} /> : null}

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

const styles: Record<string, CSSProperties> = {
  toolbar: { display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBlockEnd: '0.9rem' },
  tabs: { display: 'inline-flex', gap: '0.3rem', padding: '0.2rem', borderRadius: '999px', background: 'var(--bg-panel-soft, rgba(7,39,33,0.04))' },
  tab: {
    paddingBlock: '0.4rem',
    paddingInline: '0.8rem',
    border: 'none',
    borderRadius: '999px',
    background: 'transparent',
    color: 'var(--text-muted, #557b76)',
    fontWeight: 700,
    fontSize: '0.8rem',
    cursor: 'pointer',
    minHeight: 40,
  },
  tabActive: { background: '#fff', color: 'var(--accent-strong, #216e5d)', boxShadow: '0 2px 8px rgba(17,55,47,0.08)' },
  pager: { display: 'inline-flex', alignItems: 'center', gap: '0.4rem' },
  pagerLabel: { fontSize: '0.84rem', fontWeight: 700, color: 'var(--text, #133b35)' },
  icon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 40, height: 40, borderRadius: '50%' },
  muted: { margin: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.86rem' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.6rem' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: '0.3rem', marginBlockEnd: '1rem' },
  gridHead: { textAlign: 'center', fontSize: '0.7rem', fontWeight: 800, color: 'var(--text-muted, #557b76)', textTransform: 'uppercase' },
  cell: {
    display: 'grid',
    gap: '0.15rem',
    alignContent: 'start',
    minHeight: '4.2rem',
    padding: '0.35rem',
    borderRadius: '0.6rem',
    background: '#fff',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
  },
  cellDay: { fontSize: '0.72rem', fontWeight: 800, color: 'var(--text, #133b35)' },
  cellItem: {
    fontSize: '0.62rem',
    fontWeight: 700,
    color: 'var(--accent-strong, #216e5d)',
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
    borderRadius: '999px',
    paddingBlock: '0.05rem',
    paddingInline: '0.3rem',
  },
  cellMore: { fontSize: '0.6rem', color: 'var(--text-muted, #557b76)' },
};
