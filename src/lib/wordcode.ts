// ---------------------------------------------------------------------------
// Word codes.
//
// A room's PUBLIC identifier is four words — "mint-fox-river-halo". Everything
// inside the transport addresses rooms by their call_rooms UUID instead, so
// words appear only at the UI edge and the database is the translation layer.
//
// PERSONAL rooms derive their code deterministically from the owner's user id,
// so a user's code is stable without any lookup.
// ---------------------------------------------------------------------------

/** Exactly 64 words — 4 independent picks give 64^4 ≈ 16.7M codes. */
export const WORDS = [
  'mint', 'fox', 'dove', 'fern', 'halo', 'iris', 'jade', 'kite', 'luna', 'nova', 'olive', 'pine',
  'rose', 'sage', 'tulip', 'willow', 'amber', 'birch', 'cedar', 'echo', 'flint', 'hazel', 'juniper',
  'lemon', 'meadow', 'onyx', 'pearl', 'quartz', 'river', 'silver', 'thyme', 'maple', 'delta',
  'ginger', 'indigo', 'kelp', 'nectar', 'orchid', 'poppy', 'reed', 'stone', 'umber', 'violet',
  'wave', 'brook', 'cove', 'dune', 'cloud', 'aster', 'briar', 'clover', 'drift', 'ember', 'frost',
  'glade', 'honey', 'ivory', 'jasper', 'lark', 'moss', 'night', 'opal', 'petal', 'rain',
] as const;

/** Plain array view — tuple literals are awkward to index with a number. */
const LIST: readonly string[] = WORDS;

export const CODE_SEGMENTS = 4;

/** SHA-256 output size, in bytes. */
const HASH_BYTES = 32;

/** Words drawn from each hash segment. */
const BYTES_PER_SEGMENT = CODE_SEGMENTS;

/** How many distinct 4-word candidates one digest can yield. */
const MAX_ATTEMPTS = Math.floor(HASH_BYTES / BYTES_PER_SEGMENT);

const sha256Bytes = async (value: string): Promise<Uint8Array> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return new Uint8Array(digest);
};

/**
 * Deterministic code for a UUID: SHA-256(uuid), take four bytes, index the word
 * list with each.
 *
 * `attempt` walks the digest four bytes at a time, so an insert that collides on
 * the unique code retries with the NEXT four hash bytes — still fully
 * deterministic for that room, never random.
 */
export const codeFromUuid = async (uuid: string, attempt = 0): Promise<string> => {
  const bytes = await sha256Bytes(uuid);
  const step = Math.max(0, Math.floor(attempt)) % MAX_ATTEMPTS;
  const offset = step * BYTES_PER_SEGMENT;

  return Array.from(
    { length: CODE_SEGMENTS },
    (_, index) => LIST[bytes[offset + index] % LIST.length],
  ).join('-');
};

/** True when a value is exactly four words from the list. */
export const isWordCode = (value: string | null | undefined): boolean => {
  const parts = String(value ?? '').trim().toLowerCase().split('-');
  if (parts.length !== CODE_SEGMENTS) return false;
  const allowed = new Set<string>(WORDS);
  return parts.every((part) => allowed.has(part));
};
