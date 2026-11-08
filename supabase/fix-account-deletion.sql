-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- Account deletion. `profiles` is keyed on user_id (references auth.users.id),
-- NOT id — the function deletes the profile row first, then the auth user.
-- SECURITY DEFINER runs as the function owner (postgres), which is allowed to
-- delete from auth.users.

create or replace function public.delete_user()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  delete from public.profiles where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_user() to authenticated;
