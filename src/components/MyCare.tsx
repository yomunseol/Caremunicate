import { useState } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import CareChecklist from './CareChecklist';
import CreateCarePlanModal from './CreateCarePlanModal';

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
        <div className="eyebrow">{t('care.myCare')}</div>
        <button
          type="button"
          className="primary-button"
          style={{ justifySelf: 'start', marginBlockEnd: '0.75rem' }}
          onClick={() => setCreating(true)}
        >
          <Plus size={15} aria-hidden="true" /> {t('care.createPlan')}
        </button>
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
