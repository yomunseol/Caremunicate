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
  /**
   * JSX translation. A key with no tokens returns a string; a key with tokens
   * returns a node whose interpolated values are wrapped in <bdi>, so mixed
   * direction content cannot scramble. Use tString for string-only contexts.
   */
  t: {
    (key: string): string;
    (key: string, vars: Record<string, string | number>): ReactNode;
  };
  /**
   * String translation for contexts that must stay a string (aria-label,
   * title, state, ICS). Interpolated values are isolated with U+2068/U+2069.
   */
  tString: (key: string, vars?: Record<string, string | number>) => string;
};
