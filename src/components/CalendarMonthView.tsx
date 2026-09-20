import { useEffect, useMemo } from 'react';
import { useLang } from '../i18n';
import { formatTime, localDayKey, weekStartsOn, type Appointment } from '../lib/appointments';
import { addDays } from '../lib/calendarLayout';
import type { Anchor } from './CalendarEventPopover';

// ---------------------------------------------------------------------------
// Month grid: 6 rows × 7 columns, a date number per cell (today as a filled
// mint circle, out-of-month days dimmed), and at most three event chips with
// "+{{count}} more" for the rest.
// ---------------------------------------------------------------------------

/** Google's month view is always six rows tall, so the height never jumps. */
const ROWS = 6;

type CalendarMonthViewProps = {
  cursor: Date;
  appointments: Appointment[];
  titleFor: (appointment: Appointment) => string;
  onPickDay: (day: Date) => void;
  onEventClick: (appointment: Appointment, anchor: Anchor) => void;
};

export default function CalendarMonthView({
  cursor,
  appointments,
  titleFor,
  onPickDay,
  onEventClick,
}: CalendarMonthViewProps) {
  const { t, locale } = useLang();
  const todayKey = localDayKey(new Date());
  const firstDay = weekStartsOn(locale);

  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() - firstDay + 7) % 7;
    const start = addDays(first, -offset);
    return Array.from({ length: ROWS * 7 }, (_, index) => addDays(start, index));
  }, [cursor, firstDay]);

  const byDay = useMemo(() => {
    const map = new Map<string, Appointment[]>();
    for (const appointment of appointments) {
      const key = localDayKey(new Date(appointment.start_at));
      map.set(key, [...(map.get(key) ?? []), appointment]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.start_at.localeCompare(b.start_at));
    }
    return map;
  }, [appointments]);

  // Dev guard: report the REAL measured cell height, as a number. The rows come
  // from grid-auto-rows, so this must always read exactly 112.
  useEffect(() => {
    if (!import.meta.env?.DEV) return;
    const cell = document.querySelector('.cal-month-cell') as HTMLElement | null;
    console.assert(cell?.offsetHeight === 112, 'month cell height', cell?.offsetHeight);
  }, [days]);

  return (
    <div className="cal-month" role="grid">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={`wd-${index}`} className="cal-month-wd" role="columnheader">
          {new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(days[index])}
        </div>
      ))}

      {days.map((day) => {
        const key = localDayKey(day);
        const items = byDay.get(key) ?? [];
        const inMonth = day.getMonth() === cursor.getMonth();
        const isToday = key === todayKey;

        return (
          <div
            key={key}
            role="gridcell"
            className={inMonth ? 'cal-month-cell' : 'cal-month-cell is-outside'}
            onClick={() => onPickDay(day)}
          >
            <span className={isToday ? 'cal-month-date is-today' : 'cal-month-date'}>{day.getDate()}</span>

            {items.slice(0, 3).map((appointment) => (
              <button
                key={appointment.id}
                type="button"
                dir="ltr"
                className={`cal-chip is-${appointment.status}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onEventClick(appointment, { x: event.clientX, y: event.clientY });
                }}
                title={titleFor(appointment)}
              >
                <span className="cal-chip-time">{formatTime(appointment.start_at, locale)}</span>
                <span className="cal-chip-title">{titleFor(appointment)}</span>
              </button>
            ))}

            {items.length > 3 ? (
              <button
                type="button"
                className="cal-chip-more"
                onClick={(event) => {
                  event.stopPropagation();
                  onPickDay(day);
                }}
              >
                {t('cal.moreEvents', { count: items.length - 3 })}
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
