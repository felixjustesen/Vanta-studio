// Falsk Vanta Platform til lokale tests: POST /api/v1/appointments med samme
// regler som den rigtige (rest-handler.ts): Bearer vk_live_-nøgle, Idempotency-Key
// (8–200 tegn), X-Vanta-Source og platformens egen validering af data.
// Samme nøgle + samme data = gentaget svar; samme nøgle + andre data = 422.
//
// pumpNet() spiller pg_net's rolle: sender det, der ligger i net.http_request_queue,
// og skriver svaret i net._http_response.
import http from "node:http";
import { createHash } from "node:crypto";
import { validateAppointments } from "./platform-contract.mjs";

export const TEST_PLATFORM = "https://platform.test";

// mode: "ok" | "unauthorized" | "forbidden" | "error" | "slow" | "reject-phone"
export async function startMockPlatform({ port = 0, key = null } = {}) {
  const state = { mode: "ok", key, requests: [], idempotency: new Map() };

  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const entry = { method: req.method, path: req.url, headers: req.headers, raw, body: null, status: 0, replayed: false };
    try { entry.body = JSON.parse(raw); } catch {}
    state.requests.push(entry);

    const reply = (status, data, headers = {}) => {
      entry.status = status;
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    const error = (status, code, message, extra = {}) => reply(status, { error: { code, message, ...extra } });

    if (state.mode === "slow") await new Promise((r) => setTimeout(r, 1500));
    if (req.method !== "POST" || req.url !== "/api/v1/appointments") return error(404, "not_found", "Not found");
    if (state.mode === "error") return error(500, "internal_error", "The request could not be processed.");

    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    if (!bearer?.startsWith("vk_live_") || state.mode === "unauthorized" || (state.key && bearer !== state.key)) {
      return error(401, "unauthorized", "Invalid or revoked API key");
    }
    if (state.mode === "forbidden") return error(403, "insufficient_scope", "This key lacks the appointments:write scope");

    const idem = (req.headers["idempotency-key"] || "").trim();
    if (idem.length < 8 || idem.length > 200) return error(400, "idempotency_key_required", "Send an Idempotency-Key header (8–200 characters)");
    if ((req.headers["x-vanta-source"] ?? "api") !== "vanta_booking" && req.headers["x-vanta-source"] !== "api") {
      return error(400, "invalid_source", "X-Vanta-Source must be 'api' or 'vanta_booking'");
    }
    if (entry.body === null) return error(400, "invalid_json", "Body must be valid JSON");

    const parsed = validateAppointments(entry.body);
    if (!parsed.ok) return error(422, "validation_failed", "The payload is invalid", { issues: parsed.issues });
    if (state.mode === "reject-phone") {
      return error(422, "validation_failed", "The payload is invalid", { issues: [{ path: "items.0.customer.phone", message: "invalid phone number" }] });
    }

    const hash = createHash("sha256").update(raw).digest("hex");
    const seen = state.idempotency.get(idem);
    if (seen && seen.hash !== hash) return error(422, "idempotency_key_reused", "This Idempotency-Key was used with a different payload");
    if (seen) {
      entry.replayed = true;
      return reply(seen.status, seen.body, { "Idempotent-Replayed": "true" });
    }
    entry.data = parsed.data;
    const body = { data: { received: parsed.data.items.length, created: parsed.data.items.length, updated: 0, unchanged: 0, failed: 0 } };
    state.idempotency.set(idem, { hash, status: 200, body });
    return reply(200, body);
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    // De anmodninger, der nåede frem til en bestemt booking
    received: (externalId) => state.requests.filter((r) => r.body?.items?.[0]?.external_id === externalId),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// pg_net: send køen og gem svarene. map omsætter adresser (https://platform.test → mock).
export async function pumpNet(db, { map = (u) => u, timeoutCap = Infinity } = {}) {
  const { rows } = await db.query(
    "select id, url, headers, convert_from(body, 'UTF8') as body, timeout_milliseconds from net.http_request_queue order by id",
  );
  for (const r of rows) {
    let response;
    try {
      const res = await fetch(map(r.url), {
        method: "POST",
        headers: r.headers,
        body: r.body,
        signal: AbortSignal.timeout(Math.min(r.timeout_milliseconds, timeoutCap)),
      });
      response = [res.status, await res.text(), false, null];
    } catch (e) {
      response = e.name === "TimeoutError"
        ? [null, null, true, "Timeout of 15000 ms reached"]
        : [null, null, false, `Couldn't connect to server (${e.cause?.code || e.message})`];
    }
    await db.query(
      "insert into net._http_response (id, status_code, content, timed_out, error_msg) values ($1, $2, $3, $4, $5)",
      [r.id, ...response],
    );
    await db.query("delete from net.http_request_queue where id = $1", [r.id]);
  }
  return rows.length;
}

// Ét "minut": jobbet sender, pg_net leverer, jobbet læser svarene.
export async function tick(db, opts = {}) {
  const first = (await db.query("select salon_private.platform_sync_run() as r")).rows[0].r;
  const pumped = await pumpNet(db, opts);
  const second = (await db.query("select salon_private.platform_sync_run() as r")).rows[0].r;
  return { first, pumped, second };
}
