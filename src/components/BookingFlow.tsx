import { useState, type CSSProperties } from 'react';
import { X } from 'lucide-react';
import { createRoom } from '../lib/callRooms';
import {
  buildIcs,
  createAppointment,
  downloadIcs,
  formatDayLong,
  formatRange,
  loadAvailability,
  loadBusySlots,
  openSlots,
  type Appointment,
  type Slot,
} from '../lib/appointments';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { roleLabelKey } from '../lib/roles';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Booking flow (patient).
//
//   pick a provider -> pick an open slot -> confirm
//     -> create the call room FIRST, then the appointment that points at it
//     -> success, showing the word code and an .ics download
//
// Open slots are computed in the browser: weekly availability minus the
// provider's busy ranges, over a two-week window.
// ---------------------------------------------------------------------------

export type BookableProvider = { id: string; name: string; role: string; verified: boolean };

type BookingFlowProps = {
  patientId: string;
  providers: BookableProvider[];
  onClose: () => void;
  onBooked?: () => void;
};

export default function BookingFlow({ patientId, providers, onClose, onBooked }: BookingFlowProps) {
  const { t, locale } = useLang();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const [step, setStep] = useState<'provider' | 'slot' | 'saving' | 'done'>('provider');
  const [provider, setProvider] = useState<BookableProvider | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [chosen, setChosen] = useState<Slot | null>(null);
  const [booked, setBooked] = useState<{ code: string; appointment: Appointment } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickProvider = async (next: BookableProvider) => {
    setProvider(next);
    setStep('slot');
    setLoading(true);
    setError(null);

    const [rules, busy] = await Promise.all([loadAvailability(next.id), loadBusySlots(next.id)]);
    setSlots(openSlots(rules, busy));
    setLoading(false);
  };

  const confirm = async () => {
    if (!provider || !chosen) return;
    setStep('saving');
    setError(null);

    try {
      // Room first: the appointment stores its id, and its word code gives the
      // Join button a URL without any further lookup.
      const room = await createRoom({ lobbyEnabled: true });

      const appointment = await createAppointment({
        patientId,
        providerId: provider.id,
        roomId: room.id || null,
        roomCode: room.code,
        start: chosen.start,
        end: chosen.end,
      });

      if (!appointment) throw new Error('Appointment insert failed');

      setBooked({ code: room.code, appointment });
      setStep('done');
      onBooked?.();
    } catch (caught) {
      console.error('CALENDAR ERROR:', caught);
      setError('Could not book the appointment.');
      setStep('slot');
    }
  };

  const addToCalendar = () => {
    if (!booked) return;
    const ics = buildIcs(
      booked.appointment,
      `${t('cal.appointments')} — ${provider?.name ?? ''}`,
      `${window.location.origin}/call/${booked.code}`,
    );
    downloadIcs(`caremunicate-${booked.code}`, ics);
  };

  return (
    <div className="call-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={trapRef}
        className="call-modal cal-booking"
        role="dialog"
        aria-modal="true"
        aria-label={t('cal.bookAppointment')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="call-modal-head">
          <strong>{t('cal.bookAppointment')}</strong>
          <button type="button" className="call-panel-close" aria-label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {error ? <span className="field-error">{error}</span> : null}

        {step === 'provider' ? (
          <ul style={styles.list}>
            {providers.length === 0 ? (
              <li style={styles.muted}>—</li>
            ) : (
              providers.map((item) => (
                <li key={item.id}>
                  <button type="button" style={styles.rowButton} onClick={() => void pickProvider(item)}>
                    <span>{item.name}</span>
                    {item.role ? <span style={styles.roleBadge}>{t(roleLabelKey(item.role))}</span> : null}
                    {item.verified ? (
                      <span style={styles.verifiedBadge} title="Verified" aria-label="Verified">✓</span>
                    ) : null}
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}

        {step === 'slot' ? (
          <>
            <p style={styles.muted}>{provider?.name}</p>
            {loading ? (
              <p style={styles.muted} aria-busy="true">{t('places.searching')}</p>
            ) : slots.length === 0 ? (
              <p style={styles.muted}>—</p>
            ) : (
              <div style={styles.slotGrid}>
                {slots.map((slot) => {
                  const active = chosen?.start.getTime() === slot.start.getTime();
                  return (
                    <button
                      key={slot.start.toISOString()}
                      type="button"
                      aria-pressed={active}
                      style={{ ...styles.slot, ...(active ? styles.slotActive : null) }}
                      onClick={() => setChosen(slot)}
                    >
                      <span style={styles.slotDay}>{formatDayLong(slot.start, locale)}</span>
                      <span style={styles.slotTime} dir="ltr">
                        {formatRange(slot.start.toISOString(), slot.end.toISOString(), locale)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            <div className="call-modal-actions">
              <button type="button" className="ghost-button" onClick={() => setStep('provider')}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!chosen}
                onClick={() => void confirm()}
              >
                {t('cal.bookAppointment')}
              </button>
            </div>
          </>
        ) : null}

        {step === 'saving' ? <p style={styles.muted} aria-busy="true">{t('places.searching')}</p> : null}

        {step === 'done' && booked ? (
          <>
            <span className="call-code-chip cal-booked-chip" dir="ltr" title={booked.code}>
              {booked.code}
            </span>
            <p style={styles.muted}>
              {formatDayLong(booked.appointment.start_at, locale)} ·{' '}
              {formatRange(booked.appointment.start_at, booked.appointment.end_at, locale)}
            </p>

            <div className="call-modal-actions">
              <button type="button" className="ghost-button" onClick={addToCalendar}>
                {t('cal.appointments')} (.ics)
              </button>
              <button type="button" className="primary-button" onClick={onClose}>
                {t('common.close')}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.4rem' },
  rowButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    width: '100%',
    paddingBlock: '0.6rem',
    paddingInline: '0.7rem',
    borderRadius: '0.8rem',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    background: '#fff',
    color: 'var(--text, #133b35)',
    fontSize: '0.86rem',
    fontWeight: 600,
    textAlign: 'start',
    cursor: 'pointer',
    minHeight: 48,
  },
  roleBadge: {
    paddingBlock: '0.1rem',
    paddingInline: '0.5rem',
    borderRadius: '999px',
    background: 'rgba(62, 169, 133, 0.14)',
    color: 'var(--accent-strong, #216e5d)',
    fontSize: '0.66rem',
    fontWeight: 800,
    textTransform: 'uppercase',
  },
  verifiedBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 16,
    height: 16,
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#06231d',
    fontSize: '0.66rem',
    fontWeight: 900,
  },
  muted: { margin: 0, color: 'var(--text-muted, #557b76)', fontSize: '0.84rem' },
  slotGrid: { display: 'grid', gap: '0.4rem', maxHeight: '18rem', overflowY: 'auto' },
  slot: {
    display: 'grid',
    gap: '0.1rem',
    paddingBlock: '0.55rem',
    paddingInline: '0.7rem',
    borderRadius: '0.8rem',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    background: '#fff',
    color: 'var(--text, #133b35)',
    textAlign: 'start',
    cursor: 'pointer',
    minHeight: 48,
  },
  slotActive: {
    borderColor: 'rgba(62, 169, 133, 0.6)',
    background: 'var(--accent-soft, rgba(62, 169, 133, 0.14))',
  },
  slotDay: { fontSize: '0.82rem', fontWeight: 700 },
  slotTime: { fontSize: '0.78rem', color: 'var(--text-muted, #557b76)' },
};
