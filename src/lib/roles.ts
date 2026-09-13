// ---------------------------------------------------------------------------
// Role helpers — one place to answer "is this a provider account?".
//
// Provider-side UI (dashboard cards, stats, Care Places heading, video consult)
// covers doctor, department and hospital. Patient-side UI covers patient only.
// ---------------------------------------------------------------------------

export const PROVIDER_ROLES = ['doctor', 'department', 'hospital'] as const;

export type AppRole = 'patient' | (typeof PROVIDER_ROLES)[number];

export const isProvider = (role?: string | null): boolean =>
  (PROVIDER_ROLES as readonly string[]).includes(String(role ?? '').toLowerCase());

/** i18n key for a role's display label. */
export const roleLabelKey = (role?: string | null): string => {
  switch (String(role ?? '').toLowerCase()) {
    case 'doctor':
      return 'roles.doctor';
    case 'department':
      return 'roles.department';
    case 'hospital':
      return 'roles.hospital';
    case 'patient':
      return 'roles.patient';
    default:
      return 'chat.careMember';
  }
};
