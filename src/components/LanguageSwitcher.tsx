import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LOCALES, useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Language switcher.
//
// The menu is rendered through createPortal(document.body) with position: fixed
// and an explicit z-index, because the header sits in a lower stacking context
// than Leaflet's map panes (which use z-index 400–1000) and `.topbar` carries a
// `backdrop-filter`, which would otherwise make it a containing block for a
// fixed-position menu. Portaling to <body> escapes both problems.
// The menu tracks the trigger's bounding rect on scroll/resize.
// ---------------------------------------------------------------------------

const MENU_MIN_WIDTH = 176; // ≈ 11rem, matching .lang-menu
const VIEWPORT_GUTTER = 8;

type MenuPosition = {
  top: number;
  left: number;
  minWidth: number;
};

export default function LanguageSwitcher() {
  const { locale, dir, setLocale, t } = useLang();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLUListElement | null>(null);

  const isRtl = dir === 'rtl';

  // Anchor the menu to the trigger. LTR: align to the button's left edge.
  // RTL: align to its right edge, so it opens toward the inline start.
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const minWidth = Math.max(rect.width, MENU_MIN_WIDTH);
    const top = rect.bottom + VIEWPORT_GUTTER;
    const rawLeft = isRtl ? rect.right - minWidth : rect.left;

    // Keep it inside the viewport on narrow screens.
    const maxLeft = Math.max(VIEWPORT_GUTTER, window.innerWidth - minWidth - VIEWPORT_GUTTER);
    const left = Math.min(Math.max(VIEWPORT_GUTTER, rawLeft), maxLeft);

    setPosition({ top, left, minWidth });
  }, [isRtl]);

  // Measure before paint so the first frame isn't at a stale position.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, updatePosition]);

  // Re-anchor while the page moves under it.
  useEffect(() => {
    if (!open) return;

    const handle = () => updatePosition();
    window.addEventListener('scroll', handle, true); // capture: any scrollable ancestor
    window.addEventListener('resize', handle);

    return () => {
      window.removeEventListener('scroll', handle, true);
      window.removeEventListener('resize', handle);
    };
  }, [open, updatePosition]);

  // Dismiss on outside click or Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = LOCALES.find((entry) => entry.code === locale) ?? LOCALES[0];

  const menu =
    open && position
      ? createPortal(
          <ul
            ref={menuRef}
            role="listbox"
            aria-label={t('lang.aria')}
            className="lang-menu"
            style={{
              position: 'fixed',
              top: position.top,
              left: position.left,
              right: 'auto',
              minWidth: position.minWidth,
              zIndex: 2000,
            }}
          >
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
          </ul>,
          document.body,
        )
      : null;

  return (
    <>
      <div className="lang-switcher">
        <button
          ref={triggerRef}
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
      </div>
      {menu}
    </>
  );
}
