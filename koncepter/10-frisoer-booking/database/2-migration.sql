-- =====================================================================
--  Frisørbooking · migration (2026-11-02)
--
--  Kør hele filen én gang i Supabase → SQL Editor.
--  Ikke-destruktiv: ingen tabeller, kolonner eller rækker slettes.
--  Filen kører i én transaktion – fejler noget, ændres intet.
--  Den kan køres igen uden skade.
--
--  Hvad den gør:
--   1. Gemmer de nuværende adgangspolitikker og tabelrettigheder i skemaet
--      salon_backup, så de kan genskabes (se tilbagerulning.sql).
--   2. Tilføjer fire kolonner: services.price_is_demo,
--      salon_settings.booking_window_days, .about_text og .is_demo,
--      samt kontrolregler for nye værdier (gamle rækker valideres ikke).
--   3. Forhindrer overlappende bookinger i selve databasen
--      (exclusion constraint på appointments; aflyste aftaler tæller ikke).
--   4. Opretter funktioner til ledige datoer og tider, booking og kvittering.
--      Offentlige besøgende kan kalde dem uden at kunne læse andres bookinger.
--   5. Erstatter adgangspolitikkerne på de seks tabeller med et kendt sæt:
--      offentligt kun behandlinger, åbningstider og saloninformation;
--      resten kun for brugere, der står i admin_users.
--   6. Oversætter de engelske eksempeldata til dansk og markerer nye
--      eksempelpriser og kontaktoplysninger som demo. Kun felter, der stadig
--      har de oprindelige eksempelværdier, bliver ændret.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Sikkerhedskopi af politikker, rettigheder og RLS-status
--    (gemmes kun første gang filen køres)
-- ---------------------------------------------------------------------
create schema if not exists salon_backup;
revoke all on schema salon_backup from public;
revoke all on schema salon_backup from anon, authenticated;

create table if not exists salon_backup.policies (
  saved_at   timestamptz not null default now(),
  tablename  name not null,
  policyname name not null,
  permissive text not null,
  roles      name[] not null,
  cmd        text not null,
  qual       text,
  with_check text
);

create table if not exists salon_backup.table_grants (
  saved_at  timestamptz not null default now(),
  tablename name not null,
  grantee   name not null,
  privilege text not null
);

create table if not exists salon_backup.rls_state (
  saved_at    timestamptz not null default now(),
  tablename   name not null,
  rls_enabled boolean not null
);

insert into salon_backup.policies (tablename, policyname, permissive, roles, cmd, qual, with_check)
select p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
from pg_policies p
where p.schemaname = 'public'
  and p.tablename in ('services', 'appointments', 'business_hours', 'blocked_dates', 'salon_settings', 'admin_users')
  and not exists (select 1 from salon_backup.rls_state);

insert into salon_backup.table_grants (tablename, grantee, privilege)
select c.relname, coalesce(r.rolname, 'public'), a.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) a
left join pg_roles r on r.oid = a.grantee
where n.nspname = 'public'
  and c.relname in ('services', 'appointments', 'business_hours', 'blocked_dates', 'salon_settings', 'admin_users')
  and (r.rolname in ('anon', 'authenticated') or a.grantee = 0)
  and not exists (select 1 from salon_backup.rls_state);

insert into salon_backup.rls_state (tablename, rls_enabled)
select c.relname, c.relrowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('services', 'appointments', 'business_hours', 'blocked_dates', 'salon_settings', 'admin_users')
  and not exists (select 1 from salon_backup.rls_state);

-- ---------------------------------------------------------------------
-- 2. Nye kolonner og kontrolregler
-- ---------------------------------------------------------------------
alter table public.services
  add column if not exists price_is_demo boolean not null default false;

alter table public.salon_settings
  add column if not exists booking_window_days integer not null default 60,
  add column if not exists about_text text,
  add column if not exists is_demo boolean not null default false;

comment on column public.services.price_is_demo is
  'Prisen er en demopris og vises med markering, indtil salonen har rettet den.';
comment on column public.salon_settings.booking_window_days is
  'Hvor mange dage frem kunderne kan booke.';
comment on column public.salon_settings.about_text is
  'Kort præsentation af salonen på forsiden.';
comment on column public.salon_settings.is_demo is
  'Navn og kontaktoplysninger er demooplysninger og vises med markering.';

-- NOT VALID: gælder nye og ændrede rækker; eksisterende rækker bliver ikke afvist.
do $$
declare
  v_rule record;
begin
  for v_rule in
    select * from (values
      ('public.services',       'services_duration_range',            'check (duration_minutes between 5 and 600)'),
      ('public.services',       'services_price_not_negative',        'check (price >= 0)'),
      ('public.salon_settings', 'salon_settings_slot_interval_range', 'check (slot_interval_minutes between 5 and 240)'),
      ('public.salon_settings', 'salon_settings_notice_range',        'check (booking_notice_hours between 0 and 720)'),
      ('public.salon_settings', 'salon_settings_window_range',        'check (booking_window_days between 1 and 365)'),
      ('public.business_hours', 'business_hours_weekday_range',       'check (weekday between 0 and 6)'),
      ('public.business_hours', 'business_hours_open_times',          'check (not is_open or (start_time is not null and end_time is not null and end_time > start_time))'),
      ('public.appointments',   'appointments_status_allowed',        'check (status in (''pending'', ''confirmed'', ''cancelled'', ''completed''))'),
      ('public.appointments',   'appointments_time_order',            'check (end_time > start_time)')
    ) as t(tbl, name, def)
  loop
    if not exists (
      select 1 from pg_constraint
      where conname = v_rule.name and conrelid = v_rule.tbl::regclass
    ) then
      execute format('alter table %s add constraint %I %s not valid', v_rule.tbl, v_rule.name, v_rule.def);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Ingen overlappende bookinger – håndhævet af databasen
--    Én fælles kalender: to aktive aftaler må aldrig overlappe.
--    Aflyste aftaler (status 'cancelled') blokerer ikke.
-- ---------------------------------------------------------------------
do $$
declare
  v_invalid  text;
  v_overlaps text;
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'appointments_no_overlap' and conrelid = 'public.appointments'::regclass
  ) then
    return;
  end if;

  select string_agg(format('%s kl. %s–%s', a.appointment_date, a.start_time, a.end_time), '; ')
    into v_invalid
  from public.appointments a
  where a.status is distinct from 'cancelled'
    and a.appointment_date is not null and a.start_time is not null and a.end_time is not null
    and a.end_time < a.start_time;

  if v_invalid is not null then
    raise exception 'Migrationen er stoppet uden ændringer. Disse aktive aftaler slutter, før de starter: %. Ret eller aflys dem, og kør filen igen.', v_invalid;
  end if;

  select string_agg(format('%s kl. %s–%s og kl. %s–%s', a.appointment_date, a.start_time, a.end_time, b.start_time, b.end_time), '; ')
    into v_overlaps
  from public.appointments a
  join public.appointments b
    on a.id < b.id
   and b.status is distinct from 'cancelled'
   and b.appointment_date is not null and b.start_time is not null and b.end_time is not null
   and tsrange(a.appointment_date + a.start_time, a.appointment_date + a.end_time, '[)')
       && tsrange(b.appointment_date + b.start_time, b.appointment_date + b.end_time, '[)')
  where a.status is distinct from 'cancelled'
    and a.appointment_date is not null and a.start_time is not null and a.end_time is not null;

  if v_overlaps is not null then
    raise exception 'Migrationen er stoppet uden ændringer. Disse aktive aftaler overlapper hinanden: %. Aflys eller flyt den ene, og kør filen igen.', v_overlaps;
  end if;

  alter table public.appointments
    add constraint appointments_no_overlap
    exclude using gist (
      tsrange(appointment_date + start_time, appointment_date + end_time, '[)') with &&
    )
    where (
      status is distinct from 'cancelled'
      and appointment_date is not null and start_time is not null and end_time is not null
    );
end $$;

create index if not exists appointments_date_time_idx
  on public.appointments (appointment_date, start_time);

-- ---------------------------------------------------------------------
-- 4. Funktioner
--    Hjælpefunktioner ligger i salon_private, som API'et ikke udstiller.
--    Alle tider er salonens lokaltid (Europe/Copenhagen).
-- ---------------------------------------------------------------------
create schema if not exists salon_private;
revoke all on schema salon_private from public;
revoke all on schema salon_private from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_users au
    where au.user_id = (select auth.uid())
  );
$$;

comment on function public.is_admin() is
  'Sand, hvis den indloggede bruger står i admin_users.';

-- Ledige starttider for én behandling på én dato.
-- p_now er med som parameter, så reglerne kan testes med et fast tidspunkt.
create or replace function salon_private.free_slots(p_service_id uuid, p_date date, p_now timestamptz)
returns table (slot_start time, slot_end time)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_duration integer;
  v_interval integer;
  v_notice   integer;
  v_window   integer;
  v_today    date;
  v_earliest timestamptz;
  v_open     record;
  v_t        timestamp;
  v_t_end    timestamp;
begin
  if p_service_id is null or p_date is null or p_now is null then
    return;
  end if;

  select s.duration_minutes into v_duration
  from public.services s
  where s.id = p_service_id and s.is_active;

  if v_duration is null or v_duration <= 0 then
    return;
  end if;

  select st.slot_interval_minutes, st.booking_notice_hours, st.booking_window_days
    into v_interval, v_notice, v_window
  from public.salon_settings st
  order by st.created_at, st.id
  limit 1;

  v_interval := greatest(coalesce(v_interval, 30), 5);
  v_notice   := greatest(coalesce(v_notice, 0), 0);
  v_window   := least(greatest(coalesce(v_window, 60), 1), 365);
  v_today    := (p_now at time zone 'Europe/Copenhagen')::date;

  if p_date < v_today or p_date > v_today + v_window then
    return;
  end if;

  if exists (select 1 from public.blocked_dates b where b.blocked_date = p_date) then
    return;
  end if;

  v_earliest := p_now + make_interval(hours => v_notice);

  for v_open in
    select bh.start_time as opens, bh.end_time as closes
    from public.business_hours bh
    where bh.weekday = extract(dow from p_date)::int
      and bh.is_open
      and bh.start_time is not null
      and bh.end_time is not null
      and bh.end_time > bh.start_time
    order by bh.start_time
  loop
    for v_t in
      select g
      from generate_series(
        p_date + v_open.opens,
        p_date + v_open.closes - make_interval(mins => v_duration),
        make_interval(mins => v_interval)
      ) as g
    loop
      v_t_end := v_t + make_interval(mins => v_duration);

      continue when (v_t at time zone 'Europe/Copenhagen') < v_earliest;

      continue when exists (
        select 1
        from public.appointments a
        where a.status is distinct from 'cancelled'
          and a.appointment_date is not null
          and a.start_time is not null
          and a.end_time is not null
          and tsrange(a.appointment_date + a.start_time, a.appointment_date + a.end_time, '[)')
              && tsrange(v_t, v_t_end, '[)')
      );

      slot_start := v_t::time;
      slot_end   := case when v_t_end::date > p_date then time '24:00' else v_t_end::time end;
      return next;
    end loop;
  end loop;
end;
$$;

create or replace function public.get_available_slots(p_service_id uuid, p_date date)
returns table (start_time time, end_time time)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct f.slot_start, f.slot_end
  from salon_private.free_slots(p_service_id, p_date, now()) as f
  order by f.slot_start;
$$;

comment on function public.get_available_slots(uuid, date) is
  'Ledige tider for en behandling på en dato. Viser kun tidspunkter – aldrig kundedata.';

-- Status pr. dag til kalenderen: available, full, closed eller unavailable.
create or replace function public.get_available_dates(p_service_id uuid, p_from date, p_to date)
returns table (calendar_date date, status text, free_slots integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_window integer;
  v_today  date := (now() at time zone 'Europe/Copenhagen')::date;
  v_to     date;
  v_d      date;
  v_n      integer;
begin
  if p_service_id is null or p_from is null or p_to is null or p_to < p_from then
    return;
  end if;

  if not exists (select 1 from public.services s where s.id = p_service_id and s.is_active) then
    return;
  end if;

  v_to := least(p_to, p_from + 62);

  select st.booking_window_days into v_window
  from public.salon_settings st
  order by st.created_at, st.id
  limit 1;
  v_window := least(greatest(coalesce(v_window, 60), 1), 365);

  for v_d in
    select g::date from generate_series(p_from::timestamp, v_to::timestamp, interval '1 day') as g
  loop
    calendar_date := v_d;
    if v_d < v_today or v_d > v_today + v_window then
      status := 'unavailable';
      free_slots := 0;
    elsif exists (select 1 from public.blocked_dates b where b.blocked_date = v_d)
       or not exists (
         select 1
         from public.business_hours bh
         where bh.weekday = extract(dow from v_d)::int
           and bh.is_open
           and bh.start_time is not null
           and bh.end_time is not null
           and bh.end_time > bh.start_time
       ) then
      status := 'closed';
      free_slots := 0;
    else
      select count(distinct f.slot_start)::int into v_n
      from salon_private.free_slots(p_service_id, v_d, now()) as f;
      free_slots := v_n;
      status := case when v_n > 0 then 'available' else 'full' end;
    end if;
    return next;
  end loop;
end;
$$;

comment on function public.get_available_dates(uuid, date, date) is
  'Kalenderstatus pr. dag (højst 63 dage pr. kald). Viser aldrig kundedata.';

-- Selve bookingen. Alle regler kontrolleres her – ikke i browseren.
create or replace function salon_private.create_booking(
  p_service_id uuid,
  p_date       date,
  p_start_time time,
  p_full_name  text,
  p_email      text,
  p_phone      text,
  p_notes      text,
  p_now        timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_name    text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_phone   text := btrim(regexp_replace(coalesce(p_phone, ''), '\s+', ' ', 'g'));
  v_digits  text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_notes   text := nullif(btrim(coalesce(p_notes, '')), '');
  v_today   date := (p_now at time zone 'Europe/Copenhagen')::date;
  v_service record;
  v_end     time;
  v_id      uuid;
begin
  if char_length(v_name) < 2 or char_length(v_name) > 100 then
    raise exception using errcode = 'P0001', hint = 'invalid_name',
      message = 'Skriv dit navn (2–100 tegn).';
  end if;

  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]{2,}$' then
    raise exception using errcode = 'P0001', hint = 'invalid_email',
      message = 'Skriv en gyldig e-mailadresse.';
  end if;

  if v_phone !~ '^\+?[0-9][0-9 ()-]*$' or char_length(v_digits) not between 8 and 15 then
    raise exception using errcode = 'P0001', hint = 'invalid_phone',
      message = 'Skriv et gyldigt telefonnummer med mindst 8 cifre.';
  end if;

  if char_length(coalesce(v_notes, '')) > 500 then
    raise exception using errcode = 'P0001', hint = 'invalid_notes',
      message = 'Bemærkningen må højst være 500 tegn.';
  end if;

  select s.id, s.name, s.duration_minutes, s.price, s.price_is_demo
    into v_service
  from public.services s
  where s.id = p_service_id and s.is_active;

  if not found then
    raise exception using errcode = 'P0001', hint = 'service_unavailable',
      message = 'Behandlingen kan ikke bookes lige nu.';
  end if;

  -- Én fælles kalender: bookinger behandles én ad gangen.
  perform pg_advisory_xact_lock(hashtext('public.appointments/booking'));

  -- Bremse mod masseindsendelse.
  if (select count(*) from public.appointments a where a.created_at > now() - interval '15 minutes') >= 20 then
    raise exception using errcode = 'P0001', hint = 'too_busy',
      message = 'Der kommer mange bookinger lige nu. Prøv igen om et par minutter.';
  end if;

  if (
    select count(*)
    from public.appointments a
    where a.status in ('pending', 'confirmed')
      and a.appointment_date >= v_today
      and (
        lower(a.email) = v_email
        or right(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g'), 8) = right(v_digits, 8)
      )
  ) >= 3 then
    raise exception using errcode = 'P0001', hint = 'too_many_bookings',
      message = 'Du har allerede tre kommende bookinger. Kontakt salonen, hvis du vil booke flere.';
  end if;

  select f.slot_end into v_end
  from salon_private.free_slots(p_service_id, p_date, p_now) as f
  where f.slot_start = p_start_time;

  if not found then
    raise exception using errcode = 'P0001', hint = 'slot_unavailable',
      message = 'Tiden er ikke længere ledig. Vælg en anden tid.';
  end if;

  begin
    insert into public.appointments as a
      (service_id, full_name, email, phone, appointment_date, start_time, end_time, status, notes)
    values
      (p_service_id, v_name, v_email, v_phone, p_date, p_start_time, v_end, 'pending', v_notes)
    returning a.id into v_id;
  exception
    when exclusion_violation then
      raise exception using errcode = 'P0001', hint = 'slot_unavailable',
        message = 'Tiden er ikke længere ledig. Vælg en anden tid.';
  end;

  return jsonb_build_object(
    'id', v_id,
    'reference', upper(left(v_id::text, 8)),
    'status', 'pending',
    'service_name', v_service.name,
    'duration_minutes', v_service.duration_minutes,
    'price', v_service.price,
    'price_is_demo', v_service.price_is_demo,
    'appointment_date', p_date,
    'start_time', p_start_time,
    'end_time', v_end
  );
end;
$$;

create or replace function public.create_booking(
  p_service_id uuid,
  p_date       date,
  p_start_time time,
  p_full_name  text,
  p_email      text,
  p_phone      text,
  p_notes      text default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select salon_private.create_booking(
    p_service_id, p_date, p_start_time, p_full_name, p_email, p_phone, p_notes, now()
  );
$$;

comment on function public.create_booking(uuid, date, time, text, text, text, text) is
  'Opretter en booking med status pending, hvis tiden stadig er ledig. Sluttiden beregnes ud fra behandlingens varighed.';

-- Kvittering: kun behandling, tid og status – ingen personoplysninger.
-- Bookingens id (tilfældigt UUID) fungerer som adgangsnøgle.
create or replace function public.get_booking_receipt(p_booking_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', a.id,
    'reference', upper(left(a.id::text, 8)),
    'status', a.status,
    'service_name', s.name,
    'duration_minutes', (extract(epoch from (a.end_time - a.start_time)) / 60)::int,
    'price', s.price,
    'price_is_demo', s.price_is_demo,
    'appointment_date', a.appointment_date,
    'start_time', a.start_time,
    'end_time', a.end_time
  )
  from public.appointments a
  left join public.services s on s.id = a.service_id
  where a.id = p_booking_id;
$$;

comment on function public.get_booking_receipt(uuid) is
  'Status for én booking ud fra dens id. Returnerer ingen personoplysninger.';

-- Rettigheder til funktionerne
revoke all on function public.is_admin() from public;
revoke all on function public.get_available_slots(uuid, date) from public;
revoke all on function public.get_available_dates(uuid, date, date) from public;
revoke all on function public.create_booking(uuid, date, time, text, text, text, text) from public;
revoke all on function public.get_booking_receipt(uuid) from public;
revoke all on function salon_private.free_slots(uuid, date, timestamptz) from public, anon, authenticated;
revoke all on function salon_private.create_booking(uuid, date, time, text, text, text, text, timestamptz) from public, anon, authenticated;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.get_available_slots(uuid, date) to anon, authenticated;
grant execute on function public.get_available_dates(uuid, date, date) to anon, authenticated;
grant execute on function public.create_booking(uuid, date, time, text, text, text, text) to anon, authenticated;
grant execute on function public.get_booking_receipt(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Adgang: RLS, tabelrettigheder og politikker
--    De eksisterende politikker på de seks tabeller fjernes og erstattes
--    (de er gemt i salon_backup.policies).
-- ---------------------------------------------------------------------
do $$
declare
  v_policy record;
begin
  for v_policy in
    select p.policyname, p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('services', 'appointments', 'business_hours', 'blocked_dates', 'salon_settings', 'admin_users')
  loop
    execute format('drop policy %I on public.%I', v_policy.policyname, v_policy.tablename);
  end loop;
end $$;

alter table public.services       enable row level security;
alter table public.appointments   enable row level security;
alter table public.business_hours enable row level security;
alter table public.blocked_dates  enable row level security;
alter table public.salon_settings enable row level security;
alter table public.admin_users    enable row level security;

-- Rettigheder: RLS bestemmer hvilke rækker, rettighederne hvilke handlinger.
-- Ingen kan slette behandlinger, bookinger eller saloninformation via API'et,
-- og ingen kan skrive i admin_users via API'et.
revoke all on table
  public.services, public.appointments, public.business_hours,
  public.blocked_dates, public.salon_settings, public.admin_users
  from public, anon, authenticated;

grant select on table public.services, public.business_hours, public.salon_settings to anon, authenticated;
grant insert, update on table public.services, public.business_hours to authenticated;
grant update on table public.salon_settings to authenticated;
grant select, insert, update, delete on table public.blocked_dates to authenticated;
grant select on table public.appointments to authenticated;
grant update (status) on table public.appointments to authenticated;
grant select on table public.admin_users to authenticated;

-- services
create policy "Alle kan se aktive behandlinger"
  on public.services for select to anon, authenticated
  using (is_active or (select public.is_admin()));

create policy "Administratorer kan oprette behandlinger"
  on public.services for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan rette behandlinger"
  on public.services for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- business_hours
create policy "Alle kan se åbningstider"
  on public.business_hours for select to anon, authenticated
  using (true);

create policy "Administratorer kan oprette åbningstider"
  on public.business_hours for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan rette åbningstider"
  on public.business_hours for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- blocked_dates (årsagen kan være intern, så kun administratorer ser tabellen)
create policy "Administratorer kan se lukkedage"
  on public.blocked_dates for select to authenticated
  using ((select public.is_admin()));

create policy "Administratorer kan oprette lukkedage"
  on public.blocked_dates for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan rette lukkedage"
  on public.blocked_dates for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "Administratorer kan slette lukkedage"
  on public.blocked_dates for delete to authenticated
  using ((select public.is_admin()));

-- salon_settings
create policy "Alle kan se saloninformation"
  on public.salon_settings for select to anon, authenticated
  using (true);

create policy "Administratorer kan rette saloninformation"
  on public.salon_settings for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- appointments (oprettes kun via create_booking)
create policy "Administratorer kan se bookinger"
  on public.appointments for select to authenticated
  using ((select public.is_admin()));

create policy "Administratorer kan ændre status på bookinger"
  on public.appointments for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- admin_users (kan kun ændres i SQL Editor / Dashboard – aldrig via API'et)
create policy "Brugere kan se, om de selv er administrator"
  on public.admin_users for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 6. Danske eksempeldata
--    Kun felter, der stadig har de oprindelige engelske eksempelværdier.
-- ---------------------------------------------------------------------
with sample (old_description, new_description) as (
  values
    ('Personalized haircut with consultation and styling finish.',
     'Klipning efter dine ønsker. Vi starter med en kort snak om, hvad du gerne vil have, og slutter af med let styling.'),
    ('Clean haircut with professional styling.',
     'Klipning med saks og maskine efter behov, afsluttet med styling.'),
    ('Full color service with consultation and finish.',
     'Farvning af hele håret. Vi taler farvevalg igennem inden start og afslutter med vask og føn.'),
    ('Wash, blow dry, and polished styling.',
     'Hårvask og føntørring, afsluttet med styling.'),
    ('Deep conditioning treatment for softer and healthier-looking hair.',
     'Plejende kur til tørt eller slidt hår, afsluttet med føn.')
)
update public.services s
set description = sample.new_description
from sample
where s.description = sample.old_description;

-- De oprindelige priser er amerikanske eksempelbeløb. Er prisen uændret,
-- erstattes den af en dansk demopris, som vises med markering på siden.
with sample (old_name, new_name, old_price, demo_price) as (
  values
    ('Women''s Haircut',  'Dameklip',     65.00,  495.00),
    ('Men''s Haircut',    'Herreklip',    45.00,  345.00),
    ('Hair Coloring',     'Hårfarvning', 140.00, 1095.00),
    ('Blow Dry Styling',  'Vask og føn',  50.00,  345.00),
    ('Hair Treatment',    'Hårkur',       75.00,  295.00)
)
update public.services s
set name          = sample.new_name,
    price         = case when s.price = sample.old_price then sample.demo_price else s.price end,
    price_is_demo = case when s.price = sample.old_price then true else s.price_is_demo end
from sample
where s.name = sample.old_name;

-- Amerikanske eksempeloplysninger erstattes af tydelige demooplysninger.
update public.salon_settings
set salon_name    = case when salon_name    = 'Luxe Hair Studio'                 then 'Demosalonen'            else salon_name end,
    salon_email   = case when salon_email   = 'hello@luxehair.com'               then 'kontakt@example.com'    else salon_email end,
    salon_phone   = case when salon_phone   = '+1 555 234 7890'                  then '+45 00 00 00 00'        else salon_phone end,
    salon_address = case when salon_address = '245 Madison Avenue, New York, NY' then 'Demovej 1, 0000 Demoby' else salon_address end,
    is_demo       = true
where salon_name    = 'Luxe Hair Studio'
   or salon_email   = 'hello@luxehair.com'
   or salon_phone   = '+1 555 234 7890'
   or salon_address = '245 Madison Avenue, New York, NY';

update public.salon_settings
set about_text = 'Vi tilbyder klip, farve og hårpleje til damer og herrer. Se behandlinger og priser herunder, og book din tid online, når det passer dig. Har du spørgsmål til en behandling, er du velkommen til at kontakte salonen.'
where about_text is null
  and is_demo;

-- Mangler der rækker, oprettes de (eksisterende rækker røres ikke).
insert into public.salon_settings
  (salon_name, salon_email, salon_phone, salon_address, slot_interval_minutes, booking_notice_hours, booking_window_days, is_demo)
select 'Demosalonen', 'kontakt@example.com', '+45 00 00 00 00', 'Demovej 1, 0000 Demoby', 30, 2, 60, true
where not exists (select 1 from public.salon_settings);

insert into public.business_hours (weekday, is_open, start_time, end_time)
select d, false, null, null
from generate_series(0, 6) as d
where not exists (select 1 from public.business_hours bh where bh.weekday = d);

-- Bed API'et (PostgREST) om at indlæse de nye funktioner.
notify pgrst, 'reload schema';

commit;
