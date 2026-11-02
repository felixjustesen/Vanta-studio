// Kald til Supabase (PostgREST) med den publicerbare nøgle.
// Indloggede kald sender desuden brugerens adgangstoken.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../config.js";

export class ApiError extends Error {
  constructor(message, { status = 0, code = "", hint = "", details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

// Databasens fejlkoder (hint) → tekst til brugeren
const MESSAGES = {
  slot_unavailable: "Tiden er desværre ikke længere ledig. Vælg en anden tid.",
  service_unavailable: "Behandlingen kan ikke bookes lige nu. Vælg en anden behandling.",
  invalid_name: "Skriv dit navn (2–100 tegn).",
  invalid_email: "Skriv en gyldig e-mailadresse.",
  invalid_phone: "Skriv et gyldigt telefonnummer med mindst 8 cifre.",
  invalid_notes: "Bemærkningen må højst være 500 tegn.",
  too_many_bookings: "Du har allerede tre kommende bookinger. Kontakt salonen, hvis du vil booke flere.",
  too_busy: "Der kommer mange bookinger lige nu. Prøv igen om et par minutter.",
  login_not_found: "Der findes ingen bekræftet bruger med den e-mail. Opret brugeren i Supabase under Authentication → Users, og sæt flueben i Auto Confirm User.",
  staff_not_found: "Frisøren findes ikke længere. Genindlæs siden.",
  invalid_platform_url: "Skriv platformens adresse, fx https://app.vantastudio.dk.",
  invalid_api_key: "API-nøglen skal starte med vk_live_. Kopiér hele nøglen fra Vanta Platform.",
  platform_incomplete: "Udfyld platformens adresse og API-nøgle, før forbindelsen slås til.",
  platform_disabled: "Slå forbindelsen til, før bookingerne kan sendes.",
};

// Fejl, hvor databasens egen tekst er den mest præcise (fx med frisørens navn)
const SERVER_TEXT = new Set(["login_in_use"]);

function friendlyMessage(status, code, hint, serverText) {
  if (hint && MESSAGES[hint]) return MESSAGES[hint];
  if (hint && SERVER_TEXT.has(hint) && serverText) return serverText;
  if (code === "PGRST202" || code === "42883") return "Online booking er ikke aktiveret endnu.";
  if (code === "23P01") return "Tiden overlapper en anden booking.";
  if (code === "23505") return "Det findes allerede.";
  if (code === "23514") return "En af værdierne er ikke gyldig.";
  if (code === "42501" || status === 401 || status === 403) return "Du har ikke adgang til at gøre dette.";
  if (status === 0) return "Der er ingen forbindelse lige nu. Tjek internetforbindelsen, og prøv igen.";
  if (status >= 500) return "Der opstod en fejl hos serveren. Prøv igen om lidt.";
  return "Noget gik galt. Prøv igen.";
}

export function isNotSetUp(error) {
  return error instanceof ApiError && (error.code === "PGRST202" || error.code === "42883");
}

export async function request(path, { method = "GET", body, token, prefer, signal } = {}) {
  const headers = { apikey: SUPABASE_PUBLISHABLE_KEY, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (prefer) headers.Prefer = prefer;

  let response;
  try {
    response = await fetch(SUPABASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new ApiError(friendlyMessage(0), { status: 0, code: "network" });
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const code = data?.code ?? "";
    const hint = data?.hint ?? "";
    throw new ApiError(friendlyMessage(response.status, code, hint, data?.message), { status: response.status, code, hint, details: data });
  }
  return data;
}

export const select = (table, query, opts) => request(`/rest/v1/${table}?${query}`, opts);
export const insert = (table, rows, opts) => request(`/rest/v1/${table}`, { ...opts, method: "POST", body: rows, prefer: "return=representation" });
export const update = (table, query, values, opts) => request(`/rest/v1/${table}?${query}`, { ...opts, method: "PATCH", body: values, prefer: "return=representation" });
export const remove = (table, query, opts) => request(`/rest/v1/${table}?${query}`, { ...opts, method: "DELETE", prefer: "return=representation" });
export const rpc = (fn, args = {}, opts) => request(`/rest/v1/rpc/${fn}`, { ...opts, method: "POST", body: args });

// ---------- Offentlige data ----------
export async function loadSalon(opts) {
  const rows = await select("salon_settings", "select=*&order=created_at.asc&limit=1", opts);
  return rows?.[0] ?? null;
}

export async function loadServices(opts) {
  const rows = await select("services", "select=*&is_active=eq.true", opts);
  return (rows || []).filter((s) => s.is_active !== false).sort((a, b) => a.name.localeCompare(b.name, "da"));
}

export async function loadHours(opts) {
  return (await select("business_hours", "select=*&order=weekday.asc,start_time.asc", opts)) || [];
}

// Aktive frisører og hvilke behandlinger de laver.
// Findes tabellerne ikke (migration 6 ikke kørt), giver den en fejl, som
// siderne opfatter som "ingen frisørvalg".
export async function loadStaff(opts) {
  const [staff, links] = await Promise.all([
    select("staff", "select=id,name,sort_order,is_active&is_active=eq.true&order=sort_order.asc,name.asc", opts),
    select("staff_services", "select=staff_id,service_id", opts),
  ]);
  const services = new Map();
  for (const link of links || []) {
    if (!services.has(link.staff_id)) services.set(link.staff_id, new Set());
    services.get(link.staff_id).add(link.service_id);
  }
  return (staff || []).map((s) => ({ ...s, services: services.get(s.id) || new Set() }));
}
