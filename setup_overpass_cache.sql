-- FOUNDER SQL — run manually in the Supabase SQL editor.
-- Shared cache for Overpass "Near me" responses. 24-hour TTL, keyed by the
-- rounded centre + radius. The client fails open if these are absent.

create table if not exists public.overpass_cache (
  cache_key text primary key, 
  response_data jsonb not null,
  created_at timestamptz default now()
);

create or replace function public.get_overpass_cache(p_key text)
returns jsonb language plpgsql security definer as $$
declare v_data jsonb;
begin
  select response_data into v_data from public.overpass_cache 
  where cache_key = p_key and created_at > now() - interval '24 hours';
  return v_data;
end; $$;

create or replace function public.save_overpass_cache(p_key text, p_data jsonb)
returns void language plpgsql security definer as $$
begin
  insert into public.overpass_cache (cache_key, response_data)
  values (p_key, p_data)
  on conflict (cache_key) do update set response_data = excluded.response_data, created_at = now();
end; $$;
