-- =====================================================================
--  Efterkontrol – ændrer intet.
--  Kør efter migrationen. Den sidste række, alt_ok, skal være true.
--  Gælder tilstanden efter 2-migration.sql. Efter 6-migration-flere-frisoerer.sql
--  bruges 7-kontrol-flere-frisoerer.sql i stedet.
--  Kontrol 14–16 er oplysninger (fx om der er oprettet en administrator)
--  og tæller ikke med i alt_ok.
-- =====================================================================
with
tabeller(navn) as (
  values ('services'), ('appointments'), ('business_hours'),
         ('blocked_dates'), ('salon_settings'), ('admin_users')
),
funktioner(navn) as (
  values ('get_available_slots'), ('get_available_dates'), ('create_booking'),
         ('get_booking_receipt'), ('is_admin'), ('free_slots')
),
checks(nr, kontrol, ok, detaljer, kritisk) as (
  select 1, 'RLS er slået til på alle seks tabeller',
         bool_and(c.relrowsecurity),
         string_agg(c.relname, ', ') filter (where not c.relrowsecurity),
         true
  from pg_class c
  join tabeller t on t.navn = c.relname
  where c.relnamespace = 'public'::regnamespace

  union all
  select 2, 'Anonyme kan ikke læse bookinger, lukkedage eller administratorer',
         not (has_table_privilege('anon', 'public.appointments', 'select')
           or has_table_privilege('anon', 'public.blocked_dates', 'select')
           or has_table_privilege('anon', 'public.admin_users', 'select')),
         null, true

  union all
  select 3, 'Anonyme kan ikke skrive i nogen af tabellerne',
         not exists (
           select 1
           from tabeller t
           cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
           where has_table_privilege('anon', 'public.' || t.navn, p.priv)
         ),
         null, true

  union all
  select 4, 'Ingen kan skrive i admin_users via API''et',
         not (has_table_privilege('anon', 'public.admin_users', 'insert')
           or has_table_privilege('authenticated', 'public.admin_users', 'insert')
           or has_table_privilege('authenticated', 'public.admin_users', 'update')
           or has_table_privilege('authenticated', 'public.admin_users', 'delete')),
         null, true

  union all
  select 5, 'Bookinger kan hverken oprettes direkte eller slettes via API''et',
         not (has_table_privilege('authenticated', 'public.appointments', 'insert')
           or has_table_privilege('authenticated', 'public.appointments', 'delete')),
         null, true

  union all
  select 6, 'Administratorer kan kun ændre status på bookinger',
         has_column_privilege('authenticated', 'public.appointments', 'status', 'update')
         and not has_column_privilege('authenticated', 'public.appointments', 'full_name', 'update')
         and not has_column_privilege('authenticated', 'public.appointments', 'start_time', 'update'),
         null, true

  union all
  select 7, 'De 15 forventede politikker findes – og ingen andre',
         count(*) = 15
         and count(*) filter (where p.policyname in (
           'Alle kan se aktive behandlinger', 'Administratorer kan oprette behandlinger',
           'Administratorer kan rette behandlinger', 'Alle kan se åbningstider',
           'Administratorer kan oprette åbningstider', 'Administratorer kan rette åbningstider',
           'Administratorer kan se lukkedage', 'Administratorer kan oprette lukkedage',
           'Administratorer kan rette lukkedage', 'Administratorer kan slette lukkedage',
           'Alle kan se saloninformation', 'Administratorer kan rette saloninformation',
           'Administratorer kan se bookinger', 'Administratorer kan ændre status på bookinger',
           'Brugere kan se, om de selv er administrator')) = 15,
         count(*)::text || ' politikker fundet',
         true
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in (select navn from tabeller)

  union all
  select 8, 'Ingen politik giver anonyme adgang til bookinger, lukkedage eller administratorer',
         not exists (
           select 1 from pg_policies p
           where p.schemaname = 'public'
             and p.tablename in ('appointments', 'blocked_dates', 'admin_users')
             and ('anon' = any(p.roles) or 'public' = any(p.roles))
         ),
         null, true

  union all
  select 9, 'Databasen forhindrer overlappende bookinger (appointments_no_overlap)',
         exists (
           select 1 from pg_constraint
           where conname = 'appointments_no_overlap'
             and conrelid = 'public.appointments'::regclass
             and contype = 'x'
         ),
         null, true

  union all
  select 10, 'De offentlige funktioner findes og kan kaldes af besøgende',
         count(*) = 5,
         count(*)::text || ' af 5',
         true
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('get_available_slots', 'get_available_dates', 'create_booking', 'get_booking_receipt', 'is_admin')
    and p.prosecdef
    and has_function_privilege('anon', p.oid, 'execute')

  union all
  select 11, 'Alle funktionerne har fast search_path',
         not exists (
           select 1
           from pg_proc p
           where p.pronamespace in ('public'::regnamespace, 'salon_private'::regnamespace)
             and p.proname in (select navn from funktioner)
             and not exists (
               select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) as cfg
               where cfg like 'search_path=%'
             )
         ),
         null, true

  union all
  select 12, 'Hjælpefunktionerne i salon_private er lukket for besøgende',
         not has_schema_privilege('anon', 'salon_private', 'usage')
         and not has_schema_privilege('authenticated', 'salon_private', 'usage'),
         null, true

  union all
  select 13, 'De fire nye kolonner findes',
         count(*) = 4,
         count(*)::text || ' af 4',
         true
  from information_schema.columns
  where table_schema = 'public'
    and ((table_name = 'services' and column_name = 'price_is_demo')
      or (table_name = 'salon_settings' and column_name in ('booking_window_days', 'about_text', 'is_demo')))

  union all
  select 14, 'Behandlingerne har danske navne',
         not exists (
           select 1 from public.services
           where name in ('Women''s Haircut', 'Men''s Haircut', 'Hair Coloring', 'Blow Dry Styling', 'Hair Treatment')
         ),
         'Der står stadig engelske eksempelnavne', false

  union all
  select 15, 'Saloninformationen er ikke de amerikanske eksempeldata',
         not exists (
           select 1 from public.salon_settings
           where salon_name = 'Luxe Hair Studio' or salon_email = 'hello@luxehair.com'
              or salon_phone = '+1 555 234 7890' or salon_address = '245 Madison Avenue, New York, NY'
         ),
         'Der står stadig amerikanske eksempeldata', false

  union all
  select 16, 'Mindst én administrator er oprettet',
         exists (select 1 from public.admin_users a join auth.users u on u.id = a.user_id),
         'Opret en administrator – se README, trin 4 og 5', false
)
select kontrol, ok, detaljer
from (
  select nr, kontrol, ok, case when ok then '' else coalesce(detaljer, '') end as detaljer
  from checks
  union all
  select 99, 'alt_ok', bool_and(ok) filter (where kritisk),
         'Sand, når alle sikkerhedskontroller (1–13) er bestået'
  from checks
) as resultat
order by nr;
