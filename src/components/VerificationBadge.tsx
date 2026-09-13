import { BadgeCheck, Clock, ShieldAlert } from 'lucide-react';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Verification badge.
//
// HARD RULE: the "certified / verified" copy can ONLY render when the value
// comes from profiles.verification_status === 'verified'. Nothing else — email
// confirmation, profile completeness, role — may produce it. If a caller has no
// status, the badge degrades to the neutral community label.
// ---------------------------------------------------------------------------

type VerificationBadgeProps = {
  status?: string | null;
  /** True for the doctor themselves or an admin — the only viewers who see pending/rejected. */
  ownerView?: boolean;
};

export default function VerificationBadge({ status, ownerView = false }: VerificationBadgeProps) {
  const { t } = useLang();
  const value = String(status ?? 'unverified');

  if (value === 'verified') {
    return (
      <span className="verify-badge verify-badge--verified">
        <BadgeCheck size={14} aria-hidden="true" /> {t('verify.certified')}
      </span>
    );
  }

  if (value === 'pending') {
    if (!ownerView) return null;
    return (
      <span className="verify-badge verify-badge--pending">
        <Clock size={14} aria-hidden="true" /> {t('verify.pending')}
      </span>
    );
  }

  if (value === 'rejected') {
    if (!ownerView) return null;
    return (
      <span className="verify-badge verify-badge--rejected">
        <ShieldAlert size={14} aria-hidden="true" /> {t('verify.rejected')}
      </span>
    );
  }

  // Unverified: a neutral label, never the certified one.
  return <span className="verify-badge verify-badge--neutral">{t('verify.nonCertified')}</span>;
}
