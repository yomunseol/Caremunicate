import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Notifications — the bell's data layer.
//
// The table and the two appointment RPCs live server-side (SQL). This module
// only reads/writes rows and holds the realtime subscription; it never mints a
// room (that happens in respond_appointment via lib/appointments).
// ---------------------------------------------------------------------------

export type NotificationType =
  | 'appointment_requested'
  | 'appointment_approved'
  | 'appointment_declined'
  | 'appointment_cancelled'
  | 'call_missed'
  | 'system';

export type NotificationRow = {
  id: string;
  user_id: string;
  type: string;
  payload: Record<string, unknown> | null;
  read: boolean;
  created_at: string;
};

const TABLE = 'notifications';

/** Newest first, capped — the panel scrolls, it does not paginate. */
export const loadNotifications = async (
  userId: string,
  limit = 30,
): Promise<NotificationRow[]> => {
  if (!userId) return [];

  const { data, error } = await supabase
    .from(TABLE)
    .select('id, user_id, type, payload, read, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('NOTIF ERROR:', error.message);
    return [];
  }
  return (data ?? []) as NotificationRow[];
};

/** The badge count: unread rows for this user. */
export const loadUnreadCount = async (userId: string): Promise<number> => {
  if (!userId) return 0;

  const { count, error } = await supabase
    .from(TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('read', false);

  if (error) {
    console.error('NOTIF ERROR:', error.message);
    return 0;
  }
  return count ?? 0;
};

export const markNotificationRead = async (id: string): Promise<void> => {
  const { error } = await supabase.from(TABLE).update({ read: true }).eq('id', id);
  if (error) console.error('NOTIF ERROR:', error.message);
};

export const markAllNotificationsRead = async (userId: string): Promise<void> => {
  const { error } = await supabase
    .from(TABLE)
    .update({ read: true })
    .eq('user_id', userId)
    .eq('read', false);
  if (error) console.error('NOTIF ERROR:', error.message);
};

/** Display names for the user ids a payload references. */
export const resolveNotificationNames = async (ids: string[]): Promise<Map<string, string>> => {
  const unique = [...new Set(ids.filter(Boolean))];
  const map = new Map<string, string>();
  if (unique.length === 0) return map;

  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, username, email')
    .in('user_id', unique);

  if (error) {
    console.error('NOTIF ERROR:', error.message);
    return map;
  }

  for (const row of (data ?? []) as Array<{
    user_id: string;
    username: string | null;
    email: string | null;
  }>) {
    map.set(row.user_id, row.username?.trim() || row.email?.split('@')[0] || '');
  }
  return map;
};

/**
 * Live INSERTs for this user. Returns the unsubscribe — call it on unmount and
 * on logout so no channel outlives the session.
 */
export const subscribeNotifications = (
  userId: string,
  onInsert: (row: NotificationRow) => void,
): (() => void) => {
  if (!userId) return () => {};

  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: TABLE, filter: `user_id=eq.${userId}` },
      (payload) => onInsert(payload.new as NotificationRow),
    )
    .subscribe();

  return () => {
    void supabase.removeChannel(channel);
  };
};
