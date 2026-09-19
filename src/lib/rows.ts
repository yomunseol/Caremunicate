// ---------------------------------------------------------------------------
// Supabase result normalization.
//
// A table read or an RPC can come back as a single object, an array of rows, or
// null/undefined — the shape depends on the call and on the server function, not
// on the caller. firstRow() collapses all three to "the first row or null", so
// nothing downstream has to guess or index blindly.
// ---------------------------------------------------------------------------

export const firstRow = <T>(data: unknown): T | null => {
  if (Array.isArray(data)) return (data[0] as T | undefined) ?? null;
  if (data && typeof data === 'object') return data as T;
  return null;
};

/** The same, for calls that legitimately return a list. */
export const asRows = <T>(data: unknown): T[] => {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') return [data as T];
  return [];
};
