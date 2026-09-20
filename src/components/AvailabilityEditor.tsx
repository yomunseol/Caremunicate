import { useCallback, useEffect, useState } from 'react';
import { loadAvailability, weekStartsOn, weekdayName } from '../lib/appointments';
import { describeError } from '../lib/errors';
import { supabase } from '../lib/supabase';
import { useToast } from '../context/ToastContext';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Weekly availability editor (provider).
//
// Times are RAW 'HH:MM' STRINGS in controlled text inputs — no native time
// picker. They are written to a `time` column and read back verbatim, so the
// displayed value is the stored value: 17:00 renders as 17:00, never 05:00.
// There are no Date objects and no timezone conversion in this component.
//
// Save is plain table writes — NO RPC:
//   • enabled weekdays  -> upsert on (host_id, weekday, start_time)
//   • disabled weekdays -> delete
// ---------------------------------------------------------------------------

/** The slot lengths a provider may offer. */
const SLOT_LENGTH_CHOICES = [15, 20, 30, 45, 60] as const;

/** Used until a stored row tells us otherwise. */
const DEFAULT_SLOT_MINUTES = 30;
const DEFAULT_BUFFER_MINUTES = 0;

/** The buffer's allowed range, and the step the input moves in. */
const MAX_BUFFER_MINUTES = 60;
const BUFFER_STEP_MINUTES = 5;

const clampBuffer = (value: number): number =>
  Number.isFinite(value) ? Math.min(MAX_BUFFER_MINUTES, Math.max(0, value)) : 0;

/** The only accepted time shape: 24-hour HH:MM. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

type Row = { weekday: number; enabled: boolean; start: string; end: string };

type AvailabilityEditorProps = { providerId: string };

const initialRows = (): Row[] =>
  Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    enabled: false,
    start: '09:00',
    end: '17:00',
  }));

/** 'HH:MM:SS' from Postgres -> 'HH:MM'. A string slice, not a parse. */
const toInputTime = (value: string): string => String(value ?? '').slice(0, 5);

export default function AvailabilityEditor({ providerId }: AvailabilityEditorProps) {
  const { t, locale } = useLang();
  const { notify } = useToast();
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [busy, setBusy] = useState(false);
  const [rangeErrorWeekday, setRangeErrorWeekday] = useState<number | null>(null);
  // Slot length and buffer are per-provider: written on every row, edited once.
  const [slotMinutes, setSlotMinutes] = useState<number>(DEFAULT_SLOT_MINUTES);
  const [bufferMinutes, setBufferMinutes] = useState<number>(DEFAULT_BUFFER_MINUTES);

  // Read the stored rows back into the same raw strings they were saved as.
  const load = useCallback(async () => {
    if (!providerId) return;
    const stored = await loadAvailability(providerId);

    const next = initialRows();
    for (const rule of stored) {
      const index = next.findIndex((row) => row.weekday === Number(rule.weekday));
      if (index < 0) continue;
      next[index] = {
        weekday: Number(rule.weekday),
        enabled: true,
        start: toInputTime(rule.start_time),
        end: toInputTime(rule.end_time),
      };
    }

    // Adopt what was stored, so the controls show the saved truth after a
    // reload instead of resetting to the defaults.
    const savedSlot = Number(stored[0]?.slot_minutes);
    if (Number.isFinite(savedSlot) && savedSlot > 0) setSlotMinutes(savedSlot);
    const savedBuffer = Number(stored[0]?.buffer_minutes);
    if (Number.isFinite(savedBuffer) && savedBuffer >= 0) setBufferMinutes(savedBuffer);

    setRows(next);
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Dev guard: report the REAL measured heights, as numbers.
  useEffect(() => {
    if (!import.meta.env?.DEV) return;
    const input = document.querySelector('.cal-availability-time') as HTMLElement | null;
    console.assert(input?.offsetHeight === 44, 'availability input height', input?.offsetHeight);
    const control = document.querySelector('.cal-availability-control') as HTMLElement | null;
    console.assert(control?.offsetHeight === 44, 'availability control height', control?.offsetHeight);
  }, []);

  const patch = (weekday: number, changes: Partial<Row>) => {
    setRangeErrorWeekday(null);
    setRows((previous) =>
      previous.map((row) => (row.weekday === weekday ? { ...row, ...changes } : row)),
    );
  };

  const save = async () => {
    const enabled = rows.filter((row) => row.enabled);

    // Every enabled weekday needs two well-formed HH:MM values with end > start.
    const invalid = enabled.find(
      (row) => !TIME_RE.test(row.start) || !TIME_RE.test(row.end) || row.end <= row.start,
    );
    if (invalid) {
      setRangeErrorWeekday(invalid.weekday);
      return;
    }
    setRangeErrorWeekday(null);

    setBusy(true);
    try {
      if (!providerId) throw new Error('no provider');

      const off = rows.filter((row) => !row.enabled).map((row) => row.weekday);

      if (enabled.length > 0) {
        const payload = enabled.map((row) => ({
          host_id: providerId,
          weekday: row.weekday,
          start_time: row.start,
          end_time: row.end,
          slot_min: slotMinutes,
          buffer_min: bufferMinutes,
        }));

        const { error: upsertError } = await supabase
          .from('availability')
          .upsert(payload, { onConflict: 'host_id,weekday,start_time' });
        if (upsertError) throw upsertError;
      }

      if (off.length > 0) {
        const { error: deleteError } = await supabase
          .from('availability')
          .delete()
          .eq('host_id', providerId)
          .in('weekday', off);
        if (deleteError) throw deleteError;
      }

      // Refetch: the slot picker recomputes from what was just stored.
      await load();
      notify(t('cal.availabilitySaved'), 'success');
    } catch (caught) {
      // Self-reporting: the raw code, never a softened reason and never an object.
      console.error('CALENDAR ERROR:', caught);
      notify(describeError(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  // Render the week from the locale's first day, matching the calendar.
  const first = weekStartsOn(locale);
  const ordered = Array.from({ length: 7 }, (_, index) => (first + index) % 7);

  return (
    <div className="panel cal-availability">
      <div className="eyebrow">{t('cal.availability')}</div>

      <ul className="cal-availability-list">
        {ordered.map((weekday) => {
          const row = rows[weekday];
          const name = weekdayName(weekday, locale);
          return (
            <li key={weekday} className="cal-availability-row">
              <label className="cal-availability-toggle">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  aria-label={name}
                  onChange={(event) => patch(weekday, { enabled: event.target.checked })}
                />
                <span>{name}</span>
              </label>

              <input
                className="input ltr-isolate cal-availability-time"
                type="text"
                inputMode="numeric"
                dir="ltr"
                maxLength={5}
                placeholder="HH:MM"
                aria-label={`${name} start`}
                disabled={!row.enabled}
                value={row.start}
                onChange={(event) => patch(weekday, { start: event.target.value })}
              />
              <span aria-hidden="true">–</span>
              <input
                className="input ltr-isolate cal-availability-time"
                type="text"
                inputMode="numeric"
                dir="ltr"
                maxLength={5}
                placeholder="HH:MM"
                aria-label={`${name} end`}
                disabled={!row.enabled}
                value={row.end}
                onChange={(event) => patch(weekday, { end: event.target.value })}
              />

              {rangeErrorWeekday === weekday ? (
                <span className="field-error" role="alert">{t('cal.invalidTimeRange')}</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* The two numbers every slot is built from — live controls, not text. */}
      <div className="cal-availability-meta">
        <span className="cal-availability-meta-field">
          <label className="cal-availability-meta-label" htmlFor="cal-slot-length">
            {t('cal.slotLength')}
          </label>
          <select
            id="cal-slot-length"
            className="input cal-availability-control"
            value={slotMinutes}
            onChange={(event) => setSlotMinutes(Number(event.target.value))}
          >
            {SLOT_LENGTH_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t('cal.minUnit', { count: choice })}
              </option>
            ))}
          </select>
        </span>

        <span className="cal-availability-meta-field">
          <label className="cal-availability-meta-label" htmlFor="cal-buffer">
            {t('cal.buffer')}
          </label>
          <input
            id="cal-buffer"
            className="input cal-availability-control"
            type="number"
            min={0}
            max={MAX_BUFFER_MINUTES}
            step={BUFFER_STEP_MINUTES}
            value={bufferMinutes}
            onChange={(event) => setBufferMinutes(clampBuffer(Number(event.target.value)))}
          />
          <span className="cal-availability-meta-value">
            {t('cal.minUnit', { count: bufferMinutes })}
          </span>
        </span>
      </div>

      {/* Full width of the card CONTENT box, 48px tall. */}
      <button
        type="button"
        className="primary-button cal-availability-save"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void save()}
      >
        {t('cal.save')}
      </button>
    </div>
  );
}
