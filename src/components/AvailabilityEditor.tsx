import { useCallback, useEffect, useState, type CSSProperties } from 'react';
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

/** Fixed for now: the editor's state carries only on/off and the two times. */
const SLOT_MIN = 30;
const BUFFER_MIN = 0;

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
    setRows(next);
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load]);

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
          slot_min: SLOT_MIN,
          buffer_min: BUFFER_MIN,
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
    <div className="panel" style={styles.panel}>
      <div className="eyebrow">{t('cal.availability')}</div>

      <ul style={styles.list}>
        {ordered.map((weekday) => {
          const row = rows[weekday];
          const name = weekdayName(weekday, locale);
          return (
            <li key={weekday} style={styles.row}>
              <label style={styles.toggle}>
                <input
                  type="checkbox"
                  checked={row.enabled}
                  aria-label={name}
                  onChange={(event) => patch(weekday, { enabled: event.target.checked })}
                />
                <span>{name}</span>
              </label>

              <input
                className="input ltr-isolate"
                type="text"
                inputMode="numeric"
                dir="ltr"
                maxLength={5}
                placeholder="HH:MM"
                aria-label={`${name} start`}
                disabled={!row.enabled}
                value={row.start}
                onChange={(event) => patch(weekday, { start: event.target.value })}
                style={styles.time}
              />
              <span aria-hidden="true">–</span>
              <input
                className="input ltr-isolate"
                type="text"
                inputMode="numeric"
                dir="ltr"
                maxLength={5}
                placeholder="HH:MM"
                aria-label={`${name} end`}
                disabled={!row.enabled}
                value={row.end}
                onChange={(event) => patch(weekday, { end: event.target.value })}
                style={styles.time}
              />

              {rangeErrorWeekday === weekday ? (
                <span className="field-error" role="alert">{t('cal.invalidTimeRange')}</span>
              ) : null}
            </li>
          );
        })}
      </ul>

      <button type="button" className="primary-button" disabled={busy} aria-busy={busy} onClick={() => void save()}>
        Save
      </button>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: { display: 'grid', gap: '0.7rem' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.45rem' },
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' },
  toggle: { display: 'inline-flex', alignItems: 'center', gap: '0.45rem', minWidth: '9rem', fontSize: '0.84rem' },
  time: { width: '7rem', minHeight: 40 },
};
