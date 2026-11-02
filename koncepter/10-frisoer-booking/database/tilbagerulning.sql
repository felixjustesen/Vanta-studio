-- =====================================================================
--  Tilbagerulning af 2-migration.sql – kun hvis det bliver nødvendigt.
--
--  Genskaber de politikker, tabelrettigheder og RLS-indstillinger, der
--  var før migrationen (fra salon_backup), fjerner bookingfunktionerne
--  og reglerne og sætter de danske eksempeldata tilbage til de engelske –
--  men kun felter, der stadig har migrationens værdier. Bookinger og
--  ejerens egne ændringer bliver stående.
--
--  De nye kolonner og salon_backup bliver også stående (sidst i filen
--  kan de fjernes, hvis man ønsker det).
--  OBS: Bagefter kan siden ikke tage imod bookinger.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.staff') is not null then
    raise exception 'Migrationen til flere frisører (6) er kørt. Denne tilbagerulning gælder kun 2-migration.sql og er stoppet uden ændringer.';
  end if;
  if not exists (select 1 from salon_backup.rls_state) then
    raise exception 'Der findes ingen sikkerhedskopi i salon_backup – tilbagerulningen er stoppet uden ændringer.';
  end if;
end $$;

-- 1. Politikker: fjern de nuværende, genskab de gemte
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

  for v_policy in select * from salon_backup.policies loop
    execute format(
      'create policy %I on public.%I as %s for %s to %s%s%s',
      v_policy.policyname,
      v_policy.tablename,
      v_policy.permissive,
      v_policy.cmd,
      (select string_agg(case when r = 'public' then 'public' else quote_ident(r) end, ', ') from unnest(v_policy.roles) as r),
      case when v_policy.qual is not null then ' using (' || v_policy.qual || ')' else '' end,
      case when v_policy.with_check is not null then ' with check (' || v_policy.with_check || ')' else '' end
    );
  end loop;
end $$;

-- 2. RLS-status og tabelrettigheder som før
do $$
declare
  v_row record;
begin
  for v_row in select * from salon_backup.rls_state loop
    execute format('alter table public.%I %s row level security', v_row.tablename,
                   case when v_row.rls_enabled then 'enable' else 'disable' end);
  end loop;

  revoke all on table
    public.services, public.appointments, public.business_hours,
    public.blocked_dates, public.salon_settings, public.admin_users
    from public, anon, authenticated;

  for v_row in select * from salon_backup.table_grants loop
    execute format('grant %s on table public.%I to %s', v_row.privilege, v_row.tablename,
                   case when v_row.grantee = 'public' then 'public' else quote_ident(v_row.grantee) end);
  end loop;
end $$;

-- 3. Funktioner, regler og indeks fra migrationen
drop function if exists public.get_available_slots(uuid, date);
drop function if exists public.get_available_dates(uuid, date, date);
drop function if exists public.create_booking(uuid, date, time, text, text, text, text);
drop function if exists public.get_booking_receipt(uuid);
drop function if exists public.is_admin();
drop function if exists salon_private.free_slots(uuid, date, timestamptz);
drop function if exists salon_private.create_booking(uuid, date, time, text, text, text, text, timestamptz);
drop schema if exists salon_private;

alter table public.appointments   drop constraint if exists appointments_no_overlap;
alter table public.appointments   drop constraint if exists appointments_status_allowed;
alter table public.appointments   drop constraint if exists appointments_time_order;
alter table public.services       drop constraint if exists services_duration_range;
alter table public.services       drop constraint if exists services_price_not_negative;
alter table public.salon_settings drop constraint if exists salon_settings_slot_interval_range;
alter table public.salon_settings drop constraint if exists salon_settings_notice_range;
alter table public.salon_settings drop constraint if exists salon_settings_window_range;
alter table public.business_hours drop constraint if exists business_hours_weekday_range;
alter table public.business_hours drop constraint if exists business_hours_open_times;
drop index if exists public.appointments_date_time_idx;

-- 4. Eksempeldata tilbage (kun felter med migrationens værdier)
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
set description = sample.old_description
from sample
where s.description = sample.new_description;

with sample (old_name, new_name, old_price, demo_price) as (
  values
    ('Women''s Haircut',  'Dameklip',     65.00,  495.00),
    ('Men''s Haircut',    'Herreklip',    45.00,  345.00),
    ('Hair Coloring',     'Hårfarvning', 140.00, 1095.00),
    ('Blow Dry Styling',  'Vask og føn',  50.00,  345.00),
    ('Hair Treatment',    'Hårkur',       75.00,  295.00)
)
update public.services s
set name          = sample.old_name,
    price         = case when s.price_is_demo and s.price = sample.demo_price then sample.old_price else s.price end,
    price_is_demo = case when s.price_is_demo and s.price = sample.demo_price then false else s.price_is_demo end
from sample
where s.name = sample.new_name;

update public.salon_settings
set salon_name    = case when salon_name    = 'Demosalonen'            then 'Luxe Hair Studio'                 else salon_name end,
    salon_email   = case when salon_email   = 'kontakt@example.com'    then 'hello@luxehair.com'               else salon_email end,
    salon_phone   = case when salon_phone   = '+45 00 00 00 00'        then '+1 555 234 7890'                  else salon_phone end,
    salon_address = case when salon_address = 'Demovej 1, 0000 Demoby' then '245 Madison Avenue, New York, NY' else salon_address end,
    about_text    = case when about_text like 'Vi tilbyder klip, farve og hårpleje til damer og herrer.%' then null else about_text end,
    is_demo       = false
where is_demo;

notify pgrst, 'reload schema';

commit;

-- Valgfrit, når alt er i orden igen (sletter kolonnernes indhold og sikkerhedskopien):
-- alter table public.services drop column if exists price_is_demo;
-- alter table public.salon_settings drop column if exists booking_window_days,
--   drop column if exists about_text, drop column if exists is_demo;
-- drop schema if exists salon_backup cascade;
