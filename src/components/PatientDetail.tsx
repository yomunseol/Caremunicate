import { useState, type CSSProperties } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useLang } from '../i18n';
import { roleLabelKey } from '../lib/roles';
import type { PersonInfo } from '../lib/appointments';
import CarePlanPanel from './CarePlanPanel';

// ---------------------------------------------------------------------------
// A provider's view of one patient — the first doctor-facing patient profile.
//   Overview    : name, role, verified
//   Care Plans  : the active plan + compliance, and plan authoring
// ---------------------------------------------------------------------------

type PatientDetailProps = {
  patient: PersonInfo;
  onBack: () => void;
};

export default function PatientDetail({ patient, onBack }: PatientDetailProps) {
  const { t } = useLang();
  const [tab, setTab] = useState<'overview' | 'plans'>('plans');

  return (
    <div style={styles.wrap}>
      <button type="button" className="ghost-button" style={styles.back} onClick={onBack}>
        <ArrowLeft size={15} aria-hidden="true" /> {t('care.myPatients')}
      </button>

      <div className="panel">
        <div style={styles.head}>
          <span style={styles.avatar} aria-hidden="true">
            {(patient.name || '?').charAt(0).toUpperCase()}
          </span>
          <div style={styles.identity}>
            <strong style={styles.name}>
              {patient.name || patient.id}
              {patient.verified ? (
                <span style={styles.verified} aria-label={t('verify.verified')}>✓</span>
              ) : null}
            </strong>
            {patient.role ? <span style={styles.role}>{t(roleLabelKey(patient.role))}</span> : null}
          </div>
        </div>
      </div>

      <div style={styles.tabs} role="tablist" aria-label={patient.name}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'overview'}
          style={{ ...styles.tab, ...(tab === 'overview' ? styles.tabActive : null) }}
          onClick={() => setTab('overview')}
        >
          {t('care.tabsOverview')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'plans'}
          style={{ ...styles.tab, ...(tab === 'plans' ? styles.tabActive : null) }}
          onClick={() => setTab('plans')}
        >
          {t('care.tabsPlans')}
        </button>
      </div>

      {tab === 'plans' ? (
        <CarePlanPanel patientId={patient.id} />
      ) : (
        <div className="panel">
          <div className="eyebrow">{t('care.tabsOverview')}</div>
          <p style={styles.overviewLine}>
            {patient.name || patient.id}
            {patient.role ? ` · ${t(roleLabelKey(patient.role))}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'grid', gap: '1rem' },
  back: { justifySelf: 'start' },
  head: { display: 'flex', alignItems: 'center', gap: '0.8rem' },
  avatar: {
    display: 'grid',
    placeItems: 'center',
    width: '2.8rem',
    height: '2.8rem',
    borderRadius: '50%',
    background: 'var(--accent, #3ea985)',
    color: '#fff',
    fontWeight: 800,
    fontSize: '1.1rem',
  },
  identity: { display: 'grid', gap: '0.15rem' },
  name: { display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text, #133b35)' },
  verified: { color: 'var(--accent-strong, #216e5d)' },
  role: { color: 'var(--text-muted, #557b76)', fontSize: '0.8rem' },
  tabs: { display: 'flex', flexWrap: 'wrap', gap: '1rem', borderBottom: '1px solid var(--line)' },
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.45rem',
    paddingBlock: '0.55rem',
    paddingInline: 0,
    border: 0,
    borderBottom: '2px solid transparent',
    borderRadius: 0,
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '0.86rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    cursor: 'pointer',
  },
  tabActive: {
    borderBottomColor: 'var(--text)',
    color: 'var(--text)',
  },
  overviewLine: { margin: 0, color: 'var(--text, #133b35)' },
};
