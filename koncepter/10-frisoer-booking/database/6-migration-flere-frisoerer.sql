-- =====================================================================
--  Frisørbooking · flere frisører (2026-11-02)
--
--  Kør efter 2-migration.sql. Kør hele filen i Supabase → SQL Editor.
--  Ikke-destruktiv: ingen tabeller, kolonner eller rækker slettes.
--  Filen kører i én transaktion – fejler noget, ændres intet.
--  Den kan køres igen uden skade.
--
--  Hvad den gør:
--   1. Opretter fem tabeller: staff (frisørerne), staff_services (hvilke
--      behandlinger hver frisør laver), staff_hours (arbejdstider),
--      staff_time_off (fravær) og staff_users (frisørernes login).
--   2. Giver appointments kolonnen staff_id. Eksisterende bookinger
--      knyttes til den første frisør.
--   3. Reglen mod dobbeltbooking gælder nu pr. frisør: to frisører kan have
--      kunder på samme tid, men én frisør kan aldrig have to på én gang.
--   4. Opdaterer funktionerne til ledige tider og booking, så kunden kan
--      vælge en bestemt frisør eller "første ledige".
--   5. To roller: administratorer (admin_users) ser og ændrer alt. En
--      frisør med login ser kun sine egne bookinger og kan ændre deres status.
--   6. Opretter tre demofrisører, hvis der ikke findes nogen frisører.
-- =====================================================================

begin;

do $$
begin
  if to_regprocedure('public.get_booking_receipt(uuid)') is null
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'services' and column_name = 'price_is_demo'
     ) then
    raise exception 'Kør 2-migration.sql før denne fil. Intet er ændret.';
  end if;
end $$;

-- btree_gist gør det muligt at kombinere "samme frisør" og "overlappende
-- tid" i én regel. Supabase lægger udvidelser i skemaet extensions.
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Tabeller
-- ---------------------------------------------------------------------
create table if not exists public.staff (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  is_active  boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint staff_name_length check (char_length(btrim(name)) between 1 and 60)
);

create table if not exists public.staff_services (
  staff_id   uuid not null references public.staff (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (staff_id, service_id)
);

create table if not exists public.staff_hours (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff (id) on delete cascade,
  weekday    integer not null,
  is_working boolean not null default false,
  start_time time,
  end_time   time,
  constraint staff_hours_one_per_day unique (staff_id, weekday),
  constraint staff_hours_weekday_range check (weekday between 0 and 6),
  constraint staff_hours_times check (
    not is_working or (start_time is not null and end_time is not null and end_time > start_time)
  )
);

create table if not exists public.staff_time_off (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references public.staff (id) on delete cascade,
  starts_at  timestamp not null,
  ends_at    timestamp not null,
  reason     text,
  created_at timestamptz not null default now(),
  constraint staff_time_off_order check (ends_at > starts_at),
  constraint staff_time_off_length check (ends_at - starts_at <= interval '366 days'),
  constraint staff_time_off_reason_length check (reason is null or char_length(reason) <= 200)
);

create table if not exists public.staff_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  staff_id   uuid not null unique references public.staff (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists staff_time_off_staff_idx on public.staff_time_off (staff_id, starts_at);

comment on table public.staff is 'Frisørerne. En inaktiv frisør kan ikke bookes, og frisørens login virker ikke.';
comment on table public.staff_services is 'Hvilke behandlinger hver frisør laver.';
comment on table public.staff_hours is 'Frisørens arbejdstid pr. ugedag. Der kan kun bookes, når både salonen har åbent og frisøren arbejder.';
comment on table public.staff_time_off is 'Fravær (ferie, sygdom, fridage). Tider er salonens lokaltid (Europe/Copenhagen).';
comment on table public.staff_users is 'Kobler en frisør til et login. Ændres via link_staff_login() eller i SQL Editor.';

-- Bookingerne får en frisør.
alter table public.appointments
  add column if not exists staff_id uuid references public.staff (id);

comment on column public.appointments.staff_id is 'Frisøren, der har bookingen.';

create index if not exists appointments_staff_date_idx on public.appointments (staff_id, appointment_date);

-- ---------------------------------------------------------------------
-- 2. Nye frisører får salonens åbningstider som arbejdstider
-- ---------------------------------------------------------------------
create schema if not exists salon_private;
revoke all on schema salon_private from public;
revoke all on schema salon_private from anon, authenticated;

create or replace function salon_private.staff_default_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.staff_hours (staff_id, weekday, is_working, start_time, end_time)
  select new.id,
         d.weekday,
         coalesce(bool_or(bh.id is not null), false),
         min(bh.start_time),
         max(bh.end_time)
  from generate_series(0, 6) as d(weekday)
  left join public.business_hours bh
    on bh.weekday = d.weekday
   and bh.is_open
   and bh.start_time is not null
   and bh.end_time is not null
   and bh.end_time > bh.start_time
  group by d.weekday
  on conflict (staff_id, weekday) do nothing;
  return new;
end;
$$;

drop trigger if exists staff_default_hours on public.staff;
create trigger staff_default_hours
  after insert on public.staff
  for each row execute function salon_private.staff_default_hours();

-- ---------------------------------------------------------------------
-- 3. Demofrisører (kun hvis der ikke findes nogen frisører)
-- ---------------------------------------------------------------------
do $$
declare
  v_anna   uuid;
  v_mikkel uuid;
  v_sara   uuid;
begin
  if exists (select 1 from public.staff) then
    return;
  end if;

  insert into public.staff (name, sort_order) values ('Anna', 1) returning id into v_anna;
  insert into public.staff (name, sort_order) values ('Mikkel', 2) returning id into v_mikkel;
  insert into public.staff (name, sort_order) values ('Sara', 3) returning id into v_sara;

  insert into public.staff_services (staff_id, service_id)
  select v_anna, s.id from public.services s;

  insert into public.staff_services (staff_id, service_id)
  select v_mikkel, s.id from public.services s
  where s.name in ('Herreklip', 'Vask og føn', 'Hårkur');

  insert into public.staff_services (staff_id, service_id)
  select v_sara, s.id from public.services s
  where s.name in ('Dameklip', 'Hårfarvning', 'Vask og føn', 'Hårkur');

  -- Har salonen omdøbt behandlingerne, får frisøren dem alle.
  insert into public.staff_services (staff_id, service_id)
  select st.id, s.id
  from public.staff st
  cross join public.services s
  where st.id in (v_mikkel, v_sara)
    and not exists (select 1 from public.staff_services x where x.staff_id = st.id)
  on conflict do nothing;

  -- Lidt variation, så demoen viser forskellige arbejdsdage.
  update public.staff_hours set is_working = false where staff_id = v_mikkel and weekday = 1;
  update public.staff_hours set is_working = false where staff_id = v_sara and weekday = 6;
end $$;

-- Eksisterende bookinger uden frisør knyttes til den første frisør.
update public.appointments a
set staff_id = (
  select st.id from public.staff st
  order by st.is_active desc, st.sort_order, st.created_at, st.id
  limit 1
)
where a.staff_id is null;

do $$
begin
  if not exists (select 1 from public.appointments where staff_id is null) then
    alter table public.appointments alter column staff_id set not null;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 4. Ingen dobbeltbooking pr. frisør
--    Erstatter den fælles regel (appointments_no_overlap) fra migration 2.
--    Aflyste aftaler (status 'cancelled') blokerer ikke.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'appointments_no_overlap_per_staff' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments
      add constraint appointments_no_overlap_per_staff
      exclude using gist (
        staff_id with =,
        tsrange(appointment_date + start_time, appointment_date + end_time, '[)') with &&
      )
      where (
        status is distinct from 'cancelled'
        and appointment_date is not null and start_time is not null and end_time is not null
      );
  end if;

  if exists (
    select 1 from pg_constraint
    where conname = 'appointments_no_overlap' and conrelid = 'public.appointments'::regclass
  ) then
    alter table public.appointments drop constraint appointments_no_overlap;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Funktioner
--    De gamle versioner fjernes, så API'et kun kender én udgave af hver.
--    Den nye parameter p_staff_id er valgfri, så kald uden frisør virker
--    som før ("første ledige").
-- ---------------------------------------------------------------------
drop function if exists public.get_available_slots(uuid, date);
drop function if exists public.get_available_dates(uuid, date, date);
drop function if exists public.create_booking(uuid, date, time, text, text, text, text);
drop function if exists salon_private.create_booking(uuid, date, time, text, text, text, text, timestamptz);
drop function if exists salon_private.free_slots(uuid, date, timestamptz);

-- Frisør-id for den indloggede bruger (kun aktive frisører).
create or replace function public.my_staff_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select su.staff_id
  from public.staff_users su
  join public.staff st on st.id = su.staff_id and st.is_active
  where su.user_id = (select auth.uid());
$$;

comment on function public.my_staff_id() is
  'Frisøren, som den indloggede bruger er knyttet til – eller null.';

create or replace function public.get_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'is_admin', (select public.is_admin()),
    'staff_id', st.id,
    'staff_name', st.name
  )
  from (select 1) as one
  left join public.staff_users su on su.user_id = (select auth.uid())
  left join public.staff st on st.id = su.staff_id and st.is_active;
$$;

comment on function public.get_my_access() is
  'Rollen for den indloggede bruger: administrator, frisør eller ingen.';

-- Ledige starttider pr. frisør for én behandling på én dato.
-- p_now er med som parameter, så reglerne kan testes med et fast tidspunkt.
create or replace function salon_private.staff_slots(
  p_service_id uuid,
  p_date       date,
  p_now        timestamptz,
  p_staff_id   uuid default null
)
returns table (slot_staff_id uuid, slot_start time, slot_end time)
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
  v_dow      integer;
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
  v_dow      := extract(dow from p_date)::int;

  if p_date < v_today or p_date > v_today + v_window then
    return;
  end if;

  if exists (select 1 from public.blocked_dates b where b.blocked_date = p_date) then
    return;
  end if;

  v_earliest := p_now + make_interval(hours => v_notice);

  return query
  with windows as (
    -- Salonen skal have åbent, og frisøren skal arbejde.
    select st.id as sid,
           greatest(bh.start_time, sh.start_time) as w_start,
           least(bh.end_time, sh.end_time) as w_end
    from public.staff st
    join public.staff_services ss on ss.staff_id = st.id and ss.service_id = p_service_id
    join public.staff_hours sh on sh.staff_id = st.id and sh.weekday = v_dow and sh.is_working
    join public.business_hours bh on bh.weekday = v_dow and bh.is_open
    where st.is_active
      and (p_staff_id is null or st.id = p_staff_id)
      and sh.start_time is not null and sh.end_time is not null
      and bh.start_time is not null and bh.end_time is not null
  ),
  candidates as (
    select w.sid,
           g as s_start,
           g + make_interval(mins => v_duration) as s_end
    from windows w
    cross join lateral generate_series(
      p_date + w.w_start,
      p_date + w.w_end - make_interval(mins => v_duration),
      make_interval(mins => v_interval)
    ) as g
    where w.w_end > w.w_start
  )
  select distinct
         c.sid,
         c.s_start::time,
         case when c.s_end >= (p_date + 1)::timestamp then time '24:00' else c.s_end::time end
  from candidates c
  where (c.s_start at time zone 'Europe/Copenhagen') >= v_earliest
    and not exists (
      select 1
      from public.appointments a
      where a.staff_id = c.sid
        and a.appointment_date = p_date
        and a.status is distinct from 'cancelled'
        and a.start_time is not null
        and a.end_time is not null
        and tsrange(a.appointment_date + a.start_time, a.appointment_date + a.end_time, '[)')
            && tsrange(c.s_start, c.s_end, '[)')
    )
    and not exists (
      select 1
      from public.staff_time_off t
      where t.staff_id = c.sid
        and tsrange(t.starts_at, t.ends_at, '[)') && tsrange(c.s_start, c.s_end, '[)')
    );
end;
$$;

create or replace function public.get_available_slots(
  p_service_id uuid,
  p_date       date,
  p_staff_id   uuid default null
)
returns table (start_time time, end_time time)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct f.slot_start, f.slot_end
  from salon_private.staff_slots(p_service_id, p_date, now(), p_staff_id) as f
  order by f.slot_start;
$$;

comment on function public.get_available_slots(uuid, date, uuid) is
  'Ledige tider for en behandling på en dato – hos én frisør eller hos første ledige. Viser aldrig kundedata.';

-- Status pr. dag til kalenderen: available, full, off, closed eller unavailable.
create or replace function public.get_available_dates(
  p_service_id uuid,
  p_from       date,
  p_to         date,
  p_staff_id   uuid default null
)
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
    free_slots := 0;
    if v_d < v_today or v_d > v_today + v_window then
      status := 'unavailable';
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
    elsif not exists (
      -- Ingen frisør, der laver behandlingen, arbejder denne dag.
      select 1
      from public.staff st
      join public.staff_services ss on ss.staff_id = st.id and ss.service_id = p_service_id
      join public.staff_hours sh on sh.staff_id = st.id and sh.weekday = extract(dow from v_d)::int and sh.is_working
      where st.is_active
        and (p_staff_id is null or st.id = p_staff_id)
        and not exists (
          select 1 from public.staff_time_off t
          where t.staff_id = st.id
            and t.starts_at <= v_d::timestamp
            and t.ends_at >= (v_d + 1)::timestamp
        )
    ) then
      status := 'off';
    else
      select count(distinct f.slot_start)::int into v_n
      from salon_private.staff_slots(p_service_id, v_d, now(), p_staff_id) as f;
      free_slots := v_n;
      status := case when v_n > 0 then 'available' else 'full' end;
    end if;
    return next;
  end loop;
end;
$$;

comment on function public.get_available_dates(uuid, date, date, uuid) is
  'Kalenderstatus pr. dag (højst 63 dage pr. kald) – for én frisør eller alle. Viser aldrig kundedata.';

-- Selve bookingen. Alle regler kontrolleres her – ikke i browseren.
create or replace function salon_private.create_booking(
  p_service_id uuid,
  p_date       date,
  p_start_time time,
  p_full_name  text,
  p_email      text,
  p_phone      text,
  p_notes      text,
  p_staff_id   uuid,
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
  v_staff   uuid;
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

  -- Bookinger behandles én ad gangen, så to kunder ikke får samme frisør og tid.
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

  -- Den valgte frisør – eller den ledige frisør med færrest bookinger den dag.
  select f.slot_staff_id, f.slot_end
    into v_staff, v_end
  from salon_private.staff_slots(p_service_id, p_date, p_now, p_staff_id) as f
  join public.staff st on st.id = f.slot_staff_id
  where f.slot_start = p_start_time
  order by (
             select count(*)
             from public.appointments a
             where a.staff_id = f.slot_staff_id
               and a.appointment_date = p_date
               and a.status is distinct from 'cancelled'
           ),
           st.sort_order, st.name, st.id
  limit 1;

  if not found then
    raise exception using errcode = 'P0001', hint = 'slot_unavailable',
      message = 'Tiden er ikke længere ledig. Vælg en anden tid.';
  end if;

  begin
    insert into public.appointments as a
      (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time, status, notes)
    values
      (p_service_id, v_staff, v_name, v_email, v_phone, p_date, p_start_time, v_end, 'pending', v_notes)
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
    'end_time', v_end,
    'staff_id', v_staff,
    'staff_name', (select st.name from public.staff st where st.id = v_staff)
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
  p_notes      text default null,
  p_staff_id   uuid default null
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select salon_private.create_booking(
    p_service_id, p_date, p_start_time, p_full_name, p_email, p_phone, p_notes, p_staff_id, now()
  );
$$;

comment on function public.create_booking(uuid, date, time, text, text, text, text, uuid) is
  'Opretter en booking med status pending, hvis tiden stadig er ledig – hos den valgte frisør eller første ledige.';

-- Kvittering: kun behandling, frisør, tid og status – ingen personoplysninger.
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
    'end_time', a.end_time,
    'staff_name', st.name
  )
  from public.appointments a
  left join public.services s on s.id = a.service_id
  left join public.staff st on st.id = a.staff_id
  where a.id = p_booking_id;
$$;

-- Til administrationen: frisørernes login-e-mail (kun for administratorer).
create or replace function public.admin_staff_logins()
returns table (staff_id uuid, email text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Kun administratorer kan se frisørernes login.';
  end if;
  return query
    select su.staff_id, u.email::text
    from public.staff_users su
    join auth.users u on u.id = su.user_id;
end;
$$;

-- Til administrationen: knyt en eksisterende, bekræftet bruger til en frisør.
-- Tom e-mail fjerner frisørens login.
create or replace function public.link_staff_login(p_staff_id uuid, p_email text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
  v_other text;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Kun administratorer kan ændre frisørernes login.';
  end if;

  if not exists (select 1 from public.staff st where st.id = p_staff_id) then
    raise exception using errcode = 'P0001', hint = 'staff_not_found', message = 'Frisøren findes ikke.';
  end if;

  if v_email = '' then
    delete from public.staff_users su where su.staff_id = p_staff_id;
    return jsonb_build_object('staff_id', p_staff_id, 'email', null);
  end if;

  select u.id into v_user
  from auth.users u
  where lower(u.email) = v_email
    and u.email_confirmed_at is not null
  order by u.created_at
  limit 1;

  if v_user is null then
    raise exception using errcode = 'P0001', hint = 'login_not_found',
      message = 'Der findes ingen bekræftet bruger med den e-mail.';
  end if;

  select st.name into v_other
  from public.staff_users su
  join public.staff st on st.id = su.staff_id
  where su.user_id = v_user and su.staff_id <> p_staff_id;

  if v_other is not null then
    raise exception using errcode = 'P0001', hint = 'login_in_use',
      message = format('Brugeren er allerede knyttet til %s.', v_other);
  end if;

  delete from public.staff_users su where su.staff_id = p_staff_id and su.user_id <> v_user;
  insert into public.staff_users (user_id, staff_id) values (v_user, p_staff_id)
  on conflict (user_id) do nothing;

  return jsonb_build_object('staff_id', p_staff_id, 'email', v_email);
end;
$$;

-- Rettigheder til funktionerne
revoke all on function public.get_available_slots(uuid, date, uuid) from public, anon, authenticated;
revoke all on function public.get_available_dates(uuid, date, date, uuid) from public, anon, authenticated;
revoke all on function public.create_booking(uuid, date, time, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.get_booking_receipt(uuid) from public;
revoke all on function public.my_staff_id() from public, anon, authenticated;
revoke all on function public.get_my_access() from public, anon, authenticated;
revoke all on function public.admin_staff_logins() from public, anon, authenticated;
revoke all on function public.link_staff_login(uuid, text) from public, anon, authenticated;
revoke all on function salon_private.staff_slots(uuid, date, timestamptz, uuid) from public, anon, authenticated;
revoke all on function salon_private.create_booking(uuid, date, time, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function salon_private.staff_default_hours() from public, anon, authenticated;

grant execute on function public.get_available_slots(uuid, date, uuid) to anon, authenticated;
grant execute on function public.get_available_dates(uuid, date, date, uuid) to anon, authenticated;
grant execute on function public.create_booking(uuid, date, time, text, text, text, text, uuid) to anon, authenticated;
grant execute on function public.get_booking_receipt(uuid) to anon, authenticated;
grant execute on function public.my_staff_id() to anon, authenticated;
grant execute on function public.get_my_access() to anon, authenticated;
grant execute on function public.admin_staff_logins() to authenticated;
grant execute on function public.link_staff_login(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Adgang: RLS, tabelrettigheder og politikker
--    Politikkerne på de nye tabeller og på appointments erstattes af et
--    kendt sæt. De øvrige tabellers politikker fra migration 2 røres ikke.
-- ---------------------------------------------------------------------
do $$
declare
  v_policy record;
begin
  for v_policy in
    select p.policyname, p.tablename
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('staff', 'staff_services', 'staff_hours', 'staff_time_off', 'staff_users', 'appointments')
  loop
    execute format('drop policy %I on public.%I', v_policy.policyname, v_policy.tablename);
  end loop;
end $$;

alter table public.staff          enable row level security;
alter table public.staff_services enable row level security;
alter table public.staff_hours    enable row level security;
alter table public.staff_time_off enable row level security;
alter table public.staff_users    enable row level security;

-- Supabase giver nye tabeller fulde rettigheder som standard – de fjernes.
revoke all on table
  public.staff, public.staff_services, public.staff_hours,
  public.staff_time_off, public.staff_users
  from public, anon, authenticated;

grant select on table public.staff, public.staff_services to anon, authenticated;
grant insert (name, is_active, sort_order), update (name, is_active, sort_order) on table public.staff to authenticated;
grant insert, delete on table public.staff_services to authenticated;
grant select on table public.staff_hours, public.staff_time_off, public.staff_users to authenticated;
grant insert (staff_id, weekday, is_working, start_time, end_time),
      update (is_working, start_time, end_time) on table public.staff_hours to authenticated;
grant insert (staff_id, starts_at, ends_at, reason), delete on table public.staff_time_off to authenticated;
grant update (status, staff_id) on table public.appointments to authenticated;

-- staff (navnene er offentlige – de vises i bookingen)
create policy "Alle kan se aktive frisører"
  on public.staff for select to anon, authenticated
  using (is_active or (select public.is_admin()));

create policy "Administratorer kan oprette frisører"
  on public.staff for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan rette frisører"
  on public.staff for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- staff_services
create policy "Alle kan se, hvem der laver hvilke behandlinger"
  on public.staff_services for select to anon, authenticated
  using (true);

create policy "Administratorer kan give frisører behandlinger"
  on public.staff_services for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan fjerne behandlinger fra frisører"
  on public.staff_services for delete to authenticated
  using ((select public.is_admin()));

-- staff_hours
create policy "Administratorer og frisøren selv kan se arbejdstider"
  on public.staff_hours for select to authenticated
  using ((select public.is_admin()) or staff_id = (select public.my_staff_id()));

create policy "Administratorer kan oprette arbejdstider"
  on public.staff_hours for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan rette arbejdstider"
  on public.staff_hours for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- staff_time_off (årsagen kan være personlig)
create policy "Administratorer og frisøren selv kan se fravær"
  on public.staff_time_off for select to authenticated
  using ((select public.is_admin()) or staff_id = (select public.my_staff_id()));

create policy "Administratorer kan oprette fravær"
  on public.staff_time_off for insert to authenticated
  with check ((select public.is_admin()));

create policy "Administratorer kan slette fravær"
  on public.staff_time_off for delete to authenticated
  using ((select public.is_admin()));

-- staff_users (ændres kun via link_staff_login eller i SQL Editor)
create policy "Brugere kan se deres egen frisørkobling"
  on public.staff_users for select to authenticated
  using (user_id = (select auth.uid()));

-- appointments (oprettes kun via create_booking)
create policy "Administratorer kan se bookinger"
  on public.appointments for select to authenticated
  using ((select public.is_admin()));

create policy "Frisører kan se egne bookinger"
  on public.appointments for select to authenticated
  using (staff_id = (select public.my_staff_id()));

create policy "Administratorer kan ændre bookinger"
  on public.appointments for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "Frisører kan ændre status på egne bookinger"
  on public.appointments for update to authenticated
  using (staff_id = (select public.my_staff_id()))
  with check (staff_id = (select public.my_staff_id()));

-- Bed API'et (PostgREST) om at indlæse de nye tabeller og funktioner.
notify pgrst, 'reload schema';

commit;
