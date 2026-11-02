-- =====================================================================
--  Forhåndskontrol – ændrer intet.
--  Kør i Supabase → SQL Editor før migrationen, og gem resultatet
--  (fx "Export → CSV"). Viser RLS, politikker, rettigheder, regler,
--  funktioner, antal rækker og eventuelle overlappende aftaler.
-- =====================================================================
with tabeller(navn) as (
  values ('services'), ('appointments'), ('business_hours'),
         ('blocked_dates'), ('salon_settings'), ('admin_users')
),
aktive as (
  select a.*
  from public.appointments a
  where a.status is distinct from 'cancelled'
    and a.appointment_date is not null and a.start_time is not null and a.end_time is not null
)
select 1 as nr, 'Tabel' as omraade, t.navn::text as navn,
       case when c.relrowsecurity then 'RLS slået til' else 'RLS SLÅET FRA – alle med adgang til tabellen ser alle rækker' end as detaljer
from tabeller t
join pg_class c on c.relname = t.navn and c.relnamespace = 'public'::regnamespace

union all
select 2, 'Rækker', 'services', (select count(*) from public.services)::text
union all
select 2, 'Rækker', 'appointments', (select count(*) from public.appointments)::text
union all
select 2, 'Rækker', 'business_hours', (select count(*) from public.business_hours)::text
union all
select 2, 'Rækker', 'blocked_dates', (select count(*) from public.blocked_dates)::text
union all
select 2, 'Rækker', 'salon_settings', (select count(*) from public.salon_settings)::text
union all
select 2, 'Rækker', 'admin_users', (select count(*) from public.admin_users)::text

union all
select 3, 'Politik', p.tablename || ': ' || p.policyname,
       p.cmd || ' for ' || array_to_string(p.roles, ', ')
       || coalesce(' · using (' || p.qual || ')', '')
       || coalesce(' · with check (' || p.with_check || ')', '')
from pg_policies p
where p.schemaname = 'public'
  and p.tablename in (select navn from tabeller)

union all
select 4, 'Rettighed', g.table_name || ' → ' || g.grantee,
       string_agg(g.privilege_type, ', ' order by g.privilege_type)
from information_schema.role_table_grants g
where g.table_schema = 'public'
  and g.table_name in (select navn from tabeller)
  and g.grantee in ('anon', 'authenticated', 'PUBLIC')
group by g.table_name, g.grantee

union all
select 5, 'Regel', c.conrelid::regclass::text || ': ' || c.conname, pg_get_constraintdef(c.oid)
from pg_constraint c
where c.contype <> 'n'
  and c.conrelid in (
    select ('public.' || navn)::regclass from tabeller
  )

union all
select 6, 'Funktion', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       case when p.prosecdef then 'security definer' else 'security invoker' end
from pg_proc p
where p.pronamespace = 'public'::regnamespace

union all
select 7, 'Trigger', tg.tgrelid::regclass::text || ': ' || tg.tgname, pg_get_triggerdef(tg.oid)
from pg_trigger tg
where not tg.tgisinternal
  and tg.tgrelid in (select ('public.' || navn)::regclass from tabeller)

union all
select 8, 'Overlap', 'Aktive aftaler, der slutter før de starter',
       count(*)::text || case when count(*) > 0 then ' – migrationen stopper; ret eller aflys dem først' else ' – ok' end
from aktive a
where a.end_time < a.start_time

union all
select 8, 'Overlap', 'Aktive aftaler, der overlapper hinanden',
       count(*)::text || case when count(*) > 0 then ' – migrationen stopper; aflys eller flyt den ene først' else ' – ok' end
from aktive a
join aktive b
  on a.id < b.id
 and a.end_time >= a.start_time
 and b.end_time >= b.start_time
 and tsrange(a.appointment_date + a.start_time, a.appointment_date + a.end_time, '[)')
     && tsrange(b.appointment_date + b.start_time, b.appointment_date + b.end_time, '[)')

union all
select 9, 'Administratorer', 'admin_users',
       count(*)::text || ' række(r), heraf ' || count(u.id) || ' knyttet til en eksisterende bruger'
from public.admin_users a
left join auth.users u on u.id = a.user_id

union all
select 10, 'Eksempeldata', 'Engelske eksempelbehandlinger',
       count(*)::text
from public.services
where name in ('Women''s Haircut', 'Men''s Haircut', 'Hair Coloring', 'Blow Dry Styling', 'Hair Treatment')

union all
select 10, 'Eksempeldata', 'Amerikanske saloninformationer',
       count(*)::text
from public.salon_settings
where salon_name = 'Luxe Hair Studio' or salon_email = 'hello@luxehair.com'
   or salon_phone = '+1 555 234 7890' or salon_address = '245 Madison Avenue, New York, NY'

order by 1, 3;
