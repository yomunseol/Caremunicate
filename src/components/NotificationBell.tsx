import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  CalendarPlus,
  CheckCircle2,
  Info,
  MinusCircle,
  PhoneMissed,
  XCircle,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLang } from '../i18n';
import { useToast } from '../context/ToastContext';
import { describeError } from '../lib/errors';
import { isProvider } from '../lib/roles';
import { parseDate } from '../lib/time';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { approveAppointment, respondToAppointment } from '../lib/appointments';
import {
  loadNotifications,
  loadUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  resolveNotificationNames,
  subscribeNotifications,
  type NotificationRow,
} from '../lib/notifications';

// ---------------------------------------------------------------------------
// Notification bell + panel.
//
// The bell sits in the header nav; the panel is PORTALED to <body> and anchored
// under the bell on the inline-end edge (mirrors under RTL). Escape or an
// outside click closes it; focus is trapped while it is open.
// ---------------------------------------------------------------------------

type NotificationBellProps = {
  /** profiles.role — providers get the inline Approve/Decline triage. */
  role: string;
  onNavigate: (route: 'calendar' | 'call') => void;
};

const PANEL_WIDTH = 360;
const GUTTER = 8;

const TYPE_ICON: Record<string, typeof Bell> = {
  appointment_requested: CalendarPlus,
  appointment_approved: CheckCircle2,
  appointment_declined: XCircle,
  appointment_cancelled: MinusCircle,
  call_missed: PhoneMissed,
  system: Info,
};

const relativeTime = (iso: string, locale: string): string => {
  const parsed = parseDate(iso, 'NotificationBell.relativeTime');
  if (!parsed) return '';
  const then = parsed.getTime();

  const diffSeconds = Math.round((then - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ];

  for (const [unit, seconds] of units) {
    if (Math.abs(diffSeconds) >= seconds || unit === 'second') {
      return rtf.format(Math.round(diffSeconds / seconds), unit);
    }
  }
  return '';
};

/**
 * The {{time}} of a request: locale date + 24-hour clock (never AM/PM), or '—'
 * when the payload carries no usable time — the bell must never crash on it.
 */
const absoluteTime = (value: unknown, locale: string): string => {
  const date = parseDate(typeof value === 'string' ? value : null, 'NotificationBell');
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return '—';
  }
};

export default function NotificationBell({ role, onNavigate }: NotificationBellProps) {
  const { user } = useAuth();
  const { t, locale } = useLang();
  const { notify } = useToast();
  const provider = isProvider(role);

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [anchorEnd, setAnchorEnd] = useState(GUTTER);
  const [anchorTop, setAnchorTop] = useState(0);

  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useFocusTrap<HTMLDivElement>(open);

  const userId = user?.id ?? '';

  // ---- load + realtime -----------------------------------------------------
  const load = useCallback(async () => {
    if (!userId) {
      setItems([]);
      setUnread(0);
      return;
    }

    const [next, count] = await Promise.all([
      loadNotifications(userId),
      loadUnreadCount(userId),
    ]);
    setItems(next);
    setUnread(count);

    const ids = next
      .map((row) => {
        const payload = row.payload ?? {};
        const id = payload.patient_id ?? payload.provider_id;
        return typeof id === 'string' ? id : '';
      })
      .filter(Boolean);
    setNames(await resolveNotificationNames(ids));
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live INSERTs: prepend + bump the badge, no refresh.
  useEffect(() => {
    if (!userId) return;
    return subscribeNotifications(userId, (row) => {
      setItems((previous) => [row, ...previous.filter((item) => item.id !== row.id)]);
      if (!row.read) setUnread((count) => count + 1);
    });
  }, [userId]);

  // ---- anchoring -----------------------------------------------------------
  const reposition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const width = Math.min(PANEL_WIDTH, window.innerWidth * 0.9);
    // Distance from the viewport's inline-END edge, which mirrors under RTL.
    const raw = document.documentElement.dir === 'rtl'
      ? rect.left
      : window.innerWidth - rect.right;
    const max = Math.max(GUTTER, window.innerWidth - width - GUTTER);
    setAnchorEnd(Math.min(Math.max(GUTTER, raw), max));
    setAnchorTop(rect.bottom + GUTTER);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const handle = () => reposition();
    window.addEventListener('scroll', handle, true);
    window.addEventListener('resize', handle);
    return () => {
      window.removeEventListener('scroll', handle, true);
      window.removeEventListener('resize', handle);
    };
  }, [open, reposition]);

  // Escape + outside click.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, panelRef]);

  // ---- actions -------------------------------------------------------------
  const titleFor = (row: NotificationRow): ReactNode => {
    const payload = row.payload ?? {};
    const nameId = payload.patient_id ?? payload.provider_id;
    const name = (typeof nameId === 'string' ? names.get(nameId) : '') || '';

    if (row.type === 'appointment_requested') {
      return t('notif.notifRequested', {
        name: name || t('chat.participant'),
        time: absoluteTime(payload.start_at, locale),
      });
    }
    if (row.type === 'appointment_approved') {
      return t('notif.notifApproved', { code: String(payload.code ?? '') });
    }
    if (row.type === 'appointment_declined') return t('notif.notifDeclined');

    const custom = typeof payload.title === 'string' ? payload.title : '';
    return custom || t('notif.notifications');
  };

  const appointmentIdOf = (row: NotificationRow): string => {
    const value = (row.payload ?? {}).appointment_id;
    return typeof value === 'string' ? value : '';
  };

  const openRow = (row: NotificationRow) => {
    void markNotificationRead(row.id);
    setItems((previous) =>
      previous.map((item) => (item.id === row.id ? { ...item, read: true } : item)),
    );
    if (!row.read) setUnread((count) => Math.max(0, count - 1));
    setOpen(false);

    if (row.type === 'call_missed') onNavigate('call');
    else onNavigate('calendar');
  };

  const markAll = () => {
    if (!userId) return;
    void markAllNotificationsRead(userId);
    setItems((previous) => previous.map((item) => ({ ...item, read: true })));
    setUnread(0);
  };

  const approve = async (row: NotificationRow) => {
    const appointmentId = appointmentIdOf(row);
    if (!appointmentId) return;

    setBusyId(row.id);
    const result = await approveAppointment(appointmentId);
    setBusyId(null);

    if (!result.ok) {
      notify(`${t('auth.toast.planError')} (${result.code})`, 'error');
      return;
    }

    // The row morphs to its approved state, badge stays truthful.
    setItems((previous) =>
      previous.map((item) =>
        item.id === row.id
          ? { ...item, type: 'appointment_approved', payload: { ...(item.payload ?? {}), code: result.code }, read: true }
          : item,
      ),
    );
    notify(t('notif.notifApproved', { code: result.code }), 'success');
  };

  const decline = async (row: NotificationRow) => {
    const appointmentId = appointmentIdOf(row);
    if (!appointmentId) return;

    setConfirmingId(null);
    setBusyId(row.id);
    const result = await respondToAppointment(appointmentId, false);
    setBusyId(null);

    if (!result.ok) {
      notify(`${t('auth.toast.planError')} (${result.code})`, 'error');
      return;
    }

    setItems((previous) =>
      previous.map((item) =>
        item.id === row.id
          ? { ...item, type: 'appointment_declined', payload: {}, read: true }
          : item,
      ),
    );
    notify(t('notif.notifDeclined'), 'info');
  };

  // ---- render --------------------------------------------------------------
  const badge = unread > 9 ? '9+' : String(unread);

  const panel =
    open && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={panelRef}
            className="notif-panel"
            role="dialog"
            aria-modal="false"
            aria-label={t('notif.notifications')}
            style={{ top: anchorTop, insetInlineEnd: anchorEnd }}
          >
            <div className="notif-head">
              <strong className="notif-title">{t('notif.notifications')}</strong>
              <button type="button" className="notif-mark" onClick={markAll}>
                {t('notif.markAllRead')}
              </button>
            </div>

            {items.length === 0 ? (
              <div className="notif-empty">
                <Bell size={22} aria-hidden="true" />
                <p>{t('notif.allCaughtUp')}</p>
              </div>
            ) : (
              <ul className="notif-list">
                {items.map((row) => {
                  const Icon = TYPE_ICON[row.type] ?? Info;
                  const appointmentId = appointmentIdOf(row);
                  const canTriage = provider && row.type === 'appointment_requested' && Boolean(appointmentId);

                  return (
                    <li key={row.id}>
                      <div className={`notif-row${row.read ? '' : ' is-unread'}`}>
                        <button type="button" className="notif-main" onClick={() => openRow(row)}>
                          <span className="notif-icon" aria-hidden="true">
                            <Icon size={16} />
                          </span>
                          <span className="notif-copy">
                            <span className="notif-text">{titleFor(row)}</span>
                            <span className="notif-time">{relativeTime(row.created_at, locale)}</span>
                          </span>
                        </button>

                        {canTriage ? (
                          <div className="notif-triage">
                            {confirmingId === row.id ? (
                              <>
                                <button
                                  type="button"
                                  className="primary-button notif-decline"
                                  disabled={busyId === row.id}
                                  onClick={() => void decline(row)}
                                >
                                  {t('notif.declineRequest')}
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  onClick={() => setConfirmingId(null)}
                                >
                                  {t('common.cancel')}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="primary-button notif-approve"
                                  disabled={busyId === row.id}
                                  onClick={() => void approve(row)}
                                >
                                  {t('notif.approveRequest')}
                                </button>
                                <button
                                  type="button"
                                  className="ghost-button"
                                  disabled={busyId === row.id}
                                  onClick={() => setConfirmingId(row.id)}
                                >
                                  {t('notif.declineRequest')}
                                </button>
                              </>
                            )}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="notif-bell"
        aria-label={t('notif.notifications')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((previous) => !previous)}
      >
        <Bell size={18} aria-hidden="true" />
        {unread > 0 ? <span className="notif-badge">{badge}</span> : null}
      </button>
      {panel}
    </>
  );
}
