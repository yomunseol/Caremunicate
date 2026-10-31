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
};

/** Every document for one call, newest first. Fails soft. */
export const listCareDocs = async (callId: string): Promise<CareDoc[]> => {
  if (!callId) return [];

  const { data, error } = await supabase
    .from('caremunicate_docs')
    .select('*')
    .eq('call_id', callId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('CAREDOCS ERROR:', error.message);
    return [];
  }
  return (data ?? []) as CareDoc[];
};

/** Create a document. An empty title falls back to the DB default. */
export const createCareDoc = async (payload: {
  callId: string;
  creatorId: string;
  title: string;
  lockStatus: 'locked' | 'unlocked';
}): Promise<CareDoc | null> => {
  if (!payload.callId || !payload.creatorId) return null;

  const title = payload.title.trim();
  const { data, error } = await supabase
    .from('caremunicate_docs')
    .insert({
      call_id: payload.callId,
      creator_id: payload.creatorId,
      ...(title ? { title } : {}),
      lock_status: payload.lockStatus,
      content: '',
    })
    .select('*')
    .single();

  if (error) {
    console.error('CAREDOCS ERROR:', error.message);
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
    console.error('CAREDOCS ERROR:', error.message);
    return null;
  }
  return (data as CareDoc) ?? null;
};
