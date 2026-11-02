-- =====================================================================
--  Efterkontrol for flere frisører – ændrer intet.
--  Kør efter 6-migration-flere-frisoerer.sql. Den sidste række, alt_ok,
--  skal være true. Kontrol 16–20 er oplysninger og tæller ikke med i alt_ok.
-- =====================================================================
with
tabeller(navn) as (
  values ('services'), ('appointments'), ('business_hours'), ('blocked_dates'),
         ('salon_settings'), ('admin_users'), ('staff'), ('staff_services'),
         ('staff_hours'), ('staff_time_off'), ('staff_users')
),
lukkede(navn) as (
  values ('appointments'), ('blocked_dates'), ('admin_users'),
         ('staff_hours'), ('staff_time_off'), ('staff_users')
),
funktioner(navn) as (
  values ('get_available_slots'), ('get_available_dates'), ('create_booking'),
         ('get_booking_receipt'), ('is_admin'), ('my_staff_id'), ('get_my_access'),
         ('admin_staff_logins'), ('link_staff_login'), ('staff_slots'), ('staff_default_hours')
),
politikker(navn) as (
  values ('Alle kan se aktive behandlinger'), ('Administratorer kan oprette behandlinger'),
         ('Administratorer kan rette behandlinger'), ('Alle kan se åbningstider'),
         ('Administratorer kan oprette åbningstider'), ('Administratorer kan rette åbningstider'),
         ('Administratorer kan se lukkedage'), ('Administratorer kan oprette lukkedage'),
         ('Administratorer kan rette lukkedage'), ('Administratorer kan slette lukkedage'),
         ('Alle kan se saloninformation'), ('Administratorer kan rette saloninformation'),
         ('Brugere kan se, om de selv er administrator'),
         ('Administratorer kan se bookinger'), ('Frisører kan se egne bookinger'),
         ('Administratorer kan ændre bookinger'), ('Frisører kan ændre status på egne bookinger'),
         ('Alle kan se aktive frisører'), ('Administratorer kan oprette frisører'),
         ('Administratorer kan rette frisører'),
         ('Alle kan se, hvem der laver hvilke behandlinger'), ('Administratorer kan give frisører behandlinger'),
         ('Administratorer kan fjerne behandlinger fra frisører'),
         ('Administratorer og frisøren selv kan se arbejdstider'), ('Administratorer kan oprette arbejdstider'),
         ('Administratorer kan rette arbejdstider'),
         ('Administratorer og frisøren selv kan se fravær'), ('Administratorer kan oprette fravær'),
         ('Administratorer kan slette fravær'),
         ('Brugere kan se deres egen frisørkobling')
),
checks(nr, kontrol, ok, detaljer, kritisk) as (
  select 1, 'RLS er slået til på alle elleve tabeller',
         count(*) = 11 and bool_and(c.relrowsecurity),
         string_agg(c.relname, ', ') filter (where not c.relrowsecurity),
         true
  from pg_class c
  join tabeller t on t.navn = c.relname
  where c.relnamespace = 'public'::regnamespace

  union all
  select 2, 'Anonyme kan ikke læse bookinger, lukkedage, logins, arbejdstider eller fravær',
         not exists (
           select 1 from lukkede l
           where has_table_privilege('anon', 'public.' || l.navn, 'select')
         ),
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
  select 4, 'Ingen kan skrive i admin_users eller staff_users via API''et',
         not exists (
           select 1
           from unnest(array['public.admin_users', 'public.staff_users']) as t(navn)
           cross join unnest(array['INSERT', 'UPDATE', 'DELETE']) as p(priv)
           where has_table_privilege('anon', t.navn, p.priv)
              or has_table_privilege('authenticated', t.navn, p.priv)
         ),
         null, true

  union all
  select 5, 'Bookinger kan hverken oprettes direkte eller slettes via API''et',
         not (has_table_privilege('authenticated', 'public.appointments', 'insert')
           or has_table_privilege('authenticated', 'public.appointments', 'delete')),
         null, true

  union all
  select 6, 'På bookinger kan kun status og frisør ændres',
         has_column_privilege('authenticated', 'public.appointments', 'status', 'update')
         and has_column_privilege('authenticated', 'public.appointments', 'staff_id', 'update')
         and not has_column_privilege('authenticated', 'public.appointments', 'full_name', 'update')
         and not has_column_privilege('authenticated', 'public.appointments', 'email', 'update')
         and not has_column_privilege('authenticated', 'public.appointments', 'appointment_date', 'update')
         and not has_column_privilege('authenticated', 'public.appointments', 'start_time', 'update'),
         null, true

  union all
  select 7, 'De 30 forventede politikker findes – og ingen andre',
         count(*) = 30 and count(*) filter (where p.policyname in (select navn from politikker)) = 30,
         count(*)::text || ' politikker fundet',
         true
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in (select navn from tabeller)

  union all
  select 8, 'Ingen politik giver anonyme adgang til de lukkede tabeller',
         not exists (
           select 1 from pg_policies p
           where p.schemaname = 'public'
             and p.tablename in (select navn from lukkede)
             and ('anon' = any(p.roles) or 'public' = any(p.roles))
         ),
         null, true

  union all
  select 9, 'Databasen forhindrer dobbeltbooking pr. frisør (appointments_no_overlap_per_staff)',
         exists (
           select 1 from pg_constraint
           where conname = 'appointments_no_overlap_per_staff'
             and conrelid = 'public.appointments'::regclass
             and contype = 'x'
         )
         and not exists (
           select 1 from pg_constraint
           where conname = 'appointments_no_overlap'
             and conrelid = 'public.appointments'::regclass
         ),
         null, true

  union all
  select 10, 'Alle bookinger skal have en frisør (staff_id er NOT NULL)',
         exists (
           select 1 from pg_attribute a
           where a.attrelid = 'public.appointments'::regclass
             and a.attname = 'staff_id'
             and a.attnotnull
         ),
         null, true

  union all
  select 11, 'De offentlige funktioner findes i én udgave og kan kaldes af besøgende',
         count(*) = 6 and bool_and(p.prosecdef) and bool_and(has_function_privilege('anon', p.oid, 'execute')),
         string_agg(p.oid::regprocedure::text, ', '),
         true
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('get_available_slots', 'get_available_dates', 'create_booking', 'get_booking_receipt', 'is_admin', 'get_my_access')

  union all
  select 12, 'Administratorfunktionerne kan ikke kaldes af besøgende',
         to_regprocedure('public.admin_staff_logins()') is not null
         and to_regprocedure('public.link_staff_login(uuid, text)') is not null
         and not has_function_privilege('anon', 'public.admin_staff_logins()', 'execute')
         and not has_function_privilege('anon', 'public.link_staff_login(uuid, text)', 'execute'),
         null, true

  union all
  select 13, 'Alle funktionerne har fast search_path',
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
  select 14, 'Hjælpefunktionerne i salon_private er lukket for besøgende',
         not has_schema_privilege('anon', 'salon_private', 'usage')
         and not has_schema_privilege('authenticated', 'salon_private', 'usage'),
         null, true

  union all
  select 15, 'Udvidelsen btree_gist er installeret',
         exists (select 1 from pg_extension where extname = 'btree_gist'),
         null, true

  union all
  select 16, 'Mindst én aktiv frisør',
         exists (select 1 from public.staff where is_active),
         'Der er ingen aktive frisører – så kan intet bookes', false

  union all
  select 17, 'Alle aktive behandlinger kan bookes hos mindst én aktiv frisør',
         not exists (
           select 1 from public.services s
           where s.is_active
             and not exists (
               select 1 from public.staff_services ss
               join public.staff st on st.id = ss.staff_id and st.is_active
               where ss.service_id = s.id
             )
         ),
         (select string_agg(s.name, ', ') from public.services s
          where s.is_active
            and not exists (
              select 1 from public.staff_services ss
              join public.staff st on st.id = ss.staff_id and st.is_active
              where ss.service_id = s.id
            )),
         false

  union all
  select 18, 'Alle aktive frisører arbejder mindst én dag om ugen',
         not exists (
           select 1 from public.staff st
           where st.is_active
             and not exists (select 1 from public.staff_hours sh where sh.staff_id = st.id and sh.is_working)
         ),
         (select string_agg(st.name, ', ') from public.staff st
          where st.is_active
            and not exists (select 1 from public.staff_hours sh where sh.staff_id = st.id and sh.is_working)),
         false

  union all
  select 19, 'Mindst én administrator er oprettet',
         exists (select 1 from public.admin_users a join auth.users u on u.id = a.user_id),
         'Opret en administrator – se README, trin 4 og 5', false

  union all
  select 20, 'Frisører med eget login',
         true,
         (select count(*)::text from public.staff_users) || ' af ' || (select count(*)::text from public.staff) || ' frisører',
         false
)
select kontrol, ok, detaljer
from (
  select nr, kontrol, ok, case when ok and nr <> 20 then '' else coalesce(detaljer, '') end as detaljer
  from checks
  union all
  select 99, 'alt_ok', bool_and(ok) filter (where kritisk),
         'Sand, når alle sikkerhedskontroller (1–15) er bestået'
  from checks
) as resultat
order by nr;
