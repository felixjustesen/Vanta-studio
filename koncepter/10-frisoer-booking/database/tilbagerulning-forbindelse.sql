-- =====================================================================
--  Fjern forbindelsen til Vanta Platform (fortryder 10-forbindelse-til-platform.sql)
--
--  Stopper jobbet, fjerner triggeren, funktionerne og de to tabeller i
--  salon_private og sletter API-nøglen i Vault. Bookinger, frisører,
--  behandlinger og alt andet røres ikke. Det, der allerede er sendt til
--  Vanta Platform, bliver liggende dér.
--
--  Kør hele filen i Supabase → SQL Editor. Kan køres igen uden skade.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('cron.job') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'vanta-platform-sync';
  end if;
end $$;

drop trigger if exists platform_mark_changed on public.appointments;

do $$
begin
  if to_regclass('vault.secrets') is not null then
    begin
      delete from vault.secrets where name = 'vanta_platform_api_key';
    exception when others then
      raise notice 'API-nøglen kunne ikke slettes automatisk. Slet "vanta_platform_api_key" under Project Settings → Vault.';
    end;
  end if;
end $$;

drop function if exists public.get_platform_link();
drop function if exists public.save_platform_link(boolean, text, text, boolean);
drop function if exists public.resend_platform_sync();
drop function if exists public.platform_link_enabled();
drop function if exists salon_private.platform_sync_run(integer);
drop function if exists salon_private.platform_apply_response(uuid, bigint, integer, text, boolean, text);
drop function if exists salon_private.platform_queue_all();
drop function if exists salon_private.platform_mark_changed();
drop function if exists salon_private.platform_payload_problem(jsonb);
drop function if exists salon_private.platform_payload(uuid);

drop table if exists salon_private.platform_sync;
drop table if exists salon_private.platform_settings;

notify pgrst, 'reload schema';

commit;

select 'Forbindelsen til Vanta Platform er fjernet. Bookingerne er urørte.' as status;
