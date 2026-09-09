import { supabase } from './supabase';

// Creates a 1:1 conversation between two users, or returns the existing one.
//
// The actual insert is delegated to the SECURITY DEFINER Postgres function
// create_direct_conversation() (see supabase/migrations), which runs the
// conversation + participant inserts in ONE transaction, snapshots both
// users' roles from profiles into conversation_participants.role, serializes
// concurrent duplicate creations with an advisory lock, and re-verifies that
// auth.uid() is one of the two participants server-side.
//
// RLS intentionally has NO direct INSERT policies on conversations or
// conversation_participants, so this RPC is the only creation path.
export async function createDirectConversation(userId1: string, userId2: string): Promise<string> {
  console.log('Creating conversation between:', userId1, userId2);

  if (!userId1 || !userId2) {
    throw new Error('Both user IDs are required.');
  }

  if (userId1 === userId2) {
    throw new Error('A direct conversation requires two different users.');
  }

  // Application-level early check (the RPC re-checks this server-side, so a
  // tampered client cannot bypass it).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || user.id !== userId1) {
    throw new Error('You can only start a conversation as one of its participants.');
  }

  const { data, error } = await supabase.rpc('create_direct_conversation', {
    p_user_a: userId1,
    p_user_b: userId2,
  });

  if (error) throw error;

  console.log('Conversation ready:', data);
  return data as string;
}
