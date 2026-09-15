import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../i18n';
import {
  DAY_MINUTES,
  hourLabels,
  layoutDay,
  minutesOfDay,
  spansDay,
  startOfDay,
} from '../lib/calendarLayout';
import { formatRange, formatTime, localDayKey, type Appointment, type AppointmentStatus } from '../lib/appointments';
import type { Anchor } from './CalendarEventPopover';

// ---------------------------------------------------------------------------
// The time grid, used for both Week (7 columns) and Day (1 column).
//
// Hour gutter 12 AM–11 PM with hairline rules; one column per day; a mint
// now-line with a dot that re-renders every 30s; events absolutely positioned
// by minutes-from-midnight and laid side by side by lib/calendarLayout (never
// stacked, never hidden).
// ---------------------------------------------------------------------------

const HOUR_HEIGHT = 48;

type CalendarWeekViewProps = {
  days: Date[];
  appointments: Appointment[];
  titleFor: (appointment: Appointment) => string;
  statusOf: (appointment: Appointment) => AppointmentStatus;
  onEventClick: (appointment: Appointment, anchor: Anchor) => void;
  onSlotClick: (day: Date, minutes: number, anchor: Anchor) => void;
};

/** Minutes since midnight, ticking, for the current-time indicator. */
const useNow = (): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
};

export default function CalendarWeekView({
  days,
  appointments,
  titleFor,
  statusOf,
  onEventClick,
  onSlotClick,
}: CalendarWeekViewProps) {
  const { t, locale } = useLang();
  const now = useNow();
  const todayKey = localDayKey(now);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const labels = useMemo(() => hourLabels(locale), [locale]);

  const byColumn = useMemo(
    () =>
      days.map((day) => {
        const todays = appointments.filter((appointment) => spansDay(
          { start: new Date(appointment.start_at), end: new Date(appointment.end_at) },
          day,
        ));
        return layoutDay(
          todays.map((appointment) => ({
            ...appointment,
            start: new Date(appointment.start_at),
            end: new Date(appointment.end_at),
          })),
          day,
        );
      }),
    [days, appointments],
  );

  // Open on the working day rather than midnight.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = Math.max(0, 8 * HOUR_HEIGHT - 24);
  }, []);

  const slotFromClick = (event: React.MouseEvent<HTMLDivElement>, day: Date): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    const minutes = Math.max(0, Math.min(DAY_MINUTES - 15, Math.round((ratio * DAY_MINUTES) / 15) * 15));
    void day;
    return minutes;
  };

  return (
    <div className="cal-timegrid">
      <div className="cal-timegrid-head" style={{ gridTemplateColumns: `3.4rem repeat(${days.length}, minmax(0, 1fr))` }}>
        <span className="cal-gutter-corner" aria-hidden="true" />
        {days.map((day) => {
          const isToday = localDayKey(day) === todayKey;
          return (
            <div key={`head-${localDayKey(day)}`} className="cal-col-head">
              <span className="cal-col-wd">
                {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(day)}
              </span>
              <span className={isToday ? 'cal-col-date is-today' : 'cal-col-date'}>{day.getDate()}</span>
            </div>
          );
        })}
      </div>

      <div className="cal-timegrid-body" ref={scrollRef}>
        <div
          className="cal-timegrid-cols"
          style={{ gridTemplateColumns: `3.4rem repeat(${days.length}, minmax(0, 1fr))` }}
        >
          <div className="cal-gutter" aria-hidden="true">
            {labels.map((label, hour) => (
              <span key={label + hour} className="cal-gutter-label" style={{ top: hour * HOUR_HEIGHT }}>
                {hour === 0 ? '' : label}
              </span>
            ))}
          </div>

          {days.map((day, index) => {
            const isToday = localDayKey(day) === todayKey;
            const nowTop = (minutesOfDay(now) / DAY_MINUTES) * 100;

            return (
              <div
                key={localDayKey(day)}
                className="cal-col"
                role="gridcell"
                onClick={(event) => {
                  const target = event.target as HTMLElement;
                  // A click that landed on an event block is that event's.
                  if (target.closest('.cal-ev')) return;
                  onSlotClick(day, slotFromClick(event, day), { x: event.clientX, y: event.clientY });
                }}
              >
                {byColumn[index].map((positioned) => {
                  const appointment = positioned.event as Appointment & { start: Date; end: Date };
                  const status = statusOf(appointment);
                  return (
                    <button
                      key={appointment.id}
                      type="button"
                      dir="ltr"
                      className={`cal-ev is-${status}`}
                      style={{
                        top: `${positioned.topPct}%`,
                        height: `${positioned.heightPct}%`,
                        insetInlineStart: `${positioned.leftPct}%`,
                        width: `calc(${positioned.widthPct}% - 3px)`,
                      }}
                      title={`${titleFor(appointment)} · ${formatRange(appointment.start_at, appointment.end_at, locale)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onEventClick(appointment, { x: event.clientX, y: event.clientY });
                      }}
                    >
                      <span className="cal-ev-title">{titleFor(appointment)}</span>
                      <span className="cal-ev-time">
                        {formatTime(appointment.start_at, locale)}
                        {positioned.heightPct > 3 ? ` – ${formatTime(appointment.end_at, locale)}` : ''}
                      </span>
                    </button>
                  );
                })}

                {isToday ? (
                  <div className="cal-now" style={{ top: `${nowTop}%` }} aria-hidden="true">
                    <span className="cal-now-dot" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <span className="sr-only">{t('cal.appointments')}</span>
    </div>
  );
}

export { HOUR_HEIGHT, startOfDay };
