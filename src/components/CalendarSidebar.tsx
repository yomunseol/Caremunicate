import { useMemo } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useLang } from '../i18n';
import { addDays, startOfDay } from '../lib/calendarLayout';
import { formatMonth, localDayKey, weekStartsOn } from '../lib/appointments';

// ---------------------------------------------------------------------------
// Left rail: the mint Create button, then Google's mini month — today as a
// filled mint circle, quiet ‹ › month navigation, one hairline row per week.
// ---------------------------------------------------------------------------

type CalendarSidebarProps = {
  cursor: Date;
  onPickDay: (day: Date) => void;
  onMonth: (direction: number) => void;
  onCreate: () => void;
  showCreate: boolean;
};

export default function CalendarSidebar({
  cursor,
  onPickDay,
  onMonth,
  onCreate,
  showCreate,
}: CalendarSidebarProps) {
  const { t, locale } = useLang();
  const todayKey = localDayKey(new Date());
  const firstDay = weekStartsOn(locale);

  const weeks = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() - firstDay + 7) % 7;
    const start = addDays(first, -offset);
    const rowCount = Math.ceil((offset + new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()) / 7);
    return Array.from({ length: rowCount }, (_, week) =>
      Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)),
    );
  }, [cursor, firstDay]);

  const weekdayLabels = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const offset = (first.getDay() - firstDay + 7) % 7;
    const anchor = addDays(first, -offset);
    return Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(addDays(anchor, index)),
    );
  }, [cursor, firstDay, locale]);

  return (
    <aside className="cal-sidebar">
      {showCreate ? (
        <button type="button" className="primary-button cal-create" onClick={onCreate}>
          <Plus size={16} aria-hidden="true" /> {t('cal.create')}
        </button>
      ) : null}

      <div className="cal-mini">
        <div className="cal-mini-head">
          <span className="cal-mini-month">{formatMonth(cursor, locale)}</span>
          <span className="cal-mini-nav">
            <button
              type="button"
              className="ghost-button cal-icon-btn"
              aria-label="Previous month"
              onClick={() => onMonth(-1)}
            >
              <ChevronLeft size={15} aria-hidden="true" className="cal-chevron" />
            </button>
            <button
              type="button"
              className="ghost-button cal-icon-btn"
              aria-label="Next month"
              onClick={() => onMonth(1)}
            >
              <ChevronRight size={15} aria-hidden="true" className="cal-chevron" />
            </button>
          </span>
        </div>

        <div className="cal-mini-grid" role="grid" aria-label={formatMonth(cursor, locale)}>
          {weekdayLabels.map((label, index) => (
            <span key={`wd-${index}`} className="cal-mini-wd" role="columnheader">
              {label}
            </span>
          ))}

          {weeks.flat().map((day) => {
            const key = localDayKey(day);
            const isToday = key === todayKey;
            const inMonth = day.getMonth() === cursor.getMonth();
            return (
              <button
                key={key}
                type="button"
                role="gridcell"
                aria-current={isToday ? 'date' : undefined}
                className={[
                  'cal-mini-day',
                  isToday ? 'is-today' : '',
                  inMonth ? '' : 'is-outside',
                  localDayKey(cursor) === key ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => onPickDay(startOfDay(day))}
              >
                {day.getDate()}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
