-- =====================================================================
--  Frisørbooking · forbindelse til Vanta Platform (2026-11-02)
--
--  Kør efter 6-migration-flere-frisoerer.sql.
--  Slå først pg_cron og pg_net til under Database → Extensions.
--  Kør derefter hele filen i Supabase → SQL Editor.
--
--  Ikke-destruktiv: ingen eksisterende tabeller, kolonner, regler eller
--  rækker ændres eller slettes. Filen kører i én transaktion – fejler noget,
--  ændres intet. Den kan køres igen uden skade.
--
--  Forbindelsen er slået fra, indtil ejeren slår den til i administrationen
--  (fanen Integrationer). Indtil da sendes intet, og bookingsystemet virker
--  præcis som før – også for saloner, der ikke har Vanta Platform.
--
--  Hvad den gør:
--   1. Opretter to tabeller i salon_private, som API'et ikke udstiller:
--      platform_settings (forbindelsens indstillinger) og platform_sync
--      (hvilke bookinger der skal sendes). API-nøglen ligger krypteret i
--      Supabase Vault og kan ikke læses fra browseren.
--   2. En trigger på appointments markerer en booking, når den oprettes eller
--      ændres – kun når forbindelsen er slået til. Bookingen venter aldrig på
--      platformen, og en fejl her kan aldrig stoppe en booking.
--   3. Et job (pg_cron) kører hvert minut: sender markerede bookinger til
--      platformen (pg_net), læser svarene og prøver igen ved fejl med
--      stigende ventetid. Hver version af en booking har sin egen
--      Idempotency-Key, så platformen aldrig opretter et besøg to gange.
--   4. Valgfrit (slået fra): bekræftede bookinger markeres som gennemført,
--      når tiden er gået.
--   5. Funktioner til administrationen (kun ejere): se status, gemme
--      indstillinger og sende alle bookinger igen. Én offentlig funktion
--      fortæller bookingsiden, om forbindelsen er slået til.
--
--  Der sendes: navn, e-mail, telefon, behandling, frisør, tid, pris og
--  status. Kundens bemærkning sendes ikke. Der sendes intet
--  marketingsamtykke.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.staff') is null then
    raise exception 'Kør 6-migration-flere-frisoerer.sql før denne fil. Intet er ændret.';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_post'
  ) then
    raise exception 'Udvidelsen pg_net mangler. Slå den til under Database → Extensions, og kør filen igen. Intet er ændret.';
  end if;
  if to_regclass('cron.job') is null or not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'cron' and p.proname = 'schedule'
  ) then
    raise exception 'Udvidelsen pg_cron mangler. Slå den til under Database → Extensions, og kør filen igen. Intet er ændret.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Supabase Vault mangler (udvidelsen supabase_vault). Slå den til under Database → Extensions, og kør filen igen. Intet er ændret.';
  end if;
end $$;

create schema if not exists salon_private;
revoke all on schema salon_private from public;
revoke all on schema salon_private from anon, authenticated;

-- ---------------------------------------------------------------------
-- 1. Tabeller
-- ---------------------------------------------------------------------
create table if not exists salon_private.platform_settings (
  id              boolean primary key default true,
  enabled         boolean not null default false,
  api_url         text,
  api_key_id      uuid,
  api_key_prefix  text,
  auto_complete   boolean not null default false,
  generation      integer not null default 1,
  last_success_at timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  updated_at      timestamptz not null default now(),
  constraint platform_settings_single_row check (id)
);

insert into salon_private.platform_settings (id) values (true) on conflict (id) do nothing;

create table if not exists salon_private.platform_sync (
  appointment_id  uuid primary key references public.appointments (id) on delete cascade,
  pending         boolean not null default true,
  failed          boolean not null default false,
  change_seq      bigint not null default 1,
  queued_at       timestamptz not null default now(),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  request_id      bigint,
  request_key     text,
  request_seq     bigint,
  request_sent_at timestamptz,
  synced_key      text,
  synced_at       timestamptz,
  last_status     integer,
  last_error      text
);

create index if not exists platform_sync_due_idx
  on salon_private.platform_sync (next_attempt_at)
  where pending and not failed;

revoke all on table salon_private.platform_settings, salon_private.platform_sync from public, anon, authenticated;

comment on table salon_private.platform_settings is
  'Forbindelsen til Vanta Platform (én række). API-nøglen ligger i Supabase Vault; her gemmes kun dens id og de første tegn.';
comment on column salon_private.platform_settings.generation is
  'Tælles op, når alle bookinger skal sendes igen (fx ny nøgle). Indgår i Idempotency-Key.';
comment on column salon_private.platform_settings.auto_complete is
  'Markér bekræftede bookinger som gennemført, når tiden er gået.';
comment on table salon_private.platform_sync is
  'Én række pr. booking, der er eller skal sendes til Vanta Platform.';
comment on column salon_private.platform_sync.change_seq is
  'Tælles op ved hver ændring af bookingen. Afgør, om en ændring kom efter det seneste kald.';
comment on column salon_private.platform_sync.failed is
  'Platformen afviste bookingens data. Prøves igen, når bookingen ændres, eller når alt sendes igen.';

-- ---------------------------------------------------------------------
-- 2. Hvad der sendes for én booking
--    Tider sendes i UTC. Status: pending/confirmed → booked.
--    E-mail og telefon sendes kun, hvis platformen kan læse dem (samme
--    regler som platformens validering); ellers udelades feltet.
-- ---------------------------------------------------------------------
create or replace function salon_private.platform_payload(p_appointment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('items', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'external_id', a.id::text,
    'starts_at', to_char(((a.appointment_date + a.start_time) at time zone 'Europe/Copenhagen') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'ends_at', to_char(((a.appointment_date + a.end_time) at time zone 'Europe/Copenhagen') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'status', case a.status when 'cancelled' then 'cancelled' when 'completed' then 'completed' else 'booked' end,
    'service_name', left(s.name, 200),
    'staff_name', left(st.name, 120),
    'price_amount', s.price,
    'currency', case when s.price is not null then 'DKK' end,
    'customer', jsonb_build_object(
      'first_name', left(n.first_name, 100),
      'last_name', left(n.last_name, 100),
      'email', case
        when char_length(n.email) <= 254
         and n.email ~ '^([A-Za-z0-9_''+-]+\.)*[A-Za-z0-9_''+-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$'
        then n.email end,
      'phone', case
        when a.phone ~ '[A-Za-z]' then null
        when n.phone like '00%' then case when n.phone ~ '^00[0-9]{6,15}$' then btrim(a.phone) end
        when n.phone ~ '^\+?[0-9]{6,15}$' then btrim(a.phone)
      end
    )
  ))))
  from public.appointments a
  left join public.services s on s.id = a.service_id
  left join public.staff st on st.id = a.staff_id
  cross join lateral (
    select substring(btrim(a.full_name) from '^\S+') as first_name,
           nullif(btrim(substring(btrim(a.full_name) from '^\S+\s+(.*)$')), '') as last_name,
           lower(btrim(coalesce(a.email, ''))) as email,
           regexp_replace(coalesce(a.phone, ''), '[\s()./-]', '', 'g') as phone
  ) n
  where a.id = p_appointment_id;
$$;

comment on function salon_private.platform_payload(uuid) is
  'Bookingen i det format, Vanta Platform modtager på /api/v1/appointments. Bemærkningen sendes ikke.';

-- Bookinger, der ikke kan sendes, før data er rettet
create or replace function salon_private.platform_payload_problem(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_payload is null then 'Bookingen findes ikke længere.'
    when p_payload #>> '{items,0,customer,first_name}' is null then 'Bookingen mangler kundens navn.'
    when p_payload #>> '{items,0,customer,email}' is null and p_payload #>> '{items,0,customer,phone}' is null
      then 'Bookingen mangler en e-mail eller et telefonnummer, som platformen kan læse.'
  end;
$$;

-- ---------------------------------------------------------------------
-- 3. Triggeren: markér bookingen, når den oprettes eller ændres
-- ---------------------------------------------------------------------
create or replace function salon_private.platform_mark_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if exists (select 1 from salon_private.platform_settings s where s.id and s.enabled) then
      insert into salon_private.platform_sync as ps (appointment_id)
      values (new.id)
      on conflict (appointment_id) do update
        set pending = true,
            failed = false,
            change_seq = ps.change_seq + 1,
            queued_at = case when ps.pending then ps.queued_at else now() end,
            next_attempt_at = case when ps.attempts = 0 then now() else ps.next_attempt_at end;
    end if;
  exception when others then
    -- En fejl i forbindelsen må aldrig stoppe en booking.
    raise warning 'Vanta Platform: bookingen % blev ikke sat i kø (%).', new.id, sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists platform_mark_changed on public.appointments;
create trigger platform_mark_changed
  after insert or update on public.appointments
  for each row execute function salon_private.platform_mark_changed();

-- Sæt alle bookinger i kø (første gang, ved ny nøgle og "Send alle igen")
create or replace function salon_private.platform_queue_all()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with queued as (
    insert into salon_private.platform_sync as ps (appointment_id)
    select a.id from public.appointments a
    on conflict (appointment_id) do update
      set pending = true,
          failed = false,
          change_seq = ps.change_seq + 1,
          queued_at = now(),
          attempts = 0,
          next_attempt_at = now(),
          last_error = null
    returning 1
  )
  select count(*)::integer from queued;
$$;

-- ---------------------------------------------------------------------
-- 4. Svar fra platformen
--    2xx: sendt. 422 validation_failed: bookingens data afvist (vises i
--    administrationen). Øvrige fejl gælder forbindelsen: prøv igen med
--    stigende ventetid (2, 4, 8 … minutter, højst 6 timer).
-- ---------------------------------------------------------------------
create or replace function salon_private.platform_apply_response(
  p_appointment_id uuid,
  p_request_id     bigint,
  p_status         integer,
  p_content        text,
  p_timed_out      boolean,
  p_error          text
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r        salon_private.platform_sync;
  v_gen    integer;
  v_stale  boolean;
  v_body   jsonb;
  v_code   text;
  v_fields text;
  v_global text;
begin
  select * into r from salon_private.platform_sync ps where ps.appointment_id = p_appointment_id for update;
  if not found or r.request_id is distinct from p_request_id then
    return 'ignored';
  end if;

  -- Svar på et kald fra før en ny nøgle eller "Send alle igen" (ældre generation)
  select s.generation into v_gen from salon_private.platform_settings s where s.id;
  v_stale := r.request_key is null or r.request_key not like format('vb-%s-%%', v_gen);

  begin
    v_body := p_content::jsonb;
  exception when others then
    v_body := null;
  end;
  v_code := v_body #>> '{error,code}';

  if p_status between 200 and 299 then
    update salon_private.platform_sync ps
    set pending = ps.change_seq > coalesce(ps.request_seq, 0),
        synced_key = ps.request_key,
        synced_at = now(),
        attempts = 0,
        next_attempt_at = now(),
        last_status = p_status,
        last_error = null,
        request_id = null,
        request_key = null,
        request_seq = null
    where ps.appointment_id = p_appointment_id;
    update salon_private.platform_settings s
    set last_success_at = now(), last_error = null, last_error_at = null
    where s.id;
    return 'synced';
  end if;

  if p_status in (400, 413, 422) then
    if p_status = 422 and v_code = 'validation_failed' then
      select string_agg(distinct f.label, ', ') into v_fields
      from (
        select case
          when i->>'path' like '%customer.phone%' then 'telefonnummeret'
          when i->>'path' like '%customer.email%' then 'e-mailadressen'
          when i->>'path' like '%customer%' then 'kundens navn'
          when i->>'path' like '%starts_at%' or i->>'path' like '%ends_at%' then 'tidspunktet'
          when i->>'path' like '%price%' or i->>'path' like '%currency%' then 'prisen'
          else 'bookingens data'
        end as label
        from jsonb_array_elements(case when jsonb_typeof(v_body #> '{error,issues}') = 'array' then v_body #> '{error,issues}' else '[]'::jsonb end) i
      ) f;
      r.last_error := 'Vanta Platform afviste ' || coalesce(v_fields, 'bookingens data') || '.';
    else
      r.last_error := format('Teknisk fejl i forbindelsen (%s %s). Kontakt Vanta Studio.', p_status, coalesce(v_code, 'ukendt'));
    end if;
    -- Er bookingen ændret siden kaldet, prøves den nye udgave i stedet.
    update salon_private.platform_sync ps
    set failed = not (ps.change_seq > coalesce(ps.request_seq, 0)),
        pending = ps.change_seq > coalesce(ps.request_seq, 0),
        attempts = 0,
        next_attempt_at = now(),
        last_status = p_status,
        last_error = r.last_error,
        request_id = null,
        request_key = null,
        request_seq = null
    where ps.appointment_id = p_appointment_id;
    return 'failed';
  end if;

  v_global := case
    when p_status = 401 then 'Vanta Platform afviste API-nøglen. Opret en ny nøgle i Vanta Platform under Integrationer → Vanta Booking, og indsæt den her.'
    when p_status = 403 and v_code = 'organization_inactive' then 'Kontoen i Vanta Platform er ikke aktiv. Der prøves igen automatisk.'
    when p_status = 403 then 'API-nøglen må ikke oprette aftaler. Opret en nøgle med adgang til aftaler i Vanta Platform, og indsæt den her.'
    when p_status in (404, 405) then 'Der er ingen Vanta Platform på adressen. Tjek platformens adresse.'
    when p_status = 503 and v_code = 'not_configured' then 'Vanta Platform er ikke sat op til at modtage data endnu. Der prøves igen automatisk.'
    when p_status = 409 then null
    when p_status = 429 then 'Vanta Platform beder om en pause. Der prøves igen automatisk.'
    when coalesce(p_timed_out, false) then 'Vanta Platform svarede ikke i tide. Der prøves igen automatisk.'
    when p_status is null then 'Vanta Platform kunne ikke nås' || coalesce(' (' || left(p_error, 120) || ')', '') || '. Der prøves igen automatisk.'
    else format('Vanta Platform svarede med fejl %s. Der prøves igen automatisk.', p_status)
  end;

  -- Et forsinket fejlsvar på et kald med en gammel nøgle må hverken vise en
  -- fejl eller udsætte næste forsøg, efter at ejeren har indsat en ny.
  update salon_private.platform_sync ps
  set next_attempt_at = case when v_stale then now()
        else now() + least(interval '1 minute' * power(2, least(greatest(ps.attempts, 1), 9)), interval '6 hours') end,
      last_status = p_status,
      last_error = case when v_stale then null else coalesce(v_global, 'Venter på et nyt forsøg.') end,
      request_id = null,
      request_key = null,
      request_seq = null
  where ps.appointment_id = p_appointment_id;

  if v_global is not null and not v_stale then
    update salon_private.platform_settings s
    set last_error = v_global, last_error_at = now()
    where s.id;
  end if;
  return 'retry';
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Jobbet, der kører hvert minut
-- ---------------------------------------------------------------------
create or replace function salon_private.platform_sync_run(p_limit integer default 100)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s           salon_private.platform_settings;
  r           record;
  v_resp      record;
  v_token     text;
  v_payload   jsonb;
  v_problem   text;
  v_key       text;
  v_request   bigint;
  v_completed integer := 0;
  v_collected integer := 0;
  v_sent      integer := 0;
  v_skipped   integer := 0;
begin
  -- Kun ét kørende job ad gangen
  if not pg_try_advisory_xact_lock(hashtext('salon_private.platform_sync_run')) then
    return jsonb_build_object('busy', true);
  end if;

  select * into s from salon_private.platform_settings ps where ps.id;
  if not found then
    return jsonb_build_object('enabled', false);
  end if;

  -- a) Gennemførte besøg (valgfrit – virker også uden forbindelsen)
  if s.auto_complete then
    update public.appointments a
    set status = 'completed'
    where a.status = 'confirmed'
      and ((a.appointment_date + a.end_time) at time zone 'Europe/Copenhagen') <= now();
    get diagnostics v_completed = row_count;
  end if;

  -- Ryd jobbets egen log (ældre end to døgn) én gang i timen
  if extract(minute from now()) = 0 then
    begin
      delete from cron.job_run_details d
      using cron.job j
      where j.jobid = d.jobid
        and j.jobname = 'vanta-platform-sync'
        and d.end_time < now() - interval '2 days';
    exception when others then
      null;
    end;
  end if;

  if not s.enabled then
    return jsonb_build_object('enabled', false, 'completed', v_completed);
  end if;

  -- b) Læs svar på de kald, der er sendt
  for r in
    select ps.appointment_id, ps.request_id, ps.request_sent_at
    from salon_private.platform_sync ps
    where ps.request_id is not null
    for update skip locked
  loop
    select hr.status_code, hr.content, hr.timed_out, hr.error_msg
      into v_resp
    from net._http_response hr
    where hr.id = r.request_id;
    if found then
      perform salon_private.platform_apply_response(r.appointment_id, r.request_id, v_resp.status_code, v_resp.content, v_resp.timed_out, v_resp.error_msg);
      v_collected := v_collected + 1;
    elsif r.request_sent_at < now() - interval '10 minutes' then
      perform salon_private.platform_apply_response(r.appointment_id, r.request_id, null, null, true, null);
      v_collected := v_collected + 1;
    end if;
  end loop;

  -- c) Send det, der venter
  if s.api_url is null or s.api_key_id is null then
    return jsonb_build_object('enabled', true, 'completed', v_completed, 'collected', v_collected, 'sent', 0);
  end if;
  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id = s.api_key_id;
  if v_token is null then
    update salon_private.platform_settings ps
    set last_error = 'API-nøglen findes ikke længere. Indsæt nøglen igen.', last_error_at = now()
    where ps.id;
    return jsonb_build_object('enabled', true, 'completed', v_completed, 'collected', v_collected, 'sent', 0);
  end if;

  for r in
    select ps.appointment_id, ps.change_seq, ps.synced_key
    from salon_private.platform_sync ps
    where ps.pending and not ps.failed and ps.request_id is null and ps.next_attempt_at <= now()
    order by ps.queued_at, ps.appointment_id
    limit greatest(coalesce(p_limit, 100), 1)
    for update skip locked
  loop
    begin
      v_payload := salon_private.platform_payload(r.appointment_id);
      v_problem := salon_private.platform_payload_problem(v_payload);
      if v_problem is not null then
        update salon_private.platform_sync ps
        set pending = false, failed = true, attempts = 0, last_status = null, last_error = v_problem
        where ps.appointment_id = r.appointment_id;
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_key := format('vb-%s-%s-%s', s.generation, r.appointment_id, md5(v_payload::text));
      if v_key = r.synced_key then
        -- Platformen har allerede præcis denne udgave
        update salon_private.platform_sync ps
        set pending = false, attempts = 0, last_error = null
        where ps.appointment_id = r.appointment_id;
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_request := net.http_post(
        url := s.api_url || '/api/v1/appointments',
        body := v_payload,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || v_token,
          'Idempotency-Key', v_key,
          'X-Vanta-Source', 'vanta_booking'
        ),
        timeout_milliseconds := 15000
      );

      update salon_private.platform_sync ps
      set request_id = v_request,
          request_key = v_key,
          request_seq = r.change_seq,
          request_sent_at = now(),
          attempts = ps.attempts + 1
      where ps.appointment_id = r.appointment_id;
      v_sent := v_sent + 1;
    exception when others then
      update salon_private.platform_sync ps
      set attempts = ps.attempts + 1,
          next_attempt_at = now() + interval '5 minutes',
          last_error = left('Kunne ikke sende: ' || sqlerrm, 300)
      where ps.appointment_id = r.appointment_id;
    end;
  end loop;

  return jsonb_build_object('enabled', true, 'completed', v_completed, 'collected', v_collected, 'sent', v_sent, 'skipped', v_skipped);
end;
$$;

comment on function salon_private.platform_sync_run(integer) is
  'Kører hvert minut (pg_cron): gennemførte besøg (valgfrit), svar fra platformen og nye kald.';

-- ---------------------------------------------------------------------
-- 6. Funktioner til administrationen (kun ejere) og bookingsiden
-- ---------------------------------------------------------------------
create or replace function public.get_platform_link()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s salon_private.platform_settings;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Kun administratorer kan se forbindelsen til Vanta Platform.';
  end if;
  select * into s from salon_private.platform_settings ps where ps.id;
  return jsonb_build_object(
    'enabled', coalesce(s.enabled, false),
    'api_url', s.api_url,
    'has_key', s.api_key_id is not null,
    'key_prefix', s.api_key_prefix,
    'auto_complete', coalesce(s.auto_complete, false),
    'last_success_at', s.last_success_at,
    'last_error', s.last_error,
    'last_error_at', s.last_error_at,
    'queued', (select count(*) from salon_private.platform_sync ps where ps.pending and not ps.failed),
    'synced', (select count(*) from salon_private.platform_sync ps where ps.synced_at is not null),
    'failed', (select count(*) from salon_private.platform_sync ps where ps.failed),
    'failures', coalesce((
      select jsonb_agg(f order by f.appointment_date desc, f.start_time desc)
      from (
        select upper(left(a.id::text, 8)) as reference, a.full_name, a.appointment_date, a.start_time, ps.last_error
        from salon_private.platform_sync ps
        join public.appointments a on a.id = ps.appointment_id
        where ps.failed
        order by a.appointment_date desc, a.start_time desc
        limit 10
      ) f
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.save_platform_link(
  p_enabled       boolean,
  p_api_url       text,
  p_api_key       text,
  p_auto_complete boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s         salon_private.platform_settings;
  v_url     text := nullif(rtrim(btrim(coalesce(p_api_url, '')), '/'), '');
  v_key     text := nullif(btrim(coalesce(p_api_key, '')), '');
  v_enabled boolean := coalesce(p_enabled, false);
  v_secret  uuid;
  v_requeue boolean;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Kun administratorer kan ændre forbindelsen til Vanta Platform.';
  end if;

  select * into s from salon_private.platform_settings ps where ps.id for update;

  if v_url is not null and v_url !~ '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' then
    raise exception using errcode = 'P0001', hint = 'invalid_platform_url',
      message = 'Skriv platformens adresse, fx https://app.vantastudio.dk.';
  end if;
  if v_key is not null and v_key !~ '^vk_live_[A-Za-z0-9_-]{20,200}$' then
    raise exception using errcode = 'P0001', hint = 'invalid_api_key',
      message = 'API-nøglen skal starte med vk_live_. Kopiér hele nøglen fra Vanta Platform.';
  end if;
  if v_enabled and (v_url is null or (v_key is null and s.api_key_id is null)) then
    raise exception using errcode = 'P0001', hint = 'platform_incomplete',
      message = 'Udfyld platformens adresse og API-nøgle, før forbindelsen slås til.';
  end if;

  if v_key is not null then
    select ds.id into v_secret from vault.decrypted_secrets ds where ds.name = 'vanta_platform_api_key';
    if v_secret is null then
      v_secret := vault.create_secret(v_key, 'vanta_platform_api_key', 'API-nøgle til Vanta Platform (frisørbooking)');
    else
      perform vault.update_secret(v_secret, v_key);
    end if;
  end if;

  -- Slås forbindelsen til, eller skiftes nøgle eller adresse, sendes alle bookinger.
  v_requeue := v_enabled and (not s.enabled or v_key is not null or v_url is distinct from s.api_url);

  update salon_private.platform_settings ps
  set enabled = v_enabled,
      api_url = v_url,
      api_key_id = coalesce(v_secret, ps.api_key_id),
      api_key_prefix = case when v_key is not null then left(v_key, 14) else ps.api_key_prefix end,
      auto_complete = coalesce(p_auto_complete, false),
      generation = ps.generation + case when v_requeue then 1 else 0 end,
      last_error = case when v_requeue or not v_enabled then null else ps.last_error end,
      last_error_at = case when v_requeue or not v_enabled then null else ps.last_error_at end,
      updated_at = now()
  where ps.id;

  if v_requeue then
    perform salon_private.platform_queue_all();
  end if;

  return public.get_platform_link();
end;
$$;

create or replace function public.resend_platform_sync()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Kun administratorer kan sende bookingerne igen.';
  end if;
  if not exists (select 1 from salon_private.platform_settings s where s.id and s.enabled) then
    raise exception using errcode = 'P0001', hint = 'platform_disabled',
      message = 'Slå forbindelsen til, før bookingerne kan sendes.';
  end if;
  update salon_private.platform_settings s
  set generation = s.generation + 1, last_error = null, last_error_at = null, updated_at = now()
  where s.id;
  perform salon_private.platform_queue_all();
  return public.get_platform_link();
end;
$$;

-- Til bookingsiden: skal kunden have at vide, at oplysningerne gemmes i
-- salonens kundesystem? Afslører intet andet.
create or replace function public.platform_link_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select s.enabled from salon_private.platform_settings s where s.id), false);
$$;

comment on function public.get_platform_link() is
  'Forbindelsens indstillinger og status – kun for administratorer. Returnerer aldrig API-nøglen.';
comment on function public.save_platform_link(boolean, text, text, boolean) is
  'Gemmer forbindelsen (kun administratorer). Nøglen gemmes i Vault; tom nøgle beholder den gemte.';
comment on function public.resend_platform_sync() is
  'Sender alle bookinger til Vanta Platform igen (kun administratorer). Giver ingen dubletter.';
comment on function public.platform_link_enabled() is
  'Sand, når bookinger sendes til salonens kundesystem (Vanta Platform).';

-- ---------------------------------------------------------------------
-- 7. Rettigheder
-- ---------------------------------------------------------------------
revoke all on function salon_private.platform_payload(uuid) from public, anon, authenticated;
revoke all on function salon_private.platform_payload_problem(jsonb) from public, anon, authenticated;
revoke all on function salon_private.platform_mark_changed() from public, anon, authenticated;
revoke all on function salon_private.platform_queue_all() from public, anon, authenticated;
revoke all on function salon_private.platform_apply_response(uuid, bigint, integer, text, boolean, text) from public, anon, authenticated;
revoke all on function salon_private.platform_sync_run(integer) from public, anon, authenticated;

revoke all on function public.get_platform_link() from public, anon, authenticated;
revoke all on function public.save_platform_link(boolean, text, text, boolean) from public, anon, authenticated;
revoke all on function public.resend_platform_sync() from public, anon, authenticated;
revoke all on function public.platform_link_enabled() from public, anon, authenticated;

grant execute on function public.get_platform_link() to authenticated;
grant execute on function public.save_platform_link(boolean, text, text, boolean) to authenticated;
grant execute on function public.resend_platform_sync() to authenticated;
grant execute on function public.platform_link_enabled() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. Jobbet planlægges (ét job; filen kan køres igen)
-- ---------------------------------------------------------------------
select cron.unschedule(j.jobid) from cron.job j where j.jobname = 'vanta-platform-sync';
select cron.schedule('vanta-platform-sync', '* * * * *', 'select salon_private.platform_sync_run()');

notify pgrst, 'reload schema';

commit;

-- Resultat
select 'Forbindelsen er installeret og slået ' || case when s.enabled then 'til' else 'fra' end || '.' as status,
       (select count(*) from cron.job j where j.jobname = 'vanta-platform-sync' and j.active) as job_planlagt
from salon_private.platform_settings s;
