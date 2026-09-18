import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { isProvider } from '../lib/roles';
import { useLang } from '../i18n';
import VerificationBadge from './VerificationBadge';

// ---------------------------------------------------------------------------
// Verification Center (/verify).
//
// The one place a provider submits a license document. The status shown is
// profiles.verification_status, read live; VerificationBadge decides what copy
// may render from it. Submitting uploads to the private `verification-docs`
// bucket and moves the row to 'pending' — the only transition the DB guard
// allows an owner (guard_verification_columns).
// ---------------------------------------------------------------------------

const BUCKET = 'verification-docs';

export default function VerificationCenter() {
  const { user } = useAuth();
  const { t } = useLang();
  const [status, setStatus] = useState('unverified');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    const { data, error: loadError } = await supabase
      .from('profiles')
      .select('role, verification_status')
      .eq('user_id', user.id)
      .maybeSingle();

    if (loadError) {
      console.error('VERIFY ERROR:', loadError.message);
      setError(loadError.code ?? loadError.message);
      return;
    }

    const row = data as { role?: string | null; verification_status?: string | null } | null;
    setRole(String(row?.role ?? ''));
    setStatus(String(row?.verification_status ?? 'unverified'));
  }, [user?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!user?.id || busy) return;
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setBusy(true);
    setError('');

    try {
      const dot = file.name.lastIndexOf('.');
      const ext = dot >= 0 ? file.name.slice(dot) : '';
      const path = `${user.id}/license-${Date.now()}${ext}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;

      const { error: updateError } = await supabase
        .from('profiles')
        .update({ verification_status: 'pending' })
        .eq('user_id', user.id);
      if (updateError) throw updateError;

      await load();
    } catch (caught) {
      // Self-reporting: the raw code, never a softened reason.
      console.error('VERIFY ERROR:', caught);
      const failure = caught as { code?: string; message?: string } | null;
      setError(failure?.code ?? failure?.message ?? String(caught));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = isProvider(role) && (status === 'unverified' || status === 'rejected');

  return (
    <section className="section" aria-labelledby="verify-heading">
      <div className="panel" style={styles.panel}>
        <div className="eyebrow">{t('dash.certificationTitle')}</div>
        <h2 id="verify-heading" style={styles.title}>{t('dash.certificationTitle')}</h2>

        <VerificationBadge status={status} ownerView />

        {canSubmit ? (
          <div style={styles.form}>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,image/*"
              aria-label={t('verify.getCertified')}
            />
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void submit()}
            >
              {t('verify.getCertified')}
            </button>
          </div>
        ) : null}

        {error ? (
          <span className="field-error" role="alert">
            <span className="error-detail">{error}</span>
          </span>
        ) : null}
      </div>
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: { display: 'grid', gap: '0.8rem', maxWidth: '34rem' },
  title: { margin: 0 },
  form: { display: 'grid', gap: '0.6rem', justifyItems: 'start' },
};
