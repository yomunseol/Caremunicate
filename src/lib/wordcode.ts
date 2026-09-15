import { WORD_BANK, WORD_BANK_LENGTH } from './wordBank';

// ---------------------------------------------------------------------------
// Word codes.
//
// A room's PUBLIC identifier is four words — "willow-echo-river-sage". Codes are
// drawn at random from the local WORD_BANK, never derived from anything, and
// everything inside the transport addresses rooms by their call_rooms UUID
// instead: words appear only at the UI edge and the database is the translation
// layer (see lib/callRooms.ts -> resolveRoom).
// ---------------------------------------------------------------------------

export const CODE_SEGMENTS = 4;

const BANK: readonly string[] = WORD_BANK;
const BANK_SET: ReadonlySet<string> = new Set<string>(WORD_BANK);

// Dev-only bank health check. It WARNS and never throws: a bank imperfection
// must not be able to block meeting creation. generateWordCode() indexes
// WORD_BANK.length as-is, so it stays correct whatever the bank's size.
if (import.meta.env.DEV) {
  const problems: string[] = [];

  if (WORD_BANK_LENGTH !== 1024) {
    problems.push(`WORD_BANK_LENGTH is ${WORD_BANK_LENGTH}, expected 1024`);
  }
  if (BANK.length !== 1024) {
    problems.push(`WORD_BANK has ${BANK.length} entries, expected 1024`);
  }
  if (BANK_SET.size !== BANK.length) {
    const seen = new Set<string>();
    const duplicates = BANK.filter((word) => seen.has(word) || (seen.add(word), false));
    problems.push(
      `${BANK.length - BANK_SET.size} duplicate entr(ies): ${[...new Set(duplicates)]
        .slice(0, 8)
        .join(', ')}`,
    );
  }

  const malformed = BANK.filter((word) => !/^[a-z]{3,8}$/.test(word));
  if (malformed.length > 0) {
    problems.push(`${malformed.length} malformed word(s): ${malformed.slice(0, 8).join(', ')}`);
  }
  if (CODE_SEGMENTS !== 4) {
    problems.push(`CODE_SEGMENTS is ${CODE_SEGMENTS}, expected 4`);
  }

  if (problems.length > 0) {
    console.warn(`WORD_BANK looks imperfect (codes still work):\n  - ${problems.join('\n  - ')}`);
  }
}

/** Uniform integer in [0, max) — rejection sampling, so no modulo bias. */
const randomIndex = (max: number): number => {
  const limit = Math.floor(0x100000000 / max) * max;
  const bucket = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(bucket);
    if (bucket[0] < limit) return bucket[0] % max;
  }
};

/**
 * Four DISTINCT words joined by dashes, drawn with crypto.getRandomValues.
 *
 * Sampling is without replacement: an index already drawn is rejected, so a
 * word can never repeat inside one code ("mint-mint-..."). Because nothing is
 * derived from an identifier, two rooms created in the same millisecond are
 * still independent.
 */
export const generateWordCode = (): string => {
  const picked: string[] = [];
  const used = new Set<number>();

  while (picked.length < CODE_SEGMENTS) {
    const index = randomIndex(BANK.length);
    if (used.has(index)) continue;
    used.add(index);
    picked.push(BANK[index]);
  }

  return picked.join('-');
};

/**
 * Trim, lowercase, spaces/underscores → dashes, collapse repeated dashes.
 *
 * Deliberately does NOT strip a leading/trailing dash — the spec body stops
 * here, and a malformed code is then rejected by isValidWordCode rather than
 * silently repaired.
 */
export const normalizeCode = (raw: string): string =>
  String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');

/** Exactly four words, every one of them in WORD_BANK, and all four distinct. */
export const isValidWordCode = (value: string | null | undefined): boolean => {
  const parts = normalizeCode(String(value ?? '')).split('-');
  if (parts.length !== CODE_SEGMENTS) return false;
  if (new Set(parts).size !== CODE_SEGMENTS) return false;
  return parts.every((part) => BANK_SET.has(part));
};

// ---------------------------------------------------------------------------
// Dev-only validation. A malformed bank throws at import time so it can never
// ship — the failure is loud and names exactly what is wrong.
// ---------------------------------------------------------------------------
if (import.meta.env?.DEV) {
  const problems: string[] = [];

  if (BANK.length !== WORD_BANK_LENGTH) {
    problems.push(`word count is ${BANK.length}, expected ${WORD_BANK_LENGTH}`);
  }

  const unique = new Set(BANK);
  if (unique.size !== BANK.length) {
    const duplicates = BANK.filter((word, index) => BANK.indexOf(word) !== index);
    problems.push(`duplicate words: ${[...new Set(duplicates)].slice(0, 20).join(', ')}`);
  }
  if (unique.size !== WORD_BANK_LENGTH) {
    problems.push(`unique words are ${unique.size}, expected ${WORD_BANK_LENGTH}`);
  }

  const malformed = BANK.filter((word) => !/^[a-z]{3,8}$/.test(word));
  if (malformed.length > 0) {
    problems.push(`words outside /^[a-z]{3,8}$/: ${malformed.slice(0, 20).join(', ')}`);
  }

  if (problems.length > 0) {
    throw new Error(`WORD_BANK is invalid — refusing to run:\n  - ${problems.join('\n  - ')}`);
  }

  // Generated codes: four words, all distinct, all in the bank.
  const SAMPLES = 250;
  for (let i = 0; i < SAMPLES; i += 1) {
    const code = generateWordCode();
    const parts = code.split('-');

    if (parts.length !== CODE_SEGMENTS) {
      throw new Error(`generateWordCode produced ${parts.length} segments: ${code}`);
    }
    if (new Set(parts).size !== CODE_SEGMENTS) {
      throw new Error(`generateWordCode repeated a word: ${code}`);
    }
    if (!isValidWordCode(code)) {
      throw new Error(`generateWordCode produced a code outside WORD_BANK: ${code}`);
    }
  }

  const normalized = normalizeCode('Willow Echo River Sage');
  if (normalized !== 'willow-echo-river-sage') {
    throw new Error(`normalizeCode('Willow Echo River Sage') returned "${normalized}"`);
  }

  console.info(`WORDCODE OK — bank of ${BANK.length}, ${SAMPLES} generated codes validated`);
}
