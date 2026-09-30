import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { isProvider, roleLabelKey } from '../lib/roles';
import { listKnownPatients } from '../lib/carePlans';
import type { PersonInfo } from '../lib/appointments';
import PatientDetail from './PatientDetail';

// ---------------------------------------------------------------------------
// #patients — the provider's patients, derived from existing appointments and
// conversations (there is no assignment table). Selecting one opens the
// patient profile with its Care Plans tab.
// ---------------------------------------------------------------------------

export default function PatientsList() {
  const { user } = useAuth();
  const { t } = useLang();

  const role = String(user?.user_metadata?.role ?? '');
  const provider = isProvider(role);

  const [patients, setPatients] = useState<PersonInfo[]>([]);
  const [selected, setSelected] = useState<PersonInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!provider || !user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setPatients(await listKnownPatients(user.id));
    } finally {
      setLoading(false);
    }
  }, [provider, user]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!provider) {
    return (
      <section className="section">
        <p className="care-muted">{t('care.providersOnly')}</p>
      </section>
    );
  }

  if (selected) {
    return (
      <section className="section">
        <PatientDetail patient={selected} onBack={() => setSelected(null)} />
      </section>
    );
  }

  return (
    <section className="section">
      <div className="panel">
        <div className="eyebrow">{t('care.myPatients')}</div>
        {loading ? (
          <p className="care-muted" aria-busy="true">{t('places.searching')}</p>
        ) : patients.length === 0 ? (
          <p className="care-muted">{t('care.noPatients')}</p>
        ) : (
          <ul style={styles.list}>
            {patients.map((patient) => (
              <li key={patient.id}>
                <button type="button" style={styles.row} onClick={() => setSelected(patient)}>
                  <span style={styles.name}>
                    {patient.name || patient.id}
                    {patient.verified ? <span style={styles.verified} aria-hidden="true">✓</span> : null}
                  </span>
                  {patient.role ? <span style={styles.role}>{t(roleLabelKey(patient.role))}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.5rem' },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.8rem',
    width: '100%',
    padding: '0.7rem 0.9rem',
    border: '1px solid var(--line, rgba(15, 58, 50, 0.12))',
    borderRadius: '0.9rem',
    background: '#fff',
    fontFamily: 'inherit',
    fontSize: '0.88rem',
    fontWeight: 700,
    color: 'var(--text, #133b35)',
    cursor: 'pointer',
    textAlign: 'start',
  },
  name: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', overflowWrap: 'anywhere' },
  verified: { color: 'var(--accent-strong, #216e5d)' },
  role: { color: 'var(--text-muted, #557b76)', fontSize: '0.76rem', fontWeight: 700 },
};
