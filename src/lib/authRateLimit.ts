// ---------------------------------------------------------------------------
// Auth rate limiting is not deployed in this project. These local no-ops keep
// the auth call sites intact while removing the network requests to a missing
// endpoint (which surfaced as 404s on every signup/login attempt). They never
// block authentication; point them at a real limiter to re-enable the gate.
// ---------------------------------------------------------------------------

/** True when the identifier is NOT currently blocked. Always true today. */
export async function isAuthAllowed(_identifier: string): Promise<boolean> {
  return true;
}

/** Records a success or failure. No-op until a limiter exists. */
export async function recordAuthAttempt(
  _identifier: string,
  _success: boolean,
): Promise<void> {
  // Intentionally empty.
}
