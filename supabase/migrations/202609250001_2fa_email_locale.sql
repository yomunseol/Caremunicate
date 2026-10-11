-- CR3 — 2FA EMAIL LOCALE HARDENING.
--
-- The email-2FA branch used to ride Supabase's hosted OTP email, where a
-- non-English locale could be dropped by the hosted template. This replaces it
-- with a first-party send path so that:
--   * every locale Caremunicate ships has a template key;
--   * an unknown / NULL / garbage locale ALWAYS falls back to English;
--   * the Resend payload is built as jsonb (never string concatenation), so it
--     is escaping- and unicode-safe;
--   * a send failure is written to public.email_log and returns false — it is
--     never raised into the UI.
--
-- The code is generated and bcrypt-hashed here (10-minute TTL, 5 attempts) and
-- checked by verify_2fa_code(). The client still proves the password first (the
-- Session Trap); only once the code checks out does it create the persistent
-- session.
--
-- Requires pg_net (Supabase's `net` schema) and pgcrypto (`extensions` schema).
-- Set the Resend key on the database so the function can read it, e.g.:
--   alter database postgres set app.resend_api_key = '<RESEND key>';
--   alter database postgres set app.resend_from  = 'Caremunicate <no-reply@your-domain>';
-- (RESEND_FROM defaults to Resend's shared testing sender when unset.)

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema net;

-- ---------------------------------------------------------------------------
-- email_log — every failed send, whatever the reason. Read from the SQL editor:
--   select locale, error from public.email_log order by created_at desc limit 5;
-- ---------------------------------------------------------------------------
create table if not exists public.email_log (
  id bigint generated always as identity primary key,
  email text,
  type text not null,
  locale text,
  error text,
  created_at timestamptz not null default now()
);

alter table public.email_log enable row level security;
-- No policies: only SECURITY DEFINER functions / service_role write here.

-- ---------------------------------------------------------------------------
-- email_otp_codes — one live code per user (bcrypt hash, never the plaintext).
-- ---------------------------------------------------------------------------
create table if not exists public.email_otp_codes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.email_otp_codes enable row level security;
-- No policies: reached only through the SECURITY DEFINER functions below.

-- ---------------------------------------------------------------------------
-- request_2fa_code(p_locale) -> boolean
--   Generates + emails a 6-digit code. Never raises for an email failure: the
--   failure is written to email_log and the function returns false.
-- ---------------------------------------------------------------------------
create or replace function public.request_2fa_code(p_locale text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Every locale Caremunicate ships MUST have a key. Unknown / NULL / garbage
  -- locales fall back to 'en' (see the COALESCE lookups below).
  v_templates jsonb := $tpl${
    "en": {"subject": "Your Caremunicate verification code", "html": "<p>Your verification code is <b>{{code}}</b>. It expires in 10 minutes.</p>"},
    "fr": {"subject": "Votre code de vérification Caremunicate", "html": "<p>Votre code de vérification est <b>{{code}}</b>. Il expire dans 10 minutes.</p>"},
    "es": {"subject": "Tu código de verificación de Caremunicate", "html": "<p>Tu código de verificación es <b>{{code}}</b>. Caduca en 10 minutos.</p>"},
    "ko": {"subject": "Caremunicate 인증 코드", "html": "<p>인증 코드는 <b>{{code}}</b>입니다. 10분 후에 만료됩니다.</p>"},
    "zh": {"subject": "您的 Caremunicate 验证码", "html": "<p>您的验证码是 <b>{{code}}</b>，10 分钟后失效。</p>"},
    "pt": {"subject": "Seu código de verificação Caremunicate", "html": "<p>Seu código de verificação é <b>{{code}}</b>. Ele expira em 10 minutos.</p>"},
    "de": {"subject": "Ihr Caremunicate-Bestätigungscode", "html": "<p>Ihr Bestätigungscode lautet <b>{{code}}</b>. Er läuft in 10 Minuten ab.</p>"},
    "it": {"subject": "Il tuo codice di verifica Caremunicate", "html": "<p>Il tuo codice di verifica è <b>{{code}}</b>. Scade tra 10 minuti.</p>"},
    "ar": {"subject": "رمز التحقق الخاص بك من Caremunicate", "html": "<div dir=\"rtl\"><p>رمز التحقق الخاص بك هو <b>{{code}}</b>. تنتهي صلاحيته خلال 10 دقائق.</p></div>"},
    "he": {"subject": "קוד האימות שלך מ-Caremunicate", "html": "<div dir=\"rtl\"><p>קוד האימות שלך הוא <b>{{code}}</b>. יפוג בעוד 10 דקות.</p></div>"}
  }$tpl$::jsonb;
  v_locale text := lower(coalesce(p_locale, ''));
  v_tpl jsonb;
  v_subject text;
  v_html text;
  v_code text;
  v_uid uuid := auth.uid();
  v_email text;
  v_key text := current_setting('app.resend_api_key', true);
  v_from text := coalesce(nullif(current_setting('app.resend_from', true), ''), 'Caremunicate <onboarding@resend.dev>');
  v_recent boolean;
begin
  if v_uid is null then
    insert into public.email_log(email, type, locale, error) values (null, '2fa_code', p_locale, 'not_authenticated');
    return false;
  end if;

  select email into v_email from auth.users where id = v_uid;
  if v_email is null or v_email = '' then
    insert into public.email_log(email, type, locale, error) values (null, '2fa_code', p_locale, 'no_email_on_user');
    return false;
  end if;

  -- Server-side cooldown: one code per 30s (the UI shows the same countdown).
  select exists (
    select 1 from public.email_otp_codes
    where user_id = v_uid and created_at > now() - interval '30 seconds'
  ) into v_recent;
  if v_recent then
    insert into public.email_log(email, type, locale, error) values (v_email, '2fa_code', p_locale, 'rate_limited');
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

  -- Mandatory fallback: unknown / NULL / garbage locale -> English, never NULL.
  v_tpl := coalesce(v_templates -> v_locale, v_templates -> 'en');
  v_subject := coalesce(v_tpl ->> 'subject', v_templates -> 'en' ->> 'subject');
  v_html := replace(coalesce(v_tpl ->> 'html', v_templates -> 'en' ->> 'html'), '{{code}}', v_code);

  if v_key is null or v_key = '' then
    insert into public.email_log(email, type, locale, error) values (v_email, '2fa_code', v_locale, 'resend_api_key_missing');
    return false;
  end if;

  begin
    perform net.http_post(
      url := 'https://api.resend.com/emails',
      body := jsonb_build_object('from', v_from, 'to', v_email, 'subject', v_subject, 'html', v_html),
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      timeout_milliseconds := 5000
    );
  exception when others then
    insert into public.email_log(email, type, locale, error) values (v_email, '2fa_code', v_locale, sqlerrm);
    return false;
  end;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- verify_2fa_code(p_code) -> boolean
--   Checks the submitted code against the stored bcrypt hash. Expired or
--   over-attempted rows are dropped; a wrong code costs one attempt.
-- ---------------------------------------------------------------------------
create or replace function public.verify_2fa_code(p_code text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.email_otp_codes%rowtype;
begin
  if v_uid is null or p_code is null or btrim(p_code) = '' then
    return false;
  end if;

  select * into v_row from public.email_otp_codes where user_id = v_uid;
  if not found then
    return false;
  end if;

  if v_row.expires_at < now() or v_row.attempts >= 5 then
    delete from public.email_otp_codes where user_id = v_uid;
    return false;
  end if;

  if extensions.crypt(btrim(p_code), v_row.code_hash) = v_row.code_hash then
    delete from public.email_otp_codes where user_id = v_uid;
    return true;
  end if;

  update public.email_otp_codes set attempts = attempts + 1 where user_id = v_uid;
  return false;
end;
$$;

revoke all on function public.request_2fa_code(text) from public;
revoke all on function public.verify_2fa_code(text) from public;
grant execute on function public.request_2fa_code(text) to authenticated;
grant execute on function public.verify_2fa_code(text) to authenticated;
