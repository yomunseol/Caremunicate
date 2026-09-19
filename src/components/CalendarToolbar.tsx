import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// The Google-style top bar: Today, ‹ ›, the range label, then the view switcher
// pinned to the end. The range label is always an Intl format of the cursor, so
// it reads "September 2026" in en and "2026년 9월" in ko with no lookup table.
// ---------------------------------------------------------------------------

/** Three views only — the Day view is gone. */
export type CalendarView = 'week' | 'month' | 'schedule';

export const VIEWS: CalendarView[] = ['week', 'month', 'schedule'];

const VIEW_LABEL: Record<CalendarView, string> = {
  week: 'cal.week',
  month: 'cal.month',
  schedule: 'cal.schedule',
};

type CalendarToolbarProps = {
  view: CalendarView;
  onView: (view: CalendarView) => void;
  label: string;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onCreate?: () => void;
  showCreate?: boolean;
};

export default function CalendarToolbar({
  view,
  onView,
  label,
  onToday,
  onPrev,
  onNext,
  onCreate,
  showCreate = false,
}: CalendarToolbarProps) {
  const { t } = useLang();

  return (
    <div className="cal-toolbar">
      <button type="button" className="ghost-button cal-today" onClick={onToday}>
        {t('cal.today')}
      </button>

      <div className="cal-pager">
        <button
          type="button"
          className="ghost-button cal-icon-btn"
          aria-label="Previous"
          onClick={onPrev}
        >
          <ChevronLeft size={17} aria-hidden="true" className="cal-chevron" />
        </button>
        <button
          type="button"
          className="ghost-button cal-icon-btn"
          aria-label="Next"
          onClick={onNext}
        >
          <ChevronRight size={17} aria-hidden="true" className="cal-chevron" />
        </button>
      </div>

      <span className="cal-range" aria-live="polite">{label}</span>

      {showCreate ? (
        <button type="button" className="primary-button cal-toolbar-create" onClick={onCreate}>
          <Plus size={15} aria-hidden="true" /> {t('cal.create')}
        </button>
      ) : null}

      {/* Segmented control: Week / Month / Schedule — no duplicate tab. */}
      <div className="cal-segmented" role="tablist" aria-label={t('cal.calendar')}>
        {VIEWS.map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={view === option}
            className={view === option ? 'cal-seg is-active' : 'cal-seg'}
            onClick={() => onView(option)}
          >
            {t(VIEW_LABEL[option])}
          </button>
        ))}
      </div>
    </div>
  );
}
