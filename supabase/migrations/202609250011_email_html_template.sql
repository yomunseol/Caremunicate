-- FOUNDER SQL — run in the Supabase SQL editor. Not executed by the app.
--
-- C-02b — the verification email body is OWNED BY THE DATABASE:
--   private.mail_config('email_html_template')
-- The function reads that value and replaces {{CODE}} with the generated
-- 6-digit code. No hardcoded HTML remains here.
--
-- Requires the prior mail migrations (202609250001, 202609250010).
-- Idempotent; safe to re-run.

create or replace function public.request_2fa_code(p_locale text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template text;
  v_subject text := 'Caremunicate &#183; Verification code / &#51064;&#51613; &#53076;&#46300;';
  v_code text;
  v_uid uuid := auth.uid();
  v_email text;
  v_key text := public.mail_secret('resend_api_key');
  v_from text := coalesce(nullif(public.mail_secret('resend_from'), ''), 'Caremunicate <onboarding@resend.dev>');
  v_recent boolean;
  v_req bigint;
  v_config text;
begin
  if v_uid is null then
    perform public.log_email(null, '2fa_code', 'failed', 'not_authenticated');
    return false;
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null or v_email = '' then
    perform public.log_email(null, '2fa_code', 'failed', 'no_email_on_user');
    return false;
  end if;

  -- The DB is the source of truth for the HTML body.
  select value into v_template
    from private.mail_config
   where key = 'email_html_template';

  if v_template is null or v_template = '' then
    perform public.log_email(v_email, '2fa_code', 'failed', 'email_html_template_missing');
    return false;
  end if;

  if position('{{CODE}}' in v_template) = 0 then
    perform public.log_email(v_email, '2fa_code', 'failed', 'email_html_template_missing_placeholder');
    return false;
  end if;

  -- Boot assertion: key missing / malformed is a CONFIG error, logged loudly.
  v_config := public.resend_config_error();
  if v_config is not null then
    perform public.log_email(v_email, '2fa_code', 'failed', v_config);
    return false;
  end if;

  -- Server-side cooldown: one code per 30s (the UI shows the same countdown).
  select exists (
    select 1 from public.email_otp_codes
    where user_id = v_uid and created_at > now() - interval '30 seconds'
  ) into v_recent;
  if v_recent then
    perform public.log_email(v_email, '2fa_code', 'failed', 'rate_limited');
    return false;
  end if;

  v_code := lpad((abs(('x' || encode(extensions.gen_random_bytes(8), 'hex'))::bit(64)::bigint) % 1000000)::text, 6, '0');

  insert into public.email_otp_codes(user_id, code_hash, expires_at, attempts, created_at)
  values (v_uid, extensions.crypt(v_code, extensions.gen_salt('bf')), now() + interval '10 minutes', 0, now())
  on conflict (user_id) do update
    set code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        created_at = excluded.created_at;

  begin
    v_req := net.http_post(
      url := 'https://api.resend.com/emails',
      body := jsonb_build_object(
        'from', v_from,
        'to', v_email,
        'subject', v_subject,
        'html', replace(v_template, '{{CODE}}', v_code)
      ),
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      timeout_milliseconds := 5000
    );
  exception when others then
    perform public.log_email(v_email, '2fa_code', 'failed', sqlerrm);
    return false;
  end;

  -- Accepted for delivery by Resend (pg_net request id is the handle).
  perform public.log_email(v_email, '2fa_code', 'sent', null, v_req::text);
  return true;
end;
$$;

revoke all on function public.request_2fa_code(text) from public;
grant execute on function public.request_2fa_code(text) to authenticated;

notify pgrst, 'reload schema';
