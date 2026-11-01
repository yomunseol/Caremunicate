-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- public.hospitals currently allows SELECT, INSERT and DELETE only. The
-- post-save background geocoder (src/lib/geocode.ts) silently fills latitude/
-- longitude for a record whose coordinates are still missing, so the author
-- needs an UPDATE policy on their own row.

drop policy if exists "hospitals_update_own_coordinates" on public.hospitals;
create policy "hospitals_update_own_coordinates"
  on public.hospitals for update
  to authenticated
  using (added_by = auth.uid())
  with check (added_by = auth.uid());
