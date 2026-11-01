import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Caremunicate Documents — collaborative medical documents for one call.
// One row per document in public.caremunicate_docs, keyed by the call room id.
// updated_at is maintained by the DB trigger, never written here.
// ---------------------------------------------------------------------------

export type CareDoc = {
  id: string;
  call_id: string;
  creator_id: string;
  title: string;
  content: string | null;
  lock_status: 'locked' | 'unlocked';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** Every document for one call, newest first. Fails soft. */
export const listCareDocs = async (callId: string): Promise<CareDoc[]> => {
  if (!callId) return [];

  const { data, error } = await supabase
    .from('caremunicate_docs')
    .select('*')
    .eq('call_id', callId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('CAREDOCS ERROR:', error.message, error);
    return [];
  }
  return (data ?? []) as CareDoc[];
};

/** Documents created by one user, across calls. Null on a query error. */
export const listMyCareDocs = async (userId: string): Promise<CareDoc[] | null> => {
  if (!userId) return [];

  const { data, error } = await supabase
    .from('caremunicate_docs')
    .select('*')
    .eq('creator_id', userId)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('CAREDOCS ERROR:', error.message, error);
    return null;
  }
  return (data ?? []) as CareDoc[];
};

/** Create a document. An empty title falls back to the DB default. */
export const createCareDoc = async (payload: {
  callId: string;
  title: string;
  lockStatus: 'locked' | 'unlocked';
}): Promise<CareDoc | null> => {
  if (!payload.callId) return null;

  // Resolve the user from the live client — never a possibly-stale prop.
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    console.error('CAREDOCS ERROR: no authenticated user', authError);
    return null;
  }

  const title = payload.title.trim();
  const { data, error } = await supabase
    .from('caremunicate_docs')
    .insert({
      call_id: payload.callId,
      creator_id: user.id,
      ...(title ? { title } : {}),
      lock_status: payload.lockStatus,
      content: '',
    })
    .select('*')
    .single();

  if (error) {
    console.error('CAREDOCS ERROR:', error.message, error);
    return null;
  }
  return (data as CareDoc) ?? null;
};

/** Autosave title + content for one document. */
export const saveCareDoc = async (payload: {
  id: string;
  title: string;
  content: string;
}): Promise<CareDoc | null> => {
  if (!payload.id) return null;

  const { data, error } = await supabase
    .from('caremunicate_docs')
    .update({ title: payload.title, content: payload.content })
    .eq('id', payload.id)
    .select('*')
    .single();

  if (error) {
    console.error('CAREDOCS ERROR:', error.message, error);
    return null;
  }
  return (data as CareDoc) ?? null;
};

/** Rename only — content and lock status are untouched. */
export const renameCareDoc = async (id: string, title: string): Promise<CareDoc | null> => {
  const nextTitle = title.trim();
  if (!id || !nextTitle) return null;

  const { data, error } = await supabase
    .from('caremunicate_docs')
    .update({ title: nextTitle })
    .eq('id', id)
    .select('*')
    .single();

  if (error) {
    console.error('CAREDOCS ERROR:', error.message, error);
    return null;
  }
  return (data as CareDoc) ?? null;
};

/** Copy a document under the current user, title suffixed with " (Copy)". */
export const duplicateCareDoc = async (doc: CareDoc): Promise<CareDoc | null> => {
  if (!doc?.id) return null;

  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    console.error('CAREDOCS ERROR: no authenticated user', authError);
    return null;
  }

  const { data, error } = await supabase
    .from('caremunicate_docs')
    .insert({
      call_id: doc.call_id,
      creator_id: user.id,
      title: `${doc.title} (Copy)`,
      content: doc.content ?? '',
      lock_status: doc.lock_status,
    })
    .select('*')
    .single();

  if (error) {
    console.error('CAREDOCS ERROR:', error.message, error);
    return null;
  }
  return (data as CareDoc) ?? null;
};

/** Soft delete — sets deleted_at; the row is never hard-deleted. */
export const softDeleteCareDoc = async (id: string): Promise<boolean> => {
  if (!id) return false;

  try {
    const { error } = await supabase
      .from('caremunicate_docs')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    if (error) {
      // Exact Supabase reason, not the generic UI text.
      console.error('Supabase Delete Error:', error.message, error.details, error.hint, error.code);

      if (error.code === '42703' || /deleted_at/i.test(error.message)) {
        console.error(
          'CAREDOCS SCHEMA: public.caremunicate_docs.deleted_at is missing. Run: alter table public.caremunicate_docs add column if not exists deleted_at timestamptz;',
        );
      }
      if (error.code === '42501' || /row-level security|permission denied/i.test(error.message)) {
        console.error(
          'CAREDOCS RLS: the UPDATE was blocked by RLS. Add an UPDATE policy for public.caremunicate_docs.',
        );
      }
      return false;
    }
    return true;
  } catch (caught) {
    const failure = caught as { message?: string; details?: string; hint?: string; code?: string };
    console.error('Supabase Delete Error:', failure?.message ?? String(caught), failure?.details);
    return false;
  }
};
