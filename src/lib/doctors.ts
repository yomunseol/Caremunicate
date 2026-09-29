import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Doctor directory + patient favourites.
//
//   Directory : public.profiles WHERE role = 'doctor'. The profiles SELECT
//               policy already publishes doctor rows, so no RPC is needed.
//   Favourites: public.doctor_favorites(patient_id, doctor_id), RLS-scoped to
//               the signed-in patient.
//
// `profiles.specialty` / `profiles.clinic` are recent columns. The select tries
// the full set first and DROPS optional columns on a schema-mismatch error, so
// the directory still renders on a project where the migration has not run.
// ---------------------------------------------------------------------------

export type DoctorEntry = {
  user_id: string;
  username: string | null;
  role: string;
  specialty?: string | null;
  clinic?: string | null;
  email?: string | null;
  verification_status?: string | null;
};

/** Tried in order; the first that the live schema accepts is used. */
const DOCTOR_COLUMN_SETS = [
  'user_id, username, role, specialty, clinic, verification_status, email',
  'user_id, username, role, verification_status, email',
  'user_id, username, role, verification_status',
  'user_id, username, role',
];

const SCHEMA_MISMATCH = new Set(['42703', '42P10', 'PGRST204', 'PGRST100']);

const isSchemaMismatch = (code?: string | null): boolean => SCHEMA_MISMATCH.has(String(code ?? ''));

/** Every doctor on the network, alphabetical. Throws on a non-schema error. */
export async function listDoctors(): Promise<DoctorEntry[]> {
  let lastError: unknown = null;

  for (const columns of DOCTOR_COLUMN_SETS) {
    const { data, error } = await supabase
      .from('profiles')
      .select(columns)
      .eq('role', 'doctor')
      .order('username', { ascending: true });

    if (!error) return (data ?? []) as unknown as DoctorEntry[];

    lastError = error;
    // Only a missing column/relationship is worth retrying with fewer columns.
    if (!isSchemaMismatch(error.code)) throw error;
  }

  throw lastError ?? new Error('Could not load doctors.');
}

/** The doctor ids this patient has favourited. */
export async function listFavoriteDoctorIds(patientId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('doctor_favorites')
    .select('doctor_id')
    .eq('patient_id', patientId);

  if (error) throw error;
  return ((data ?? []) as Array<{ doctor_id: string }>).map((row) => row.doctor_id);
}

/** Save a doctor. A duplicate is already-saved, not an error. */
export async function addDoctorFavorite(patientId: string, doctorId: string): Promise<void> {
  const { error } = await supabase
    .from('doctor_favorites')
    .insert({ patient_id: patientId, doctor_id: doctorId });

  if (error && error.code !== '23505') throw error;
}

/** Remove a doctor from favourites. */
export async function removeDoctorFavorite(patientId: string, doctorId: string): Promise<void> {
  const { error } = await supabase
    .from('doctor_favorites')
    .delete()
    .eq('patient_id', patientId)
    .eq('doctor_id', doctorId);

  if (error) throw error;
}
