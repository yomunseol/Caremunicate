create table if not exists public.call_chat_messages (
  id uuid default gen_random_uuid() primary key,
  call_id text not null, -- Matches the call room ID
  user_id uuid references auth.users(id) on delete cascade not null,
  user_name text not null,
  message text not null,
  created_at timestamptz default now()
);
create index if not exists idx_chat_call_id on public.call_chat_messages(call_id);
create index if not exists idx_chat_created_at on public.call_chat_messages(created_at);
