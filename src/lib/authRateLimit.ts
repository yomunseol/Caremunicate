import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Brute-force gate for signup / login / 2FA.
//
// Backed by the FOUNDER SQL (public.auth_rate_limits +
// check_auth_rate_limit / record_auth_attempt). Those functions must exist in
// Supabase; until they do, this gate FAILS OPEN — a missing function must never
// block authentication.
// ---------------------------------------------------------------------------

const normalize = (identifier: string): string => identifier.trim().toLowerCase();

/** True when the identifier is NOT currently blocked. Fails open on error. */
export async function isAuthAllowed(identifier: string): Promise<boolean> {
  const id = normalize(identifier);
  if (!id) return true;

  try {
    const { data, error } = await supabase.rpc('check_auth_rate_limit', { p_identifier: id });
    if (error) {
      console.log('AUTH RATE LIMIT unavailable (failing open):', error);
      return true;
    }
    return data !== false;
  } catch (error) {
    console.log('AUTH RATE LIMIT unavailable (failing open):', error);
    return true;
  }
}

/** Records a success (clears the counter) or a failure (increments it). */
export async function recordAuthAttempt(identifier: string, success: boolean): Promise<void> {
  const id = normalize(identifier);
  if (!id) return;

  try {
    const { error } = await supabase.rpc('record_auth_attempt', {
      p_identifier: id,
      p_success: success,
    });
    if (error) console.log('AUTH RATE LIMIT record failed:', error);
  } catch (error) {
    console.log('AUTH RATE LIMIT record failed:', error);
  }
}
