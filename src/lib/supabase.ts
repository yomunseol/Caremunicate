import { createBrowserClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

// The main, persistent browser client. createBrowserClient keeps the auth
// session in cookies so it survives page loads and route changes.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);

// A memory-only client used for the 2FA "Session Trap" login flow.
//
// This SDK version does not accept a per-call `persistSession` option, so we
// achieve the same guarantee at construction time: `persistSession: false`
// keeps every session this client ever receives in memory only. Nothing it
// does is written to storage, so the password step can never leave a
// background/persistent session behind before 2FA has completed.
export const supabaseMemory = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

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
