// ---------------------------------------------------------------------------
// The specialty concept registry.
//
// A medical specialty, in every language we ship: one canonical id, the OSM
// `healthcare:specialty` token it maps to, and the aliases people actually
// type — including colloquials and the misspellings patients use.
//
// MATCHING RULE (see matchConcept below): an alias matches when it is a
// substring of the query OR the query is a substring of it, so a language
// without word breaks (zh, ko, ja) matches without tokenizing.
//
// TO ADD A CONCEPT:
//   1. push one entry, in the order it should win ties (first match wins);
//   2. `id` is a stable lowercase slug, never a display string;
//   3. `osm` is the EXACT token used in the `healthcare:specialty` OSM tag;
//   4. list aliases for ALL ten locales — an empty locale silently loses
//      matching for that language. Two-letter aliases are the minimum, since
//      the reverse direction is guarded at length 2.
// ---------------------------------------------------------------------------

export const SPECIALTY_LOCALES = ['en', 'fr', 'es', 'ko', 'zh', 'pt', 'de', 'it', 'ar', 'he'] as const;

export type SpecialtyLocale = (typeof SPECIALTY_LOCALES)[number];

export type SpecialtyConcept = {
  /** Stable slug. Never rendered. */
  id: string;
  /** The token this concept looks for in `healthcare:specialty`. */
  osm: string;
  /** Aliases per locale; every locale must carry at least one. */
  aliases: Record<SpecialtyLocale, string[]>;
};

export const SPECIALTIES: SpecialtyConcept[] = [
  {
    id: 'dermatology',
    osm: 'dermatology',
    aliases: {
      en: ['dermatology', 'dermatologist', 'derm'],
      fr: ['dermatologie', 'dermatologue', 'dermato'],
      es: ['dermatología', 'dermatólogo'],
      ko: ['피부과'],
      zh: ['皮肤科', '皮肤'],
      pt: ['dermatologia', 'dermatologista'],
      de: ['Dermatologie', 'Hautarzt'],
      it: ['dermatologia', 'dermatologo'],
      ar: ['جلدية', 'الأمراض الجلدية'],
      he: ['דרמטולוגיה', 'עור'],
    },
  },
  {
    id: 'ophthalmology',
    osm: 'ophthalmology',
    aliases: {
      en: ['ophthalmology', 'eye clinic', 'eye'],
      fr: ['ophtalmologie', 'ophtalmologue', 'yeux'],
      es: ['oftalmología', 'oftalmólogo'],
      ko: ['안과'],
      zh: ['眼科'],
      pt: ['oftalmologia', 'oftalmologista'],
      de: ['Augenheilkunde', 'Augenarzt'],
      it: ['oftalmologia', 'oculista'],
      ar: ['طب العيون', 'عيون'],
      he: ['רפואת עיניים', 'עיניים'],
    },
  },
  {
    id: 'paediatrics',
    osm: 'paediatrics',
    aliases: {
      en: ['pediatrics', 'paediatrics', 'children'],
      fr: ['pédiatrie', 'pédiatre'],
      es: ['pediatría', 'pediatra'],
      ko: ['소아과', '소아청소년과'],
      zh: ['儿科'],
      pt: ['pediatria', 'pediatra'],
      de: ['Pädiatrie', 'Kinderarzt'],
      it: ['pediatria', 'pediatra'],
      ar: ['طب الأطفال', 'أطفال'],
      he: ['רפואת ילדים', 'ילדים'],
    },
  },
  {
    id: 'dentistry',
    osm: 'dentist',
    aliases: {
      en: ['dentistry', 'dentist', 'dental'],
      fr: ['dentiste', 'stomatologie'],
      es: ['dentista', 'odontología'],
      ko: ['치과'],
      zh: ['口腔科', '牙科'],
      pt: ['dentista', 'odontologia'],
      de: ['Zahnarzt', 'Zahnmedizin'],
      it: ['dentista', 'odontoiatria'],
      ar: ['طب الأسنان', 'أسنان'],
      he: ['רפואת שיניים', 'שיניים'],
    },
  },
  {
    id: 'internal',
    osm: 'internal',
    aliases: {
      en: ['internal medicine'],
      fr: ['médecine interne', 'généraliste'],
      es: ['medicina interna', 'médico general'],
      ko: ['내과'],
      zh: ['内科'],
      pt: ['medicina interna', 'clínico geral'],
      de: ['Innere Medizin', 'Hausarzt'],
      it: ['medicina interna', 'medico di base'],
      ar: ['باطنة', 'طب باطني'],
      he: ['רפואה פנימית'],
    },
  },
  {
    id: 'psychiatry',
    osm: 'psychiatry',
    aliases: {
      en: ['psychiatry', 'psychiatrist', 'mental health'],
      fr: ['psychiatrie', 'psychiatre'],
      es: ['psiquiatría', 'psiquiatra'],
      ko: ['정신과', '정신건강의학과'],
      zh: ['精神科'],
      pt: ['psiquiatria', 'psiquiatra'],
      de: ['Psychiatrie', 'Psychiater'],
      it: ['psichiatria', 'psichiatra'],
      ar: ['طب نفسي', 'نفسي'],
      he: ['פסיכיאטריה'],
    },
  },
  {
    id: 'orthopaedics',
    osm: 'orthopaedics',
    aliases: {
      en: ['orthopedics', 'orthopaedics', 'ortho'],
      fr: ['orthopédie', 'orthopédiste'],
      es: ['ortopedia', 'traumatología'],
      ko: ['정형외과'],
      zh: ['骨科'],
      pt: ['ortopedia', 'ortopedista'],
      de: ['Orthopädie', 'Orthopäde'],
      it: ['ortopedia', 'ortopedico'],
      ar: ['عظام', 'جراحة العظام'],
      he: ['אורתופדיה'],
    },
  },
  {
    id: 'gynaecology',
    osm: 'gynaecology',
    aliases: {
      en: ['gynecology', 'gynaecology', 'ob-gyn'],
      fr: ['gynécologie', 'gynécologue'],
      es: ['ginecología', 'ginecólogo'],
      ko: ['산부인과'],
      zh: ['妇产科'],
      pt: ['ginecologia', 'ginecologista', 'obstetrícia'],
      de: ['Gynäkologie', 'Frauenarzt'],
      it: ['ginecologia', 'ginecologo'],
      ar: ['نساء وتوليد', 'نسائية'],
      he: ['גינקולוגיה', 'נשים'],
    },
  },
  {
    id: 'ent',
    osm: 'otolaryngology',
    aliases: {
      en: ['ent', 'otolaryngology', 'ear nose throat'],
      fr: ['orl', 'oto-rhino-laryngologie'],
      es: ['otorrinolaringología'],
      ko: ['이비인후과'],
      zh: ['耳鼻喉科'],
      pt: ['otorrinolaringologia', 'otorrino'],
      de: ['hno', 'Hals-Nasen-Ohren'],
      it: ['otorinolaringoiatria', 'otorino'],
      ar: ['أنف وأذن وحنجرة'],
      he: ['אף אוזן גרון'],
    },
  },
  {
    id: 'cardiology',
    osm: 'cardiology',
    aliases: {
      en: ['cardiology', 'cardiologist', 'heart'],
      fr: ['cardiologie', 'cardiologue'],
      es: ['cardiología', 'cardiólogo'],
      ko: ['순환기과', '심장내과'],
      zh: ['心血管科', '心脏科'],
      pt: ['cardiologia', 'cardiologista'],
      de: ['Kardiologie', 'Kardiologe', 'Herz'],
      it: ['cardiologia', 'cardiologo'],
      ar: ['قلب', 'أمراض القلب'],
      he: ['קרדיולוגיה', 'לב'],
    },
  },
  {
    id: 'neurology',
    osm: 'neurology',
    aliases: {
      en: ['neurology', 'neurologist', 'brain'],
      fr: ['neurologie', 'neurologue'],
      es: ['neurología', 'neurólogo'],
      ko: ['신경과'],
      zh: ['神经内科', '神经科'],
      pt: ['neurologia', 'neurologista'],
      de: ['Neurologie', 'Neurologe'],
      it: ['neurologia', 'neurologo'],
      ar: ['أعصاب', 'طب الأعصاب'],
      he: ['נוירולוגיה', 'עצבים'],
    },
  },
];

// ---------------------------------------------------------------------------
// Matching — pure, so the acceptance matrix can be run without a network.
// ---------------------------------------------------------------------------

/** Lowercase, trim, collapse runs of whitespace. */
export const normalizeQuery = (query: string): string =>
  String(query ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');

/** The reverse direction needs a floor, or 'e' would match every concept. */
const MIN_REVERSE_LENGTH = 2;

/** Every alias of a concept, across all locales — matching is locale-agnostic. */
export const aliasesOf = (concept: SpecialtyConcept): string[] =>
  SPECIALTY_LOCALES.flatMap((locale) => concept.aliases[locale]);

export type ConceptMatch = {
  concept: SpecialtyConcept;
  /** The aliases that actually fired, for debugging and for stripping. */
  matched: string[];
};

/**
 * The first concept whose alias is a substring of the query, or — for scripts
 * without word breaks — whose alias CONTAINS the query. Order in SPECIALTIES
 * decides ties.
 */
export const matchConcept = (query: string): ConceptMatch | null => {
  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  for (const concept of SPECIALTIES) {
    const matched = aliasesOf(concept).filter((alias) => {
      const candidate = normalizeQuery(alias);
      if (!candidate) return false;
      if (candidate.length >= MIN_REVERSE_LENGTH && normalized.includes(candidate)) return true;
      return normalized.length >= MIN_REVERSE_LENGTH && candidate.includes(normalized);
    });
    if (matched.length > 0) return { concept, matched };
  }
  return null;
};

/**
 * The query with the matched aliases cut out — what's left is the place name
 * that goes to geocoding. Ordering is longest-first so 'dermatologist' does not
 * leave a stray 'ist' behind after 'dermatology' is removed.
 */
export const stripAliases = (query: string, matched: string[]): string => {
  let rest = normalizeQuery(query);
  for (const alias of [...matched].sort((a, b) => b.length - a.length)) {
    rest = rest.split(normalizeQuery(alias)).join(' ');
  }
  return rest.replace(/\s+/g, ' ').trim();
};

/** One call for the pipeline: the concept, what matched, and the place remainder. */
export const resolveSpecialty = (
  query: string,
): { concept: SpecialtyConcept; matched: string[]; remainder: string } | null => {
  const match = matchConcept(query);
  if (!match) return null;
  return {
    concept: match.concept,
    matched: match.matched,
    remainder: stripAliases(query, match.matched),
  };
};
