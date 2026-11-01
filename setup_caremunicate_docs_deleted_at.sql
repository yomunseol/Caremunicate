-- FOUNDER SQL — run in the Supabase SQL editor (not executed by the app).
-- Adds the soft-delete column used by Caremunicate Docs.
alter table public.caremunicate_docs
  add column if not exists deleted_at timestamptz;

create index if not exists idx_docs_deleted_at
  on public.caremunicate_docs(deleted_at);
