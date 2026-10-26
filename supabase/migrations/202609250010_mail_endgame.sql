-- C-04 — mail endgame: code-only, all-locale stacked, loud failures.
--
--   * ONE static template for the custom code emails (2FA + any custom OTP):
--     a branded mint/clinical card, the code in a big mono block, then one short
--     instruction line per repo locale — all ten stacked in the SAME email
--     (en, ko, zh, es, fr, de, pt, it, ar, he). No per-locale template map, no
--     dynamic-hook scaffolding, no magic links.
--   * email_log gains to_email / kind / status / resend_id and a single
--     SECURITY DEFINER writer log_email(...). Every send is logged.
--   * send_test_email() returns the RAW Resend response (status + body) so the
--     founder can prove the key without exposing it to the client.
--
-- KEY / PIPELINE (one canonical read point for the DB runtime):
--   current_setting('app.resend_api_key')  -> the ONLY DB-side read site.
--   The Edge Function runtime reads Deno.env RESEND_API_KEY (its own runtime).
--   The key is NEVER stored in a table and never reaches the client.
--
-- Requires pg_net (`net`) + pgcrypto (`extensions`), created by 202609250001.
-- Idempotent; safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) email_log — enrich for the wrapper (legacy columns kept).
-- ---------------------------------------------------------------------------
alter table public.email_log
  add column if not exists to_email text,
  add column if not exists kind text,
  add column if not exists status text,
  add column if not exists resend_id text;

-- The ONE writer. SECURITY DEFINER so RLS stays strict (no client policy).
create or replace function public.log_email(
  p_to_email text,
  p_kind     text,
  p_status   text,
  p_error    text default null,
  p_resend_id text default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.email_log (email, type, to_email, kind, status, error, resend_id)
  values (p_to_email, p_kind, p_to_email, p_kind, p_status, p_error, p_resend_id);
$$;

revoke all on function public.log_email(text, text, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- 2) ONE canonical DB-side key read + boot assertion.
--    Missing / not ^re_ -> CONFIG failure, logged loudly.
-- ---------------------------------------------------------------------------
create or replace function public.resend_config_error()
returns text
language sql
stable
as $$
  with k as (select coalesce(current_setting('app.resend_api_key', true), '') as key)
  select case
           when (select key from k) = '' then 'resend_api_key_missing'
           when (select key from k) !~ '^re_' then 'resend_api_key_malformed'
           else null
         end;
$$;

-- ---------------------------------------------------------------------------
-- 3) request_2fa_code(p_locale) -> boolean — ONE static stacked template.
--    Locale no longer selects a template (all locales ship in every email);
--    it is kept only for logging. Unknown locale is harmless.
-- ---------------------------------------------------------------------------
create or replace function public.request_2fa_code(p_locale text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_html text := $html$<!doctype html><html><body style="margin:0;background:#f4f9f6;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d8ece2;border-radius:16px;padding:24px;">
    <div style="font-size:13px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#3ea985;">Caremunicate</div>
    <div dir="ltr" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;font-weight:800;letter-spacing:.28em;color:#133b35;background:#f0fdf4;border:1px solid #d8ece2;border-radius:12px;padding:18px;text-align:center;margin:16px 0;">{{code}}</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Your Caremunicate verification code:</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">It expires in 10 minutes. If you didn&#39;t request it, ignore this email.</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Caremunicate &#51064;&#51613; &#53076;&#46300;:</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">10&#48516; &#54980; &#47564;&#47308;&#46121;&#45768;&#45796;. &#50836;&#52397;&#54616;&#51648; &#50504;&#50532;&#45796;&#47732; &#47924;&#49884;&#54616;&#49464;&#50836;.</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">&#24744;&#30340; Caremunicate &#39564;&#35777;&#30721;&#65306;</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">10 &#20998;&#38047;&#21518;&#22833;&#25928;&#12290;&#33509;&#38750;&#26412;&#20154;&#25805;&#20316;&#65292;&#35831;&#24573;&#30053;&#27492;&#37038;&#20214;&#12290;</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Tu c&#243;digo de verificaci&#243;n de Caremunicate:</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">Caduca en 10 minutos. Si no lo solicitaste, ignora este correo.</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Votre code de v&#233;rification Caremunicate :</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">Il expire dans 10 minutes. Si vous ne l&#39;avez pas demand&#233;, ignorez cet e-mail.</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Ihr Caremunicate-Best&#228;tigungscode:</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">Er l&#228;uft in 10 Minuten ab. Falls Sie ihn nicht angefordert haben, ignorieren Sie diese E-Mail.</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Seu c&#243;digo de verifica&#231;&#227;o Caremunicate:</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">Ele expira em 10 minutos. Se voc&#234; n&#227;o solicitou, ignore este e-mail.</div>
    <div dir="ltr" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">Il tuo codice di verifica Caremunicate:</div>
    <div dir="ltr" style="color:#557b76;font-size:13px;margin:0 0 10px;">Scade tra 10 minuti. Se non l&#39;hai richiesto, ignora questa email.</div>
    <div dir="rtl" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">&#1585;&#1605;&#1586; &#1575;&#1604;&#1578;&#1581;&#1602;&#1602; &#1605;&#1606; Caremunicate:</div>
    <div dir="rtl" style="color:#557b76;font-size:13px;margin:0 0 10px;">&#1578;&#1606;&#1578;&#1607;&#1610; &#1589;&#1604;&#1575;&#1581;&#1610;&#1578;&#1607; &#1582;&#1604;&#1575;&#1604; 10 &#1583;&#1602;&#1575;&#1574;&#1602;. &#1573;&#1584;&#1575; &#1604;&#1605; &#1578;&#1591;&#1604;&#1576;&#1607;&#1548; &#1601;&#1578;&#1580;&#1575;&#1607;&#1604; &#1607;&#1584;&#1575; &#1575;&#1604;&#1576;&#1585;&#1610;&#1583;.</div>
    <div dir="rtl" style="color:#133b35;font-size:15px;font-weight:700;margin:12px 0 2px;">&#1511;&#1493;&#1491; &#1492;&#1488;&#1497;&#1502;&#1493;&#1514; &#1513;&#1500;&#1498; &#1502;-Caremunicate:</div>
    <div dir="rtl" style="color:#557b76;font-size:13px;margin:0 0 10px;">&#1497;&#1508;&#1493;&#1490; &#1489;&#1506;&#1493;&#1491; 10 &#1491;&#1511;&#1493;&#1514;. &#1488;&#1501; &#1500;&#1488; &#1489;&#1497;&#1511;&#1513;&#1514; &#1488;&#1493;&#1514;&#1493;, &#1492;&#1514;&#1506;&#1500;&#1501; &#1502;&#1492;&#1493;&#1491;&#1506;&#1492; &#1494;&#1493;.</div>
  </div>
</body></html>$html$;
  v_subject text := 'Caremunicate &#183; Verification code / &#51064;&#51613; &#53076;&#46300;';
  v_code text;
  v_uid uuid := auth.uid();
  v_email text;
  v_key text := current_setting('app.resend_api_key', true);
  v_from text := coalesce(nullif(current_setting('app.resend_from', true), ''), 'Caremunicate <onboarding@resend.dev>');
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
        'html', replace(v_html, '{{code}}', v_code)
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

-- ---------------------------------------------------------------------------
-- 4) send_test_email() -> jsonb — the RAW Resend response, for the founder only.
--    Never returns the key. pg_net is async, so the response is polled briefly.
-- ---------------------------------------------------------------------------
create or replace function public.send_test_email(p_to text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text := current_setting('app.resend_api_key', true);
  v_from text := coalesce(nullif(current_setting('app.resend_from', true), ''), 'Caremunicate <onboarding@resend.dev>');
  v_config text;
  v_req bigint;
  v_status integer;
  v_body text;
  v_err text;
  v_found boolean := false;
begin
  v_config := public.resend_config_error();
  if v_config is not null then
    return jsonb_build_object('ok', false, 'error', v_config);
  end if;

  begin
    v_req := net.http_post(
      url := 'https://api.resend.com/emails',
      body := jsonb_build_object(
        'from', v_from,
        'to', p_to,
        'subject', 'Caremunicate · SMTP/key test',
        'html', '<p>Caremunicate mail pipeline test. If you can read this, the Resend key and sender are valid.</p>'
      ),
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key, 'Content-Type', 'application/json'),
      timeout_milliseconds := 5000
    );
  exception when others then
    perform public.log_email(p_to, 'test', 'failed', sqlerrm);
    return jsonb_build_object('ok', false, 'error', sqlerrm);
  end;

  -- Poll for the async response for a few seconds.
  for i in 1..10 loop
    perform pg_sleep(0.3);
    select status_code, content, error_msg
      into v_status, v_body, v_err
      from net._http_response
     where id = v_req;
    if found then v_found := true; exit; end if;
  end loop;

  perform public.log_email(
    p_to, 'test',
    case when v_found and v_status between 200 and 299 then 'sent' else 'failed' end,
    case when v_found then coalesce(v_err, v_body) else 'no_response_yet' end,
    v_req::text
  );

  return jsonb_build_object(
    'ok', v_found and v_status between 200 and 299,
    'request_id', v_req,
    'status_code', v_status,
    'body', v_body,
    'error', v_err,
    -- pg_net is asynchronous: with no response yet, read it later with
    --   select status_code, content, error_msg from net._http_response where id = <request_id>;
    'note', case when v_found then 'raw Resend response' else 'no response yet — query net._http_response by request_id' end
  );
end;
$$;

revoke all on function public.send_test_email(text) from public;
grant execute on function public.send_test_email(text) to service_role;

notify pgrst, 'reload schema';
