import type { ReactElement, ReactNode } from 'react';

export type LocaleCode =
  | 'en' | 'fr' | 'es' | 'ko' | 'zh' | 'pt' | 'de' | 'it' | 'ar' | 'he';

export type Direction = 'ltr' | 'rtl';

export const LOCALES: ReadonlyArray<{ code: LocaleCode; label: string; dir: Direction }>;

export function LangProvider(props: { children: ReactNode }): ReactElement;

export function useLang(): {
  locale: LocaleCode;
  dir: Direction;
  setLocale: (locale: LocaleCode) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};
