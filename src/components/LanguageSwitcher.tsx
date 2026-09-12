import { useEffect, useRef, useState } from 'react';
import { LOCALES, useLang } from '../i18n';

// Globe dropdown in the app header. Lists every locale by its native name and
// persists the choice through useLang() (localStorage).
export default function LanguageSwitcher() {
  const { locale, setLocale, t } = useLang();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close when clicking outside the switcher.
  useEffect(() => {
    if (!open) return;

    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const current = LOCALES.find((entry) => entry.code === locale) ?? LOCALES[0];

  return (
    <div className="lang-switcher" ref={rootRef}>
      <button
        type="button"
        className="lang-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('lang.aria')}
        onClick={() => setOpen((previous) => !previous)}
      >
        <span aria-hidden="true">🌐</span>
        <span className="lang-current">{current.label}</span>
      </button>

      {open ? (
        <ul className="lang-menu" role="listbox" aria-label={t('lang.aria')}>
          {LOCALES.map((entry) => (
            <li key={entry.code}>
              <button
                type="button"
                role="option"
                aria-selected={entry.code === locale}
                className={entry.code === locale ? 'lang-option active' : 'lang-option'}
                onClick={() => {
                  setLocale(entry.code);
                  setOpen(false);
                }}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
