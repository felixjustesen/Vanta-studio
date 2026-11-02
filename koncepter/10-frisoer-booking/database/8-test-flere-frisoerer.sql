-- =====================================================================
--  Test uden spor for flere frisører – kør efter 6-migration-flere-frisoerer.sql
--  (helst når der er oprettet en administrator, så administratoradgangen
--  også bliver testet).
--
--  Hele testen er én blok, der til sidst fejler med vilje. Derfor ruller
--  Postgres ALT tilbage: testfrisører, testbehandlinger, testbookinger,
--  testbruger og midlertidige ændringer af indstillinger forsvinder igen.
--
--  Forventet resultat: en (rød) fejlbesked, der begynder med "TEST OK".
--  Begynder den med "TEST FEJL", står det i beskeden, hvad der fejlede.
-- =====================================================================
do $test$
declare
  v_svc      uuid;
  v_svc_off  uuid;
  v_a        uuid;
  v_b        uuid;
  v_c        uuid;
  v_d        uuid;
  v_date     date;
  v_wd       integer;
  v_now      timestamptz;
  v_cnt      integer;
  v_cnt2     integer;
  v_rows     integer;
  v_rows2    integer;
  v_txt      text;
  v_res      jsonb;
  v_id_a     uuid;
  v_id_b     uuid;
  v_id_m     uuid;
  v_id_15    uuid;
  v_pub_id   uuid;
  v_block_id uuid;
  v_admin    uuid;
  v_user     uuid := gen_random_uuid();
  v_login    uuid := gen_random_uuid();
  v_login_ok boolean := false;
  v_email    text;
  v_state    text;
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

  -- A arbejder hele dagen, B fra kl. 12, C laver ikke behandlingen, D er inaktiv.
  insert into public.staff (name, sort_order) values ('TEST A', 901) returning id into v_a;
  insert into public.staff (name, sort_order) values ('TEST B', 902) returning id into v_b;
  insert into public.staff (name, sort_order) values ('TEST C', 903) returning id into v_c;
  insert into public.staff (name, sort_order, is_active) values ('TEST D', 904, false) returning id into v_d;

  update public.staff_hours set is_working = true, start_time = '09:00', end_time = '17:00'
  where staff_id in (v_a, v_c, v_d) and weekday = v_wd;
  update public.staff_hours set is_working = true, start_time = '12:00', end_time = '17:00'
  where staff_id = v_b and weekday = v_wd;

  insert into public.staff_services (staff_id, service_id)
  values (v_a, v_svc), (v_b, v_svc), (v_d, v_svc), (v_a, v_svc_off), (v_b, v_svc_off);

  -- Fast "nu": dagen før testdagen kl. 12.00 dansk tid.
  v_now := ((v_date - 1) + time '12:00') at time zone 'Europe/Copenhagen';

  -- ---------- Bookingregler pr. frisør ----------
  select count(*) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now, v_a);
  insert into _test(ok, besked) values (v_cnt = 15, format('A (9–17, 60 min, interval 30): forventede 15 tider, fik %s', v_cnt));

  select count(*) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now, v_b);
  insert into _test(ok, besked) values (v_cnt = 9, format('B (12–17): forventede 9 tider, fik %s', v_cnt));

  select count(distinct f.slot_start) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now) f;
  insert into _test(ok, besked) values (v_cnt = 15, format('Første ledige: forventede 15 forskellige tider, fik %s', v_cnt));

  select count(*) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now, v_c);
  insert into _test(ok, besked) values (v_cnt = 0, format('C laver ikke behandlingen: forventede 0 tider, fik %s', v_cnt));

  select count(*) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now, v_d);
  insert into _test(ok, besked) values (v_cnt = 0, format('D er inaktiv: forventede 0 tider, fik %s', v_cnt));

  v_res := salon_private.create_booking(v_svc, v_date, '13:00', 'Test Testesen', 'test-a@example.com', '+45 10 20 30 40', null, v_a, v_now);
  v_id_a := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_res->>'staff_id' = v_a::text and v_res->>'status' = 'pending' and v_res->>'end_time' = '14:00:00',
    format('Booking hos A kl. 13.00 skal være pending hos A og slutte 14.00, fik %s', v_res));

  select count(distinct f.slot_start) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now) f;
  insert into _test(ok, besked) values (v_cnt = 15, format('B er ledig kl. 12.30–13.30, så første ledige har stadig 15 tider, fik %s', v_cnt));

  begin
    perform salon_private.create_booking(v_svc, v_date, '13:00', 'Test Igen', 'test-b@example.com', '+45 10 20 30 41', null, v_a, v_now);
    insert into _test(ok, besked) values (false, 'A kunne bookes to gange kl. 13.00');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into _test(ok, besked) values (v_hint = 'slot_unavailable', format('Dobbeltbooking hos A skulle afvises med slot_unavailable, fik %s', v_hint));
  end;

  v_res := salon_private.create_booking(v_svc, v_date, '13:00', 'Test Parallel', 'test-c@example.com', '+45 10 20 30 42', null, null, v_now);
  v_id_b := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_res->>'staff_id' = v_b::text, format('Første ledige kl. 13.00 skal give B, fordi A er optaget, fik %s', v_res->>'staff_name'));

  begin
    perform salon_private.create_booking(v_svc, v_date, '13:00', 'Test Tredje', 'test-d@example.com', '+45 10 20 30 43', null, null, v_now);
    insert into _test(ok, besked) values (false, 'Kl. 13.00 kunne bookes, selvom begge frisører var optaget');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into _test(ok, besked) values (v_hint = 'slot_unavailable', format('Alle optaget: forventede slot_unavailable, fik %s', v_hint));
  end;

  begin
    insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time, status)
    values (v_svc, v_a, 'Direkte', 'test-e@example.com', '+45 10 20 30 44', v_date, '13:30', '14:30', 'pending');
    insert into _test(ok, besked) values (false, 'Databasen tillod to overlappende bookinger hos A');
  exception when exclusion_violation then
    insert into _test(ok, besked) values (true, 'Databasen afviser overlap hos samme frisør');
  end;

  v_res := salon_private.create_booking(v_svc, v_date, '09:00', 'Test Morgen', 'test-f@example.com', '+45 10 20 30 45', null, null, v_now);
  v_id_m := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_res->>'staff_id' = v_a::text, format('Kl. 9.00 arbejder kun A, fik %s', v_res->>'staff_name'));

  v_res := salon_private.create_booking(v_svc, v_date, '15:00', 'Test Fordeling', 'test-g@example.com', '+45 10 20 30 46', null, null, v_now);
  v_id_15 := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_res->>'staff_id' = v_b::text, format('Første ledige skal gå til frisøren med færrest bookinger (B), fik %s', v_res->>'staff_name'));

  insert into public.staff_time_off (staff_id, starts_at, ends_at, reason)
  values (v_a, v_date + time '10:00', v_date + time '12:00', 'TEST');
  select count(*) filter (where f.slot_start = '10:30'), count(*) filter (where f.slot_start = '12:00')
    into v_cnt, v_cnt2
  from salon_private.staff_slots(v_svc, v_date, v_now, v_a) f;
  insert into _test(ok, besked) values (v_cnt = 0 and v_cnt2 = 1, format('Fravær 10–12 hos A: 10.30 skal være væk og 12.00 ledig, fik %s og %s', v_cnt, v_cnt2));

  insert into public.staff_time_off (staff_id, starts_at, ends_at, reason)
  values (v_b, v_date::timestamp, (v_date + 1)::timestamp, 'TEST');
  select d.status into v_txt from public.get_available_dates(v_svc, v_date, v_date, v_b) d;
  insert into _test(ok, besked) values (v_txt = 'off', format('Hel fraværsdag: B skal stå som ikke på arbejde (off), fik %s', v_txt));

  update public.appointments set status = 'cancelled' where id = v_id_m;
  select count(*) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now, v_a) f where f.slot_start = '09:00';
  insert into _test(ok, besked) values (v_cnt = 1, 'Aflyst booking skal frigive tiden hos A');

  insert into public.blocked_dates (blocked_date, reason) values (v_date, 'TEST') returning id into v_block_id;
  select count(*) into v_cnt from salon_private.staff_slots(v_svc, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 0, format('Lukkedag: forventede 0 tider, fik %s', v_cnt));
  delete from public.blocked_dates where id = v_block_id;

  select count(*) into v_cnt from salon_private.staff_slots(v_svc_off, v_date, v_now);
  insert into _test(ok, besked) values (v_cnt = 0, format('Inaktiv behandling: forventede 0 tider, fik %s', v_cnt));

  begin
    perform salon_private.create_booking(v_svc, v_date, '10:15', 'Test Skæv', 'test-h@example.com', '+45 10 20 30 47', null, null, v_now);
    insert into _test(ok, besked) values (false, 'Tid uden for intervallet blev accepteret');
  exception when others then
    get stacked diagnostics v_hint = pg_exception_hint;
    insert into _test(ok, besked) values (v_hint = 'slot_unavailable', format('Tid uden for interval: forventede slot_unavailable, fik %s', v_hint));
  end;

  v_res := public.get_booking_receipt(v_id_b);
  insert into _test(ok, besked) values (v_res->>'staff_name' = 'TEST B' and not (v_res ? 'email') and not (v_res ? 'full_name') and not (v_res ? 'phone'),
    format('Kvittering skal vise frisøren uden personoplysninger: fik %s', v_res));

  -- ---------- Anonym besøgende ----------
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into v_cnt from public.staff where id in (v_a, v_b, v_d);
  select count(*) into v_cnt2 from public.staff_services where staff_id = v_a;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_cnt = 2 and v_cnt2 = 2, format('Anonyme skal se aktive frisører (2) og hvad de laver (2), fik %s og %s', v_cnt, v_cnt2));

  perform set_config('role', 'anon', true);
  begin
    perform 1 from public.staff_hours limit 1;
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  begin
    perform 1 from public.staff_time_off limit 1;
    v_txt := 'tilladt';
  exception when insufficient_privilege then
    v_txt := 'afvist';
  end;
  begin
    perform 1 from public.staff_users limit 1;
    v_hint := 'tilladt';
  exception when insufficient_privilege then
    v_hint := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist' and v_txt = 'afvist' and v_hint = 'afvist',
    format('Anonyme må ikke læse arbejdstider, fravær eller logins: %s, %s, %s', v_state, v_txt, v_hint));

  perform set_config('role', 'anon', true);
  begin
    insert into public.staff (name) values ('Anon');
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_state = 'afvist', 'Anonyme skal ikke kunne oprette frisører');

  perform set_config('role', 'anon', true);
  select count(*) into v_cnt from public.get_available_slots(v_svc, v_date, v_a);
  v_res := public.create_booking(v_svc, v_date, '16:00', 'Anne Anonym', 'test-i@example.com', '+45 10 20 30 48', 'Test', v_a);
  perform set_config('role', 'none', true);
  v_pub_id := (v_res->>'id')::uuid;
  insert into _test(ok, besked) values (v_cnt > 0, format('Anonyme skal kunne se en frisørs ledige tider, fik %s', v_cnt));
  insert into _test(ok, besked) values (v_res->>'staff_id' = v_a::text and v_res->>'status' = 'pending',
    format('Anonyme skal kunne booke hos en bestemt frisør: fik %s', v_res));

  -- ---------- Indlogget bruger uden rolle ----------
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  select count(*) into v_cnt from public.appointments;
  begin
    insert into public.staff (name) values ('Indbrud');
    v_state := 'tilladt';
  exception when insufficient_privilege then
    v_state := 'afvist';
  end;
  begin
    perform public.link_staff_login(v_a, 'test@example.com');
    v_txt := 'tilladt';
  exception when insufficient_privilege then
    v_txt := 'afvist';
  end;
  v_res := public.get_my_access();
  perform set_config('role', 'none', true);
  insert into _test(ok, besked) values (v_cnt = 0, format('Bruger uden rolle skal ikke se bookinger: så %s', v_cnt));
  insert into _test(ok, besked) values (v_state = 'afvist', 'Bruger uden rolle skal ikke kunne oprette frisører');
  insert into _test(ok, besked) values (v_txt = 'afvist', 'Bruger uden rolle skal ikke kunne knytte logins til frisører');
  insert into _test(ok, besked) values ((v_res->>'is_admin')::boolean = false and v_res->>'staff_id' is null,
    format('Bruger uden rolle: get_my_access skal give ingen rolle, fik %s', v_res));

  -- ---------- Frisør med login (testbruger, rulles tilbage) ----------
  v_email := 'test-frisoer-' || left(v_login::text, 8) || '@example.invalid';
  begin
    insert into auth.users (id, email, email_confirmed_at) values (v_login, v_email, now());
    insert into public.staff_users (user_id, staff_id) values (v_login, v_b);
    v_login_ok := true;
  exception when others then
    v_note := v_note || ' Frisørlogin er ikke testet, fordi der ikke kunne oprettes en testbruger.';
  end;

  if v_login_ok then
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_login, 'role', 'authenticated')::text, true);
    v_res := public.get_my_access();
    select count(*) filter (where a.staff_id = v_b), count(*) filter (where a.staff_id <> v_b)
      into v_cnt, v_cnt2
    from public.appointments a;
    update public.appointments set status = 'confirmed' where id = v_id_b;
    get diagnostics v_rows = row_count;
    begin
      update public.appointments set staff_id = v_a where id = v_id_15;
      v_state := 'tilladt';
    exception when insufficient_privilege then
      v_state := 'afvist';
    end;
    update public.appointments set status = 'cancelled' where id = v_pub_id;
    get diagnostics v_rows2 = row_count;
    perform set_config('role', 'none', true);
    insert into _test(ok, besked) values (v_res->>'staff_id' = v_b::text and (v_res->>'is_admin')::boolean = false,
      format('Frisørlogin skal genkendes som frisør B, fik %s', v_res));
    insert into _test(ok, besked) values (v_cnt = 2 and v_cnt2 = 0, format('Frisør B skal kun se egne bookinger: egne %s, andres %s', v_cnt, v_cnt2));
    insert into _test(ok, besked) values (v_rows = 1, format('Frisør B skal kunne ændre status på egen booking: ændrede %s', v_rows));
    insert into _test(ok, besked) values (v_state = 'afvist', 'Frisør B skal ikke kunne flytte sin booking til en anden frisør');
    insert into _test(ok, besked) values (v_rows2 = 0, format('Frisør B skal ikke kunne ændre A''s booking: ændrede %s', v_rows2));
  end if;

  -- ---------- Administrator (hvis oprettet) ----------
  select a.user_id into v_admin
  from public.admin_users a
  join auth.users u on u.id = a.user_id
  limit 1;

  if v_admin is null then
    v_note := v_note || ' Administratoradgang er ikke testet, fordi der endnu ikke er oprettet en administrator.';
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    v_res := public.get_my_access();
    update public.appointments set staff_id = v_a where id = v_id_15;
    get diagnostics v_rows = row_count;
    begin
      update public.appointments set staff_id = v_a where id = v_id_b;
      v_state := 'tilladt';
    exception when exclusion_violation then
      v_state := 'afvist';
    end;
    begin
      update public.appointments set full_name = 'Ændret' where id = v_id_b;
      v_txt := 'tilladt';
    exception when insufficient_privilege then
      v_txt := 'afvist';
    end;
    update public.staff_hours set start_time = '10:00' where staff_id = v_a and weekday = v_wd;
    get diagnostics v_rows2 = row_count;
    v_hint := null;
    v_cnt2 := 0;
    if v_login_ok then
      begin
        perform public.link_staff_login(v_a, v_email);
        v_hint := 'tilladt';
      exception when others then
        get stacked diagnostics v_hint = pg_exception_hint;
      end;
      select count(*) into v_cnt2 from public.admin_staff_logins() l where l.email = v_email;
    end if;
    perform set_config('role', 'none', true);
    insert into _test(ok, besked) values ((v_res->>'is_admin')::boolean, format('Administrator skal genkendes, fik %s', v_res));
    insert into _test(ok, besked) values (v_rows = 1, 'Administrator skal kunne flytte en booking til en ledig frisør');
    insert into _test(ok, besked) values (v_state = 'afvist', 'Flytning til en optaget frisør skal afvises af databasen');
    insert into _test(ok, besked) values (v_txt = 'afvist', 'Administrator skal ikke kunne ændre kundens oplysninger');
    insert into _test(ok, besked) values (v_rows2 = 1, 'Administrator skal kunne rette arbejdstider');
    if v_login_ok then
      insert into _test(ok, besked) values (v_hint = 'login_in_use', format('Et login kan kun høre til én frisør: forventede login_in_use, fik %s', v_hint));
      insert into _test(ok, besked) values (v_cnt2 = 1, 'Administrator skal kunne se frisørernes login-e-mail');
    end if;
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
