-- =====================================================================
--  Test uden spor for forbindelsen til Vanta Platform – kør efter
--  10-forbindelse-til-platform.sql (helst når der er oprettet en
--  administrator, så administratorfunktionerne også bliver testet).
--
--  Hele testen er én blok, der til sidst fejler med vilje. Derfor ruller
--  Postgres ALT tilbage: testbookinger, testnøgle, indstillinger og kald.
--  Der sendes intet: kaldene er adresseret til https://platform.invalid,
--  som ikke findes, og pg_net sender først, når en transaktion er gemt –
--  det bliver denne aldrig.
--
--  Forventet resultat: en (rød) fejlbesked, der begynder med "TEST OK".
--  Begynder den med "TEST FEJL", står det i beskeden, hvad der fejlede.
-- =====================================================================
do $test$
declare
  v_svc     uuid;
  v_staff   uuid;
  v_appt    uuid;
  v_past    uuid;
  v_future  uuid;
  v_date    date := make_date(extract(year from now())::int + 2, 1, 15); -- vintertid
  v_today   date := (now() at time zone 'Europe/Copenhagen')::date;
  v_key     text := 'vk_live_TEST' || replace(gen_random_uuid()::text, '-', '');
  v_admin   uuid;
  v_res     jsonb;
  v_payload jsonb;
  v_sync    record;
  v_req     record;
  v_out     text;
  v_hint    text;
  v_hint2   text;
  v_state   text;
  v_cnt     integer;
  v_bool    boolean;
  v_pass    integer;
  v_failed  integer;
  v_msgs    text;
  v_note    text := '';
begin
  create temp table _test (nr serial, ok boolean not null, besked text not null);

  -- ---------- Opsætning (rulles tilbage) ----------
  update salon_private.platform_settings set enabled = false, auto_complete = false where id;

  insert into public.services (name, description, duration_minutes, price, is_active)
  values ('TEST – rulles tilbage', null, 60, 450, true)
  returning id into v_svc;
  insert into public.staff (name, sort_order) values ('TEST Platform', 999) returning id into v_staff;

  insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time, status, notes)
  values (v_svc, v_staff, 'Test  Kunde Testesen', 'TEST.Kunde@Example.com', '+45 12 34 56 78', v_date, '10:00', '11:00', 'pending', 'HEMMELIG-BEMAERKNING')
  returning id into v_appt;
  insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time, status)
  values (v_svc, v_staff, 'Test Tidligere', 'tidligere@example.invalid', '12345678', v_today - 2, '10:00', '11:00', 'confirmed')
  returning id into v_past;
  insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time, status)
  values (v_svc, v_staff, 'Test Senere', 'senere@example.invalid', '12345678', v_date, '12:00', '13:00', 'confirmed')
  returning id into v_future;

  -- ---------- Installation ----------
  select count(*) into v_cnt from cron.job j
  where j.jobname = 'vanta-platform-sync' and j.active and j.schedule = '* * * * *' and j.command like '%platform_sync_run%';
  insert into _test(ok, besked) values (v_cnt = 1, format('Der skal være ét aktivt job, der kører hvert minut: fandt %s', v_cnt));
  select count(*) into v_cnt from pg_trigger t
  where t.tgrelid = 'public.appointments'::regclass and t.tgname = 'platform_mark_changed' and t.tgenabled = 'O';
  insert into _test(ok, besked) values (v_cnt = 1, 'Triggeren platform_mark_changed skal findes på appointments');

  -- ---------- Slået fra: intet i kø ----------
  select count(*) into v_cnt from salon_private.platform_sync where appointment_id in (v_appt, v_past, v_future);
  insert into _test(ok, besked) values (v_cnt = 0, format('Når forbindelsen er slået fra, må intet sættes i kø: fandt %s', v_cnt));
  insert into _test(ok, besked) values (public.platform_link_enabled() = false, 'platform_link_enabled skal være falsk, når forbindelsen er slået fra');

  -- ---------- Hvad der sendes ----------
  v_payload := salon_private.platform_payload(v_appt);
  insert into _test(ok, besked) values (v_payload #>> '{items,0,external_id}' = v_appt::text, 'external_id skal være bookingens id');
  insert into _test(ok, besked) values (v_payload #>> '{items,0,starts_at}' = to_char(v_date, 'YYYY-MM-DD') || 'T09:00:00Z'
    and v_payload #>> '{items,0,ends_at}' = to_char(v_date, 'YYYY-MM-DD') || 'T10:00:00Z',
    format('Kl. 10–11 dansk vintertid skal sendes som 09–10 UTC, fik %s–%s', v_payload #>> '{items,0,starts_at}', v_payload #>> '{items,0,ends_at}'));
  insert into _test(ok, besked) values (v_payload #>> '{items,0,status}' = 'booked', 'En afventende booking skal sendes som booked');
  insert into _test(ok, besked) values (v_payload #>> '{items,0,customer,first_name}' = 'Test'
    and v_payload #>> '{items,0,customer,last_name}' = 'Kunde Testesen'
    and v_payload #>> '{items,0,customer,email}' = 'test.kunde@example.com'
    and v_payload #>> '{items,0,customer,phone}' = '+45 12 34 56 78',
    format('Kundens navn, e-mail og telefon skal sendes korrekt, fik %s', v_payload -> 'items' -> 0 -> 'customer'));
  insert into _test(ok, besked) values ((v_payload #>> '{items,0,price_amount}')::numeric = 450
    and v_payload #>> '{items,0,currency}' = 'DKK'
    and v_payload #>> '{items,0,service_name}' = 'TEST – rulles tilbage'
    and v_payload #>> '{items,0,staff_name}' = 'TEST Platform',
    'Behandling, frisør og pris skal sendes');
  insert into _test(ok, besked) values (position('HEMMELIG' in v_payload::text) = 0, 'Kundens bemærkning må ikke sendes');

  -- ---------- Rettigheder ----------
  insert into _test(ok, besked) values (
    not has_schema_privilege('anon', 'salon_private', 'usage')
    and not has_schema_privilege('authenticated', 'salon_private', 'usage')
    and not has_table_privilege('authenticated', 'salon_private.platform_settings', 'select')
    and not has_table_privilege('authenticated', 'salon_private.platform_sync', 'select'),
    'Indstillinger og kø skal være lukket for besøgende og indloggede');
  insert into _test(ok, besked) values (
    not has_function_privilege('anon', 'public.get_platform_link()', 'execute')
    and not has_function_privilege('anon', 'public.save_platform_link(boolean, text, text, boolean)', 'execute')
    and not has_function_privilege('anon', 'public.resend_platform_sync()', 'execute')
    and has_function_privilege('anon', 'public.platform_link_enabled()', 'execute'),
    'Besøgende må kun kunne kalde platform_link_enabled');
  insert into _test(ok, besked) values (
    not has_function_privilege('authenticated', 'salon_private.platform_sync_run(integer)', 'execute')
    and not has_function_privilege('authenticated', 'salon_private.platform_payload(uuid)', 'execute'),
    'Jobbet og hjælpefunktionerne må ikke kunne kaldes udefra');
  insert into _test(ok, besked) values (
    not has_table_privilege('anon', 'vault.decrypted_secrets', 'select')
    and not has_table_privilege('authenticated', 'vault.decrypted_secrets', 'select'),
    'Nøglerne i Vault må ikke kunne læses af besøgende og indloggede');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform public.get_platform_link();
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  begin
    perform public.save_platform_link(true, 'https://platform.invalid', v_key, false);
    v_out := 'tilladt';
  exception when insufficient_privilege then
    v_out := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist', 'En bruger uden rolle må ikke se forbindelsen');
  insert into _test(ok, besked) values (v_out = 'afvist', 'En bruger uden rolle må ikke ændre forbindelsen');

  -- ---------- Slå forbindelsen til ----------
  select a.user_id into v_admin
  from public.admin_users a
  join auth.users u on u.id = a.user_id
  limit 1;

  if v_admin is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    begin
      perform public.save_platform_link(true, 'http://platform.invalid', v_key, false);
    exception when others then
      get stacked diagnostics v_hint = pg_exception_hint;
    end;
    begin
      perform public.save_platform_link(true, 'https://platform.invalid', 'forkert-nøgle', false);
    exception when others then
      get stacked diagnostics v_hint2 = pg_exception_hint;
    end;
    v_res := public.save_platform_link(true, 'https://platform.invalid/', v_key, false);
    perform set_config('role', 'none', true);
    insert into _test(ok, besked) values (v_hint = 'invalid_platform_url', format('Adresser uden https skal afvises, fik %s', v_hint));
    insert into _test(ok, besked) values (v_hint2 = 'invalid_api_key', format('En forkert nøgle skal afvises, fik %s', v_hint2));
    insert into _test(ok, besked) values ((v_res->>'enabled')::boolean and v_res->>'api_url' = 'https://platform.invalid'
      and (v_res->>'has_key')::boolean and v_res->>'key_prefix' = left(v_key, 14),
      format('Administrator skal kunne slå forbindelsen til, fik %s', v_res));
    insert into _test(ok, besked) values (position(v_key in v_res::text) = 0, 'API-nøglen må aldrig sendes tilbage til browseren');
  else
    v_note := v_note || ' Administratorfunktionerne er ikke testet, fordi der endnu ikke er oprettet en administrator.';
    update salon_private.platform_settings
    set enabled = true, api_url = 'https://platform.invalid', generation = generation + 1,
        api_key_id = vault.create_secret(v_key, 'vanta_platform_api_key_test', 'Test – rulles tilbage'),
        api_key_prefix = left(v_key, 14)
    where id;
    perform salon_private.platform_queue_all();
  end if;

  select count(*) into v_cnt
  from vault.decrypted_secrets ds
  join salon_private.platform_settings s on s.api_key_id = ds.id
  where ds.decrypted_secret = v_key;
  insert into _test(ok, besked) values (v_cnt = 1, 'API-nøglen skal ligge i Vault');
  insert into _test(ok, besked) values (public.platform_link_enabled(), 'platform_link_enabled skal være sand, når forbindelsen er slået til');
  select count(*) into v_cnt from salon_private.platform_sync where appointment_id in (v_appt, v_past, v_future) and pending;
  insert into _test(ok, besked) values (v_cnt = 3, format('Når forbindelsen slås til, skal alle bookinger i kø: %s af 3', v_cnt));

  -- Kun testbookingen sendes i resten af testen
  update salon_private.platform_sync set pending = false where appointment_id <> v_appt;

  -- ---------- Afsendelse ----------
  v_res := salon_private.platform_sync_run();
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  insert into _test(ok, besked) values ((v_res->>'sent')::int = 1 and v_sync.request_id is not null
    and v_sync.request_key like 'vb-%-' || v_appt::text || '-%',
    format('Jobbet skal sende testbookingen, fik %s', v_res));
  begin
    select q.url, q.headers into v_req from net.http_request_queue q where q.id = v_sync.request_id;
    insert into _test(ok, besked) values (v_req.url = 'https://platform.invalid/api/v1/appointments'
      and v_req.headers->>'Authorization' = 'Bearer ' || v_key
      and v_req.headers->>'Idempotency-Key' = v_sync.request_key
      and v_req.headers->>'X-Vanta-Source' = 'vanta_booking',
      'Kaldet skal have adresse, nøgle, Idempotency-Key og kilde');
  exception when others then
    v_note := v_note || ' Kaldets headere er ikke kontrolleret, fordi pg_net-køen ikke kunne læses.';
  end;

  v_out := salon_private.platform_apply_response(v_appt, v_sync.request_id, 200, '{"data":{"received":1,"created":1}}', false, null);
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  insert into _test(ok, besked) values (v_out = 'synced' and not v_sync.pending and v_sync.synced_key is not null,
    format('Et 200-svar skal markere bookingen som sendt, fik %s', v_out));
  insert into _test(ok, besked) values ((select s.last_success_at is not null and s.last_error is null from salon_private.platform_settings s where s.id),
    'Sidst sendt skal opdateres');

  v_res := salon_private.platform_sync_run();
  insert into _test(ok, besked) values (coalesce((v_res->>'sent')::int, 0) = 0, 'En sendt booking må ikke sendes igen uden ændringer');

  -- Afventer → bekræftet giver samme data (booked): intet kald
  update public.appointments set status = 'confirmed' where id = v_appt;
  select pending into v_bool from salon_private.platform_sync where appointment_id = v_appt;
  v_res := salon_private.platform_sync_run();
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  insert into _test(ok, besked) values (v_bool and not v_sync.pending and v_sync.request_id is null,
    'En ændring skal sætte bookingen i kø; uændrede data skal ikke sendes igen');

  -- Gennemført → nyt kald; platformen afviser nøglen
  update public.appointments set status = 'completed' where id = v_appt;
  v_res := salon_private.platform_sync_run();
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  v_out := salon_private.platform_apply_response(v_appt, v_sync.request_id, 401, '{"error":{"code":"unauthorized","message":"Invalid or revoked API key"}}', false, null);
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  insert into _test(ok, besked) values (v_out = 'retry' and v_sync.pending and v_sync.next_attempt_at > now(),
    format('Ved 401 skal bookingen prøves igen senere, fik %s', v_out));
  insert into _test(ok, besked) values ((select s.last_error like '%API-nøglen%' from salon_private.platform_settings s where s.id),
    'Ved 401 skal administrationen vise, at nøglen blev afvist');

  -- Platformen afviser bookingens data
  update salon_private.platform_sync set next_attempt_at = now() where appointment_id = v_appt;
  v_res := salon_private.platform_sync_run();
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  v_out := salon_private.platform_apply_response(v_appt, v_sync.request_id, 422,
    '{"error":{"code":"validation_failed","message":"The payload is invalid","issues":[{"path":"items.0.customer.phone","message":"invalid phone number"}]}}', false, null);
  select * into v_sync from salon_private.platform_sync where appointment_id = v_appt;
  insert into _test(ok, besked) values (v_out = 'failed' and v_sync.failed and not v_sync.pending and v_sync.last_error like '%telefonnummeret%',
    format('Ved 422 skal bookingen vises som afvist med årsag, fik %s / %s', v_out, v_sync.last_error));

  if v_admin is not null then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_res := public.get_platform_link();
    perform set_config('role', 'none', true);
    insert into _test(ok, besked) values ((v_res->>'failed')::int >= 1
      and exists (select 1 from jsonb_array_elements(v_res->'failures') f where f->>'reference' = upper(left(v_appt::text, 8))),
      'Administrationen skal vise den afviste booking');
  end if;

  -- ---------- Gennemførte besøg ----------
  update salon_private.platform_settings set auto_complete = true where id;
  v_res := salon_private.platform_sync_run();
  insert into _test(ok, besked) values ((select status from public.appointments where id = v_past) = 'completed',
    'En bekræftet booking, hvis tid er gået, skal markeres som gennemført');
  insert into _test(ok, besked) values ((select status from public.appointments where id = v_future) = 'confirmed',
    'En bekræftet booking i fremtiden må ikke markeres som gennemført');
  insert into _test(ok, besked) values ((select pending from salon_private.platform_sync where appointment_id = v_past),
    'Den gennemførte booking skal sættes i kø til platformen');

  -- ---------- Resultat (og tilbagerulning) ----------
  perform set_config('role', 'none', true);
  select count(*) filter (where ok), count(*) filter (where not ok),
         string_agg(besked, ' | ' order by nr) filter (where not ok)
    into v_pass, v_failed, v_msgs
  from _test;

  if v_failed = 0 then
    raise exception 'TEST OK: alle % kontroller bestået.% Alt er rullet tilbage – intet er gemt eller sendt.', v_pass, v_note;
  else
    raise exception 'TEST FEJL: % af % kontroller fejlede: %. Alt er rullet tilbage – intet er gemt eller sendt.', v_failed, v_pass + v_failed, v_msgs;
  end if;
end
$test$;
