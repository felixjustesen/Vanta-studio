// Testserver til browser.test.py (kun lokalt – rører ikke Supabase):
//  :8790  statiske filer som på Vercel (cleanUrls), config.js peger på :8791
//  :8791  mini-Supabase: PostgREST-delmængde + Auth (password/refresh/logout) mod PGlite
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createHmac, randomUUID } from "node:crypto";
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

const ROOT = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const DB_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DBTEST = new URL(".", import.meta.url).pathname;
const SECRET = "test-secret-test-secret-test-secret-123";
const API = "http://127.0.0.1:8791";
const LIVE = "https://fiszpthonodetuqclzsn.supabase.co";
const log = [];

let db;
let tokenTtl = 3600;
const refreshTokens = new Map();
const USERS = {
  "admin@test.dk": { id: "aaaaaaaa-0000-4000-8000-000000000001", password: "Hemmelig-123" },
  "bruger@test.dk": { id: "bbbbbbbb-0000-4000-8000-000000000002", password: "Hemmelig-456" },
  "frisoer@test.dk": { id: "cccccccc-0000-4000-8000-000000000003", password: "Hemmelig-789" }, // frisør Mikkel
  "ny@test.dk": { id: "dddddddd-0000-4000-8000-000000000004", password: "Hemmelig-000" }, // får login i testen
};

// migrate: "0" = som databasen var før, "2" = kun migration 2, ellers 2 + 6 (flere frisører)
async function resetDb({ migrate = "6", demo = "" } = {}) {
  if (db) await db.close();
  db = await PGlite.create({ extensions: { btree_gist } });
  await db.exec("set timezone = 'UTC'");
  await db.exec(readFileSync(DBTEST + "supabase-stub.sql", "utf8"));
  await db.exec(readFileSync(DBTEST + "original.sql", "utf8"));
  for (const [email, u] of Object.entries(USERS)) await db.query("insert into auth.users (id, email) values ($1, $2)", [u.id, email]);
  if (migrate !== "0") {
    await db.exec(readFileSync(`${DB_DIR}/2-migration.sql`, "utf8"));
    await db.query("insert into public.admin_users (user_id) values ($1)", [USERS["admin@test.dk"].id]);
  }
  if (migrate !== "0" && migrate !== "2") {
    await db.exec(readFileSync(`${DB_DIR}/6-migration-flere-frisoerer.sql`, "utf8"));
    await db.query("insert into public.staff_users (user_id, staff_id) select $1, id from public.staff where name = 'Mikkel'", [USERS["frisoer@test.dk"].id]);
    if (demo === "skarp") await db.exec(readFileSync(`${DB_DIR}/9-demo-skarp.sql`, "utf8"));
  }
}

// ---------- JWT (HS256) ----------
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
function sign(payload) {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64(payload);
  const sig = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  const [head, body, sig] = token.split(".");
  if (!sig) return null;
  const expected = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  if (expected !== sig) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  if (payload.exp < Date.now() / 1000) return "expired";
  return payload;
}
function session(email) {
  const u = USERS[email];
  const now = Math.floor(Date.now() / 1000);
  const refresh = randomUUID();
  refreshTokens.set(refresh, email);
  return {
    access_token: sign({ sub: u.id, email, role: "authenticated", aud: "authenticated", iat: now, exp: now + tokenTtl }),
    token_type: "bearer", expires_in: tokenTtl, expires_at: now + tokenTtl, refresh_token: refresh,
    user: { id: u.id, email, role: "authenticated" },
  };
}

// ---------- typer som PostgREST ----------
const isoTs = (v) => v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
const PARSERS = {
  1082: (v) => v, 1083: (v) => v, 1114: (v) => v.replace(" ", "T"),
  1184: isoTs, 1700: (v) => Number(v),
};

const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => { if (!IDENT.test(s)) throw Object.assign(new Error(`ugyldigt navn ${s}`), { code: "PGRST100" }); return `"${s}"`; };
const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

function where(params, values) {
  const clauses = [];
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const m = raw.match(/^(eq|neq|gt|gte|lt|lte|in|is)\.(.*)$/s);
    if (!m) throw Object.assign(new Error(`ukendt filter ${key}=${raw}`), { code: "PGRST100" });
    const [, op, val] = m;
    if (op === "in") {
      values.push(val.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")));
      clauses.push(`${ident(key)}::text = any($${values.length}::text[])`);
    } else if (op === "is") {
      clauses.push(`${ident(key)} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`);
    } else {
      values.push(val);
      clauses.push(`${ident(key)} ${OPS[op]} $${values.length}`);
    }
  }
  return clauses.length ? ` where ${clauses.join(" and ")}` : "";
}

function selectCols(params) {
  const sel = params.get("select") || "*";
  return sel === "*" ? "*" : sel.split(",").map((c) => ident(c.trim())).join(", ");
}

function orderBy(params) {
  const o = params.get("order");
  if (!o) return "";
  return " order by " + o.split(",").map((part) => {
    const [col, dir = "asc"] = part.split(".");
    return `${ident(col)} ${dir === "desc" ? "desc" : "asc"}`;
  }).join(", ");
}

async function asRole(role, claims, fn) {
  return db.transaction(async (tx) => {
    await tx.query("select set_config('role', $1, true)", [role]);
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    return fn(tx);
  });
}

function pgError(e, role) {
  const code = e.code || "XX000";
  let status = 400;
  if (code === "42501") status = role === "anon" ? 401 : 403;
  else if (code === "23505" || code === "23P01" || code === "23503") status = 409;
  else if (code === "PGRST202") status = 404;
  else if (code.startsWith("XX") || code.startsWith("58")) status = 500;
  return [status, { code, details: e.detail ?? null, hint: e.hint ?? null, message: e.message }];
}

async function handleRest(req, res, url, body) {
  // Rolle ud fra Authorization (publicerbar nøgle eller intet = anon)
  let role = "anon";
  let claims = { role: "anon" };
  const auth = req.headers.authorization || "";
  if (!req.headers.apikey) return send(res, 401, { message: "No API key found in request" });
  if (auth.startsWith("Bearer ") && auth.slice(7).split(".").length === 3) {
    const payload = verify(auth.slice(7));
    if (payload === "expired") return send(res, 401, { code: "PGRST303", message: "JWT expired", details: null, hint: null });
    if (!payload) return send(res, 401, { code: "PGRST301", message: "JWSError", details: null, hint: null });
    role = payload.role;
    claims = payload;
  }

  const path = url.pathname.replace(/^\/rest\/v1\//, "");
  const params = url.searchParams;
  const values = [];
  try {
    if (path.startsWith("rpc/")) {
      const fn = path.slice(4);
      const meta = (await db.query("select p.proretset from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace", [fn])).rows[0];
      if (!meta) throw Object.assign(new Error(`Could not find the function public.${fn} in the schema cache`), { code: "PGRST202" });
      const args = body || {};
      const names = Object.keys(args);
      names.forEach((n) => ident(n));
      const argSql = names.map((n, i) => `${n} => $${i + 1}`).join(", ");
      const out = await asRole(role, claims, (tx) => tx.query(
        meta.proretset ? `select * from public.${ident(fn)}(${argSql})` : `select public.${ident(fn)}(${argSql}) as result`,
        names.map((n) => args[n]), { parsers: PARSERS }));
      return send(res, 200, meta.proretset ? out.rows : out.rows[0]?.result ?? null);
    }

    const table = ident(path);
    if (req.method === "GET") {
      const limit = params.get("limit") ? ` limit ${Number(params.get("limit"))}` : "";
      const sql = `select ${selectCols(params)} from public.${table}${where(params, values)}${orderBy(params)}${limit}`;
      const out = await asRole(role, claims, (tx) => tx.query(sql, values, { parsers: PARSERS }));
      return send(res, 200, out.rows);
    }
    if (req.method === "POST") {
      const rows = Array.isArray(body) ? body : [body];
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const tuples = rows.map((r) => `(${cols.map((c) => { values.push(r[c] ?? null); return `$${values.length}`; }).join(", ")})`);
      const sql = `insert into public.${table} (${cols.map(ident).join(", ")}) values ${tuples.join(", ")} returning *`;
      const out = await asRole(role, claims, (tx) => tx.query(sql, values, { parsers: PARSERS }));
      return send(res, 201, out.rows);
    }
    if (req.method === "PATCH") {
      const sets = Object.entries(body).map(([c, v]) => { values.push(v); return `${ident(c)} = $${values.length}`; });
      const sql = `update public.${table} set ${sets.join(", ")}${where(params, values)} returning *`;
      const out = await asRole(role, claims, (tx) => tx.query(sql, values, { parsers: PARSERS }));
      return send(res, 200, out.rows);
    }
    if (req.method === "DELETE") {
      const sql = `delete from public.${table}${where(params, values)} returning *`;
      const out = await asRole(role, claims, (tx) => tx.query(sql, values, { parsers: PARSERS }));
      return send(res, 200, out.rows);
    }
    return send(res, 405, { message: "metode ikke understøttet" });
  } catch (e) {
    const [status, payload] = pgError(e, role);
    return send(res, status, payload);
  }
}

async function handleAuth(req, res, url, body) {
  if (url.pathname === "/auth/v1/token") {
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const u = USERS[(body?.email || "").toLowerCase()];
      if (!u || u.password !== body?.password) return send(res, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      return send(res, 200, session(body.email.toLowerCase()));
    }
    if (grant === "refresh_token") {
      const email = refreshTokens.get(body?.refresh_token);
      if (!email) return send(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
      refreshTokens.delete(body.refresh_token);
      log.push(`REFRESH ${email}`);
      return send(res, 200, session(email));
    }
  }
  if (url.pathname === "/auth/v1/logout") { res.writeHead(204, cors()); return res.end(); }
  return send(res, 404, { msg: "not found" });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "apikey, authorization, content-type, prefer, accept, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}
function send(res, status, data) {
  res.writeHead(status, { ...cors(), "Content-Type": "application/json; charset=utf-8" });
  res.end(data === undefined ? "" : JSON.stringify(data));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, API);
  if (req.method === "OPTIONS") { res.writeHead(204, cors()); return res.end(); }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  log.push(`${req.method} ${url.pathname}${url.search} ${raw.slice(0, 200)}`);
  try {
    if (url.pathname === "/__test/reset") { await resetDb({ migrate: url.searchParams.get("migrate") || "6", demo: url.searchParams.get("demo") || "" }); tokenTtl = 3600; return send(res, 200, { ok: true }); }
    if (url.pathname === "/__test/ttl") { tokenTtl = Number(url.searchParams.get("s")); return send(res, 200, { ok: true }); }
    if (url.pathname === "/__test/sql") { const out = await db.exec(body.sql); return send(res, 200, out.at(-1)?.rows ?? []); }
    if (url.pathname === "/__test/log") return send(res, 200, log.splice(0));
    if (url.pathname.startsWith("/rest/v1/")) return await handleRest(req, res, url, body);
    if (url.pathname.startsWith("/auth/v1/")) return await handleAuth(req, res, url, body);
    send(res, 404, { message: "not found" });
  } catch (e) {
    send(res, 500, { message: String(e.message) });
  }
}).listen(8791, "127.0.0.1");

// ---------- statiske filer (cleanUrls som vercel.json) ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8790");
  let p = join(ROOT, decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  else if (!existsSync(p) && existsSync(p + ".html")) p += ".html";
  if (!existsSync(p)) { res.writeHead(404); return res.end("404"); }
  let data = readFileSync(p);
  const type = TYPES[extname(p)] || "application/octet-stream";
  if (p.endsWith("/assets/config.js")) data = Buffer.from(data.toString().replace(LIVE, API));
  if (p.endsWith(".html")) data = Buffer.from(data.toString().replaceAll(LIVE, API));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}).listen(8790, "127.0.0.1");

await resetDb();
console.log("klar: http://127.0.0.1:8790/koncepter/10-frisoer-booking  (API :8791)");
