import { useMemo } from 'react';
import { useLang } from '../i18n';
import { formatDayLong, localDayKey, type Appointment } from '../lib/appointments';
import { addDays, groupByDay, SCHEDULE_WINDOW_DAYS, startOfDay } from '../lib/calendarLayout';
import AppointmentCard, { type Counterpart } from './AppointmentCard';

// ---------------------------------------------------------------------------
// Schedule — a flat list from today forward 30 days.
//
// Grouped ONLY by days that actually carry an appointment, so an empty day and
// an empty week render nothing at all: no full-week scaffolding, no month of
// blank day headers. The single exception is a today section, which is always
// present — with a muted line when nothing is on.
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
  onApprove: (appointment: Appointment) => void;
  onDecline: (appointment: Appointment) => void;
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
  onApprove,
  onDecline,
}: CalendarScheduleViewProps) {
  const { t, locale } = useLang();

  const groups = useMemo(() => {
    const today = startOfDay(new Date());
    const todayKey = localDayKey(today);
    // Today forward 30 days. groupByDay keeps only the days that carry an
    // appointment, so a day in the window with nothing on renders no section.
    const days = groupByDay(
      appointments,
      (appointment) => localDayKey(appointment.start_at),
      todayKey,
      localDayKey(addDays(today, SCHEDULE_WINDOW_DAYS)),
    );
    return { today, todayKey, days };
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
        onApprove={onApprove}
        onDecline={onDecline}
      />
    </li>
  );

  const todayItems = groups.days.find(([key]) => key === groups.todayKey)?.[1] ?? [];
  const laterDays = groups.days.filter(([key]) => key !== groups.todayKey);

  return (
    <div className="cal-schedule">
      {/* Today is always the first section, even with nothing on it. */}
      <section className="cal-schedule-day">
        <h3 className="cal-schedule-date">{formatDayLong(groups.today, locale)}</h3>
        {todayItems.length > 0 ? (
          <ul className="cal-schedule-list">{todayItems.map(renderRow)}</ul>
        ) : (
          <p className="cal-muted">{t('cal.nothingToday')}</p>
        )}
      </section>

      {laterDays.map(([dayKey, items]) => (
        <section key={dayKey} className="cal-schedule-day">
          <h3 className="cal-schedule-date">{formatDayLong(items[0].start_at, locale)}</h3>
          <ul className="cal-schedule-list">{items.map(renderRow)}</ul>
        </section>
      ))}

      <p className="cal-muted cal-schedule-end">{t('cal.noMoreAppointments')}</p>
    </div>
  );
}
