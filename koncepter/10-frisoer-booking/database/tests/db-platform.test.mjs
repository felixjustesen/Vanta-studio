// Test af 10-forbindelse-til-platform.sql (forbindelsen til Vanta Platform) mod PGlite.
// pg_net, pg_cron og Vault efterlignes (platform-stub.sql); kaldene sendes over
// rigtig HTTP til en falsk platform, der bruger Vanta Platforms egen validering.
// Rører hverken Supabase eller nogen rigtig platform.
// Kør fra denne mappe: node db-platform.test.mjs
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startMockPlatform, pumpNet, tick, TEST_PLATFORM } from "./platform-mock.mjs";
import { validateAppointments } from "./platform-contract.mjs";

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
const PLATFORM_STUB = read(HERE + "platform-stub.sql");
const ORIGINAL = read(HERE + "original.sql");
const M2 = read(DB_DIR + "/2-migration.sql");
const M6 = read(DB_DIR + "/6-migration-flere-frisoerer.sql");
const M10 = read(DB_DIR + "/10-forbindelse-til-platform.sql");
const T11 = read(DB_DIR + "/11-test-forbindelse.sql");
const ROLLBACK = read(DB_DIR + "/tilbagerulning-forbindelse.sql");
const KONTROL = read(DB_DIR + "/7-kontrol-flere-frisoerer.sql");
const T8 = read(DB_DIR + "/8-test-flere-frisoerer.sql");

const SVC = { dame: "46d76786-57c6-4325-9d23-f07b991f064b", herre: "6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900" };
const ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "bbbbbbbb-0000-4000-8000-000000000002";
const BARBER = "cccccccc-0000-4000-8000-000000000003";
const KEY = `vk_live_${"Ab1-".repeat(10)}xyz`;
const KEY2 = `vk_live_${"Zz9_".repeat(10)}abc`;
const NOW = "2026-11-02T07:00:00Z"; // mandag kl. 8.00 dansk tid

let passed = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) passed++;
  else failures.push(`${name}${detail ? " – " + detail : ""}`);
}

async function fresh({ stub = true, m6 = true, m10 = true } = {}) {
  const db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec("set timezone = 'UTC'");
  await db.exec(STUB);
  await db.exec(ORIGINAL);
  await db.exec(`insert into auth.users (id, email) values
    ('${ADMIN}', 'admin@test.dk'), ('${USER}', 'bruger@test.dk'), ('${BARBER}', 'frisoer@test.dk')`);
  await db.exec(M2);
  await db.exec(`insert into public.admin_users (user_id) values ('${ADMIN}')`);
  if (m6) {
    await db.exec(M6);
    await db.exec(`insert into public.staff_users (user_id, staff_id) select '${BARBER}', id from public.staff where name = 'Mikkel'`);
  }
  if (stub) await db.exec(PLATFORM_STUB);
  if (m10) await db.exec(M10);
  return db;
}

const rows = async (db, sql, params = []) => (await db.query(sql, params)).rows;
const one = async (db, sql, params = []) => (await rows(db, sql, params))[0];

async function tryq(db, sql, params = []) {
  try {
    if (params.length === 0) return { rows: (await db.exec(sql)).at(-1)?.rows ?? [] };
    return { rows: (await db.query(sql, params)).rows };
  } catch (e) {
    try { await db.exec("rollback"); } catch {}
    return { err: { code: e.code, message: e.message, hint: e.hint } };
  }
}

async function as(db, role, sub, sql, params = []) {
  try {
    await db.exec("begin");
    await db.query("select set_config('role', $1, true)", [role]);
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(sub ? { sub, role } : { role })]);
    const out = (await db.query(sql, params)).rows;
    await db.exec("commit");
    return { rows: out };
  } catch (e) {
    try { await db.exec("rollback"); } catch {}
    return { err: { code: e.code, message: e.message, hint: e.hint } };
  }
}
const anon = (db, sql, params) => as(db, "anon", null, sql, params);
const user = (db, id, sql, params) => as(db, "authenticated", id, sql, params);

const save = (db, { enabled = true, url = TEST_PLATFORM, key = null, auto = false } = {}, who = ADMIN) =>
  user(db, who, "select public.save_platform_link($1, $2, $3, $4) as r", [enabled, url, key, auto]);
const link = async (db, who = ADMIN) => (await user(db, who, "select public.get_platform_link() as r")).rows?.[0]?.r;
const settings = (db) => one(db, "select * from salon_private.platform_settings");
const syncRow = (db, id) => one(db, "select * from salon_private.platform_sync where appointment_id = $1", [id]);
const staffId = async (db, name) => (await one(db, "select id from public.staff where name = $1", [name])).id;

async function insertAppt(db, { staff = "Anna", svc = SVC.dame, name = "Mette Holm", email = "mette@example.dk", phone = "12 34 56 78", date = "2026-11-20", start = "10:00", end = "11:00", status = "pending", notes = null } = {}) {
  return (await one(db, `insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time, status, notes)
    values ($1, (select id from public.staff where name = $2), $3, $4, $5, $6::date, $7::time, $8::time, $9, $10) returning id`,
    [svc, staff, name, email, phone, date, start, end, status, notes])).id;
}

const payload = async (db, id) => (await one(db, "select salon_private.platform_payload($1) as p", [id])).p;
const problem = async (db, id) => (await one(db, "select salon_private.platform_payload_problem(salon_private.platform_payload($1)) as p", [id])).p;

const mock = await startMockPlatform({ key: KEY });
const net = { map: (u) => u.replace(TEST_PLATFORM, mock.url) };

// =====================================================================
console.log("1) Installation");
{
  const noExt = await fresh({ stub: false, m10: false });
  const r = await tryq(noExt, M10);
  check("uden pg_net: tydelig fejl", /pg_net mangler/.test(r.err?.message || ""), r.err?.message);
  check("uden pg_net: intet ændret", (await one(noExt, "select to_regclass('salon_private.platform_settings') is null as n")).n
    && (await one(noExt, "select count(*)::int n from pg_trigger where tgname = 'platform_mark_changed'")).n === 0);
  await noExt.close();

  const noM6 = await fresh({ m6: false, m10: false });
  const r6 = await tryq(noM6, M10);
  check("uden migration 6: tydelig fejl", /Kør 6-migration/.test(r6.err?.message || ""), r6.err?.message);
  await noM6.close();
}

const db = await fresh({ m10: false });
{
  await insertAppt(db, { name: "Før Forbindelsen", date: "2026-11-19" });
  const r = await tryq(db, M10);
  check("migrationen kører", !r.err, r.err?.message);
  check("resultat: slået fra og job planlagt", r.rows?.[0]?.status === "Forbindelsen er installeret og slået fra." && Number(r.rows?.[0]?.job_planlagt) === 1, JSON.stringify(r.rows));
  const s = await settings(db);
  check("indstillinger: slået fra, ingen nøgle", s.enabled === false && s.api_key_id === null && s.auto_complete === false && s.generation === 1);
  const jobs = await rows(db, "select schedule, command, active from cron.job where jobname = 'vanta-platform-sync'");
  check("ét job hvert minut", jobs.length === 1 && jobs[0].schedule === "* * * * *" && jobs[0].command === "select salon_private.platform_sync_run()" && jobs[0].active);
  check("eksisterende bookinger ikke i kø, når forbindelsen er slået fra", (await one(db, "select count(*)::int n from salon_private.platform_sync")).n === 0);
  const k = await tryq(db, KONTROL);
  check("7-kontrol: alt_ok efter migration 10", k.rows?.find((x) => x.kontrol === "alt_ok")?.ok === true);

  await save(db, { key: KEY });
  const before = await settings(db);
  const again = await tryq(db, M10);
  const after = await settings(db);
  check("migrationen kan køres igen", !again.err, again.err?.message);
  check("genkørsel: stadig ét job", (await one(db, "select count(*)::int n from cron.job where jobname = 'vanta-platform-sync'")).n === 1);
  check("genkørsel: indstillinger og nøgle bevaret", after.enabled === true && after.api_key_id === before.api_key_id && after.generation === before.generation && after.api_url === TEST_PLATFORM);
  check("genkørsel: én nøgle i Vault", (await one(db, "select count(*)::int n from vault.secrets")).n === 1);
  // Tilbage til udgangspunktet: ingen forbindelse og ingen nøgle
  await db.exec(`update salon_private.platform_settings set enabled = false, api_url = null, api_key_id = null, api_key_prefix = null;
    delete from vault.secrets; delete from salon_private.platform_sync;`);
}

// =====================================================================
console.log("2) Data til platformen (platformens egen validering)");
{
  const winter = await insertAppt(db, { name: "Mette  Holm Jensen", email: "Mette.Holm@Example.DK", phone: "+45 12 34 56 78", date: "2026-11-24", notes: "HEMMELIG NOTE" });
  const summer = await insertAppt(db, { staff: "Sara", name: "Ida", email: "ida@example.dk", phone: "0045 87654321", date: "2027-06-15", start: "10:00", end: "10:45", status: "confirmed" });
  const p = await payload(db, winter);
  const item = p.items[0];
  check("external_id er bookingens id", item.external_id === winter);
  check("vintertid: 10.00 → 09.00 UTC", item.starts_at === "2026-11-24T09:00:00Z" && item.ends_at === "2026-11-24T10:00:00Z", `${item.starts_at} ${item.ends_at}`);
  check("sommertid: 10.00 → 08.00 UTC", (await payload(db, summer)).items[0].starts_at === "2027-06-15T08:00:00Z");
  check("navn deles i fornavn og efternavn", item.customer.first_name === "Mette" && item.customer.last_name === "Holm Jensen", JSON.stringify(item.customer));
  check("enkelt navn: intet efternavn", !("last_name" in (await payload(db, summer)).items[0].customer));
  check("e-mail med små bogstaver", item.customer.email === "mette.holm@example.dk");
  check("behandling, frisør og pris", item.service_name === "Dameklip" && item.staff_name === "Anna" && Number(item.price_amount) === 495 && item.currency === "DKK", JSON.stringify(item));
  check("bemærkningen sendes ikke", !JSON.stringify(p).includes("HEMMELIG") && !("notes" in item));
  check("intet marketingsamtykke", !("marketing_consent" in item.customer));
  const statuses = {};
  for (const st of ["pending", "confirmed", "cancelled", "completed"]) {
    await db.query("update public.appointments set status = $1 where id = $2", [st, winter]);
    statuses[st] = (await payload(db, winter)).items[0].status;
  }
  check("status: afventer og bekræftet → booked, aflyst → cancelled, gennemført → completed",
    statuses.pending === "booked" && statuses.confirmed === "booked" && statuses.cancelled === "cancelled" && statuses.completed === "completed", JSON.stringify(statuses));

  // Gamle rækker med data, platformen ikke kan læse
  const badPhone = await insertAppt(db, { staff: "Mikkel", svc: SVC.herre, name: "Ole", email: "ole@example.dk", phone: "ring efter kl 16", date: "2026-11-25", start: "10:00", end: "10:45" });
  const badEmail = await insertAppt(db, { staff: "Mikkel", svc: SVC.herre, name: "Kåre", email: "kåre@mail.dk", phone: "87654321", date: "2026-11-25", start: "11:00", end: "11:45" });
  const nothing = await insertAppt(db, { staff: "Mikkel", svc: SVC.herre, name: "Ukendt", email: "ingen", phone: "123", date: "2026-11-25", start: "12:00", end: "12:45" });
  const noName = await insertAppt(db, { staff: "Mikkel", svc: SVC.herre, name: "   ", email: "x@example.dk", date: "2026-11-25", start: "13:00", end: "13:45" });
  const pb = await payload(db, badPhone);
  check("ulæseligt telefonnummer udelades", !("phone" in pb.items[0].customer) && pb.items[0].customer.email === "ole@example.dk");
  const pe = await payload(db, badEmail);
  check("e-mail med æøå udelades (platformen ville afvise den)", !("email" in pe.items[0].customer) && pe.items[0].customer.phone === "87654321");
  check("hverken e-mail eller telefon: sendes ikke", /e-mail eller et telefonnummer/.test(await problem(db, nothing) || ""));
  check("intet navn: sendes ikke", /navn/.test(await problem(db, noName) || ""));

  // Alle bookinger, der kan sendes, skal godkendes af platformens validering
  const all = await rows(db, "select id from public.appointments");
  let valid = 0, sendable = 0;
  const invalid = [];
  for (const { id } of all) {
    if (await problem(db, id)) continue;
    sendable++;
    const v = validateAppointments(await payload(db, id));
    if (v.ok) valid++;
    else invalid.push(JSON.stringify(v.issues));
  }
  check("alle sendbare bookinger godkendes af platformens validering", sendable >= 4 && valid === sendable, invalid.join("; "));
  check("telefonnumre normaliseres af platformen", validateAppointments(await payload(db, summer)).data?.items[0].customer.phone === "+4587654321");
  await db.exec(`delete from public.appointments where id in ('${badPhone}', '${badEmail}', '${nothing}', '${noName}', '${winter}', '${summer}')`);
}

// =====================================================================
console.log("3) Adgang");
{
  const a = await anon(db, "select public.get_platform_link() as r");
  check("anonyme kan ikke se forbindelsen", a.err?.code === "42501", JSON.stringify(a.err));
  const a2 = await anon(db, "select public.save_platform_link(true, 'https://x.dk', $1, false) as r", [KEY]);
  check("anonyme kan ikke ændre forbindelsen", a2.err?.code === "42501");
  const a3 = await anon(db, "select public.platform_link_enabled() as r");
  check("anonyme kan se, om forbindelsen er slået til", a3.rows?.[0]?.r === false, JSON.stringify(a3));
  const a4 = await anon(db, "select * from salon_private.platform_settings");
  check("anonyme kan ikke læse indstillingerne", a4.err?.code === "42501");
  const a5 = await anon(db, "select salon_private.platform_sync_run()");
  check("anonyme kan ikke køre jobbet", a5.err?.code === "42501");
  const a6 = await anon(db, "select * from vault.decrypted_secrets");
  check("anonyme kan ikke læse Vault", a6.err?.code === "42501");

  const u = await user(db, USER, "select public.get_platform_link() as r");
  check("bruger uden rolle kan ikke se forbindelsen", u.err?.code === "42501");
  const u2 = await save(db, { key: KEY }, USER);
  check("bruger uden rolle kan ikke ændre forbindelsen", u2.err?.code === "42501");
  const u3 = await user(db, USER, "select public.resend_platform_sync() as r");
  check("bruger uden rolle kan ikke sende igen", u3.err?.code === "42501");
  const b = await user(db, BARBER, "select public.get_platform_link() as r");
  check("frisør kan ikke se forbindelsen", b.err?.code === "42501");
  const b2 = await user(db, BARBER, "select * from salon_private.platform_sync");
  check("frisør kan ikke læse køen", b2.err?.code === "42501");

  const ad = await link(db);
  check("administrator kan se forbindelsen", ad?.enabled === false && "queued" in ad && Array.isArray(ad.failures), JSON.stringify(ad));

  const bad1 = await save(db, { url: "http://platform.test", key: KEY });
  check("adresse uden https afvises", bad1.err?.hint === "invalid_platform_url", JSON.stringify(bad1.err));
  const bad2 = await save(db, { url: "https://platform.test/api", key: KEY });
  check("adresse med sti afvises", bad2.err?.hint === "invalid_platform_url");
  const bad3 = await save(db, { key: "sk_live_forkert" });
  check("forkert nøgle afvises", bad3.err?.hint === "invalid_api_key");
  const bad4 = await save(db, { enabled: true, key: null });
  check("kan ikke slås til uden nøgle", bad4.err?.hint === "platform_incomplete");
  const bad5 = await user(db, ADMIN, "select public.resend_platform_sync() as r");
  check("send igen kræver, at forbindelsen er slået til", bad5.err?.hint === "platform_disabled");
  check("ingen nøgle gemt efter afviste forsøg", (await one(db, "select count(*)::int n from vault.secrets")).n === 0 && (await settings(db)).enabled === false);
}

// =====================================================================
console.log("4) Kø og trigger");
const existing = (await one(db, "select count(*)::int n from public.appointments")).n;
{
  const off = await insertAppt(db, { name: "Slået Fra", date: "2026-11-26" });
  check("slået fra: ny booking sættes ikke i kø", !(await syncRow(db, off)));

  const s0 = await settings(db);
  const r = await save(db, { key: KEY });
  const s1 = await settings(db);
  check("slå til: svar uden nøglen", r.rows?.[0]?.r?.enabled === true && !JSON.stringify(r.rows?.[0]?.r).includes(KEY), JSON.stringify(r));
  check("slå til: nøglens begyndelse vises som på platformen", r.rows?.[0]?.r?.key_prefix === KEY.slice(0, 14));
  check("slå til: alle bookinger i kø", (await one(db, "select count(*)::int n from salon_private.platform_sync where pending")).n === existing + 1);
  check("slå til: ny generation", s1.generation === s0.generation + 1);
  check("nøglen ligger i Vault", (await one(db, "select count(*)::int n from vault.decrypted_secrets where id = $1 and decrypted_secret = $2", [s1.api_key_id, KEY])).n === 1);
  check("platform_link_enabled er nu sand", (await anon(db, "select public.platform_link_enabled() as r")).rows?.[0]?.r === true);

  // Kundens booking (anonym) og administratorens ændring
  const pub = await anon(db, "select public.create_booking($1, $2::date, '10:00'::time, 'Pia Public', 'pia@example.com', '+45 11 22 33 44') as r",
    [SVC.dame, (await one(db, "select ((now() at time zone 'Europe/Copenhagen')::date + 7 + ((2 - extract(dow from (now() at time zone 'Europe/Copenhagen')::date + 7)::int + 7) % 7))::text as d")).d]);
  const pubId = pub.rows?.[0]?.r?.id;
  check("kundens booking virker og sættes i kø", !!pubId && (await syncRow(db, pubId))?.pending === true && (await syncRow(db, pubId))?.change_seq === 1, JSON.stringify(pub.err || pub.rows));
  const up = await user(db, ADMIN, "update public.appointments set status = 'confirmed' where id = $1 returning id", [pubId]);
  check("administratorens ændring tæller op", up.rows?.length === 1 && (await syncRow(db, pubId)).change_seq === 2);
  const mikkelAppt = await insertAppt(db, { staff: "Mikkel", svc: SVC.herre, name: "Mikkels Kunde", date: "2026-11-27", start: "10:00", end: "10:45" });
  const bu = await user(db, BARBER, "update public.appointments set status = 'confirmed' where id = $1 returning id", [mikkelAppt]);
  check("frisørens ændring sættes også i kø", bu.rows?.length === 1 && (await syncRow(db, mikkelAppt)).change_seq === 2, JSON.stringify(bu));

  // En fejl i køen må aldrig stoppe en booking
  await db.exec("alter table salon_private.platform_sync add constraint test_blok check (appointment_id is null) not valid");
  const blocked = await tryq(db, `insert into public.appointments (service_id, staff_id, full_name, email, phone, appointment_date, start_time, end_time)
    values ('${SVC.dame}', (select id from public.staff where name = 'Sara'), 'Trods Fejl', 't@example.dk', '12345678', '2026-11-28', '10:00', '11:00') returning id`);
  check("fejl i køen stopper ikke bookingen", !blocked.err && !!blocked.rows?.[0]?.id, JSON.stringify(blocked.err));
  await db.exec("alter table salon_private.platform_sync drop constraint test_blok");
  check("bookingen findes, men står ikke i kø", !(await syncRow(db, blocked.rows[0].id)));
}

// =====================================================================
console.log("5) Afsendelse og svar");
{
  // Kun nogle få bookinger i kø for overskuelighedens skyld
  await db.exec("update salon_private.platform_sync set pending = false");
  const id = await insertAppt(db, { name: "Sofie Sendt", email: "sofie@example.dk", phone: "11223344", date: "2026-12-01", status: "pending" });
  mock.state.requests.length = 0;

  let t = await tick(db, net);
  let row = await syncRow(db, id);
  let got = mock.received(id);
  check("sendes ved næste kørsel", t.first.sent === 1 && t.pumped === 1 && got.length === 1, JSON.stringify(t));
  check("headere som platformen kræver", got[0]?.headers.authorization === `Bearer ${KEY}` && got[0]?.headers["x-vanta-source"] === "vanta_booking"
    && /^vb-\d+-[0-9a-f-]{36}-[0-9a-f]{32}$/.test(got[0]?.headers["idempotency-key"] || "") && got[0]?.path === "/api/v1/appointments", JSON.stringify(got[0]?.headers));
  check("platformen godkender data", got[0]?.status === 200);
  check("markeret som sendt", !row.pending && !row.failed && row.synced_key === got[0].headers["idempotency-key"] && row.request_id === null && row.attempts === 0);
  check("sidst sendt opdateret", !!(await settings(db)).last_success_at && (await link(db)).queued === 0);

  t = await tick(db, net);
  check("intet sendes igen uden ændringer", t.first.sent === 0 && mock.received(id).length === 1);

  await db.query("update public.appointments set status = 'confirmed' where id = $1", [id]);
  t = await tick(db, net);
  row = await syncRow(db, id);
  check("afventer → bekræftet giver samme data: intet kald", t.first.sent === 0 && t.first.skipped === 1 && !row.pending && mock.received(id).length === 1, JSON.stringify(t.first));

  await db.query("update public.appointments set status = 'completed' where id = $1", [id]);
  t = await tick(db, net);
  got = mock.received(id);
  check("gennemført sendes som completed", got.length === 2 && got[1].body.items[0].status === "completed" && got[1].status === 200);
  check("ny udgave har ny Idempotency-Key", got[0].headers["idempotency-key"] !== got[1].headers["idempotency-key"]);

  // Ændring, mens kaldet er undervejs: den nye udgave sendes efter svaret
  const setStatus = (status) => db.query("update public.appointments set status = $1 where id = $2", [status, id]);
  await setStatus("cancelled");
  await db.query("select salon_private.platform_sync_run()"); // kald A (aflyst) undervejs
  await setStatus("completed");
  await pumpNet(db, net); // A når frem
  await db.query("select salon_private.platform_sync_run()"); // svar på A, og B (gennemført) sendes
  row = await syncRow(db, id);
  check("ændring undervejs: den nye udgave sendes efter svaret", row.pending && row.request_id !== null && mock.received(id).at(-1).body.items[0].status === "cancelled", JSON.stringify({ pending: row.pending, req: row.request_id }));
  await tick(db, net);
  row = await syncRow(db, id);
  check("ændring undervejs: platformen ender med den nyeste udgave", !row.pending && mock.received(id).at(-1).body.items[0].status === "completed");

  // Mistet svar: samme nøgle sendes igen, og platformen svarer med det gemte svar
  await setStatus("cancelled");
  await db.query("select salon_private.platform_sync_run()");
  const lost = await syncRow(db, id);
  await pumpNet(db, net);
  await db.query("delete from net._http_response where id = $1", [lost.request_id]);
  await db.query("update salon_private.platform_sync set request_sent_at = now() - interval '11 minutes' where appointment_id = $1", [id]);
  await db.query("select salon_private.platform_sync_run()");
  row = await syncRow(db, id);
  check("intet svar i 10 minutter: prøves igen senere", row.pending && row.request_id === null && new Date(row.next_attempt_at) > new Date() && /svarede ikke i tide/.test(row.last_error || ""), JSON.stringify(row));
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id]);
  await tick(db, net);
  got = mock.received(id);
  row = await syncRow(db, id);
  check("gentaget kald har samme nøgle og samme data", got.at(-1).headers["idempotency-key"] === got.at(-2).headers["idempotency-key"] && got.at(-1).raw === got.at(-2).raw);
  check("platformen genkender kaldet (ingen dublet)", got.at(-1).replayed === true && !row.pending && row.last_error === null);

  // Nøglen afvises → ny nøgle
  mock.state.key = KEY2;
  await setStatus("completed");
  t = await tick(db, net);
  row = await syncRow(db, id);
  let s = await settings(db);
  check("401: fejl om nøglen vises", /afviste API-nøglen/.test(s.last_error || "") && !!s.last_error_at, s.last_error);
  check("401: prøves igen om 2 minutter", row.pending && row.attempts === 1 && Math.abs(new Date(row.next_attempt_at) - Date.now() - 120000) < 15000, JSON.stringify(row));
  t = await tick(db, net);
  check("401: ingen nye kald i ventetiden", t.first.sent === 0);
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id]);
  await tick(db, net);
  row = await syncRow(db, id);
  check("401 igen: ventetiden fordobles (4 minutter)", row.attempts === 2 && Math.abs(new Date(row.next_attempt_at) - Date.now() - 240000) < 15000);

  // Et forsinket 401-svar på den gamle nøgle må hverken vise fejl eller udsætte kaldet
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id]);
  await db.query("select salon_private.platform_sync_run()"); // kald med den gamle nøgle undervejs
  const r2 = await save(db, { key: KEY2 });
  check("ny nøgle: fejlen ryddes, og alt sendes igen", r2.rows?.[0]?.r?.last_error === null && r2.rows?.[0]?.r?.queued >= 1, JSON.stringify(r2.err || r2.rows?.[0]?.r));
  await pumpNet(db, net); // svaret på kaldet med den gamle nøgle (401)
  await db.query("select salon_private.platform_sync_run()");
  s = await settings(db);
  check("forsinket 401 på gammel nøgle viser ikke fejl", s.last_error === null, s.last_error);
  await tick(db, net);
  row = await syncRow(db, id);
  got = mock.received(id);
  check("ny nøgle: sendt med det samme med den nye nøgle og ny generation", !row.pending && got.at(-1).headers.authorization === `Bearer ${KEY2}` && got.at(-1).headers["idempotency-key"].startsWith(`vb-${s.generation}-`) && got.at(-1).status === 200, JSON.stringify(row));
  check("tom nøgle ved gem beholder den gemte nøgle", (await save(db, { key: "" })).rows?.[0]?.r?.key_prefix === KEY2.slice(0, 14)
    && (await one(db, "select count(*)::int n from vault.secrets")).n === 1
    && (await one(db, "select decrypted_secret from vault.decrypted_secrets")).decrypted_secret === KEY2);

  // Platformen afviser data
  mock.state.mode = "reject-phone";
  await setStatus("cancelled");
  await tick(db, net);
  row = await syncRow(db, id);
  let l = await link(db);
  check("422: bookingen markeres som afvist med årsag", row.failed && !row.pending && /telefonnummeret/.test(row.last_error || ""), row.last_error);
  check("422: vises i administrationen", l.failed === 1 && l.failures[0]?.reference === id.slice(0, 8).toUpperCase() && /telefonnummeret/.test(l.failures[0]?.last_error || "") && l.queued === 0, JSON.stringify(l.failures));
  check("422: ingen fejl på forbindelsen", (await settings(db)).last_error === null);
  mock.state.mode = "ok";
  await setStatus("completed");
  check("ændret booking prøves igen", (await syncRow(db, id)).failed === false && (await syncRow(db, id)).pending === true);
  await tick(db, net);
  check("ændret booking sendt", !(await syncRow(db, id)).pending && (await link(db)).failed === 0);

  // Serverfejl, timeout og forkert adresse
  const id2 = await insertAppt(db, { staff: "Sara", name: "Freja Fejl", email: "freja@example.dk", date: "2026-12-02" });
  mock.state.mode = "error";
  await tick(db, net);
  check("500: prøves igen, fejl vises", (await syncRow(db, id2)).pending && /fejl 500/.test((await settings(db)).last_error || ""));
  mock.state.mode = "slow";
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id2]);
  await tick(db, { ...net, timeoutCap: 300 });
  check("timeout: prøves igen, fejl vises", (await syncRow(db, id2)).pending && /svarede ikke i tide/.test((await settings(db)).last_error || ""));
  mock.state.mode = "ok";
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id2]);
  await tick(db, { map: (u) => u.replace(TEST_PLATFORM, "http://127.0.0.1:9") });
  check("platform kan ikke nås: prøves igen, fejl vises", (await syncRow(db, id2)).pending && /kunne ikke nås/.test((await settings(db)).last_error || ""), (await settings(db)).last_error);
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id2]);
  mock.state.mode = "forbidden";
  await tick(db, net);
  check("403: fejl om nøglens adgang", /må ikke oprette aftaler/.test((await settings(db)).last_error || ""));
  mock.state.mode = "ok";
  await db.query("update salon_private.platform_sync set next_attempt_at = now() where appointment_id = $1", [id2]);
  await tick(db, net);
  check("efter fejl: sendt, og fejlen er væk", !(await syncRow(db, id2)).pending && (await settings(db)).last_error === null);

  // Send alle igen og slå fra/til
  const before = (await settings(db)).generation;
  const re = await user(db, ADMIN, "select public.resend_platform_sync() as r");
  check("send alle igen: alle i kø med ny generation", re.rows?.[0]?.r?.queued === (await one(db, "select count(*)::int n from public.appointments")).n && (await settings(db)).generation === before + 1, JSON.stringify(re.err || re.rows?.[0]?.r?.queued));
  await save(db, { enabled: false });
  t = await tick(db, net);
  check("slået fra: intet sendes", t.first.enabled === false && t.pumped === 0);
  const offAppt = await insertAppt(db, { staff: "Sara", name: "Mens Slukket", date: "2026-12-03" });
  check("slået fra: nye bookinger ikke i kø", !(await syncRow(db, offAppt)));
  await save(db, { enabled: true });
  check("slå til igen: også bookinger fra pausen i kø", (await syncRow(db, offAppt))?.pending === true);
  let rounds = 0;
  while ((await link(db)).queued > 0 && rounds++ < 10) await tick(db, net);
  check("alle bookinger når frem", (await link(db)).queued === 0 && (await link(db)).failed === 0, JSON.stringify(await link(db)));
  const ids = new Set(mock.state.requests.filter((r) => r.status === 200).map((r) => r.body.items[0].external_id));
  check("hver booking findes på platformen", (await rows(db, "select id from public.appointments")).every((r) => ids.has(r.id)));
}

// =====================================================================
console.log("6) Gennemførte besøg");
{
  const today = (await one(db, "select (now() at time zone 'Europe/Copenhagen')::date::text as d")).d;
  const shift = (n) => new Date(new Date(today + "T12:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);
  await save(db, { enabled: false, auto: false });
  const past = await insertAppt(db, { staff: "Anna", name: "Forbi Bekræftet", date: shift(-1), start: "10:00", end: "11:00", status: "confirmed" });
  const pastPending = await insertAppt(db, { staff: "Anna", name: "Forbi Afventer", date: shift(-1), start: "12:00", end: "13:00", status: "pending" });
  const pastCancelled = await insertAppt(db, { staff: "Anna", name: "Forbi Aflyst", date: shift(-1), start: "14:00", end: "15:00", status: "cancelled" });
  const future = await insertAppt(db, { staff: "Anna", name: "Senere Bekræftet", date: shift(1), start: "10:00", end: "11:00", status: "confirmed" });
  await db.query("select salon_private.platform_sync_run()");
  check("slået fra: intet markeres som gennemført", (await one(db, "select status from public.appointments where id = $1", [past])).status === "confirmed");

  const r = await save(db, { enabled: false, auto: true });
  check("kan slås til uden forbindelsen", r.rows?.[0]?.r?.auto_complete === true && r.rows?.[0]?.r?.enabled === false, JSON.stringify(r.err));
  const out = (await one(db, "select salon_private.platform_sync_run() as r")).r;
  const st = Object.fromEntries((await rows(db, "select id, status from public.appointments where id = any($1::uuid[])", [[past, pastPending, pastCancelled, future]])).map((x) => [x.id, x.status]));
  check("bekræftet og forbi → gennemført", st[past] === "completed" && out.completed >= 1, JSON.stringify(out));
  check("afventende, aflyste og fremtidige røres ikke", st[pastPending] === "pending" && st[pastCancelled] === "cancelled" && st[future] === "confirmed", JSON.stringify(st));

  await db.query("update public.appointments set status = 'confirmed' where id = $1", [past]);
  await save(db, { enabled: true, auto: true });
  mock.state.requests.length = 0;
  let rounds = 0;
  while ((await link(db)).queued > 0 && rounds++ < 10) await tick(db, net);
  const sent = mock.received(past).at(-1);
  check("gennemført besøg sendes til platformen som completed", sent?.body.items[0].status === "completed" && sent?.status === 200, JSON.stringify(sent?.body));
}

// =====================================================================
console.log("7) Andre scripts sammen med forbindelsen");
{
  const syncBefore = (await one(db, "select count(*)::int n from salon_private.platform_sync")).n;
  const r8 = await tryq(db, T8);
  check("8-test (flere frisører) består med forbindelsen slået til", /^TEST OK: alle 41 kontroller/.test(r8.err?.message || ""), r8.err?.message?.slice(0, 200));
  check("8-test efterlader intet i køen", (await one(db, "select count(*)::int n from salon_private.platform_sync")).n === syncBefore);

  const snap = async () => JSON.stringify([
    await settings(db),
    await one(db, "select count(*)::int a, (select count(*)::int from salon_private.platform_sync where pending) p, (select count(*)::int from vault.secrets) v, (select count(*)::int from net.http_request_queue) q, (select count(*)::int from public.appointments) b from salon_private.platform_sync"),
    await one(db, "select string_agg(status, ',' order by id) s from public.appointments"),
  ]);
  const before = await snap();
  const r11 = await tryq(db, T11);
  const m = /^TEST OK: alle (\d+) kontroller/.exec(r11.err?.message || "");
  check("11-test med administrator: TEST OK", !!m, r11.err?.message?.slice(0, 400));
  check("11-test med administrator: alle kontroller (36)", m?.[1] === "36", m?.[1]);
  check("11-test efterlader intet", (await snap()) === before);

  await db.exec(`delete from public.admin_users where user_id = '${ADMIN}'`);
  const r11b = await tryq(db, T11);
  const m2 = /^TEST OK: alle (\d+) kontroller bestået\. Administratorfunktionerne er ikke testet/.exec(r11b.err?.message || "");
  check("11-test uden administrator: TEST OK med besked", !!m2, r11b.err?.message?.slice(0, 400));
  check("11-test uden administrator: antal kontroller (31)", m2?.[1] === "31", m2?.[1]);
  await db.exec(`insert into public.admin_users (user_id) values ('${ADMIN}')`);
  check("11-test uden administrator efterlader intet", (await snap()) === before);
}

// =====================================================================
console.log("8) Fjern forbindelsen (tilbagerulning-forbindelse.sql)");
{
  const appts = (await one(db, "select count(*)::int n, string_agg(id::text || status, ',' order by id) s from public.appointments"));
  const r = await tryq(db, ROLLBACK);
  check("tilbagerulning kører", !r.err, r.err?.message);
  const gone = await one(db, `select
    to_regclass('salon_private.platform_settings') is null and to_regclass('salon_private.platform_sync') is null as tables,
    to_regprocedure('public.get_platform_link()') is null and to_regprocedure('public.platform_link_enabled()') is null
      and to_regprocedure('salon_private.platform_sync_run(integer)') is null as funcs,
    (select count(*) from pg_trigger where tgname = 'platform_mark_changed') = 0 as trig,
    (select count(*) from cron.job where jobname = 'vanta-platform-sync') = 0 as job,
    (select count(*) from vault.secrets where name = 'vanta_platform_api_key') = 0 as secret`);
  check("tabeller, funktioner, trigger, job og nøgle er væk", gone.tables && gone.funcs && gone.trig && gone.job && gone.secret, JSON.stringify(gone));
  const after = await one(db, "select count(*)::int n, string_agg(id::text || status, ',' order by id) s from public.appointments");
  check("bookingerne er urørte", after.n === appts.n && after.s === appts.s);
  const k = await tryq(db, KONTROL);
  check("7-kontrol: alt_ok efter tilbagerulning", k.rows?.find((x) => x.kontrol === "alt_ok")?.ok === true);
  const b = await insertAppt(db, { staff: "Sara", name: "Efter Tilbagerulning", date: "2026-12-10" });
  check("bookinger virker efter tilbagerulning", !!b);
  const again = await tryq(db, ROLLBACK);
  check("tilbagerulning kan køres igen", !again.err, again.err?.message);
  const re = await tryq(db, M10);
  check("migrationen kan installeres igen bagefter", !re.err && (await settings(db)).enabled === false, re.err?.message);
}

await db.close();
await mock.close();

console.log(`\n${passed} bestået, ${failures.length} fejlet`);
for (const f of failures) console.log("  ✗", f);
process.exit(failures.length ? 1 : 0);
