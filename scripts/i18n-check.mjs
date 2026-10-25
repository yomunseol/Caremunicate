// ---------------------------------------------------------------------------
// CF-5 — i18n regression guard.
//
//   node scripts/i18n-check.mjs   (npm run i18n:check, wired into prebuild)
//
// Fails when EITHER:
//   1. a locale block is missing a master (en) key, or has a duplicate key; or
//   2. a hardcoded user-facing string appears in src/**/*.{tsx,jsx} OUTSIDE the
//      allowlist (brand names, codes, units, symbol-only text).
//
// Scope note: the string scan covers JSX text nodes and the user-facing
// attributes aria-label / title / placeholder / alt. It deliberately does NOT
// judge JS object label maps or template literals — the intent is a fast,
// dependency-free gate that catches the string that would otherwise leak into a
// non-English UI, not a full AST linter.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const I18N = join(ROOT, 'src/i18n.jsx');

const problems = [];

// ---------------------------------------------------------------------------
// 1) Key coverage — every locale must carry every `en` key.
// ---------------------------------------------------------------------------
const i18nSrc = readFileSync(I18N, 'utf8');
const body = i18nSrc.slice(
  i18nSrc.indexOf('const translations = {'),
  i18nSrc.indexOf('\n};\n\nconst supportedLocales'),
);

const blocks = [...body.matchAll(/^ {2}(\w+): \{$/gm)].map((m) => ({ code: m[1], at: m.index }));
if (blocks.length === 0) problems.push('i18n: could not parse any locale block.');

const keysOf = (segment) => [...segment.matchAll(/'([^']+)':/g)].map((m) => m[1]);
const masterKeys = new Set(
  keysOf(body.slice(blocks[0]?.at ?? 0, blocks[1]?.at ?? body.length)),
);

for (let i = 0; i < blocks.length; i += 1) {
  const { code, at } = blocks[i];
  const segment = body.slice(at, i + 1 < blocks.length ? blocks[i + 1].at : body.length);
  const keys = keysOf(segment);
  const unique = new Set(keys);

  if (keys.length !== unique.size) problems.push(`i18n: ${code} has duplicate keys.`);

  const missing = [...masterKeys].filter((key) => !unique.has(key));
  if (missing.length > 0) {
    problems.push(`i18n: ${code} is missing ${missing.length} key(s): ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 2) Hardcoded user-facing strings.
// ---------------------------------------------------------------------------
const ALLOW = new Set([
  'Caremunicate',
  'LancerMents',
  'HH:MM',
  'mint-fox-river-halo',
  'word-word-word-word',
  '••••••••',
  '—',
  '–',
  '-',
  '✓',
  '×',
  '←',
  '→',
  '9+',
  '·',
  '🌐',
  '•',
]);

// Code tokens that can appear between > and < and are never user-facing prose.
const CODE_WORDS = new Set([
  'new',
  'return',
  'const',
  'let',
  'var',
  'function',
  'import',
  'export',
  'await',
  'async',
  'type',
  'interface',
  'class',
  'extends',
  'implements',
  'typeof',
  'keyof',
  'Promise',
  'Array',
  'Record',
  'Partial',
  'string',
  'number',
  'boolean',
  'void',
  'null',
  'undefined',
  'unknown',
]);

const hasLetters = (s) => /[A-Za-z]/.test(s);
const isCommentLine = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);
// Anything carrying code punctuation is not a user-facing sentence.
const CODE_PUNCT = /[;=()[\]|&`@$\\/:<>#{}]/;

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|jsx)$/.test(entry)) out.push(full);
  }
  return out;
};

for (const file of walk(join(ROOT, 'src'))) {
  // Drop comments so their prose never counts as UI text: standalone comment
  // lines first, then inline {/* ... */} JSX comments and /* ... */ blocks.
  const clean = readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => (isCommentLine(line) ? '' : line))
    .join('\n')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

  const report = (kind, value, index) => {
    const line = clean.slice(0, index).split('\n').length;
    problems.push(`${relative(ROOT, file)}:${line}  hardcoded ${kind}: "${value.slice(0, 60)}"`);
  };

  const consider = (kind, raw, index) => {
    const value = raw.replace(/\s+/g, ' ').trim();
    if (!value || !hasLetters(value)) return;
    if (ALLOW.has(value)) return;
    if (value.includes('//') || value.includes('/*') || value.includes('*/')) return;
    if (CODE_PUNCT.test(value)) return;
    const firstWord = value.split(/[\s(]/)[0];
    if (CODE_WORDS.has(firstWord)) return;
    report(kind, value, index);
  };

  // Literal attributes.
  for (const m of clean.matchAll(/\b(aria-label|title|placeholder|alt)=(["'])(.*?)\2/g)) {
    consider(m[1], m[3], m.index);
  }

  // JSX text nodes (multi-line aware).
  for (const m of clean.matchAll(/>([^<>{}]+)</gs)) {
    consider('jsx text', m[1], m.index);
  }
}

if (problems.length > 0) {
  console.error(`\ni18n:check FAILED — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error('  ' + problem);
  console.error('\nFix: route the string through t()/tString(), or allowlist it in scripts/i18n-check.mjs.');
  process.exit(1);
}

console.log(
  `i18n:check OK — ${blocks.length} locales, ${masterKeys.size} keys each, no hardcoded user-facing strings.`,
);
