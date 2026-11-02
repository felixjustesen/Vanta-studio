-- =====================================================================
--  Gør en bruger til administrator.
--
--  1. Opret først brugeren i Supabase: Authentication → Users → Add user
--     → Create new user. Brug en stærk adgangskode, og sæt flueben i
--     "Auto Confirm User".
--  2. Skriv brugerens e-mail i linjen herunder, og kør filen.
--  Resultatet viser alle administratorer.
-- =====================================================================
do $$
declare
  v_email text := 'SKRIV-E-MAIL-HER';
  v_id    uuid;
begin
  select u.id into v_id from auth.users u where lower(u.email) = lower(btrim(v_email));
  if v_id is null then
    raise exception 'Der findes ingen bruger med e-mailen %. Opret brugeren under Authentication → Users først.', v_email;
  end if;
  insert into public.admin_users (user_id)
  select v_id
  where not exists (select 1 from public.admin_users a where a.user_id = v_id);
end $$;

select u.email, a.created_at as administrator_siden
from public.admin_users a
join auth.users u on u.id = a.user_id
order by a.created_at;

-- Fjern en administrator igen (brugeren kan stadig logge ind, men ser intet):
-- delete from public.admin_users where user_id = (select id from auth.users where email = 'navn@eksempel.dk');
