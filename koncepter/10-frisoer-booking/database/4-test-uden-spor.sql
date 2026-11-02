-- =====================================================================
--  Test uden spor – kør efter migrationen (helst efter trin 5 i README,
--  så administratoradgangen også bliver testet).
--  Gælder tilstanden efter 2-migration.sql. Efter 6-migration-flere-frisoerer.sql
--  bruges 8-test-flere-frisoerer.sql i stedet.
--
--  Hele testen er én blok, der til sidst fejler med vilje. Derfor ruller
--  Postgres ALT tilbage: testbehandlinger, testbookinger og midlertidige
--  ændringer af indstillinger forsvinder igen. Intet bliver gemt.
--
--  Forventet resultat: en (rød) fejlbesked, der begynder med "TEST OK".
--  Begynder den med "TEST FEJL", står det i beskeden, hvad der fejlede.
-- =====================================================================
do $test$
declare
  v_svc      uuid;
  v_svc_off  uuid;
  v_date     date;
  v_wd       integer;
  v_now      timestamptz;
  v_cnt      integer;
  v_txt      text;
  v_res      jsonb;
  v_id       uuid;
  v_pub_id   uuid;
  v_block_id uuid;
  v_admin    uuid;
  v_user     uuid := gen_random_uuid();
  v_state    text;
  v_rows     integer;
  v_hint     text;
  v_pass     integer;
  v_failed   integer;
  v_msgs     text;
  v_note     text := '';
begin
  create temp table _test (nr serial, ok boolean not null, besked text not null);

  -- ---------- Opsætning (rulles tilbage) ----------
  update public.salon_settings
  set slot_interval_minutes = 30, booking_notice_hours = 2, booking_window_days = 365;

  -- En testdag om ca. 300 dage uden bookinger og lukkedage.
  v_date := (now() at time zone 'Europe/Copenhagen')::date + 300;
  while exists (select 1 from public.appointments a where a.appointment_date = v_date and a.status is distinct from 'cancelled')
     or exists (select 1 from public.blocked_dates b where b.blocked_date = v_date) loop
    v_date := v_date + 1;
  end loop;
  v_wd := extract(dow from v_date)::int;

  update public.business_hours set is_open = false where weekday = v_wd;
  update public.business_hours set is_open = true, start_time = '09:00', end_time = '17:00'
  where id = (select bh.id from public.business_hours bh where bh.weekday = v_wd order by bh.start_time nulls last limit 1);
  if not found then
    insert into public.business_hours (weekday, is_open, start_time, end_time) values (v_wd, true, '09:00', '17:00');
  end if;

  insert into public.services (name, description, duration_minutes, price, is_active)
  values ('TEST – rulles tilbage', 'Midlertidig testbehandling', 60, 1, true)
  returning id into v_svc;

  insert into public.services (name, description, duration_minutes, price, is_active)
  values ('TEST inaktiv – rulles tilbage', null, 30, 1, false)
  returning id into v_svc_off;

  -- Fast "nu": dagen før testdagen kl. 12.00 dansk tid.
  v_now := ((v_date - 1) + time '12:00') at time zone 'Europe/Copenhagen';

  -- ---------- Bookingregler ----------
  select count(*) into v_cnt from salon_private.free_slots(v_svc, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 15, format('Åbent 9–17, 60 min, interval 30: forventede 15 tider, fik %s', v_cnt));

  select string_agg(f.slot_start::text || '-' || f.slot_end::text, ',') into v_txt
  from (select * from salon_private.free_slots(v_svc, v_date, v_now) order by 1 desc limit 1) f;
  insert into _test(ok, besked) values (v_txt = '16:00:00-17:00:00', format('Sidste tid skal slutte ved lukketid, fik %s', v_txt));

  v_res := salon_private.create_booking(v_svc, v_date, '10:00', 'Test Testesen', 'test-a@example.com', '+45 10 20 30 40', null, v_now);
  v_id := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_res->>'status' = 'pending' and v_res->>'end_time' = '11:00:00',
    format('Booking 10.00 skal være pending og slutte 11.00, fik %s', v_res));

  select count(*) into v_cnt from salon_private.free_slots(v_svc, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 12, format('Efter booking 10.00–11.00: forventede 12 tider, fik %s', v_cnt));

  begin
    perform salon_private.create_booking(v_svc, v_date, '10:00', 'Test Igen', 'test-b@example.com', '+45 10 20 30 41', null, v_now);
    insert into _test(ok, besked) values (false, 'Samme tid kunne bookes to gange');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into _test(ok, besked) values (v_hint = 'slot_unavailable', format('Dobbeltbooking skulle afvises med slot_unavailable, fik %s', v_hint));
  end;

  begin
    insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status)
    values (v_svc, 'Direkte', 'test-c@example.com', '+45 10 20 30 42', v_date, '10:30', '11:30', 'pending');
    insert into _test(ok, besked) values (false, 'Databasen tillod en overlappende række');
  exception when exclusion_violation then
    insert into _test(ok, besked) values (true, 'Databasen afviser overlap');
  end;

  update public.appointments set status = 'cancelled' where id = v_id;
  select count(*) into v_cnt from salon_private.free_slots(v_svc, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 15, format('Aflyst booking skal frigive tiden: forventede 15, fik %s', v_cnt));

  select min(f.slot_start)::text into v_txt
  from salon_private.free_slots(v_svc, v_date, (v_date + time '09:10') at time zone 'Europe/Copenhagen') f;
  insert into _test(ok, besked) values (v_txt = '11:30:00', format('Varsling 2 timer kl. 9.10: første tid skal være 11.30, fik %s', v_txt));

  update public.salon_settings set slot_interval_minutes = 15;
  select count(*) into v_cnt from salon_private.free_slots(v_svc, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 29, format('Interval 15: forventede 29 tider, fik %s', v_cnt));
  update public.salon_settings set slot_interval_minutes = 30;

  insert into public.blocked_dates (blocked_date, reason) values (v_date, 'TEST') returning id into v_block_id;
  select count(*) into v_cnt from salon_private.free_slots(v_svc, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 0, format('Blokeret dato: forventede 0 tider, fik %s', v_cnt));
  delete from public.blocked_dates where id = v_block_id;

  select count(*) into v_cnt from salon_private.free_slots(v_svc_off, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 0, format('Inaktiv behandling: forventede 0 tider, fik %s', v_cnt));

  begin
    perform salon_private.create_booking(v_svc, v_date, '10:15', 'Test Skæv', 'test-d@example.com', '+45 10 20 30 43', null, v_now);
    insert into _test(ok, besked) values (false, 'Tid uden for intervallet blev accepteret');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into _test(ok, besked) values (v_hint = 'slot_unavailable', format('Tid uden for interval: forventede slot_unavailable, fik %s', v_hint));
  end;

  begin
    perform salon_private.create_booking(v_svc, v_date, '12:00', 'Test Mail', 'ikke-en-mail', '+45 10 20 30 44', null, v_now);
    insert into _test(ok, besked) values (false, 'Ugyldig e-mail blev accepteret');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into _test(ok, besked) values (v_hint = 'invalid_email', format('Ugyldig e-mail: forventede invalid_email, fik %s', v_hint));
  end;

  -- ---------- Anonym besøgende ----------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  begin
    perform 1 from public.appointments limit 1;
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist', 'Anonyme skal ikke kunne læse bookinger');

  perform set_config('role', 'anon', true);
  begin
    insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time)
    values (v_svc, 'Anon', 'anon@example.com', '12345678', v_date, '15:00', '16:00');
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist', 'Anonyme skal ikke kunne oprette bookinger uden om reglerne');

  perform set_config('role', 'anon', true);
  begin
    insert into public.admin_users (user_id) values (v_user);
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist', 'Anonyme skal ikke kunne gøre sig til administrator');

  perform set_config('role', 'anon', true);
  begin
    update public.services set price = 0 where id = v_svc;
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist', 'Anonyme skal ikke kunne rette priser');

  perform set_config('role', 'anon', true);
  select count(*) into v_cnt from public.get_available_slots(v_svc, v_date);
  v_res := public.create_booking(v_svc, v_date, '13:00', 'Anne Anonym', 'test-e@example.com', '+45 10 20 30 45', 'Test');
  perform set_config('role', 'none', true);
  v_pub_id := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_cnt = 15, format('Anonyme skal kunne se ledige tider: forventede 15, fik %s', v_cnt));
  insert into _test(ok, besked) values (v_res->>'status' = 'pending', format('Anonyme skal kunne booke via create_booking: fik %s', v_res));

  perform set_config('role', 'anon', true);
  v_res := public.get_booking_receipt(v_pub_id);
  begin
    perform public.create_booking(v_svc, v_date, '13:00', 'Bo Anonym', 'test-f@example.com', '+45 10 20 30 46');
    v_hint := 'tilladt';
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_res->>'status' = 'pending' and not (v_res ? 'email') and not (v_res ? 'full_name') and not (v_res ? 'phone'),
    format('Kvittering skal vise status uden personoplysninger: fik %s', v_res));
  insert into _test(ok, besked) values (v_hint = 'slot_unavailable', format('Anonym dobbeltbooking skulle afvises, fik %s', v_hint));

  -- ---------- Indlogget bruger uden administratorrettigheder ----------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.appointments;
  update public.appointments set status = 'cancelled' where id = v_pub_id;
  get diagnostics v_rows = row_count;
  begin
    insert into public.admin_users (user_id) values (v_user);
    v_txt := 'tilladt';
  exception when insufficient_privilege then
    v_txt := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_cnt = 0, format('Almindelig bruger skal ikke se bookinger: så %s', v_cnt));
  insert into _test(ok, besked) values (v_rows = 0, format('Almindelig bruger skal ikke kunne ændre status: ændrede %s', v_rows));
  insert into _test(ok, besked) values (v_txt = 'afvist', 'Almindelig bruger skal ikke kunne gøre sig til administrator');

  -- ---------- Administrator (hvis oprettet) ----------
  select a.user_id into v_admin
  from public.admin_users a
  join auth.users u on u.id = a.user_id
  limit 1;

  if v_admin is null then
    v_note := ' Administratoradgang er ikke testet, fordi der endnu ikke er oprettet en administrator.';
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_txt := public.is_admin()::text;
    select count(*) into v_cnt from public.appointments where id = v_pub_id;
    update public.appointments set status = 'confirmed' where id = v_pub_id;
    get diagnostics v_rows = row_count;
    begin
      update public.appointments set full_name = 'Ændret' where id = v_pub_id;
      v_hint := 'tilladt';
    exception when insufficient_privilege then
      v_hint := 'afvist';
    end;
    perform set_config('role', 'none', true);
    insert into _test(ok, besked) values (v_txt = 'true', 'Administrator skal genkendes af is_admin()');
    insert into _test(ok, besked) values (v_cnt = 1, 'Administrator skal kunne se bookinger');
    insert into _test(ok, besked) values (v_rows = 1, 'Administrator skal kunne ændre status');
    insert into _test(ok, besked) values (v_hint = 'afvist', 'Administrator skal ikke kunne ændre kundens oplysninger');
    v_res := public.get_booking_receipt(v_pub_id);
    insert into _test(ok, besked) values (v_res->>'status' = 'confirmed', 'Kvitteringen skal vise den nye status');
  end if;

  -- ---------- Resultat (og tilbagerulning) ----------
  perform set_config('role', 'none', true);
  select count(*) filter (where ok), count(*) filter (where not ok),
         string_agg(besked, ' | ' order by nr) filter (where not ok)
    into v_pass, v_failed, v_msgs
  from _test;

  if v_failed = 0 then
    raise exception 'TEST OK: alle % kontroller bestået.% Alt er rullet tilbage – intet er gemt.', v_pass, v_note;
  else
    raise exception 'TEST FEJL: % af % kontroller fejlede: %. Alt er rullet tilbage – intet er gemt.', v_failed, v_pass + v_failed, v_msgs;
  end if;
end
$test$;
