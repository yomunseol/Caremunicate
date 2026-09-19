// ---------------------------------------------------------------------------
// One-line, ALWAYS-STRING error reasons.
//
// "[object Object]" must be impossible: every failure is reduced to a string in
// a fixed order — the PostgREST/Supabase code first, then the message, then a
// JSON dump, then String(). Used by plan writes, availability saves, the
// verification flow and the Overpass client.
// ---------------------------------------------------------------------------

export const describeError = (error: unknown): string => {
  if (typeof error === 'string') return error;

  const failure = error as { code?: unknown; message?: unknown } | null;
  if (failure?.code) return String(failure.code);
  if (failure?.message) return String(failure.message);

  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
};
