import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import CareChecklist from './CareChecklist';
import CreateCarePlanModal from './CreateCarePlanModal';
import SlimButton from './ui/SlimButton';

// ---------------------------------------------------------------------------
// #care — the patient's own Care Plans checklist (all active tasks).
//
// Every authenticated patient, including the basic tier, may author their own
// plan: CreateCarePlanModal writes patient_id = auth.uid(), and the created
// tasks load straight into the checklist after creation.
// ---------------------------------------------------------------------------

export default function MyCare() {
  const { user } = useAuth();
  const { t } = useLang();
  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  if (!user) return null;

  return (
    <section className="section">
      <div className="panel">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            marginBlockEnd: '0.75rem',
          }}
        >
          <div className="eyebrow" style={{ margin: 0 }}>{t('care.myCare')}</div>
          <SlimButton variant="primary" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> {t('care.createPlan')}
          </SlimButton>
        </div>
        <CareChecklist key={refreshKey} patientId={user.id} />
      </div>

      {creating ? (
        <CreateCarePlanModal
          patientId={user.id}
          onClose={() => setCreating(false)}
          onCreated={() => setRefreshKey((key) => key + 1)}
        />
      ) : null}
    </section>
  );
}
