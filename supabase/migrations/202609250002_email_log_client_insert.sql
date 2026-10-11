-- CR4 — recovery flow: let the browser record its own updateUser failures.
--
-- CR3 created public.email_log with RLS enabled and NO policies, so only
-- SECURITY DEFINER functions / service_role can write. The reset-password UI
-- must be able to log a failed updateUser(), so this adds a single, narrow
-- INSERT policy: an authenticated user may insert a row ONLY of type
-- 'recovery-ui'. Reads stay closed (the founder reads via the SQL editor).

create policy "email_log_insert_recovery_ui"
  on public.email_log
  for insert
  to authenticated
  with check (type = 'recovery-ui');
