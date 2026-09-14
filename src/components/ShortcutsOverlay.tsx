import { X } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// Keyboard shortcuts overlay, opened with "?".
//
// The key combinations are language-neutral; the labels use the app's existing
// translations where one exists, otherwise a short English description.
// ---------------------------------------------------------------------------

type ShortcutsOverlayProps = {
  onClose: () => void;
};

export function shortcutList(t: (key: string) => string): Array<{ keys: string; label: string }> {
  return [
    { keys: 'Alt + M', label: 'Microphone' },
    { keys: 'Alt + V', label: 'Camera' },
    { keys: 'Alt + S', label: t('call.screenShare') },
    { keys: 'F', label: 'Fullscreen' },
    { keys: '?', label: 'Keyboard shortcuts' },
    { keys: 'Esc', label: t('common.close') },
  ];
}

export default function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  const { t } = useLang();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  return (
    <div className="call-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={trapRef}
        className="call-modal call-shortcuts"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="call-modal-head">
          <strong>Keyboard shortcuts</strong>
          <button type="button" className="call-panel-close" aria-label={t('common.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <ul className="call-shortcuts-list">
          {shortcutList(t).map((shortcut) => (
            <li key={shortcut.keys} className="call-shortcuts-row">
              <kbd className="call-kbd" dir="ltr">{shortcut.keys}</kbd>
              <span>{shortcut.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
