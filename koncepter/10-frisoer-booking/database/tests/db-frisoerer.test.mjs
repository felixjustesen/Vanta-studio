// Test af 6-migration-flere-frisoerer.sql (flere frisører) mod PGlite – rører ikke Supabase.
// Kør fra denne mappe: node db-frisoerer.test.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// PGlite (Postgres i WebAssembly) lånes fra vanta-platform; kan overskrives med PGLITE=<sti>.
const PGLITE = process.env.PGLITE
  ? pathToFileURL(process.env.PGLITE).href
  : new URL("../../../../vanta-platform/node_modules/@electric-sql/pglite/dist/index.js", import.meta.url).href;
const { PGlite } = await import(PGLITE).catch(() => {
  console.error("PGlite blev ikke fundet. Sæt PGLITE til stien til @electric-sql/pglite/dist/index.js.");
  process.exit(2);
});
const { btree_gist } = await import(new URL("./contrib/btree_gist.js", PGLITE).href);

const DB_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HERE = new URL(".", import.meta.url).pathname;
const read = (p) => readFileSync(p, "utf8");
const STUB = read(HERE + "supabase-stub.sql");
const ORIGINAL = read(HERE + "original.sql");
const M2 = read(DB_DIR + "/2-migration.sql");
const M6 = read(DB_DIR + "/6-migration-flere-frisoerer.sql");
const KONTROL = read(DB_DIR + "/7-kontrol-flere-frisoerer.sql");
const TEST = read(DB_DIR + "/8-test-flere-frisoerer.sql");
const TILBAGE = read(DB_DIR + "/tilbagerulning.sql");
const DEMO_SKARP = read(DB_DIR + "/9-demo-skarp.sql");

const SVC = {
  dame: "46d76786-57c6-4325-9d23-f07b991f064b",
  herre: "6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900",
  farve: "72d8b7a9-98e4-4327-b1c3-34f977aeb8ec",
  foen: "9e50c1ed-7fb4-4e70-8651-244a99ef60e7",
  kur: "ac9c094a-7a65-4939-9b2e-5c858644b9ed",
};
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "bbbbbbbb-0000-4000-8000-000000000002";
const LOGIN = "cccccccc-0000-4000-8000-000000000003"; // bliver frisør Mikkel
const NEW = "dddddddd-0000-4000-8000-000000000004"; // bruges til at knytte login
const UNCONFIRMED = "eeeeeeee-0000-4000-8000-000000000005";

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? " – " + detail : ""}`);
}

async function fresh({ m2 = true, m6 = true, admin = true } = {}) {
  const db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec("set timezone = 'UTC'");
  await db.exec(STUB);
  await db.exec(ORIGINAL);
  await db.exec(`insert into auth.users (id, email) values
    ('${ADMIN}', 'admin@test.dk'), ('${USER}', 'bruger@test.dk'),
    ('${LOGIN}', 'frisoer@test.dk'), ('${NEW}', 'ny@test.dk')`);
  await db.exec(`insert into auth.users (id, email, email_confirmed_at) values ('${UNCONFIRMED}', 'ubekraeftet@test.dk', null)`);
  if (m2) {
    await db.exec(M2);
    if (admin) await db.exec(`insert into public.admin_users (user_id) values ('${ADMIN}')`);
    // Bookinger fra før flere frisører
    await db.exec(`insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status) values
      ('${SVC.dame}', 'Eksisterende Kunde', 'eks@example.com', '12345678', '2026-11-20', '10:00', '11:00', 'confirmed'),
      ('${SVC.herre}', 'Aflyst Kunde', 'afl@example.com', '87654321', '2026-11-20', '10:00', '10:45', 'cancelled')`);
  }
  if (m6) await db.exec(M6);
  return db;
}

async function rows(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}

async function tryq(db, sql, params = []) {
  try {
    if (params.length === 0) {
      const results = await db.exec(sql);
      return { rows: results.at(-1)?.rows ?? [] };
    }
    return { rows: (await db.query(sql, params)).rows };
  } catch (e) {
    return { err: { code: e.code, message: e.message, hint: e.hint } };
  }
}

// Kør én sætning som en bestemt rolle i sin egen transaktion.
async function as(db, role, sub, sql, params = [], { commit = true } = {}) {
  try {
    await db.exec("begin");
    await db.query("select set_config('role', $1, true)", [role]);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(sub ? { sub, role } : { role })]);
    const out = (await db.query(sql, params)).rows;
    await db.exec(commit ? "commit" : "rollback");
    return { rows: out };
  } catch (e) {
    try { await db.exec("rollback"); } catch {}
    return { err: { code: e.code, message: e.message, hint: e.hint } };
  }
}
const anon = (db, sql, params) => as(db, "anon", null, sql, params);
const user = (db, id, sql, params) => as(db, "authenticated", id, sql, params);

const staffId = async (db, name) => (await rows(db, "select id from public.staff where name = $1", [name]))[0]?.id;

const slots = async (db, svc, date, now, staff = null) =>
  rows(db, `select slot_staff_id s, slot_start::text t, slot_end::text e
            from salon_private.staff_slots($1, $2::date, $3::timestamptz, $4::uuid) order by 2, 1`, [svc, date, now, staff]);
const starts = (list) => [...new Set(list.map((r) => r.t))];

let seq = 0;
const book = (db, svc, date, time, now, staff = null, over = {}) =>
  tryq(db, `select salon_private.create_booking($1, $2::date, $3::time, $4, $5, $6, $7, $8::uuid, $9::timestamptz) as r`, [
    svc, date, time,
    over.name ?? "Test Kunde",
    over.email ?? `kunde${++seq}@example.com`,
    over.phone ?? `+45 ${String(20000000 + seq * 7919).slice(0, 8)}`,
    over.notes ?? null,
    staff,
    now,
  ]);

// Datoer i forhold til i dag i København (til funktioner, der bruger now()).
const fmt = (d) => d.toISOString().slice(0, 10);
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const nextDow = (want, min = 3) => { let d = addDays(TODAY, min); while (dow(d) !== want) d = addDays(d, 1); return d; };

// =====================================================================
console.log("1) Migration oven på migration 2");
{
  const db = await fresh({ m6: false });
  const before = (await rows(db, "select count(*)::int n from pg_policies where schemaname='public' and tablename not in ('appointments')"))[0].n;
  const r = await tryq(db, M6);
  check("migration 6 kører uden fejl", !r.err, r.err?.message);
  if (r.err) { console.log("MIGRATION FEJL:", r.err); process.exit(1); }

  const staff = await rows(db, "select name, sort_order, is_active from public.staff order by sort_order");
  check("tre demofrisører", staff.map((s) => s.name).join(",") === "Anna,Mikkel,Sara", JSON.stringify(staff));
  const svcCount = Object.fromEntries((await rows(db, "select st.name, count(ss.*)::int n from public.staff st left join public.staff_services ss on ss.staff_id = st.id group by st.name")).map((x) => [x.name, x.n]));
  check("Anna laver alle 5 behandlinger", svcCount.Anna === 5, JSON.stringify(svcCount));
  check("Mikkel laver 3 (herreklip, vask og føn, hårkur)", svcCount.Mikkel === 3, JSON.stringify(svcCount));
  check("Sara laver 4", svcCount.Sara === 4, JSON.stringify(svcCount));
  const hours = await rows(db, "select st.name, sh.weekday, sh.is_working, sh.start_time::text s, sh.end_time::text e from public.staff_hours sh join public.staff st on st.id = sh.staff_id order by 1, 2");
  check("7 arbejdstider pr. frisør", hours.length === 21, String(hours.length));
  const h = (name, wd) => hours.find((x) => x.name === name && x.weekday === wd);
  check("arbejdstider kopieret fra salonen (fredag 9–19)", h("Anna", 5).is_working && h("Anna", 5).s === "09:00:00" && h("Anna", 5).e === "19:00:00", JSON.stringify(h("Anna", 5)));
  check("søndag: ingen arbejder", !h("Anna", 0).is_working && !h("Sara", 0).is_working);
  check("Mikkel har fri mandag, Sara lørdag", !h("Mikkel", 1).is_working && !h("Sara", 6).is_working && h("Anna", 1).is_working);

  const appts = await rows(db, "select a.full_name, st.name staff from public.appointments a join public.staff st on st.id = a.staff_id order by 1");
  check("eksisterende bookinger knyttet til Anna", appts.length === 2 && appts.every((a) => a.staff === "Anna"), JSON.stringify(appts));
  check("staff_id er NOT NULL", (await rows(db, "select attnotnull from pg_attribute where attrelid='public.appointments'::regclass and attname='staff_id'"))[0].attnotnull === true);
  const cons = (await rows(db, "select conname from pg_constraint where conrelid='public.appointments'::regclass and contype='x'")).map((c) => c.conname);
  check("ny regel pr. frisør, gammel fælles regel fjernet", cons.join() === "appointments_no_overlap_per_staff", cons.join());
  const procs = (await rows(db, "select proname, count(*)::int n from pg_proc where pronamespace='public'::regnamespace and proname in ('get_available_dates','get_available_slots','create_booking') group by 1")).map((x) => x.n);
  check("kun én udgave af hver offentlig funktion (ingen tvetydighed i API'et)", procs.length === 3 && procs.every((n) => n === 1), JSON.stringify(procs));
  check("gamle salon_private.free_slots fjernet", (await rows(db, "select count(*)::int n from pg_proc where proname = 'free_slots'"))[0].n === 0);
  const after = (await rows(db, "select count(*)::int n from pg_policies where schemaname='public' and tablename in ('services','business_hours','blocked_dates','salon_settings','admin_users')"))[0].n;
  check("de øvrige tabellers politikker er uændrede", after === before - 0 && after === 13, `${before} → ${after}`);

  // Idempotens
  const again = await tryq(db, M6);
  check("migration 6 kan køres igen", !again.err, again.err?.message);
  check("stadig 3 frisører", (await rows(db, "select count(*)::int n from public.staff"))[0].n === 3);
  check("stadig 21 arbejdstider", (await rows(db, "select count(*)::int n from public.staff_hours"))[0].n === 21);
  check("stadig 12 behandlingskoblinger", (await rows(db, "select count(*)::int n from public.staff_services"))[0].n === 12);
  check("stadig 30 politikker", (await rows(db, "select count(*)::int n from pg_policies where schemaname='public'"))[0].n === 30);

  // Efterkontrol
  const k = await tryq(db, KONTROL);
  const alt = k.rows?.find((x) => x.kontrol === "alt_ok");
  check("7-kontrol: alt_ok er sand", alt?.ok === true, JSON.stringify(k.err || k.rows?.filter((x) => !x.ok)));
  check("7-kontrol: 21 rækker", k.rows?.length === 21, String(k.rows?.length));

  // Den gamle tilbagerulning (til migration 2) må ikke kunne køres nu
  const tb = await tryq(db, TILBAGE);
  check("gammel tilbagerulning stopper efter migration 6", !!tb.err && /flere frisører/.test(tb.err.message), tb.err?.message);
  await tryq(db, "rollback");
  check("tilbagerulningen ændrede intet", (await rows(db, "select count(*)::int n from pg_policies where schemaname='public'"))[0].n === 30 && (await rows(db, "select count(*)::int n from pg_proc where proname = 'staff_slots'"))[0].n === 1);
  await db.close();
}

{
  const db = await fresh({ m2: false, m6: false });
  const r = await tryq(db, M6);
  check("migration 6 stopper uden migration 2", r.err && /Kør 2-migration\.sql/.test(r.err.message), r.err?.message);
  await tryq(db, "rollback"); // SQL Editor afbryder selv transaktionen
  check("intet oprettet, når den stopper", (await rows(db, "select to_regclass('public.staff') is null as x"))[0].x === true);
  await db.close();
}

// =====================================================================
console.log("2) Ledige tider pr. frisør (fast tidspunkt: mandag 2. nov. 2026 kl. 08.00)");
const NOW = "2026-11-02T08:00:00+01:00";
let db = await fresh();
const ANNA = await staffId(db, "Anna");
const MIKKEL = await staffId(db, "Mikkel");
const SARA = await staffId(db, "Sara");
await db.exec(`insert into public.staff_users (user_id, staff_id) values ('${LOGIN}', '${MIKKEL}')`);

let s = await slots(db, SVC.dame, "2026-11-03", NOW, ANNA);
check("tirsdag: Anna har 17 tider til dameklip (9.00–17.00)", s.length === 17 && s[0].t === "09:00:00" && s.at(-1).t === "17:00:00", `${s.length} ${s[0]?.t}–${s.at(-1)?.t}`);
s = await slots(db, SVC.dame, "2026-11-03", NOW, MIKKEL);
check("Mikkel laver ikke dameklip → 0", s.length === 0, String(s.length));
s = await slots(db, SVC.dame, "2026-11-03", NOW);
check("første ledige: 17 forskellige tider fordelt på Anna og Sara", starts(s).length === 17 && s.length === 34, `${starts(s).length}/${s.length}`);
s = await slots(db, SVC.herre, "2026-11-09", NOW, MIKKEL);
check("Mikkel arbejder ikke mandag → 0", s.length === 0);
s = await slots(db, SVC.herre, "2026-11-09", NOW);
check("mandag: herreklip kan stadig bookes hos Anna", s.length === 17 && s.every((r) => r.s === ANNA), String(s.length));
s = await slots(db, SVC.dame, "2026-11-07", NOW);
check("lørdag (10–16): kun Anna, 11 tider", s.length === 11 && s.every((r) => r.s === ANNA) && s[0].t === "10:00:00", `${s.length}`);
s = await slots(db, SVC.dame, "2026-11-02", NOW, ANNA);
check("i dag: varsling 2 t → første tid 10.00", s[0]?.t === "10:00:00" && s.length === 15, `${s[0]?.t} ${s.length}`);

await db.exec(`update public.staff_hours set start_time = '12:00', end_time = '15:00' where staff_id = '${SARA}' and weekday = 2`);
s = await slots(db, SVC.dame, "2026-11-03", NOW, SARA);
check("Saras egne arbejdstider (12–15) begrænser tiderne", s.length === 5 && s[0].t === "12:00:00" && s.at(-1).t === "14:00:00", s.map((r) => r.t).join(","));
await db.exec(`update public.staff_hours set start_time = '07:00', end_time = '21:00' where staff_id = '${ANNA}' and weekday = 2`);
s = await slots(db, SVC.dame, "2026-11-03", NOW, ANNA);
check("frisørens tider kan ikke gå ud over salonens åbningstid", s.length === 17 && s[0].t === "09:00:00" && s.at(-1).e === "18:00:00", `${s.length} ${s[0]?.t}–${s.at(-1)?.e}`);
await db.exec(`update public.staff_hours set start_time = '09:00', end_time = '18:00' where staff_id in ('${ANNA}', '${SARA}') and weekday = 2`);

await db.exec(`insert into public.staff_time_off (staff_id, starts_at, ends_at, reason) values ('${ANNA}', '2026-11-03 13:00', '2026-11-03 15:00', 'Tandlæge')`);
s = await slots(db, SVC.dame, "2026-11-03", NOW, ANNA);
check("fravær 13–15: tiderne 12.30–14.30 forsvinder", s.length === 12 && !s.some((r) => ["12:30:00", "13:00:00", "14:30:00"].includes(r.t)) && s.some((r) => r.t === "15:00:00") && s.some((r) => r.t === "12:00:00"), s.map((r) => r.t).join(","));
s = await slots(db, SVC.dame, "2026-11-03", NOW);
check("første ledige dækker over fravær med Sara", starts(s).length === 17);
await db.exec("delete from public.staff_time_off");

await db.exec(`update public.staff set is_active = false where id = '${SARA}'`);
s = await slots(db, SVC.dame, "2026-11-03", NOW, SARA);
check("inaktiv frisør → 0 tider", s.length === 0);
await db.exec(`update public.staff set is_active = true where id = '${SARA}'`);

await db.exec("insert into public.blocked_dates (blocked_date, reason) values ('2026-11-04', 'Kursus')");
s = await slots(db, SVC.dame, "2026-11-04", NOW);
check("lukkedag gælder alle frisører", s.length === 0);
await db.exec("delete from public.blocked_dates");

// Sommertid: mandag 29. marts 2027 (CEST). 07.30 + 2 t → første tid 9.30.
await db.exec("update public.salon_settings set booking_window_days = 365");
s = await slots(db, SVC.dame, "2027-03-29", "2027-03-29T07:30:00+02:00", ANNA);
check("sommertid: varsling regnes i dansk tid (første tid 9.30)", s[0]?.t === "09:30:00", s[0]?.t);
s = await slots(db, SVC.dame, "2026-10-26", "2026-10-26T07:30:00+01:00", ANNA);
check("vintertid: varsling regnes i dansk tid (første tid 9.30)", s[0]?.t === "09:30:00", s[0]?.t);
await db.exec("update public.salon_settings set booking_window_days = 60");

// =====================================================================
console.log("3) Kalenderstatus (rigtigt tidspunkt)");
const MON = nextDow(1);
const TUE = nextDow(2);
const SUN = nextDow(0);
const day = async (svc, date, staff = null) =>
  (await rows(db, "select status, free_slots from public.get_available_dates($1, $2::date, $2::date, $3::uuid)", [svc, date, staff]))[0];
check("frisør med fri: status off", (await day(SVC.herre, MON, MIKKEL))?.status === "off", JSON.stringify(await day(SVC.herre, MON, MIKKEL)));
check("første ledige samme dag: available (Anna)", (await day(SVC.herre, MON))?.status === "available");
check("søndag: closed", (await day(SVC.dame, SUN, ANNA))?.status === "closed");
check("frisør der ikke laver behandlingen: off", (await day(SVC.dame, TUE, MIKKEL))?.status === "off");
await db.exec(`insert into public.staff_time_off (staff_id, starts_at, ends_at) values ('${SARA}', '${TUE} 00:00', '${addDays(TUE, 1)} 00:00')`);
check("hel fraværsdag: off", (await day(SVC.dame, TUE, SARA))?.status === "off");
check("første ledige trods Saras fravær: available", (await day(SVC.dame, TUE))?.status === "available");
await db.exec("delete from public.staff_time_off");
check("ledige tider tælles som forskellige starttider", (await day(SVC.dame, TUE))?.free_slots === 17, JSON.stringify(await day(SVC.dame, TUE)));
const anonDates = await anon(db, "select count(*)::int n from public.get_available_dates($1, $2::date, $3::date, $4::uuid)", [SVC.dame, TODAY, addDays(TODAY, 20), SARA]);
check("anonyme kan hente kalender for én frisør", anonDates.rows?.[0]?.n === 21, JSON.stringify(anonDates));
const oldStyle = await anon(db, "select count(*)::int n from public.get_available_dates(p_service_id => $1, p_from => $2::date, p_to => $3::date)", [SVC.dame, TODAY, addDays(TODAY, 6)]);
check("kald uden frisør virker som før", oldStyle.rows?.[0]?.n === 7, JSON.stringify(oldStyle));

// =====================================================================
console.log("4) Booking pr. frisør");
let r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW, SARA, { name: "Sofie Sara" });
let b = r.rows?.[0]?.r;
check("booking hos valgt frisør", b?.staff_id === SARA && b?.staff_name === "Sara" && b?.status === "pending" && b?.end_time === "11:00:00", JSON.stringify(r));
s = await slots(db, SVC.dame, "2026-11-03", NOW, SARA);
check("Sara mister 9.30, 10.00 og 10.30", s.length === 14 && !s.some((x) => ["09:30:00", "10:00:00", "10:30:00"].includes(x.t)), String(s.length));
s = await slots(db, SVC.dame, "2026-11-03", NOW);
check("første ledige har stadig 17 tider (Anna er ledig)", starts(s).length === 17);
r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW, SARA);
check("samme frisør og tid afvises", r.err?.hint === "slot_unavailable", JSON.stringify(r.err));
r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW, ANNA, { name: "Alma Anna" });
check("anden frisør samme tid tilladt", r.rows?.[0]?.r?.staff_id === ANNA, JSON.stringify(r));
r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW);
check("første ledige afvises, når alle er optaget", r.err?.hint === "slot_unavailable", JSON.stringify(r.err));
r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW, MIKKEL);
check("frisør der ikke laver behandlingen afvises", r.err?.hint === "slot_unavailable");

// Fordeling: onsdag. Anna får 9.00, derefter går "første ledige" til Sara.
r = await book(db, SVC.dame, "2026-11-04", "09:00", NOW, ANNA);
r = await book(db, SVC.dame, "2026-11-04", "11:00", NOW);
check("første ledige går til frisøren med færrest bookinger", r.rows?.[0]?.r?.staff_name === "Sara", JSON.stringify(r.rows?.[0]?.r));
r = await book(db, SVC.dame, "2026-11-04", "13:00", NOW);
check("ved lige mange bookinger vælges efter rækkefølge (Anna)", r.rows?.[0]?.r?.staff_name === "Anna", JSON.stringify(r.rows?.[0]?.r));
r = await book(db, SVC.herre, "2026-11-09", "10:00", NOW);
check("mandag: herreklip går til Anna (Mikkel har fri)", r.rows?.[0]?.r?.staff_name === "Anna");

// Direkte i tabellen
let ins = await tryq(db, `insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time) values ('${SVC.dame}', '${SARA}', 'X', 'x@example.com', '12345678', '2026-11-03', '10:30', '11:30')`);
check("databasen afviser overlap hos samme frisør", ins.err?.code === "23P01", JSON.stringify(ins.err));
ins = await tryq(db, `insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time) values ('${SVC.herre}', '${MIKKEL}', 'Y', 'y@example.com', '12345679', '2026-11-03', '10:30', '11:15')`);
check("databasen tillader samme tid hos en anden frisør", !ins.err, JSON.stringify(ins.err));
ins = await tryq(db, `insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time) values ('${SVC.dame}', 'Z', 'z@example.com', '12345670', '2026-11-05', '10:00', '11:00')`);
check("booking uden frisør afvises (NOT NULL)", ins.err?.code === "23502", JSON.stringify(ins.err));
await db.exec("update public.appointments set status = 'cancelled' where full_name = 'Y'");
ins = await tryq(db, `insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time) values ('${SVC.herre}', '${MIKKEL}', 'Y2', 'y2@example.com', '12345671', '2026-11-03', '10:30', '11:15')`);
check("aflyst booking blokerer ikke", !ins.err, JSON.stringify(ins.err));

// Offentlige funktioner (rigtigt tidspunkt)
const pub = await anon(db, "select public.create_booking($1, $2::date, '10:00'::time, 'Pia Public', 'pia@example.com', '+45 11 22 33 44') as r", [SVC.dame, TUE]);
check("offentlig booking uden frisør (som før) virker", pub.rows?.[0]?.r?.status === "pending" && !!pub.rows?.[0]?.r?.staff_name, JSON.stringify(pub));
const pub2 = await anon(db, "select public.create_booking(p_service_id => $1, p_date => $2::date, p_start_time => '11:00'::time, p_full_name => 'Per Public', p_email => 'per@example.com', p_phone => '+45 11 22 33 45', p_staff_id => $3::uuid) as r", [SVC.herre, TUE, MIKKEL]);
check("offentlig booking hos bestemt frisør", pub2.rows?.[0]?.r?.staff_name === "Mikkel", JSON.stringify(pub2));
const rec = await anon(db, "select public.get_booking_receipt($1) as r", [pub2.rows?.[0]?.r?.id]);
const receipt = rec.rows?.[0]?.r;
check("kvittering viser frisøren", receipt?.staff_name === "Mikkel", JSON.stringify(receipt));
check("kvittering uden personoplysninger", receipt && !("email" in receipt) && !("full_name" in receipt) && !("phone" in receipt) && !("staff_id" in receipt));
const slotsAnon = await anon(db, "select count(*)::int n from public.get_available_slots($1, $2::date, $3::uuid)", [SVC.herre, TUE, MIKKEL]);
check("anonyme kan se én frisørs ledige tider (17 minus 3 omkring bookingen kl. 11)", slotsAnon.rows?.[0]?.n === 14, JSON.stringify(slotsAnon));

// =====================================================================
console.log("5) Adgang og roller");
const MIKKEL_BOOKING = pub2.rows?.[0]?.r?.id;
const ANNA_BOOKING = (await rows(db, "select id from public.appointments where staff_id = $1 and status <> 'cancelled' limit 1", [ANNA]))[0].id;

let a = await anon(db, "select name from public.staff order by sort_order");
check("anonyme ser aktive frisører", a.rows?.map((x) => x.name).join() === "Anna,Mikkel,Sara", JSON.stringify(a));
await db.exec(`update public.staff set is_active = false where id = '${SARA}'`);
a = await anon(db, "select name from public.staff order by sort_order");
check("anonyme ser ikke inaktive frisører", a.rows?.map((x) => x.name).join() === "Anna,Mikkel", JSON.stringify(a));
await db.exec(`update public.staff set is_active = true where id = '${SARA}'`);
a = await anon(db, "select count(*)::int n from public.staff_services");
check("anonyme ser hvem der laver hvad", a.rows?.[0]?.n === 12);
for (const t of ["staff_hours", "staff_time_off", "staff_users", "appointments"]) {
  a = await anon(db, `select * from public.${t} limit 1`);
  check(`anonyme kan ikke læse ${t}`, a.err?.code === "42501", JSON.stringify(a));
}
a = await anon(db, "insert into public.staff (name) values ('Anon')");
check("anonyme kan ikke oprette frisører", a.err?.code === "42501");
a = await anon(db, "delete from public.staff_services");
check("anonyme kan ikke slette koblinger", a.err?.code === "42501");
a = await anon(db, "select public.admin_staff_logins()");
check("anonyme kan ikke kalde administratorfunktioner", a.err?.code === "42501", JSON.stringify(a));
a = await anon(db, "select public.get_my_access() as r");
check("get_my_access som anonym: ingen rolle", a.rows?.[0]?.r?.is_admin === false && a.rows?.[0]?.r?.staff_id === null, JSON.stringify(a));

// Bruger uden rolle
let u = await user(db, USER, "select count(*)::int n from public.appointments");
check("bruger uden rolle ser ingen bookinger", u.rows?.[0]?.n === 0);
u = await user(db, USER, "insert into public.staff (name) values ('Indbrud')");
check("bruger uden rolle kan ikke oprette frisører", u.err?.code === "42501", JSON.stringify(u));
u = await user(db, USER, "select count(*)::int n from public.staff_hours");
check("bruger uden rolle ser ingen arbejdstider", u.rows?.[0]?.n === 0);
u = await user(db, USER, "insert into public.staff_users (user_id, staff_id) values ($1, $2)", [USER, ANNA]);
check("ingen kan gøre sig til frisør via API'et", u.err?.code === "42501", JSON.stringify(u));
u = await user(db, USER, "select public.link_staff_login($1, 'bruger@test.dk')", [ANNA]);
check("bruger uden rolle kan ikke knytte logins", u.err?.code === "42501");

// Frisør (Mikkel)
u = await user(db, LOGIN, "select public.get_my_access() as r");
check("frisørlogin genkendes", u.rows?.[0]?.r?.staff_id === MIKKEL && u.rows?.[0]?.r?.staff_name === "Mikkel" && u.rows?.[0]?.r?.is_admin === false, JSON.stringify(u));
u = await user(db, LOGIN, "select distinct staff_id from public.appointments");
check("frisør ser kun egne bookinger", u.rows?.length === 1 && u.rows[0].staff_id === MIKKEL, JSON.stringify(u.rows));
u = await user(db, LOGIN, "update public.appointments set status = 'confirmed' where id = $1 returning status", [MIKKEL_BOOKING]);
check("frisør kan bekræfte egen booking", u.rows?.[0]?.status === "confirmed", JSON.stringify(u));
u = await user(db, LOGIN, "update public.appointments set status = 'cancelled' where id = $1 returning id", [ANNA_BOOKING]);
check("frisør kan ikke ændre andres bookinger", u.rows?.length === 0, JSON.stringify(u));
u = await user(db, LOGIN, "update public.appointments set staff_id = $2 where id = $1", [MIKKEL_BOOKING, ANNA]);
check("frisør kan ikke flytte egen booking til en anden", u.err?.code === "42501", JSON.stringify(u));
u = await user(db, LOGIN, "update public.appointments set full_name = 'X' where id = $1", [MIKKEL_BOOKING]);
check("frisør kan ikke ændre kundens oplysninger", u.err?.code === "42501");
u = await user(db, LOGIN, "select distinct staff_id from public.staff_hours");
check("frisør ser kun egne arbejdstider", u.rows?.length === 1 && u.rows[0].staff_id === MIKKEL, JSON.stringify(u.rows));
u = await user(db, LOGIN, "update public.staff_hours set start_time = '06:00' where staff_id = $1 returning id", [MIKKEL]);
check("frisør kan ikke selv rette arbejdstider", u.rows?.length === 0, JSON.stringify(u));
u = await user(db, LOGIN, "insert into public.staff_time_off (staff_id, starts_at, ends_at) values ($1, '2026-12-01', '2026-12-02')", [MIKKEL]);
check("frisør kan ikke selv oprette fravær", u.err?.code === "42501");
u = await user(db, LOGIN, "update public.services set price = 1 returning id");
check("frisør kan ikke rette priser", u.rows?.length === 0);
u = await user(db, LOGIN, "select count(*)::int n from public.blocked_dates");
check("frisør ser ikke lukkedagenes årsager", u.rows?.[0]?.n === 0);
u = await user(db, LOGIN, "select count(*)::int n from public.staff_users");
check("frisør ser kun sin egen kobling", u.rows?.[0]?.n === 1);
await db.exec(`update public.staff set is_active = false where id = '${MIKKEL}'`);
u = await user(db, LOGIN, "select count(*)::int n from public.appointments");
check("inaktiv frisør mister adgangen", u.rows?.[0]?.n === 0, JSON.stringify(u));
u = await user(db, LOGIN, "select public.get_my_access() as r");
check("inaktiv frisør: ingen rolle", u.rows?.[0]?.r?.staff_id === null);
await db.exec(`update public.staff set is_active = true where id = '${MIKKEL}'`);

// Administrator
u = await user(db, ADMIN, "select public.get_my_access() as r");
check("administrator genkendes", u.rows?.[0]?.r?.is_admin === true && u.rows?.[0]?.r?.staff_id === null);
u = await user(db, ADMIN, "insert into public.staff (name, sort_order) values ('Ida', 4) returning id");
const IDA = u.rows?.[0]?.id;
check("administrator kan oprette frisør", !!IDA, JSON.stringify(u));
const idaHours = await rows(db, "select weekday, is_working, start_time::text s from public.staff_hours where staff_id = $1 order by weekday", [IDA]);
check("ny frisør får salonens åbningstider", idaHours.length === 7 && idaHours[1].is_working && idaHours[1].s === "09:00:00" && !idaHours[0].is_working, JSON.stringify(idaHours));
u = await user(db, ADMIN, "insert into public.staff_services (staff_id, service_id) values ($1, $2), ($1, $3) returning staff_id", [IDA, SVC.dame, SVC.herre]);
check("administrator kan give frisør behandlinger", u.rows?.length === 2, JSON.stringify(u));
u = await user(db, ADMIN, "delete from public.staff_services where staff_id = $1 and service_id = $2 returning staff_id", [IDA, SVC.herre]);
check("administrator kan fjerne en behandling", u.rows?.length === 1);
u = await user(db, ADMIN, "update public.staff_hours set start_time = '10:00', end_time = '16:00' where staff_id = $1 and weekday = 2 returning id", [IDA]);
check("administrator kan rette arbejdstider", u.rows?.length === 1);
u = await user(db, ADMIN, "update public.staff_hours set start_time = '16:00', end_time = '10:00' where staff_id = $1 and weekday = 2", [IDA]);
check("arbejdstid med slut før start afvises", u.err?.code === "23514", JSON.stringify(u.err));
u = await user(db, ADMIN, "insert into public.staff_time_off (staff_id, starts_at, ends_at, reason) values ($1, '2026-12-01 00:00', '2026-12-03 00:00', 'Ferie') returning id", [IDA]);
check("administrator kan oprette fravær", u.rows?.length === 1, JSON.stringify(u));
u = await user(db, ADMIN, "delete from public.staff_time_off where staff_id = $1 returning id", [IDA]);
check("administrator kan slette fravær", u.rows?.length === 1);
u = await user(db, ADMIN, "insert into public.staff_time_off (staff_id, starts_at, ends_at) values ($1, '2026-12-03', '2026-12-01')", [IDA]);
check("fravær der slutter før det starter afvises", u.err?.code === "23514");
u = await user(db, ADMIN, "update public.staff set name = 'Ida K.', is_active = false where id = $1 returning name, is_active", [IDA]);
check("administrator kan omdøbe og deaktivere frisør", u.rows?.[0]?.name === "Ida K." && u.rows?.[0]?.is_active === false);
u = await user(db, ADMIN, "select count(*)::int n from public.staff");
check("administrator ser også inaktive frisører", u.rows?.[0]?.n === 4);
u = await user(db, ADMIN, "delete from public.staff where id = $1", [IDA]);
check("frisører kan ikke slettes via API'et", u.err?.code === "42501");
u = await user(db, ADMIN, "update public.appointments set staff_id = $2 where id = $1 returning staff_id", [MIKKEL_BOOKING, ANNA]);
check("administrator kan flytte booking til ledig frisør", u.rows?.[0]?.staff_id === ANNA, JSON.stringify(u));
const conflict = (await rows(db, "select a.id from public.appointments a where a.staff_id = $1 and a.appointment_date = '2026-11-03' and a.start_time = '10:00' and a.status <> 'cancelled'", [SARA]))[0].id;
u = await user(db, ADMIN, "update public.appointments set staff_id = $2 where id = $1", [conflict, ANNA]);
check("flytning til optaget frisør afvises (23P01)", u.err?.code === "23P01", JSON.stringify(u));
u = await user(db, ADMIN, "update public.appointments set full_name = 'X' where id = $1", [conflict]);
check("administrator kan ikke ændre kundens oplysninger", u.err?.code === "42501");

// Login til frisører
u = await user(db, ADMIN, "select public.link_staff_login($1, 'findes.ikke@test.dk') as r", [SARA]);
check("ukendt e-mail: login_not_found", u.err?.hint === "login_not_found", JSON.stringify(u));
u = await user(db, ADMIN, "select public.link_staff_login($1, 'ubekraeftet@test.dk') as r", [SARA]);
check("ubekræftet bruger kan ikke knyttes", u.err?.hint === "login_not_found");
u = await user(db, ADMIN, "select public.link_staff_login($1, '  NY@test.dk ') as r", [SARA]);
check("administrator kan knytte login (store bogstaver og mellemrum ignoreres)", u.rows?.[0]?.r?.email === "ny@test.dk", JSON.stringify(u));
u = await user(db, NEW, "select public.get_my_access() as r");
check("det nye login er nu frisør Sara", u.rows?.[0]?.r?.staff_id === SARA);
u = await user(db, ADMIN, "select public.link_staff_login($1, 'ny@test.dk') as r", [ANNA]);
check("et login kan kun høre til én frisør", u.err?.hint === "login_in_use" && /Sara/.test(u.err?.message), JSON.stringify(u.err));
u = await user(db, ADMIN, "select public.link_staff_login($1, 'bruger@test.dk') as r", [SARA]);
check("nyt login erstatter det gamle", u.rows?.[0]?.r?.email === "bruger@test.dk" && (await rows(db, "select count(*)::int n from public.staff_users where staff_id = $1", [SARA]))[0].n === 1);
u = await user(db, ADMIN, "select * from public.admin_staff_logins() order by email");
check("administrator ser frisørernes login-e-mails", u.rows?.map((x) => x.email).join() === "bruger@test.dk,frisoer@test.dk", JSON.stringify(u));
u = await user(db, USER, "select * from public.admin_staff_logins()");
check("kun administratorer ser login-e-mails", u.err?.code === "42501");
u = await user(db, ADMIN, "select public.link_staff_login($1, '') as r", [SARA]);
check("tom e-mail fjerner login", u.rows?.[0]?.r?.email === null && (await rows(db, "select count(*)::int n from public.staff_users where staff_id = $1", [SARA]))[0].n === 0);
await db.close();

// =====================================================================
console.log("6) Testscriptet 8-test-flere-frisoerer.sql");
for (const withAdmin of [true, false]) {
  const t = await fresh({ admin: withAdmin });
  const countBefore = (await rows(t, "select (select count(*) from public.staff) + (select count(*) from public.appointments) + (select count(*) from public.services) + (select count(*) from auth.users) n"))[0].n;
  const res = await tryq(t, TEST);
  const msg = res.err?.message || "";
  check(`8-test ${withAdmin ? "med" : "uden"} administrator: TEST OK`, msg.startsWith("TEST OK"), msg);
  check(`8-test ${withAdmin ? "med" : "uden"} administrator: antal kontroller`, withAdmin ? /alle 41 kontroller/.test(msg) : /alle 34 kontroller/.test(msg), msg.slice(0, 60));
  const countAfter = (await rows(t, "select (select count(*) from public.staff) + (select count(*) from public.appointments) + (select count(*) from public.services) + (select count(*) from auth.users) n"))[0].n;
  check(`8-test ${withAdmin ? "med" : "uden"} administrator: intet gemt`, countBefore === countAfter, `${countBefore} → ${countAfter}`);
  if (withAdmin) {
    const k = await tryq(t, KONTROL);
    check("7-kontrol efter 8-test: alt_ok stadig sand", k.rows?.find((x) => x.kontrol === "alt_ok")?.ok === true);
  }
  await t.close();
}

// =====================================================================
console.log("7) Demodata til SKARP (9-demo-skarp.sql)");
{
  const t = await fresh();
  await t.exec("update public.services set price = 500, price_is_demo = false where name = 'Hårkur'"); // ejerens egen pris
  const r1 = await tryq(t, DEMO_SKARP);
  check("demoscript kører uden fejl", !r1.err, r1.err?.message);
  const svc = await rows(t, "select name, duration_minutes, price::text, price_is_demo from public.services order by name");
  check("demobehandlinger omdøbt til barbershop", svc.map((x) => x.name).join() === "Hårkur,Klip,Klip og skæg,Skin fade,Skæg", svc.map((x) => x.name).join());
  check("ejerens egen behandling røres ikke", svc.find((x) => x.name === "Hårkur")?.price === "500.00");
  check("nye demopriser og varigheder", svc.find((x) => x.name === "Skæg")?.price === "195.00" && svc.find((x) => x.name === "Skæg")?.duration_minutes === 20 && svc.find((x) => x.name === "Klip")?.price_is_demo === true);
  const st = (await rows(t, "select salon_name, salon_address, about_text from public.salon_settings"))[0];
  check("salonen hedder SKARP", st.salon_name === "SKARP" && st.salon_address === "Vesterbro, København (demo)" && /barber/i.test(st.about_text), JSON.stringify(st));
  const r2 = await tryq(t, DEMO_SKARP);
  check("demoscript kan køres igen", !r2.err && (await rows(t, "select count(*)::int n from public.services"))[0].n === 5);
  await t.exec("update public.salon_settings set salon_name = 'Ejerens Salon', is_demo = false");
  await tryq(t, DEMO_SKARP);
  check("tilpasset saloninfo røres ikke", (await rows(t, "select salon_name from public.salon_settings"))[0].salon_name === "Ejerens Salon");
  const kontrol = await tryq(t, KONTROL);
  check("7-kontrol stadig ok efter demodata", kontrol.rows?.find((x) => x.kontrol === "alt_ok")?.ok === true);
  await t.close();
}

console.log(`\n${passed} bestået, ${failures.length} fejlet`);
for (const f of failures) console.log("  ✗", f);
process.exit(failures.length ? 1 : 0);
