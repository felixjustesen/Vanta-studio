// Login for administratorer og frisører via Supabase Auth (e-mail og adgangskode).
// Sessionen gemmes i localStorage og fornyes automatisk, før den udløber.
// Brugerens rolle afgøres af databasen (admin_users, staff_users + RLS).
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../config.js";

const STORAGE_KEY = "frisoer-booking:session";
const listeners = new Set();
let session = read();
let refreshing = null;

export class AuthError extends Error {
  constructor(message, code = "") {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return value?.access_token && value?.refresh_token ? value : null;
  } catch {
    return null;
  }
}

function write(next) {
  session = next;
  if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  else localStorage.removeItem(STORAGE_KEY);
  listeners.forEach((fn) => fn(session));
}

function message(data, status) {
  const code = data?.error_code || data?.error || "";
  if (code === "invalid_credentials" || code === "invalid_grant") return "Forkert e-mail eller adgangskode.";
  if (code === "email_not_confirmed") return "E-mailadressen er ikke bekræftet endnu.";
  if (code === "user_banned") return "Kontoen er spærret.";
  if (status === 429 || /rate_limit/.test(code)) return "For mange forsøg. Vent lidt, og prøv igen.";
  if (status >= 500) return "Login er ikke tilgængeligt lige nu. Prøv igen om lidt.";
  return "Login mislykkedes. Prøv igen.";
}

async function tokenRequest(grantType, body) {
  let response;
  try {
    response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError("Der er ingen forbindelse lige nu. Tjek internetforbindelsen, og prøv igen.", "network");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new AuthError(message(data, response.status), data?.error_code || data?.error || String(response.status));
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: { id: data.user?.id, email: data.user?.email },
  };
}

export async function signIn(email, password) {
  write(await tokenRequest("password", { email: email.trim(), password }));
  return session;
}

// Gyldigt adgangstoken – fornyes, hvis det udløber inden for et minut.
export async function getToken({ force = false } = {}) {
  if (!session) return null;
  if (!force && session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  if (!refreshing) {
    const refreshToken = session.refresh_token;
    refreshing = tokenRequest("refresh_token", { refresh_token: refreshToken })
      .then((next) => {
        write(next);
        return next.access_token;
      })
      .catch((error) => {
        if (error.code !== "network") write(null);
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

export async function signOut() {
  const token = session?.access_token;
  write(null);
  if (!token) return;
  try {
    await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
    });
  } catch {
    // Sessionen er allerede fjernet lokalt.
  }
}

export const currentUser = () => session?.user ?? null;

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Log ind/ud i én fane slår igennem i de andre.
window.addEventListener("storage", (e) => {
  if (e.key !== STORAGE_KEY) return;
  session = read();
  listeners.forEach((fn) => fn(session));
});
