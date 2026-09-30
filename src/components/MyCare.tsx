import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import CareChecklist from './CareChecklist';

// ---------------------------------------------------------------------------
// #care — the patient's own Care Plans checklist (all active tasks).
// ---------------------------------------------------------------------------

export default function MyCare() {
  const { user } = useAuth();
  const { t } = useLang();

  if (!user) return null;

  return (
    <section className="section">
      <div className="panel">
        <div className="eyebrow">{t('care.myCare')}</div>
        <CareChecklist patientId={user.id} />
      </div>
    </section>
  );
}
