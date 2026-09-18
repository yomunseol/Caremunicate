import { useMemo } from 'react';
import { CalendarOff } from 'lucide-react';
import { useLang } from '../i18n';
import { effectiveStatus, formatDayLong, type Appointment } from '../lib/appointments';
import AppointmentCard, { type Counterpart } from './AppointmentCard';

// ---------------------------------------------------------------------------
// Schedule — the appointments list. Grouped by day, each row an AppointmentCard
// with its status chip and Join button; cancelled and finished appointments
// sink below the ones still to come.
// ---------------------------------------------------------------------------

type CalendarScheduleViewProps = {
  appointments: Appointment[];
  side: 'patient' | 'provider';
  counterpartFor: (appointment: Appointment) => Counterpart;
  onJoin: (appointment: Appointment) => void;
  onCancel: (appointment: Appointment) => void;
  onConfirm: (appointment: Appointment) => void;
  onReschedule: (appointment: Appointment) => void;
  onAddToCalendar: (appointment: Appointment) => void;
};

export default function CalendarScheduleView({
  appointments,
  side,
  counterpartFor,
  onJoin,
  onCancel,
  onConfirm,
  onReschedule,
  onAddToCalendar,
}: CalendarScheduleViewProps) {
  const { t, locale } = useLang();

  const groups = useMemo(() => {
    const now = Date.now();
    const ordered = [...appointments].sort((a, b) => a.start_at.localeCompare(b.start_at));
    const isDone = (appointment: Appointment) => {
      const status = effectiveStatus(appointment, now);
      return status === 'completed' || status === 'cancelled';
    };
    const upcoming = ordered.filter((appointment) => !isDone(appointment));
    const past = ordered.filter(isDone);

    const bucket = (list: Appointment[]) => {
      const byDay = new Map<string, Appointment[]>();
      for (const appointment of list) {
        const key = new Date(appointment.start_at).toDateString();
        byDay.set(key, [...(byDay.get(key) ?? []), appointment]);
      }
      return [...byDay.entries()];
    };

    return { upcoming: bucket(upcoming), past: bucket(past) };
  }, [appointments]);

  const renderRow = (appointment: Appointment) => (
    <li key={appointment.id}>
      <AppointmentCard
        appointment={appointment}
        counterpart={counterpartFor(appointment)}
        side={side}
        onJoin={onJoin}
        onCancel={onCancel}
        onConfirm={onConfirm}
        onReschedule={onReschedule}
        onAddToCalendar={onAddToCalendar}
      />
    </li>
  );

  if (appointments.length === 0) {
    /* Never a bare '—': an icon and a sentence. */
    return (
      <div className="cal-empty-state">
        <CalendarOff size={22} aria-hidden="true" />
        {/* Not yet translated — needs the 10-locale string. */}
        <p>No appointments yet.</p>
      </div>
    );
  }

  return (
    <div className="cal-schedule">
      {groups.upcoming.map(([dayKey, items]) => (
        <section key={dayKey} className="cal-schedule-day">
          <h3 className="cal-schedule-date">{formatDayLong(items[0].start_at, locale)}</h3>
          <ul className="cal-schedule-list">{items.map(renderRow)}</ul>
        </section>
      ))}

      {groups.past.length > 0 ? (
        <section className="cal-schedule-day is-past">
          <h3 className="cal-schedule-date">{t('cal.appointments')}</h3>
          <ul className="cal-schedule-list">
            {groups.past.flatMap(([, items]) => items).map(renderRow)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
