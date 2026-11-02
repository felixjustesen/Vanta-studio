// Test af migrationen mod PGlite (rigtig Postgres i WebAssembly) – rører ikke Supabase.
// Kør fra denne mappe: node db.test.mjs
import { readFileSync } from "node:fs";

// PGlite (Postgres i WebAssembly) lånes fra vanta-platform; kan overskrives med PGLITE=<sti>.
const PGLITE = process.env.PGLITE || new URL("../../../../vanta-platform/node_modules/@electric-sql/pglite/dist/index.js", import.meta.url).href;
const { PGlite } = await import(PGLITE).catch(() => {
  console.error("PGlite blev ikke fundet. Sæt PGLITE til stien til @electric-sql/pglite/dist/index.js.");
  process.exit(2);
});

const DB_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HERE = new URL(".", import.meta.url).pathname;
const read = (p) => readFileSync(p, "utf8");
const STUB = read(HERE + "supabase-stub.sql");
const ORIGINAL = read(HERE + "original.sql");
const MIGRATION = read(DB_DIR + "/2-migration.sql");

const SVC = {
  dame: "46d76786-57c6-4325-9d23-f07b991f064b",
  herre: "6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900",
  farve: "72d8b7a9-98e4-4327-b1c3-34f977aeb8ec",
  foen: "9e50c1ed-7fb4-4e70-8651-244a99ef60e7",
  kur: "ac9c094a-7a65-4939-9b2e-5c858644b9ed",
};
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "bbbbbbbb-0000-4000-8000-000000000002";

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? " – " + detail : ""}`);
}

async function fresh(original = ORIGINAL) {
  const db = await PGlite.create();
  await db.exec("set timezone = 'UTC'");
  await db.exec(STUB);
  await db.exec(original);
  await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'admin@test.dk'), ('${USER}', 'bruger@test.dk')`);
  return db;
}

async function rows(db, sql, params = []) {
  return (await db.query(sql, params)).rows;
}

// Kør én sætning som en bestemt rolle i sin egen transaktion.
async function as(db, role, sub, sql, params = [], { commit = true } = {}) {
  try {
    let out;
    await db.exec("begin");
    await db.query("select set_config('role', $1, true)", [role]);
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(sub ? { sub, role } : { role }),
    ]);
    out = (await db.query(sql, params)).rows;
    await db.exec(commit ? "commit" : "rollback");
    return { rows: out };
  } catch (e) {
    try { await db.exec("rollback"); } catch {}
    return { err: { code: e.code, message: e.message, hint: e.hint } };
  }
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

const slots = async (db, svc, date, now) =>
  (await rows(db, `select slot_start::text s, slot_end::text e from salon_private.free_slots($1, $2::date, $3::timestamptz)`, [svc, date, now]));

const book = (db, svc, date, time, now, over = {}) =>
  tryq(db, `select salon_private.create_booking($1, $2::date, $3::time, $4, $5, $6, $7, $8::timestamptz) as r`, [
    svc, date, time,
    over.name ?? "Test Kunde",
    over.email ?? `kunde${Math.random().toString(36).slice(2, 8)}@example.com`,
    over.phone ?? `+45 ${String(Math.floor(10000000 + Math.random() * 89999999))}`,
    over.notes ?? null,
    now,
  ]);

// =====================================================================
console.log("1) Migration på genskabt database");
let db = await fresh();
const policiesBefore = (await rows(db, "select tablename, policyname from pg_policies where schemaname='public' order by 1,2")).map((r) => `${r.tablename}:${r.policyname}`);

// Før: skabelonen lader anonyme læse bookinger (det hul, migrationen lukker)
await db.exec(`insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status) values ('${SVC.dame}', 'Eksisterende Kunde', 'eks@example.com', '12345678', '2026-11-20', '10:00', '11:00', 'confirmed')`);
const leakBefore = await as(db, "anon", null, "select full_name, email from public.appointments");
check("skabelonens hul findes før migration", leakBefore.rows?.length === 1);

const mig = await tryq(db, MIGRATION);
check("migration kører uden fejl", !mig.err, mig.err?.message);
if (mig.err) { console.log("MIGRATION FEJL:", mig.err); process.exit(1); }

const leakAfter = await as(db, "anon", null, "select full_name, email from public.appointments");
check("anon kan ikke læse bookinger efter migration", leakAfter.err?.code === "42501", JSON.stringify(leakAfter));

const svcRows = await rows(db, "select id, name, description, price::text, price_is_demo, duration_minutes from public.services order by duration_minutes, name");
const names = svcRows.map((r) => r.name).sort().join(",");
check("behandlinger oversat", names === "Dameklip,Herreklip,Hårfarvning,Hårkur,Vask og føn", names);
const ENGLISH = ["Personalized haircut with consultation and styling finish.", "Clean haircut with professional styling.", "Full color service with consultation and finish.", "Wash, blow dry, and polished styling.", "Deep conditioning treatment for softer and healthier-looking hair."];
check("ingen engelske beskrivelser tilbage", svcRows.every((r) => !ENGLISH.includes(r.description)), svcRows.map((r) => r.description).join(" | "));
const prices = Object.fromEntries(svcRows.map((r) => [r.name, [r.price, r.price_is_demo]]));
check("demopriser sat og markeret", prices["Dameklip"][0] === "495.00" && prices["Dameklip"][1] === true && prices["Hårfarvning"][0] === "1095.00", JSON.stringify(prices));
check("varigheder uændrede", svcRows.find((r) => r.name === "Hårfarvning").duration_minutes === 120);
check("ingen dubletter", (await rows(db, "select count(*)::int n from public.services"))[0].n === 5);

const st = (await rows(db, "select * from public.salon_settings"))[0];
check("saloninfo erstattet med demo", st.salon_name === "Demosalonen" && st.salon_email === "kontakt@example.com" && st.salon_phone === "+45 00 00 00 00" && st.salon_address === "Demovej 1, 0000 Demoby" && st.is_demo === true, JSON.stringify(st));
check("om-tekst sat for demo", typeof st.about_text === "string" && st.about_text.length > 50);
check("bookingvindue standard 60", st.booking_window_days === 60);

const backup = (await rows(db, "select count(*)::int n from salon_backup.policies"))[0].n;
check("gamle politikker gemt i backup", backup === policiesBefore.length, `${backup} vs ${policiesBefore.length}`);

// Idempotens
const mig2 = await tryq(db, MIGRATION);
check("migration kan køres igen", !mig2.err, mig2.err?.message);
check("backup ikke overskrevet ved 2. kørsel", (await rows(db, "select count(*)::int n from salon_backup.policies"))[0].n === policiesBefore.length);
check("stadig 5 behandlinger efter 2. kørsel", (await rows(db, "select count(*)::int n from public.services"))[0].n === 5);
check("ejertilpasset pris røres ikke", (await rows(db, "select price::text p from public.services where name='Dameklip'"))[0].p === "495.00");

// =====================================================================
console.log("2) Bookingregler med fast tidspunkt (mandag 2. nov. 2026 kl. 08.00)");
const NOW = "2026-11-02T08:00:00+01:00";
let s = await slots(db, SVC.dame, "2026-11-02", NOW);
check("i dag: varsling 2 t → første tid 10.00", s[0]?.s === "10:00:00", s[0]?.s);
check("i dag: 15 tider (10.00–17.00)", s.length === 15, String(s.length));
s = await slots(db, SVC.dame, "2026-11-03", NOW);
check("tirsdag: 17 tider", s.length === 17, String(s.length));
check("sidste tid slutter ved lukketid", s.at(-1)?.s === "17:00:00" && s.at(-1)?.e === "18:00:00");
check("ingen tid der går over lukketid", !s.some((x) => x.s === "17:30:00"));
check("sluttid = start + varighed", s[0].e === "10:00:00");
check("søndag lukket", (await slots(db, SVC.dame, "2026-11-08", NOW)).length === 0);
check("lørdag 10–16: 11 tider", (await slots(db, SVC.dame, "2026-11-07", NOW)).length === 11);
check("fredag 9–19: 19 tider", (await slots(db, SVC.dame, "2026-11-06", NOW)).length === 19);
s = await slots(db, SVC.farve, "2026-11-03", NOW);
check("farvning 120 min: 15 tider, sidste 16.00", s.length === 15 && s.at(-1).s === "16:00:00");
check("fortid giver ingen tider", (await slots(db, SVC.dame, "2026-11-01", NOW)).length === 0);
check("dag 60 kan bookes", (await slots(db, SVC.dame, "2027-01-01", NOW)).length > 0);
check("dag 61 kan ikke bookes", (await slots(db, SVC.dame, "2027-01-02", NOW)).length === 0);

await db.exec("insert into public.blocked_dates (blocked_date, reason) values ('2026-11-04', 'Kursus')");
check("blokeret dato giver ingen tider", (await slots(db, SVC.dame, "2026-11-04", NOW)).length === 0);
let r = await book(db, SVC.dame, "2026-11-04", "10:00", NOW);
check("booking på blokeret dato afvises", r.err?.hint === "slot_unavailable", JSON.stringify(r));
await db.exec("delete from public.blocked_dates where blocked_date = '2026-11-04'");

await db.exec("update public.salon_settings set slot_interval_minutes = 15");
check("interval 15: 33 tider tirsdag", (await slots(db, SVC.dame, "2026-11-03", NOW)).length === 33);
await db.exec("update public.salon_settings set slot_interval_minutes = 30, booking_notice_hours = 0");
s = await slots(db, SVC.dame, "2026-11-03", "2026-11-03T12:10:00+01:00");
check("varsling 0 kl. 12.10: første tid 12.30", s[0]?.s === "12:30:00" && s.length === 10, `${s[0]?.s} / ${s.length}`);
await db.exec("update public.salon_settings set booking_notice_hours = 2");

// Sommertid: lør. 27. marts 2027 kl. 23.30 (CET) + 34 t = man. 29. marts kl. 10.30 (CEST)
await db.exec("update public.salon_settings set booking_notice_hours = 34");
s = await slots(db, SVC.dame, "2027-03-29", "2027-03-27T23:30:00+01:00");
check("sommertid: varsling regnes i Europe/Copenhagen", s[0]?.s === "10:30:00", s[0]?.s);
await db.exec("update public.salon_settings set booking_notice_hours = 2");
// Også uafhængig af sessionens tidszone
await db.exec("set timezone = 'America/New_York'");
check("uafhængig af sessionens tidszone", (await slots(db, SVC.dame, "2026-11-02", NOW))[0]?.s === "10:00:00");
await db.exec("set timezone = 'UTC'");

// Booking
r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW, { name: "  Anna   Hansen ", email: " Anna@Example.COM ", phone: "+45 12 34 56 78", notes: "  Kort i nakken  " });
const b1 = r.rows?.[0]?.r;
check("booking oprettes", !!b1?.id, JSON.stringify(r));
check("status er pending", b1?.status === "pending");
check("sluttid beregnet (11.00)", b1?.end_time === "11:00:00");
check("bookingnummer = 8 tegn", b1?.reference?.length === 8 && b1.reference === b1.id.slice(0, 8).toUpperCase());
const saved = (await rows(db, "select full_name, email, phone, notes, status from public.appointments where id = $1", [b1.id]))[0];
check("data normaliseret", saved.full_name === "Anna Hansen" && saved.email === "anna@example.com" && saved.notes === "Kort i nakken", JSON.stringify(saved));

s = await slots(db, SVC.dame, "2026-11-03", NOW);
check("booket tid og overlap fjernet (14 tilbage)", s.length === 14 && !s.some((x) => ["09:30:00", "10:00:00", "10:30:00"].includes(x.s)), String(s.length));
check("tilstødende tider stadig ledige", s.some((x) => x.s === "09:00:00") && s.some((x) => x.s === "11:00:00"));
s = await slots(db, SVC.herre, "2026-11-03", NOW);
check("herreklip 45 min respekterer booking", s.length === 14 && !s.some((x) => x.s === "09:30:00"), String(s.length));

r = await book(db, SVC.dame, "2026-11-03", "10:00", NOW);
check("samme tid kan ikke bookes igen", r.err?.hint === "slot_unavailable", JSON.stringify(r.err));
r = await book(db, SVC.herre, "2026-11-03", "10:30", NOW);
check("overlappende tid afvises", r.err?.hint === "slot_unavailable");
r = await tryq(db, `insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status) values ('${SVC.dame}', 'X', 'x@example.com', '12345678', '2026-11-03', '10:30', '11:30', 'pending')`);
check("databasen afviser overlap direkte (exclusion constraint)", r.err?.code === "23P01", JSON.stringify(r.err));

await db.query("update public.appointments set status = 'cancelled' where id = $1", [b1.id]);
check("aflyst booking frigiver tiden", (await slots(db, SVC.dame, "2026-11-03", NOW)).length === 17);
r = await book(db, SVC.herre, "2026-11-03", "10:30", NOW);
check("ny booking på frigivet tid", !!r.rows?.[0]?.r?.id, JSON.stringify(r.err));
r = await tryq(db, "update public.appointments set status = 'pending' where id = $1", [b1.id]);
check("genåbning af aflyst booking i optaget tid afvises", r.err?.code === "23P01");
await db.query("update public.appointments set status = 'completed' where full_name = 'Test Kunde' and appointment_date = '2026-11-03'");
check("gennemført booking blokerer stadig", !(await slots(db, SVC.dame, "2026-11-03", NOW)).some((x) => x.s === "10:30:00"));

// Validering
const bad = async (over, hint, label, time = "14:00", svc = SVC.dame) => {
  const x = await book(db, svc, "2026-11-05", time, NOW, over);
  check(label, x.err?.hint === hint, JSON.stringify(x.err ?? x.rows));
};
await bad({ name: "A" }, "invalid_name", "for kort navn afvises");
await bad({ email: "anna@" }, "invalid_email", "ugyldig e-mail afvises");
await bad({ phone: "1234" }, "invalid_phone", "for kort telefonnummer afvises");
await bad({ phone: "ring mig" }, "invalid_phone", "telefon med bogstaver afvises");
await bad({ notes: "x".repeat(501) }, "invalid_notes", "for lang bemærkning afvises");
await bad({}, "slot_unavailable", "tid uden for interval afvises", "14:15");
await bad({}, "slot_unavailable", "tid før åbning afvises", "08:00");
await bad({}, "slot_unavailable", "tid der går over lukketid afvises", "17:30");
await db.query("update public.services set is_active = false where id = $1", [SVC.kur]);
await bad({}, "service_unavailable", "inaktiv behandling afvises", "14:00", SVC.kur);
check("inaktiv behandling har ingen tider", (await slots(db, SVC.kur, "2026-11-05", NOW)).length === 0);
await db.query("update public.services set is_active = true where id = $1", [SVC.kur]);

// Grænse pr. kunde
for (const t of ["09:00", "11:00", "13:00"]) await book(db, SVC.dame, "2026-11-12", t, NOW, { email: "gentag@example.com", phone: "11111111" });
r = await book(db, SVC.dame, "2026-11-12", "15:00", NOW, { email: "gentag@example.com", phone: "22222222" });
check("højst 3 kommende bookinger pr. e-mail", r.err?.hint === "too_many_bookings", JSON.stringify(r.err));
r = await book(db, SVC.dame, "2026-11-12", "15:00", NOW, { email: "ny@example.com", phone: "+45 11 11 11 11" });
check("højst 3 kommende bookinger pr. telefon", r.err?.hint === "too_many_bookings", JSON.stringify(r.err));

// Bremse mod masseindsendelse
await db.exec(`insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status)
  select '${SVC.dame}', 'Flood', 'f' || g || '@example.com', '12345678', date '2026-12-01' + g, '09:00', '10:00', 'pending' from generate_series(1, 20) g`);
r = await book(db, SVC.dame, "2026-11-13", "09:00", NOW);
check("bremse ved >20 bookinger på 15 min", r.err?.hint === "too_busy", JSON.stringify(r.err));
await db.exec("delete from public.appointments where full_name = 'Flood'");

// Midnat: åbent til 24.00
await db.exec("update public.business_hours set end_time = '24:00' where weekday = 2");
s = await slots(db, SVC.dame, "2026-11-10", NOW);
check("åbent til 24.00: sidste tid slutter 24.00", s.at(-1)?.s === "23:00:00" && s.at(-1)?.e === "24:00:00", JSON.stringify(s.at(-1)));
r = await book(db, SVC.dame, "2026-11-10", "23:00", NOW);
check("booking der slutter 24.00 kan gemmes", r.rows?.[0]?.r?.end_time === "24:00:00", JSON.stringify(r.err));
await db.exec("update public.business_hours set end_time = '18:00' where weekday = 2");

// =====================================================================
console.log("3) Kalenderstatus (get_available_dates, rigtig tid)");
const today = (await rows(db, "select ((now() at time zone 'Europe/Copenhagen')::date)::text d"))[0].d;
const cal = await rows(db, "select calendar_date::text d, status, free_slots from public.get_available_dates($1, $2::date - 3, $2::date + 70)", [SVC.dame, today]);
check("højst 63 dage pr. kald", cal.length === 63, String(cal.length));
check("fortid = unavailable", cal[0].status === "unavailable");
check("søndage = closed", cal.filter((c) => new Date(c.d + "T12:00:00Z").getUTCDay() === 0 && c.status !== "unavailable").every((c) => c.status === "closed"));
const future = cal.filter((c) => c.d > today && c.status !== "unavailable");
check("hverdage har ledige tider", future.some((c) => c.status === "available"));
const sat = future.find((c) => new Date(c.d + "T12:00:00Z").getUTCDay() === 6 && c.status === "available");
await db.exec(`update public.business_hours set start_time = '10:00', end_time = '11:00' where weekday = 6`);
await db.query(`insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status) values ($1, 'Fuld', 'fuld@example.com', '12345678', $2, '10:00', '11:00', 'confirmed')`, [SVC.dame, sat.d]);
const cal2 = await rows(db, "select status from public.get_available_dates($1, $2::date, $2::date)", [SVC.dame, sat.d]);
check("fuldt booket dag = full", cal2[0]?.status === "full", JSON.stringify(cal2));
await db.exec(`update public.business_hours set start_time = '10:00', end_time = '16:00' where weekday = 6`);
await db.exec("delete from public.appointments where full_name = 'Fuld'");
check("inaktiv/ukendt behandling giver ingen dage", (await rows(db, "select * from public.get_available_dates('00000000-0000-4000-8000-000000000000', current_date, current_date + 5)")).length === 0);

// =====================================================================
console.log("4) Adgang: anonym, almindelig bruger og administrator");
await db.query("update public.services set is_active = false where id = $1", [SVC.kur]);
let a = await as(db, "anon", null, "select name from public.services");
check("anon ser kun aktive behandlinger", a.rows?.length === 4, JSON.stringify(a));
check("anon ser åbningstider", (await as(db, "anon", null, "select * from public.business_hours")).rows?.length === 7);
a = await as(db, "anon", null, "select salon_name, salon_email, salon_phone from public.salon_settings");
check("anon ser saloninformation", a.rows?.length === 1);
for (const [label, sql] of [
  ["læse bookinger", "select * from public.appointments"],
  ["læse lukkedage", "select * from public.blocked_dates"],
  ["læse administratorer", "select * from public.admin_users"],
  ["oprette booking direkte", `insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time) values ('${SVC.dame}','Hacker','h@example.com','12345678','2026-11-20','15:00','16:00')`],
  ["rette pris", "update public.services set price = 1"],
  ["oprette behandling", "insert into public.services (name, duration_minutes, price) values ('X', 30, 1)"],
  ["slette behandling", "delete from public.services"],
  ["rette saloninfo", "update public.salon_settings set salon_name = 'Hacket'"],
  ["rette åbningstider", "update public.business_hours set is_open = false"],
  ["gøre sig til administrator", `insert into public.admin_users (user_id) values ('${USER}')`],
  ["kalde private funktioner", `select * from salon_private.free_slots('${SVC.dame}', current_date, now())`],
]) {
  const x = await as(db, "anon", null, sql);
  check(`anon kan ikke ${label}`, x.err?.code === "42501", JSON.stringify(x));
}
check("anon: is_admin() = false", (await as(db, "anon", null, "select public.is_admin() v")).rows?.[0]?.v === false);

// Offentlige funktioner som anon (rigtig tid; vælg første ledige dag)
const freeDay = cal.find((c) => c.status === "available" && c.d > today)?.d;
a = await as(db, "anon", null, "select start_time::text s from public.get_available_slots($1, $2::date)", [SVC.dame, freeDay]);
check("anon kan se ledige tider", a.rows?.length > 0, JSON.stringify(a.err));
check("ledige tider indeholder ingen kundedata", a.rows && Object.keys(a.rows[0]).length === 1);
const slotTime = a.rows[0].s;
a = await as(db, "anon", null, "select public.create_booking($1, $2::date, $3::time, 'Offentlig Kunde', 'off@example.com', '87654321', 'Hej') r", [SVC.dame, freeDay, slotTime]);
const pub = a.rows?.[0]?.r;
check("anon kan booke via create_booking", pub?.status === "pending", JSON.stringify(a.err));
a = await as(db, "anon", null, "select public.get_booking_receipt($1) r", [pub.id]);
const rec = a.rows?.[0]?.r;
check("kvittering viser status", rec?.status === "pending" && rec?.service_name === "Dameklip");
check("kvittering uden personoplysninger", rec && !("full_name" in rec) && !("email" in rec) && !("phone" in rec) && !("notes" in rec), JSON.stringify(rec));
a = await as(db, "anon", null, "select public.create_booking($1, $2::date, $3::time, 'Anden Kunde', 'anden@example.com', '87654322') r", [SVC.dame, freeDay, slotTime]);
check("anon kan ikke dobbeltbooke", a.err?.hint === "slot_unavailable", JSON.stringify(a));

// Almindelig indlogget bruger (fx via offentlig registrering)
for (const [label, sql, expect] of [
  ["se bookinger", "select * from public.appointments", "empty"],
  ["se lukkedage", "select * from public.blocked_dates", "empty"],
  ["se andre administratorer", "select * from public.admin_users", "empty"],
  ["ændre status", "update public.appointments set status = 'cancelled' returning id", "empty"],
  ["rette pris", "update public.services set price = 1 returning id", "empty"],
  ["rette saloninfo", "update public.salon_settings set salon_name = 'X' returning id", "empty"],
  ["rette åbningstider", "update public.business_hours set is_open = false returning id", "empty"],
  ["oprette behandling", "insert into public.services (name, duration_minutes, price) values ('X', 30, 1)", "denied"],
  ["oprette lukkedag", "insert into public.blocked_dates (blocked_date) values ('2026-12-24')", "denied"],
  ["gøre sig til administrator", `insert into public.admin_users (user_id) values ('${USER}')`, "denied"],
  ["slette bookinger", "delete from public.appointments", "denied"],
  ["se inaktive behandlinger", `select * from public.services where id = '${SVC.kur}'`, "empty"],
]) {
  const x = await as(db, "authenticated", USER, sql);
  const ok = expect === "empty" ? x.rows?.length === 0 : x.err?.code === "42501";
  check(`almindelig bruger kan ikke ${label}`, ok, JSON.stringify(x));
}
check("almindelig bruger: is_admin() = false", (await as(db, "authenticated", USER, "select public.is_admin() v")).rows?.[0]?.v === false);

// Administrator
await db.exec(`insert into public.admin_users (user_id) values ('${ADMIN}')`);
check("admin: is_admin() = true", (await as(db, "authenticated", ADMIN, "select public.is_admin() v")).rows?.[0]?.v === true);
a = await as(db, "authenticated", ADMIN, "select id, full_name, email, phone, notes from public.appointments");
check("admin ser bookinger med kundedata", a.rows?.length > 3, JSON.stringify(a.err));
a = await as(db, "authenticated", ADMIN, "update public.appointments set status = 'confirmed' where id = $1 returning status", [pub.id]);
check("admin kan bekræfte booking", a.rows?.[0]?.status === "confirmed", JSON.stringify(a));
a = await as(db, "anon", null, "select public.get_booking_receipt($1) r", [pub.id]);
check("kvittering viser bekræftet efter admin", a.rows?.[0]?.r?.status === "confirmed");
a = await as(db, "authenticated", ADMIN, "update public.appointments set full_name = 'Ændret' where id = $1", [pub.id]);
check("admin kan kun ændre status (ikke kundedata)", a.err?.code === "42501", JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, "delete from public.appointments where id = $1", [pub.id]);
check("bookinger kan ikke slettes via API", a.err?.code === "42501");
a = await as(db, "authenticated", ADMIN, "update public.appointments set status = 'pending' where id = $1", [b1.id]);
check("admin-genåbning i optaget tid afvises af databasen", a.err?.code === "23P01", JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, "select count(*)::int n from public.services");
check("admin ser også inaktive behandlinger", a.rows?.[0]?.n === 5);
a = await as(db, "authenticated", ADMIN, "update public.services set price = 525, price_is_demo = false where id = $1 returning price::text", [SVC.dame]);
check("admin kan rette pris", a.rows?.[0]?.price === "525.00", JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, "update public.services set duration_minutes = 75 where id = $1 returning duration_minutes", [SVC.dame]);
check("admin kan rette varighed", a.rows?.[0]?.duration_minutes === 75);
a = await as(db, "authenticated", ADMIN, "update public.services set duration_minutes = 2 where id = $1", [SVC.dame]);
check("urimelig varighed afvises", a.err?.code === "23514");
await db.query("update public.services set duration_minutes = 60 where id = $1", [SVC.dame]);
a = await as(db, "authenticated", ADMIN, "insert into public.services (name, description, duration_minutes, price, price_is_demo) values ('Børneklip', 'Til børn under 12 år.', 30, 250, false) returning id");
check("admin kan oprette behandling", !!a.rows?.[0]?.id, JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, "delete from public.services where name = 'Børneklip'");
check("behandlinger kan ikke slettes (kun skjules)", a.err?.code === "42501");
a = await as(db, "authenticated", ADMIN, "insert into public.blocked_dates (blocked_date, reason) values ('2026-12-24', 'Juleaften') returning id");
check("admin kan oprette lukkedag", !!a.rows?.[0]?.id, JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, "delete from public.blocked_dates where blocked_date = '2026-12-24' returning id");
check("admin kan fjerne lukkedag", a.rows?.length === 1);
a = await as(db, "authenticated", ADMIN, "update public.salon_settings set salon_name = 'Salon Test', booking_window_days = 90, is_demo = false returning salon_name");
check("admin kan rette saloninfo og bookingindstillinger", a.rows?.[0]?.salon_name === "Salon Test", JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, "update public.salon_settings set slot_interval_minutes = 0");
check("ugyldigt interval afvises", a.err?.code === "23514");
a = await as(db, "authenticated", ADMIN, "update public.business_hours set start_time = '18:00', end_time = '09:00' where weekday = 1");
check("åbningstid med slut før start afvises", a.err?.code === "23514");
a = await as(db, "authenticated", ADMIN, "update public.business_hours set start_time = '08:30' where weekday = 1 returning start_time::text");
check("admin kan rette åbningstider", a.rows?.[0]?.start_time === "08:30:00", JSON.stringify(a));
a = await as(db, "authenticated", ADMIN, `insert into public.admin_users (user_id) values ('${USER}')`);
check("admin kan heller ikke udnævne administratorer via API", a.err?.code === "42501");

// =====================================================================
console.log("5) Kontrolscripts, test uden spor og tilbagerulning");
for (const f of ["1-kontrol-foer.sql", "3-kontrol-efter.sql"]) {
  let sql;
  try { sql = read(`${DB_DIR}/${f}`); } catch { check(`${f} findes`, false); continue; }
  const x = await tryq(db, sql);
  check(`${f} kører`, !x.err, x.err?.message);
  if (f === "3-kontrol-efter.sql" && x.rows) {
    const alt = x.rows.find((row) => row.kontrol === "alt_ok");
    check("efterkontrol: alt_ok = true", alt?.ok === true, JSON.stringify(x.rows.filter((row) => row.ok === false)));
  }
}
try {
  const testSql = read(`${DB_DIR}/4-test-uden-spor.sql`);
  const countBefore = (await rows(db, "select count(*)::int n from public.appointments"))[0].n;
  const settingsBefore = JSON.stringify(await rows(db, "select * from public.salon_settings"));
  const x = await tryq(db, testSql);
  check("4-test-uden-spor: TEST OK", /TEST OK/.test(x.err?.message ?? ""), x.err?.message ?? "ingen fejlbesked");
  check("4-test-uden-spor efterlader intet", (await rows(db, "select count(*)::int n from public.appointments"))[0].n === countBefore && JSON.stringify(await rows(db, "select * from public.salon_settings")) === settingsBefore);
  console.log("   besked:", x.err?.message);
} catch (e) { check("4-test-uden-spor.sql findes", false, e.message); }

try {
  const rb = read(`${DB_DIR}/tilbagerulning.sql`);
  const x = await tryq(db, rb);
  check("tilbagerulning kører", !x.err, x.err?.message);
  const after = (await rows(db, "select tablename, policyname from pg_policies where schemaname='public' order by 1,2")).map((r) => `${r.tablename}:${r.policyname}`);
  check("oprindelige politikker genskabt", JSON.stringify(after) === JSON.stringify(policiesBefore), after.join(" | "));
  check("funktioner fjernet", (await rows(db, "select count(*)::int n from pg_proc where proname in ('get_available_slots','create_booking','get_booking_receipt','get_available_dates','is_admin')"))[0].n === 0);
  check("overlap-regel fjernet", (await rows(db, "select count(*)::int n from pg_constraint where conname = 'appointments_no_overlap'"))[0].n === 0);
  const names2 = (await rows(db, "select name from public.services order by name")).map((x) => x.name).join(",");
  check("eksempelnavne tilbage, ejerændringer bevaret", names2.includes("Men's Haircut") && names2.includes("Børneklip"), names2);
  check("ejerens rettede pris bevaret ved tilbagerulning", (await rows(db, "select price::text p from public.services where id = $1", [SVC.dame]))[0].p === "525.00");
  check("bookinger bevaret", (await rows(db, "select count(*)::int n from public.appointments"))[0].n > 3);
  const again = await tryq(db, MIGRATION);
  check("migration kan køres igen efter tilbagerulning", !again.err, again.err?.message);
} catch (e) { check("tilbagerulning.sql findes", false, e.message); }
await db.close();

// =====================================================================
console.log("6) Variant: løsere skema (nullable, ingen checks, åben adgang, RLS slået fra)");
const VARIANT = ORIGINAL
  .replace(/ not null/g, "")
  .replace(/ unique/g, "")
  .replace(/ check \(status in \('pending','confirmed','cancelled','completed'\)\)/, "")
  .replace(/ check \(weekday between 0 and 6\)/, "")
  .replace(/create policy[\s\S]*$/m, "")
  .replace(/alter table public\.(appointments|admin_users) enable row level security;/g, "")
  + "\ncreate policy \"Open\" on public.services for all using (true) with check (true);\n";
db = await fresh(VARIANT);
await db.exec("insert into public.business_hours (weekday, is_open, start_time, end_time) values (2, true, '13:00', '15:00')");
await db.exec("update public.business_hours set end_time = '12:00' where weekday = 2 and start_time = '09:00'");
r = await tryq(db, MIGRATION);
check("variant: migration kører", !r.err, r.err?.message);
s = await slots(db, SVC.dame, "2026-11-03", NOW);
check("variant: to åbningsperioder (frokostpause) respekteres", s.map((x) => x.s).join(",") === "09:00:00,09:30:00,10:00:00,10:30:00,11:00:00,13:00:00,13:30:00,14:00:00", s.map((x) => x.s).join(","));
check("variant: RLS slået til på alle tabeller", (await rows(db, "select bool_and(relrowsecurity) v from pg_class where relname in ('services','appointments','business_hours','blocked_dates','salon_settings','admin_users') and relnamespace = 'public'::regnamespace"))[0].v === true);
check("variant: anon kan ikke læse bookinger", (await as(db, "anon", null, "select * from public.appointments")).err?.code === "42501");
check("variant: åben politik fjernet", (await as(db, "anon", null, "update public.services set price = 1")).err?.code === "42501");
await db.close();

console.log("7) Variant: eksisterende overlappende aftaler stopper migrationen uden ændringer");
db = await fresh();
await db.exec(`insert into public.appointments (service_id, full_name, email, phone, appointment_date, start_time, end_time, status) values
  ('${SVC.dame}', 'A', 'a@example.com', '12345678', '2026-11-20', '10:00', '11:00', 'pending'),
  ('${SVC.dame}', 'B', 'b@example.com', '12345679', '2026-11-20', '10:30', '11:30', 'confirmed')`);
r = await tryq(db, MIGRATION);
check("overlap: migration stopper med forklaring", /overlapper/.test(r.err?.message ?? ""), r.err?.message);
try { await db.exec("rollback"); } catch {}
check("overlap: intet ændret", (await rows(db, "select count(*)::int n from public.services where name = 'Dameklip'"))[0].n === 0
  && (await rows(db, "select count(*)::int n from pg_policies where schemaname='public'"))[0].n === policiesBefore.length);
await db.close();

// =====================================================================
console.log(`\n${passed} bestået, ${failures.length} fejlet`);
for (const f of failures) console.log("  ✗ " + f);
process.exit(failures.length ? 1 : 0);
