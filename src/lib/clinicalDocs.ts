import { supabase } from './supabase';
import { firstRow } from './rows';

// ---------------------------------------------------------------------------
// Caremunicate Docs — a doctor's clinical notes for one call session.
//
// One doc per (call_session_id, author_id). edit_mode is chosen at creation and
// is IMMUTABLE: 'meeting_only' docs lock when the session ends, 'anytime' docs
// stay editable. The lock is enforced by RLS as well as the UI.
// ---------------------------------------------------------------------------

export type EditMode = 'meeting_only' | 'anytime';

export type ClinicalDoc = {
  id: string;
  call_session_id: string | null;
  appointment_id: string | null;
  author_id: string;
  title: string | null;
  content: string;
  edit_mode: EditMode;
  created_at: string;
  updated_at: string;
};

export const loadClinicalDoc = async (
  sessionId: string,
  authorId: string,
): Promise<ClinicalDoc | null> => {
  if (!sessionId || !authorId) return null;

  const { data, error } = await supabase
    .from('clinical_docs')
    .select('*')
    .eq('call_session_id', sessionId)
    .eq('author_id', authorId)
    .maybeSingle();

  if (error) {
    console.error('CALL ERROR:', error.message);
    return null;
  }
  return firstRow<ClinicalDoc>(data);
};

/** The "Create New Doc" step — edit_mode is fixed here. */
export const createClinicalDoc = async (payload: {
  sessionId: string;
  authorId: string;
  editMode: EditMode;
  appointmentId?: string | null;
  title?: string | null;
}): Promise<ClinicalDoc | null> => {
  const { data, error } = await supabase
    .from('clinical_docs')
    .insert({
      call_session_id: payload.sessionId,
      appointment_id: payload.appointmentId ?? null,
      author_id: payload.authorId,
      title: payload.title ?? null,
      content: '',
      edit_mode: payload.editMode,
    })
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('CALL ERROR:', error.message);
    return null;
  }
  return firstRow<ClinicalDoc>(data);
};

/** Update the body. A save against a locked doc is rejected by RLS. */
export const saveClinicalDoc = async (payload: {
  id: string;
  content: string;
  title?: string | null;
}): Promise<ClinicalDoc | null> => {
  if (!payload.id) return null;

  const { data, error } = await supabase
    .from('clinical_docs')
    .update({
      content: payload.content,
      ...(payload.title !== undefined ? { title: payload.title } : {}),
    })
    .eq('id', payload.id)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('CALL ERROR:', error.message);
    return null;
  }
  return firstRow<ClinicalDoc>(data);
};

/**
 * A 'meeting_only' doc is locked once its session has ended (or is gone).
 * An 'anytime' doc is never locked.
 */
export const isDocLocked = (
  doc: Pick<ClinicalDoc, 'edit_mode'> | null,
  session: { ended_at: string | null } | null,
): boolean => {
  if (!doc) return false;
  if (doc.edit_mode === 'anytime') return false;
  return !session || session.ended_at !== null;
};
