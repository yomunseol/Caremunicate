import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X } from 'lucide-react';
import { useCallContext } from '../context/CallContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useLang } from '../i18n';

// ---------------------------------------------------------------------------
// In-call invite drawer.
//
// Everything needed to bring someone else in: the word code, a copy button, the
// share link, and a QR of that link so a phone can scan its way in.
//
// The QR is rendered by `qrcode.react`, which is already a dependency (it draws
// the matrix itself — no API, no key, no network). The underlying `qrcode`
// package is not needed on top of it.
// ---------------------------------------------------------------------------

type CallInviteDrawerProps = {
  onClose: () => void;
};

export default function CallInviteDrawer({ onClose }: CallInviteDrawerProps) {
  const { t } = useLang();
  const { roomCode, notify } = useCallContext();
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const trapRef = useFocusTrap<HTMLElement>(true);

  const joinUrl =
    typeof window === 'undefined' || !roomCode
      ? ''
      : `${window.location.origin}/call/${roomCode}`;

  const copy = (value: string, which: 'code' | 'link') => {
    setCopied(which);
    void navigator.clipboard
      ?.writeText(value)
      .then(() => notify('copied'))
      .catch(() => {})
      .finally(() => window.setTimeout(() => setCopied(null), 2000));
  };

  return (
    <aside
      ref={trapRef}
      className="call-participants call-invite"
      role="dialog"
      aria-modal="true"
      aria-label={t('call.invite')}
    >
      <header className="call-panel-head">
        <strong>{t('call.invite')}</strong>
        <button type="button" className="call-panel-close" aria-label={t('common.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      {roomCode ? (
        <div className="call-invite-body">
          <span className="call-code-chip call-invite-chip" dir="ltr" title={roomCode}>
            {roomCode}
          </span>

          <button type="button" className="ghost-button" onClick={() => copy(roomCode, 'code')}>
            {copied === 'code' ? t('call.copied') : `📋 ${t('call.copyCode')}`}
          </button>

          {joinUrl ? (
            <>
              <button type="button" className="ghost-button" onClick={() => copy(joinUrl, 'link')}>
                {copied === 'link' ? t('call.copied') : `🔗 ${t('call.shareLink')}`}
              </button>

              <div className="call-invite-qr">
                <QRCodeSVG
                  value={joinUrl}
                  size={148}
                  level="M"
                  marginSize={1}
                  bgColor="#ffffff"
                  fgColor="#0d2b24"
                  title={joinUrl}
                />
              </div>
              <span className="call-invite-scan">{t('call.scanToJoin')}</span>
            </>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
