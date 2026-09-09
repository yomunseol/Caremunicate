import { supabase } from './supabase';

type ParticipantRole = 'patient' | 'doctor' | 'hospital';

// Creates a 1:1 conversation between two users, or returns the existing one.
// Each participant's profile role is snapshotted into
// conversation_participants.role at creation time so later role changes never
// retroactively alter who is "patient" vs "doctor" in this conversation.
export async function createDirectConversation(userId1: string, userId2: string): Promise<string> {
  console.log('Creating conversation between:', userId1, userId2);

  if (!userId1 || !userId2) {
    throw new Error('Both user IDs are required.');
  }

  if (userId1 === userId2) {
    throw new Error('A direct conversation requires two different users.');
  }

  // Boundary guard: only one of the two participants may create the
  // conversation (defense in depth — RLS still enforces this server-side).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.id !== userId1) {
    throw new Error('You can only start a conversation as one of its participants.');
  }

  // 1) Snapshot both users' roles from profiles.
  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('user_id, role')
    .in('user_id', [userId1, userId2]);

  if (profileError) throw profileError;

  const roleByUser = new Map<string, ParticipantRole | null>(
    (profiles ?? []).map((p) => [p.user_id as string, p.role as ParticipantRole | null]),
  );

  for (const userId of [userId1, userId2]) {
    const role = roleByUser.get(userId);
    if (!role) {
      throw new Error(`User ${userId} has no profile role — cannot create a care conversation.`);
    }
  }

  // 2) Duplicate check: an existing conversation has BOTH users as
  // participants, regardless of which id is passed first.
  const { data: memberships, error: lookupError } = await supabase
    .from('conversation_participants')
    .select('conversation_id')
    .in('user_id', [userId1, userId2]);

  if (lookupError) throw lookupError;

  const memberCount = new Map<string, number>();
  for (const row of memberships ?? []) {
    const conversationId = row.conversation_id as string;
    memberCount.set(conversationId, (memberCount.get(conversationId) ?? 0) + 1);
  }

  const existingConversationId = [...memberCount.entries()].find(([, count]) => count === 2)?.[0];
  if (existingConversationId) {
    console.log('Conversation already exists:', existingConversationId);
    return existingConversationId;
  }

  // 3) Create the conversation row, then both participant rows.
  const { data: conversation, error: insertError } = await supabase
    .from('conversations')
    .insert({})
    .select('id')
    .single();

  if (insertError) throw insertError;

  const conversationId = conversation.id as string;

  const { error: participantsError } = await supabase.from('conversation_participants').insert([
    {
      conversation_id: conversationId,
      user_id: userId1,
      role: roleByUser.get(userId1),
    },
    {
      conversation_id: conversationId,
      user_id: userId2,
      role: roleByUser.get(userId2),
    },
  ]);

  if (participantsError) {
    // Best-effort rollback: never leave an empty, orphaned conversation behind.
    await supabase.from('conversations').delete().eq('id', conversationId);
    throw participantsError;
  }

  console.log('Created conversation:', conversationId);
  return conversationId;
}
