import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

// The main, persistent client. Sessions are saved to localStorage and
// restored across page loads.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// A memory-only client used for the 2FA "Session Trap" login flow.
//
// This SDK version does not accept a per-call `persistSession` option, so we
// achieve the same guarantee at construction time: `persistSession: false`
// keeps every session this client ever receives in memory only. Nothing it
// does is written to localStorage, so the password step can never leave a
// background/persistent session behind before 2FA has completed.
export const supabaseMemory = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// Directly wipe any session token the persistent client may have stored for
// this project (e.g. the transient session the password step creates before
// 2FA is complete). Works regardless of the storage key in use.
export async function clearPersistedSupabaseSession(
  client: SupabaseClient = supabase,
): Promise<void> {
  try {
    await client.auth.signOut({ scope: 'local' });
  } catch {
    // signOut can fail if no session exists; fall through to the manual wipe.
  }

  try {
    const storage = (client as unknown as { storageKey?: string }).storageKey ?? '';
    const key = storage || 'sb-auth-token';
    const variants = new Set([key, `sb-${key}-auth-token`]);

    for (const variant of variants) {
      localStorage.removeItem(variant);
      sessionStorage.removeItem(variant);
    }
    // Supabase also stores the user object separately when userStorage is in
    // use; clean both common suffixes.
    for (const variant of variants) {
      localStorage.removeItem(`${variant}-user`);
      sessionStorage.removeItem(`${variant}-user`);
    }
  } catch {
    // Storage access can throw in privacy-restricted contexts; ignore.
  }
}

// Reset the memory-only client so no stale in-memory session survives from a
// previous (possibly aborted) login flow. The memory client keeps sessions in
// memory only for the lifetime of the module, so this must run when entering
// the login screen to make the trap hermetic.
export async function resetMemoryAuthClient(): Promise<void> {
  try {
    await supabaseMemory.auth.signOut({ scope: 'local' });
  } catch {
    // signOut can fail if no session exists; ignore.
  }
}
