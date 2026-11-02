// Administration: bookinger, dagsplan, frisører, fravær, behandlinger, åbningstider,
// lukkedage og indstillinger.
// Adgang kræver login (Supabase Auth). Administratorer (admin_users) ser og ændrer alt;
// en frisør med login (staff_users) ser kun sine egne bookinger og kan ændre deres
// status. Databasen afviser alt andet, uanset hvad browseren gør.
import { h, $, $$, fill, icon, toast, confirmDialog } from "./lib/dom.js";
import { ApiError, isNotSetUp, select, insert, update, remove, rpc, loadSalon } from "./lib/api.js";
import { AuthError, signIn, signOut, getToken, currentUser, onAuthChange } from "./lib/auth.js";
import { createCalendar } from "./lib/calendar.js";
import {
  STATUS, WEEKDAYS, WEEK_ORDER, capitalize, clock, timeRange, duration, kr, parseAmount,
  dateLong, dateShort, todayInCopenhagen, addDays, timestamp, weekday, firstName,
} from "./lib/format.js";
import { salonName, telHref } from "./lib/site.js";
import { BASE } from "./config.js";

const app = $("#app");
const today = todayInCopenhagen();
// [id, navn, hvem ser fanen]
const ALL_TABS = [
  ["bookinger", "Bookinger", "alle"],
  ["dagsplan", "Dagsplan", "alle"],
  ["frisoerer", "Frisører", "admin"],
  ["fravaer", "Fravær", "admin"],
  ["behandlinger", "Behandlinger", "admin"],
  ["aabningstider", "Åbningstider", "admin"],
  ["lukkedage", "Lukkedage", "admin"],
  ["indstillinger", "Indstillinger", "admin"],
];
let TABS = [];

const state = {
  role: null, // "admin" eller "staff"
  me: null, // svaret fra get_my_access
  salon: null,
  services: [],
  hours: [],
  staff: [], // administrator: alle frisører; frisør: de aktive
  staffServices: new Map(), // staff_id → Set(service_id)
  staffHours: null,
  blocked: [],
  timeOff: [],
  bookings: [],
  pendingCount: 0,
  tab: "bookinger",
  filter: { period: "upcoming", status: "all", staff: "all", q: "" },
  planDate: today,
};

const isAdmin = () => state.role === "admin";
const byName = (a, b) => a.name.localeCompare(b.name, "da");
const staffById = (id) => state.staff.find((s) => s.id === id);
const staffNameOf = (id) => staffById(id)?.name || "Ukendt frisør";
const activeStaff = () => state.staff.filter((s) => s.is_active);
const doesService = (staffId, serviceId) => state.staffServices.get(staffId)?.has(serviceId) || false;
const toMin = (t) => { const [hh, mm] = String(t).split(":").map(Number); return hh * 60 + (mm || 0); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const listText = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} og ${items.at(-1)}`);
const avatar = (name) => h("span", { class: "avatar", "aria-hidden": "true", text: String(name || "?").trim().charAt(0).toUpperCase() });

function setStaffServices(links) {
  state.staffServices = new Map();
  for (const link of links) {
    if (!state.staffServices.has(link.staff_id)) state.staffServices.set(link.staff_id, new Set());
    state.staffServices.get(link.staff_id).add(link.service_id);
  }
}

let sessionMessage = "";

// ---------------------------------------------------------------------
// Kald med brugerens token. Udløbet token fornyes én gang; mislykkes det,
// sendes brugeren tilbage til login.
class SessionEnded extends Error {}

async function call(fn) {
  try {
    return await fn(await getToken());
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      try {
        return await fn(await getToken({ force: true }));
      } catch (retryError) {
        if (retryError instanceof AuthError || (retryError instanceof ApiError && retryError.status === 401)) return endSession();
        throw retryError;
      }
    }
    if (error instanceof AuthError && error.code !== "network") return endSession();
    throw error;
  }
}

function endSession() {
  sessionMessage = "Din session er udløbet. Log ind igen.";
  signOut();
  throw new SessionEnded();
}

function report(error) {
  if (error instanceof SessionEnded) return;
  toast(error.message || "Noget gik galt. Prøv igen.", { error: true });
}

// ---------------------------------------------------------------------
async function boot() {
  if (!currentUser()) return showLogin();
  fill(app, h("div", { class: "auth-wrap" }, h("p", { class: "muted", text: "Indlæser …" })));
  try {
    let access;
    try {
      access = await call((token) => rpc("get_my_access", {}, { token }));
    } catch (error) {
      if (!isNotSetUp(error)) throw error;
      // Databasen kender ikke frisører endnu (6-migration-flere-frisoerer.sql mangler).
      const admin = await call((token) => rpc("is_admin", {}, { token }));
      if (admin !== true) return showNoAccess();
      return showMessage("Administrationen skal opdateres", "Databasen mangler opdateringen til flere frisører. Kør 6-migration-flere-frisoerer.sql i Supabase (se database/README.md), og prøv igen.", true);
    }
    if (access?.is_admin === true) state.role = "admin";
    else if (access?.staff_id) state.role = "staff";
    else return showNoAccess();
    state.me = access;
    await showDashboard();
  } catch (error) {
    if (error instanceof SessionEnded) return;
    if (isNotSetUp(error)) return showMessage("Administrationen er ikke klar endnu", "Databasemigrationen mangler. Kør filerne i mappen database (se README.md), og prøv igen.");
    showMessage("Administrationen kunne ikke indlæses", error.message, true);
  }
}

onAuthChange((session) => {
  if (!session) showLogin();
});

function brandBlock() {
  const name = salonName(state.salon);
  return h("a", { class: "brand", href: BASE },
    h("span", { class: "brand__mark", "aria-hidden": "true", text: name.charAt(0).toUpperCase() }),
    h("span", { class: "brand__name", text: name }),
  );
}

async function ensureSalon() {
  if (!state.salon) state.salon = await loadSalon().catch(() => null);
}

async function showLogin() {
  document.title = "Log ind – administration";
  await ensureSalon();
  const message = sessionMessage;
  sessionMessage = "";
  const error = h("div", { role: "alert" });
  const email = h("input", { class: "input", id: "login-email", type: "email", autocomplete: "username", inputmode: "email", required: true });
  const password = h("input", { class: "input", id: "login-password", type: "password", autocomplete: "current-password", required: true });
  const button = h("button", { class: "btn btn--primary btn--block", type: "submit", text: "Log ind" });

  const form = h("form", { novalidate: true },
    h("div", { class: "field" }, h("label", { class: "label", for: "login-email", text: "E-mail" }), email),
    h("div", { class: "field" }, h("label", { class: "label", for: "login-password", text: "Adgangskode" }), password),
    error,
    button,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.replaceChildren();
    if (!email.value.trim() || !password.value) {
      fill(error, h("div", { class: "notice notice--error" }, icon("alert"), h("span", { text: "Skriv din e-mail og adgangskode." })));
      return;
    }
    button.disabled = true;
    fill(button, h("span", { class: "spinner", "aria-hidden": "true" }), "Logger ind …");
    try {
      await signIn(email.value, password.value);
      boot();
    } catch (err) {
      fill(error, h("div", { class: "notice notice--error" }, icon("alert"), h("span", { text: err.message })));
      button.disabled = false;
      button.textContent = "Log ind";
      password.select();
    }
  });

  fill(app, h("main", { class: "auth-wrap" },
    h("div", { class: "card auth-card" },
      brandBlock(),
      h("h1", { text: "Log ind" }),
      h("p", { class: "muted", text: "Administration for salonens personale." }),
      message ? h("div", { class: "notice notice--warn" }, icon("info"), h("span", { text: message })) : null,
      form,
      h("p", { class: "fine" }, h("a", { href: BASE, text: "Tilbage til hjemmesiden" })),
    ),
  ));
  email.focus();
}

function showNoAccess() {
  document.title = "Ingen adgang – administration";
  const user = currentUser();
  fill(app, h("main", { class: "auth-wrap" },
    h("div", { class: "card auth-card" },
      brandBlock(),
      h("h1", { text: "Ingen adgang" }),
      h("p", { class: "step__intro" }, "Kontoen ", h("strong", { text: user?.email || "" }), " har ikke adgang til administrationen."),
      h("p", { class: "fine", text: "Logins til administratorer og frisører oprettes af den, der har adgang til salonens Supabase-projekt." }),
      h("button", { class: "btn btn--ghost btn--block", type: "button", onclick: () => signOut() }, icon("logout"), "Log ud"),
    ),
  ));
}

function showMessage(title, text, retry = false) {
  fill(app, h("main", { class: "auth-wrap" },
    h("div", { class: "card auth-card" },
      h("h1", { text: title }),
      h("p", { class: "step__intro", text }),
      retry ? h("button", { class: "btn btn--primary btn--block", type: "button", text: "Prøv igen", onclick: boot }) : null,
      h("button", { class: "btn btn--ghost btn--block", type: "button", onclick: () => signOut() }, icon("logout"), "Log ud"),
    ),
  ));
}

// ---------------------------------------------------------------------
async function showDashboard() {
  const [salon, services, hours, staff, links] = await Promise.all([
    call((token) => select("salon_settings", "select=*&order=created_at.asc&limit=1", { token })),
    call((token) => select("services", "select=*&order=name.asc", { token })),
    call((token) => select("business_hours", "select=*&order=weekday.asc,start_time.asc", { token })),
    call((token) => select("staff", "select=*&order=sort_order.asc,name.asc", { token })),
    call((token) => select("staff_services", "select=staff_id,service_id", { token })),
  ]);
  state.salon = salon?.[0] ?? null;
  state.services = (services || []).sort(byName);
  state.hours = hours || [];
  state.staff = staff || [];
  state.staffHours = null;
  setStaffServices(links || []);
  TABS = ALL_TABS.filter(([, , who]) => who === "alle" || isAdmin());
  const name = salonName(state.salon);
  document.title = `Administration – ${name}`;

  const fromHash = location.hash.slice(1);
  state.tab = TABS.some(([id]) => id === fromHash) ? fromHash : "bookinger";

  fill(app,
    h("header", { class: "admin-header" },
      h("div", { class: "wrap admin-header__inner" },
        h("div", { class: "admin-header__title" }, h("strong", { text: name }), h("span", { text: isAdmin() ? "Administration" : `Frisør: ${state.me.staff_name}` })),
        h("div", { class: "admin-header__meta" },
          h("span", { class: "admin-header__user", text: currentUser()?.email || "" }),
          h("a", { class: "btn btn--quiet btn--sm", href: BASE, target: "_blank", rel: "noopener" }, h("span", { class: "btn__label", text: "Hjemmeside" }), icon("external")),
          h("button", { class: "btn btn--quiet btn--sm", type: "button", onclick: () => signOut() }, icon("logout"), h("span", { class: "btn__label", text: "Log ud" })),
        ),
      ),
    ),
    h("div", { class: "tabs-wrap" },
      h("div", { class: "wrap" },
        h("div", { class: "tabs", role: "tablist", "aria-label": "Administration" },
          TABS.map(([id, label]) => h("button", {
            class: "tab", type: "button", role: "tab", id: `tab-${id}`, "aria-controls": "panel",
            "aria-selected": String(id === state.tab), tabindex: id === state.tab ? "0" : "-1",
            onclick: () => selectTab(id),
          }, label, id === "bookinger" ? h("span", { class: "tab__count", id: "pending-count", hidden: true }) : null)),
        ),
      ),
    ),
    h("main", { class: "admin-main" },
      h("div", { class: "wrap" }, h("section", { id: "panel", role: "tabpanel", tabindex: "-1", "aria-labelledby": `tab-${state.tab}` })),
    ),
  );

  $(".tabs").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex(([id]) => id === state.tab);
    const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    selectTab(TABS[next][0]);
    $(`#tab-${TABS[next][0]}`).focus();
  });

  refreshPendingCount();
  renderTab();
}

function selectTab(id) {
  state.tab = id;
  history.replaceState(null, "", `#${id}`);
  $$(".tab").forEach((tab) => {
    const selected = tab.id === `tab-${id}`;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $("#panel").setAttribute("aria-labelledby", `tab-${id}`);
  renderTab();
}

function renderTab() {
  const renderers = {
    bookinger: renderBookings,
    dagsplan: renderPlan,
    frisoerer: renderStaff,
    fravaer: renderTimeOff,
    behandlinger: renderServices,
    aabningstider: renderHours,
    lukkedage: renderBlocked,
    indstillinger: renderSettings,
  };
  renderers[state.tab]().catch(report);
}

function panelHead(title, intro, ...actions) {
  return h("div", { class: "panel__head" },
    h("div", null, h("h2", { text: title }), intro ? h("p", { class: "panel__intro", text: intro }) : null),
    actions.length ? h("div", null, actions) : null,
  );
}

const loading = () => h("p", { class: "muted", text: "Henter …" });
const errorNotice = (text) => h("div", { class: "notice notice--error" }, icon("alert"), h("span", { text }));

// ---------------------------------------------------------------------
// Bookinger
async function refreshPendingCount() {
  try {
    const rows = await call((token) => select("appointments", `select=id&status=eq.pending&appointment_date=gte.${today}&limit=999`, { token }));
    state.pendingCount = rows?.length || 0;
    const badge = $("#pending-count");
    if (badge) {
      badge.textContent = String(state.pendingCount);
      badge.hidden = state.pendingCount === 0;
      badge.setAttribute("aria-label", `${state.pendingCount} afventer`);
    }
  } catch (error) {
    report(error);
  }
}

function bookingQuery() {
  const { period, status, staff } = state.filter;
  const parts = ["select=*"];
  if (period === "upcoming") parts.push(`appointment_date=gte.${today}`, "order=appointment_date.asc,start_time.asc", "limit=500");
  if (period === "today") parts.push(`appointment_date=eq.${today}`, "order=start_time.asc");
  if (period === "past") parts.push(`appointment_date=lt.${today}`, "order=appointment_date.desc,start_time.desc", "limit=300");
  if (period === "all") parts.push("order=appointment_date.desc,start_time.desc", "limit=500");
  if (status !== "all") parts.push(`status=eq.${status}`);
  if (isAdmin() && staff !== "all") parts.push(`staff_id=eq.${staff}`);
  return parts.join("&");
}

async function renderBookings() {
  const panel = $("#panel");
  const list = h("div", { "aria-live": "polite" }, loading());
  const periods = [["upcoming", "Kommende"], ["today", "I dag"], ["past", "Tidligere"], ["all", "Alle"]];
  const search = h("input", {
    class: "input", type: "search", value: state.filter.q, "aria-label": "Søg i bookinger",
    placeholder: "Søg på navn, telefon, e-mail eller bookingnr.",
    oninput: () => { state.filter.q = search.value; drawBookings(list); },
  });
  const statusSelect = h("select", {
    class: "select", "aria-label": "Vis status",
    onchange: () => { state.filter.status = statusSelect.value; loadBookings(list); },
  },
  h("option", { value: "all", text: "Alle statusser" }),
  Object.entries(STATUS).map(([value, label]) => h("option", { value, text: label })));
  statusSelect.value = state.filter.status;

  let staffSelect = null;
  if (isAdmin() && state.staff.length > 1) {
    staffSelect = h("select", {
      class: "select", "aria-label": "Vis frisør",
      onchange: () => { state.filter.staff = staffSelect.value; loadBookings(list); },
    },
    h("option", { value: "all", text: "Alle frisører" }),
    state.staff.map((s) => h("option", { value: s.id, text: s.is_active ? s.name : `${s.name} (inaktiv)` })));
    staffSelect.value = state.staff.some((s) => s.id === state.filter.staff) ? state.filter.staff : "all";
    state.filter.staff = staffSelect.value;
  }

  fill(panel,
    panelHead("Bookinger", isAdmin()
      ? "Kunden får ikke automatisk besked, når du ændrer status eller frisør. Kontakt kunden på telefon eller e-mail, hvis det er nødvendigt."
      : `Her ser du dine egne bookinger, ${firstName(state.me.staff_name)}. Kunden får ikke automatisk besked, når du ændrer status.`),
    h("div", { class: `filters${staffSelect ? " filters--4" : ""}` },
      h("div", { class: "segmented", role: "group", "aria-label": "Periode" }, periods.map(([value, label]) => h("button", {
        type: "button", "aria-pressed": String(state.filter.period === value),
        onclick: (e) => {
          state.filter.period = value;
          $$(".segmented button", panel).forEach((b) => b.setAttribute("aria-pressed", String(b === e.currentTarget)));
          loadBookings(list);
        },
      }, label))),
      statusSelect,
      staffSelect,
      search,
    ),
    list,
  );
  await loadBookings(list);
}

async function loadBookings(list) {
  fill(list, loading());
  try {
    state.bookings = await call((token) => select("appointments", bookingQuery(), { token })) || [];
    drawBookings(list);
  } catch (error) {
    if (error instanceof SessionEnded) return;
    fill(list, errorNotice(`Bookingerne kunne ikke hentes. ${error.message}`));
  }
}

function matches(b, q) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  const digits = needle.replace(/\D/g, "");
  return [b.full_name, b.email, b.id.slice(0, 8)].some((v) => String(v || "").toLowerCase().includes(needle))
    || (digits.length >= 3 && String(b.phone || "").replace(/\D/g, "").includes(digits));
}

function drawBookings(list) {
  const rows = state.bookings.filter((b) => matches(b, state.filter.q));
  if (!rows.length) {
    return fill(list, h("div", { class: "notice" }, icon("info"), h("span", { text: state.filter.q ? "Ingen bookinger matcher søgningen." : "Ingen bookinger at vise." })));
  }
  const groups = new Map();
  for (const b of rows) {
    if (!groups.has(b.appointment_date)) groups.set(b.appointment_date, []);
    groups.get(b.appointment_date).push(b);
  }
  fill(list, [...groups].map(([date, items]) => h("section", { class: "day-group", "aria-label": dateLong(date) },
    h("h3", { class: "day-group__title" }, capitalize(dateLong(date)), date === today ? h("span", { text: " · i dag" }) : null, h("span", { text: ` · ${items.length} ${items.length === 1 ? "booking" : "bookinger"}` })),
    h("ul", { class: "booking-list" }, items.map(bookingCard)),
  )));
}

function bookingCard(b) {
  const service = state.services.find((s) => s.id === b.service_id);
  const selectId = `status-${b.id}`;
  const statusSelect = h("select", { class: "select", id: selectId },
    Object.entries(STATUS).map(([value, label]) => h("option", { value, text: label })));
  statusSelect.value = b.status;

  // Administratoren kan flytte bookingen til en anden frisør
  let staffControl = null;
  let staffSelect = null;
  if (isAdmin() && state.staff.length > 1) {
    const staffId = `staff-${b.id}`;
    staffSelect = h("select", { class: "select", id: staffId },
      state.staff.filter((s) => s.is_active || s.id === b.staff_id).map((s) => h("option", {
        value: s.id,
        text: `${s.name}${s.is_active ? "" : " (inaktiv)"}${b.service_id && !doesService(s.id, b.service_id) ? " (laver den ikke)" : ""}`,
      })));
    staffSelect.value = b.staff_id;
    staffControl = [h("label", { class: "label booking-card__label", for: staffId, text: "Frisør" }), staffSelect];
  }

  const card = h("li", { class: `booking-card${b.status === "cancelled" ? " is-cancelled" : ""}`, id: `booking-${b.id}` },
    h("div", null,
      h("div", { class: "booking-card__time", text: timeRange(b.start_time, b.end_time) }),
      h("div", { class: "booking-card__service", text: service?.name || "Ukendt behandling" }),
      !staffControl && isAdmin() && b.staff_id ? h("div", { class: "booking-card__staff" }, avatar(staffNameOf(b.staff_id)), h("span", { text: staffNameOf(b.staff_id) })) : null,
    ),
    h("div", { class: "booking-card__customer" },
      h("div", { class: "booking-card__name", text: b.full_name }),
      h("div", { class: "booking-card__contact" },
        b.phone ? h("a", { href: telHref(b.phone) }, icon("phone"), h("span", { text: b.phone })) : null,
        b.email ? h("a", { href: `mailto:${b.email}` }, icon("mail"), h("span", { text: b.email })) : null,
      ),
      b.notes ? h("p", { class: "booking-card__notes", text: b.notes }) : null,
      h("p", { class: "booking-card__ref", text: `Bookingnr. ${b.id.slice(0, 8).toUpperCase()} · Oprettet ${timestamp(b.created_at)}` }),
    ),
    h("div", { class: "booking-card__status" },
      h("span", { class: `badge badge--${b.status}`, text: STATUS[b.status] || b.status }),
      h("label", { class: "label sr-only", for: selectId, text: `Status for ${b.full_name} kl. ${clock(b.start_time)}` }),
      statusSelect,
      staffControl,
    ),
  );
  statusSelect.addEventListener("change", () => changeStatus(b, statusSelect, card));
  staffSelect?.addEventListener("change", () => moveBooking(b, staffSelect, card));
  return card;
}

async function changeStatus(b, statusSelect, card) {
  const next = statusSelect.value;
  if (next === b.status) return;
  if (next === "cancelled") {
    const ok = await confirmDialog({
      title: "Aflys bookingen?",
      text: `${b.full_name}, ${dateShort(b.appointment_date)} kl. ${clock(b.start_time)}. Tiden bliver ledig for andre kunder, og kunden får ikke automatisk besked.`,
      confirm: "Aflys booking",
      cancel: "Behold booking",
      danger: true,
    });
    if (!ok) {
      statusSelect.value = b.status;
      return;
    }
  }
  statusSelect.disabled = true;
  try {
    const rows = await call((token) => update("appointments", `id=eq.${b.id}`, { status: next }, { token }));
    if (!rows?.length) throw new ApiError("Du har ikke adgang til at ændre bookingen.");
    Object.assign(b, rows[0]);
    const fresh = bookingCard(b);
    card.replaceWith(fresh);
    $(`#status-${b.id}`)?.focus();
    toast(`Status ændret til ${STATUS[next]}.`);
    refreshPendingCount();
  } catch (error) {
    statusSelect.value = b.status;
    statusSelect.disabled = false;
    if (error instanceof SessionEnded) return;
    toast(error.code === "23P01" ? "Tiden er optaget af en anden booking, så denne kan ikke genåbnes." : error.message, { error: true });
  }
}

async function moveBooking(b, staffSelect, card) {
  const next = staffSelect.value;
  if (next === b.staff_id) return;
  staffSelect.disabled = true;
  try {
    const rows = await call((token) => update("appointments", `id=eq.${b.id}`, { staff_id: next }, { token }));
    if (!rows?.length) throw new ApiError("Du har ikke adgang til at flytte bookingen.");
    Object.assign(b, rows[0]);
    const fresh = bookingCard(b);
    card.replaceWith(fresh);
    $(`#staff-${b.id}`)?.focus();
    toast(`Bookingen er flyttet til ${staffNameOf(next)}.`);
  } catch (error) {
    staffSelect.value = b.staff_id;
    staffSelect.disabled = false;
    if (error instanceof SessionEnded) return;
    toast(error.code === "23P01" ? `${staffNameOf(next)} har allerede en booking på det tidspunkt.` : error.message, { error: true });
  }
}

// Én booking i en dialog (fra dagsplanen)
function openBookingDialog(b, onClose) {
  const close = h("button", { class: "btn btn--quiet btn--sm", type: "button", "aria-label": "Luk" }, icon("x"));
  const dialog = h("dialog", { class: "dialog dialog--wide", "aria-labelledby": "booking-dialog-title" },
    h("div", { class: "dialog__head" },
      h("h2", { id: "booking-dialog-title", text: `${capitalize(dateShort(b.appointment_date))} kl. ${clock(b.start_time)}` }),
      close,
    ),
    h("ul", { class: "booking-list" }, bookingCard(b)),
  );
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => {
    dialog.remove();
    onClose?.();
  });
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
}

// ---------------------------------------------------------------------
// Dagsplan: én kolonne pr. frisør
async function renderPlan() {
  const panel = $("#panel");
  const body = h("div", { "aria-live": "polite" }, loading());
  const title = h("h3", { class: "plan-nav__date" });
  const go = (days) => {
    state.planDate = days === 0 ? today : addDays(state.planDate, days);
    drawPlan();
  };
  fill(panel,
    panelHead("Dagsplan", isAdmin()
      ? "Klik på en booking for at se detaljer, ændre status eller flytte den til en anden frisør. Skraverede felter er tider, hvor frisøren ikke arbejder."
      : "Dine bookinger dag for dag. Klik på en booking for at se detaljer og ændre status."),
    h("div", { class: "plan-nav" },
      h("button", { class: "cal__nav", type: "button", "aria-label": "Forrige dag", onclick: () => go(-1) }, icon("left")),
      title,
      h("button", { class: "cal__nav", type: "button", "aria-label": "Næste dag", onclick: () => go(1) }, icon("right")),
      h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "I dag", onclick: () => go(0) }),
    ),
    body,
  );

  async function drawPlan() {
    const date = state.planDate;
    title.textContent = `${capitalize(dateLong(date))}${date === today ? " · i dag" : ""}`;
    fill(body, loading());
    try {
      const [bookings, hours, off] = await Promise.all([
        call((token) => select("appointments", `select=*&appointment_date=eq.${date}&status=neq.cancelled&order=start_time.asc`, { token })),
        state.staffHours || call((token) => select("staff_hours", "select=*", { token })),
        call((token) => select("staff_time_off", `select=*&starts_at=lt.${addDays(date, 1)}T00:00:00&ends_at=gt.${date}T00:00:00`, { token })),
      ]);
      state.staffHours = hours || [];
      if (date !== state.planDate) return;
      fill(body, planGrid(date, bookings || [], state.staffHours, off || [], drawPlan));
      // På smalle skærme kan kolonnerne fylde mere end skærmen
      requestAnimationFrame(() => {
        const plan = $(".plan", body);
        if (plan && plan.scrollWidth > plan.clientWidth + 4) plan.before(h("p", { class: "plan__hint muted", text: "Rul til siden for at se alle frisører." }));
      });
    } catch (error) {
      if (error instanceof SessionEnded) return;
      fill(body, errorNotice(`Dagsplanen kunne ikke hentes. ${error.message}`));
    }
  }
  await drawPlan();
}

function planGrid(date, bookings, hours, off, refresh) {
  const dow = weekday(date);
  const salon = state.hours
    .filter((r) => r.weekday === dow && r.is_open && r.start_time && r.end_time)
    .map((r) => [toMin(r.start_time), toMin(r.end_time)]);
  // Kolonner: frisører, der arbejder eller har bookinger denne dag
  const people = state.staff.filter((s) => {
    if (!isAdmin()) return s.id === state.me.staff_id;
    return bookings.some((b) => b.staff_id === s.id)
      || (s.is_active && hours.some((x) => x.staff_id === s.id && x.weekday === dow && x.is_working));
  });
  if (!people.length) {
    return h("div", { class: "notice" }, icon("info"), h("span", {
      text: salon.length ? "Ingen frisører arbejder denne dag, og der er ingen bookinger." : "Salonen har lukket denne dag, og der er ingen bookinger.",
    }));
  }

  // Arbejdstid = salonens åbningstid ∩ frisørens arbejdstid
  const work = new Map(people.map((p) => {
    const row = hours.find((x) => x.staff_id === p.id && x.weekday === dow);
    const spans = row?.is_working && row.start_time && row.end_time
      ? salon.map(([a, b]) => [Math.max(a, toMin(row.start_time)), Math.min(b, toMin(row.end_time))]).filter(([a, b]) => b > a)
      : [];
    return [p.id, spans];
  }));
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${addDays(date, 1)}T00:00:00`;
  const away = new Map(people.map((p) => [p.id, off.filter((t) => t.staff_id === p.id).map((t) => [
    t.starts_at <= dayStart ? 0 : toMin(t.starts_at.slice(11)),
    t.ends_at >= dayEnd ? 24 * 60 : toMin(t.ends_at.slice(11)),
  ])]));

  const points = [...salon.flat(), ...[...work.values()].flat(2), ...bookings.flatMap((b) => [toMin(b.start_time), toMin(b.end_time)])];
  const start = points.length ? Math.floor(Math.min(...points) / 60) * 60 : 9 * 60;
  const end = points.length ? Math.max(Math.ceil(Math.max(...points) / 60) * 60, start + 60) : 17 * 60;
  const STEP = 5; // minutter pr. række i gitteret
  const row = (m) => Math.round((Math.min(Math.max(m, start), end) - start) / STEP) + 2;
  const place = (el, col, from, to) => {
    el.style.gridColumn = String(col);
    el.style.gridRow = `${row(from)} / ${row(to)}`;
    return el;
  };

  const grid = h("div", { class: "plan__grid" }, h("div", { class: "plan__corner" }));
  grid.style.setProperty("--cols", String(people.length));
  grid.style.setProperty("--rows", String((end - start) / STEP));

  people.forEach((p, i) => {
    const col = i + 2;
    const spans = [...work.get(p.id)].sort((x, y) => x[0] - y[0]);
    const head = h("div", { class: "plan__head" }, avatar(p.name), h("div", null,
      h("strong", { text: p.name }),
      h("span", { text: spans.length ? spans.map(([a, b]) => timeRange(hhmm(a), hhmm(b))).join(", ") : "Arbejder ikke" }),
    ));
    head.style.gridColumn = String(col);
    grid.append(head, place(h("div", { class: "plan__col" }), col, start, end));
    let cursor = start;
    for (const [a, b] of spans) {
      if (a > cursor) grid.append(place(h("div", { class: "plan__off" }), col, cursor, a));
      cursor = Math.max(cursor, b);
    }
    if (cursor < end) grid.append(place(h("div", { class: "plan__off" }), col, cursor, end));
    for (const [a, b] of away.get(p.id)) {
      if (b > start && a < end) grid.append(place(h("div", { class: "plan__off plan__off--away" }, h("span", { text: "Fravær" })), col, a, b));
    }
  });

  for (let m = start; m < end; m += 60) {
    const label = h("div", { class: "plan__hour", text: clock(hhmm(m)) });
    label.style.gridColumn = "1";
    label.style.gridRow = `${row(m)} / span ${60 / STEP}`;
    grid.append(label);
  }

  for (const b of bookings) {
    const col = people.findIndex((p) => p.id === b.staff_id) + 2;
    if (col < 2) continue;
    const service = state.services.find((s) => s.id === b.service_id);
    grid.append(place(h("button", {
      class: `plan__item plan__item--${b.status}`, type: "button",
      "aria-label": `${timeRange(b.start_time, b.end_time)}, ${b.full_name}, ${service?.name || "ukendt behandling"}, ${(STATUS[b.status] || b.status).toLowerCase()}`,
      onclick: () => openBookingDialog(b, refresh),
    },
    h("span", { class: "plan__time", text: timeRange(b.start_time, b.end_time) }),
    h("span", { class: "plan__name", text: b.full_name }),
    h("span", { class: "plan__service", text: service?.name || "" }),
    ), col, toMin(b.start_time), toMin(b.end_time)));
  }

  const pending = bookings.filter((b) => b.status === "pending").length;
  return [
    h("p", { class: "plan__summary muted", text: bookings.length ? `${bookings.length} ${bookings.length === 1 ? "booking" : "bookinger"}${pending ? `, heraf ${pending} afventer` : ""}.` : "Ingen bookinger." }),
    h("div", { class: "plan", role: "region", "aria-label": `Dagsplan for ${dateLong(date)}`, tabindex: "0" }, grid),
  ];
}

// ---------------------------------------------------------------------
// Frisører
let editorSeq = 0;

function salonHoursText(day) {
  const rows = state.hours.filter((r) => r.weekday === day && r.is_open && r.start_time && r.end_time);
  return rows.length ? `Salonen: ${rows.map((r) => timeRange(r.start_time, r.end_time)).join(", ")}` : "Salonen har lukket";
}

function salonDefault(day) {
  const rows = state.hours.filter((r) => r.weekday === day && r.is_open && r.start_time && r.end_time);
  return rows.length ? { from: rows[0].start_time.slice(0, 5), to: rows.at(-1).end_time.slice(0, 5) } : { from: "09:00", to: "17:00" };
}

function serviceChecks(isChecked) {
  return h("div", { class: "check-grid" }, state.services.map((s) => {
    const box = h("input", { type: "checkbox", checked: isChecked(s), dataset: { service: s.id } });
    return h("label", { class: "check" }, box, h("span", null, s.name, s.is_active ? null : h("span", { class: "muted", text: " (skjult)" })));
  }));
}

async function renderStaff() {
  const panel = $("#panel");
  const list = h("div", { class: "editor-list" }, loading());
  const add = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icon("plus"), "Tilføj frisør");
  fill(panel,
    panelHead("Frisører", "Frisørerne vises på hjemmesiden og i bookingen. En frisør kan kun bookes til de behandlinger, der er sat flueben ved, og kun når både salonen har åbent og frisøren arbejder.", add),
    list,
  );
  let logins = null;
  try {
    const [hours, loginRows] = await Promise.all([
      call((token) => select("staff_hours", "select=*&order=weekday.asc", { token })),
      call((token) => rpc("admin_staff_logins", {}, { token })).catch((error) => {
        if (error instanceof SessionEnded) throw error;
        return null;
      }),
    ]);
    state.staffHours = hours || [];
    logins = loginRows ? new Map(loginRows.map((l) => [l.staff_id, l.email])) : null;
  } catch (error) {
    if (error instanceof SessionEnded) return;
    return fill(list, errorNotice(`Frisørerne kunne ikke hentes. ${error.message}`));
  }

  add.addEventListener("click", () => {
    if ($(".editor.is-new", list)) return $(".editor.is-new input", list).focus();
    const editor = newStaffEditor();
    list.prepend(editor);
    $("input", editor).focus();
  });
  fill(list, state.staff.length
    ? state.staff.map((person) => staffEditor(person, logins))
    : h("div", { class: "notice" }, icon("info"), h("span", { text: "Der er ingen frisører endnu. Tilføj den første." })));
}

function newStaffEditor() {
  const n = ++editorSeq;
  const name = h("input", { class: "input", id: `st${n}-name`, maxlength: "60", required: true, "aria-describedby": `st${n}-name-error` });
  const checks = serviceChecks((s) => s.is_active);
  const save = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "Opret frisør" });
  const form = h("form", { class: "editor is-new", novalidate: true, "aria-label": "Ny frisør" },
    h("div", { class: "field" }, h("label", { class: "label", for: name.id, text: "Navn" }), name, h("p", { class: "error", id: `st${n}-name-error` })),
    h("div", { class: "staff-editor__section" }, h("h3", { text: "Behandlinger" }), checks),
    h("p", { class: "hint step__body", text: "Arbejdstiderne sættes til salonens åbningstider. Du kan rette dem bagefter." }),
    h("div", { class: "editor__foot" },
      h("span", { class: "spacer" }),
      h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Annullér", onclick: () => form.remove() }),
      save,
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const value = name.value.trim().replace(/\s+/g, " ");
    const error = $(`#st${n}-name-error`, form);
    if (value.length < 1 || value.length > 60) {
      name.setAttribute("aria-invalid", "true");
      fill(error, icon("alert"), h("span", { text: "Skriv frisørens navn." }));
      return name.focus();
    }
    save.disabled = true;
    try {
      const order = Math.max(0, ...state.staff.map((s) => s.sort_order || 0)) + 1;
      const rows = await call((token) => insert("staff", [{ name: value, is_active: true, sort_order: order }], { token }));
      const person = rows[0];
      const chosen = $$("input[data-service]", checks).filter((box) => box.checked).map((box) => box.dataset.service);
      if (chosen.length) await call((token) => insert("staff_services", chosen.map((service_id) => ({ staff_id: person.id, service_id })), { token }));
      state.staff.push(person);
      state.staffServices.set(person.id, new Set(chosen));
      state.staffHours = null;
      toast(`${person.name} er oprettet med salonens åbningstider som arbejdstider.`);
      renderStaff();
    } catch (err) {
      save.disabled = false;
      report(err);
    }
  });
  return form;
}

function staffEditor(person, logins) {
  const n = ++editorSeq;
  const name = h("input", { class: "input", id: `st${n}-name`, value: person.name, maxlength: "60", required: true, "aria-describedby": `st${n}-name-error` });
  const active = h("input", { type: "checkbox", checked: person.is_active });
  const checks = serviceChecks((s) => doesService(person.id, s.id));

  const hourRows = WEEK_ORDER.map((day) => {
    const row = state.staffHours.find((x) => x.staff_id === person.id && x.weekday === day) || null;
    const fallback = salonDefault(day);
    const fromValue = (row?.start_time || fallback.from).slice(0, 5);
    const toValue = (row?.end_time || fallback.to).slice(0, 5);
    const working = h("input", { type: "checkbox", checked: !!row?.is_working, "aria-label": `${person.name} arbejder ${WEEKDAYS[day]}` });
    const from = h("select", { class: "select", "aria-label": `${person.name} starter ${WEEKDAYS[day]}` }, timeOptions(fromValue));
    const to = h("select", { class: "select", "aria-label": `${person.name} slutter ${WEEKDAYS[day]}` }, timeOptions(toValue, { end: true }));
    from.value = fromValue;
    to.value = toValue;
    const tr = h("tr", { class: row?.is_working ? null : "is-closed" },
      h("td", { class: "day" }, capitalize(WEEKDAYS[day])),
      h("td", null, h("label", { class: "check" }, working, h("span", { text: "Arbejder" }))),
      h("td", { class: "times" }, from, h("span", { "aria-hidden": "true", text: "–" }), to),
      h("td", { class: "salon-hours", text: salonHoursText(day) }),
    );
    working.addEventListener("change", () => tr.classList.toggle("is-closed", !working.checked));
    return { day, row, working, from, to, tr };
  });

  const status = h("span", { class: "editor__status", "aria-live": "polite" });
  const save = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: "Gem ændringer", disabled: true });
  const loginBox = h("div", { class: "editor__login" });
  const summary = h("summary");

  // Oversigt i det lukkede kort: navn, behandlinger, arbejdsdage og login
  function drawSummary() {
    const offers = state.services.filter((s) => doesService(person.id, s.id)).map((s) => s.name);
    const days = (state.staffHours || []).filter((x) => x.staff_id === person.id && x.is_working).length;
    const email = logins?.get(person.id);
    fill(summary,
      avatar(person.name),
      h("span", { class: "staff-card__main" },
        h("span", { class: "staff-card__name" }, h("strong", { text: person.name }), person.is_active ? null : h("span", { class: "badge badge--inactive", text: "Inaktiv" })),
        h("span", { class: "staff-card__meta", text: [
          offers.length ? listText(offers) : "Ingen behandlinger",
          days ? `arbejder ${days} ${days === 1 ? "dag" : "dage"} om ugen` : "arbejder ingen dage",
          email ? `login: ${email}` : "intet login",
        ].join(" · ") }),
      ),
      h("span", { class: "staff-card__edit", "aria-hidden": "true" }, "Ret", icon("right")),
    );
  }

  const form = h("form", { class: "editor staff-editor", novalidate: true, "aria-label": person.name },
    h("div", { class: "editor__grid" },
      h("div", { class: "field span-2" }, h("label", { class: "label", for: name.id, text: "Navn" }), name, h("p", { class: "error", id: `st${n}-name-error` })),
      h("div", { class: "field span-2 staff-editor__active" }, h("label", { class: "check" }, active, h("span", { text: "Aktiv – kan bookes og vises på hjemmesiden" }))),
    ),
    h("div", { class: "staff-editor__section" }, h("h3", { text: "Behandlinger" }), checks),
    h("div", { class: "staff-editor__section" },
      h("h3", { text: "Arbejdstider" }),
      h("table", { class: "hours-table" },
        h("thead", null, h("tr", null, h("th", { text: "Dag" }), h("th", { text: "Status" }), h("th", { text: "Arbejdstid" }), h("th", { text: "Åbningstid" }))),
        h("tbody", null, hourRows.map((r) => r.tr)),
      ),
      h("p", { class: "hint", text: "Kunderne kan kun booke, når både salonen har åbent og frisøren arbejder. Ferie og fridage registrerer du under Fravær." }),
    ),
    h("div", { class: "editor__foot" }, h("span", { class: "spacer" }), status, save),
    h("div", { class: "staff-editor__section" }, h("h3", { text: "Login" }), loginBox),
  );

  form.addEventListener("input", (e) => {
    if (loginBox.contains(e.target)) return;
    save.disabled = false;
    status.textContent = "Ikke gemt";
    if (e.target === name) {
      name.removeAttribute("aria-invalid");
      $(`#st${n}-name-error`, form).replaceChildren();
    }
  });
  form.addEventListener("change", (e) => {
    if (loginBox.contains(e.target)) return;
    save.disabled = false;
    status.textContent = "Ikke gemt";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newName = name.value.trim().replace(/\s+/g, " ");
    if (newName.length < 1 || newName.length > 60) {
      name.setAttribute("aria-invalid", "true");
      fill($(`#st${n}-name-error`, form), icon("alert"), h("span", { text: "Skriv frisørens navn." }));
      return name.focus();
    }
    const bad = hourRows.find((r) => r.working.checked && r.to.value <= r.from.value);
    if (bad) {
      toast(`${capitalize(WEEKDAYS[bad.day])}: Sluttiden skal ligge efter starttiden.`, { error: true });
      return bad.to.focus();
    }
    if (person.is_active && !active.checked) {
      const upcoming = await call((token) => select("appointments", `select=id&staff_id=eq.${person.id}&appointment_date=gte.${today}&status=in.(pending,confirmed)`, { token })).catch(() => []);
      const ok = await confirmDialog({
        title: `Gør ${person.name} inaktiv?`,
        text: `${person.name} kan ikke længere bookes, og et eventuelt login holder op med at virke.${upcoming?.length ? ` ${upcoming.length} kommende ${upcoming.length === 1 ? "booking bliver" : "bookinger bliver"} ikke flyttet eller aflyst automatisk – flyt dem under Bookinger.` : ""}`,
        confirm: "Gør inaktiv",
        cancel: "Annullér",
      });
      if (!ok) return;
    }

    save.disabled = true;
    status.textContent = "Gemmer …";
    try {
      if (newName !== person.name || active.checked !== person.is_active) {
        const rows = await call((token) => update("staff", `id=eq.${person.id}`, { name: newName, is_active: active.checked }, { token }));
        if (!rows?.length) throw new ApiError("Du har ikke adgang til at ændre frisøren.");
        Object.assign(person, rows[0]);
      }

      const want = new Set($$("input[data-service]", checks).filter((box) => box.checked).map((box) => box.dataset.service));
      const have = state.staffServices.get(person.id) || new Set();
      const added = [...want].filter((id) => !have.has(id));
      const dropped = [...have].filter((id) => !want.has(id));
      if (added.length) await call((token) => insert("staff_services", added.map((service_id) => ({ staff_id: person.id, service_id })), { token }));
      if (dropped.length) await call((token) => remove("staff_services", `staff_id=eq.${person.id}&service_id=in.(${dropped.join(",")})`, { token }));
      state.staffServices.set(person.id, want);

      for (const r of hourRows) {
        const values = r.working.checked
          ? { is_working: true, start_time: r.from.value, end_time: r.to.value }
          : { is_working: false };
        const unchanged = r.row && r.row.is_working === values.is_working
          && (!values.is_working || (r.row.start_time?.slice(0, 5) === values.start_time && r.row.end_time?.slice(0, 5) === values.end_time));
        if (unchanged) continue;
        const saved = r.row
          ? await call((token) => update("staff_hours", `id=eq.${r.row.id}`, values, { token }))
          : await call((token) => insert("staff_hours", [{ staff_id: person.id, weekday: r.day, ...values }], { token }));
        if (!saved?.length) throw new ApiError("Du har ikke adgang til at ændre arbejdstiderne.");
        if (r.row) Object.assign(r.row, saved[0]);
        else { r.row = saved[0]; state.staffHours.push(saved[0]); }
      }

      status.textContent = "Gemt";
      form.setAttribute("aria-label", person.name);
      drawSummary();
      toast(`${person.name} er gemt.`);
    } catch (error) {
      save.disabled = false;
      status.textContent = "Ikke gemt";
      report(error);
    }
  });

  function drawLogin() {
    if (!logins) return fill(loginBox, h("p", { class: "hint", text: "Logins kunne ikke hentes lige nu." }));
    const email = logins.get(person.id);
    if (email) {
      return fill(loginBox,
        h("p", { class: "editor__login-status" }, icon("user"), h("span", null, "Logger ind med ", h("strong", { text: email }))),
        h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Fjern login", onclick: unlink }),
      );
    }
    const input = h("input", { class: "input", type: "email", id: `st${n}-login`, inputmode: "email", autocomplete: "off", placeholder: "frisoer@eksempel.dk" });
    const button = h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Giv login" });
    button.addEventListener("click", () => link(input, button));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        button.click();
      }
    });
    fill(loginBox,
      h("label", { class: "label sr-only", for: input.id, text: `Login-e-mail til ${person.name}` }),
      input,
      button,
      h("p", { class: "hint", text: "Opret først brugeren i Supabase under Authentication → Users med Auto Confirm User. Så kan frisøren logge ind her og se sine egne bookinger." }),
    );
  }

  async function link(input, button) {
    const email = input.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      input.setAttribute("aria-invalid", "true");
      toast("Skriv en gyldig e-mailadresse.", { error: true });
      return input.focus();
    }
    input.removeAttribute("aria-invalid");
    button.disabled = true;
    try {
      const result = await call((token) => rpc("link_staff_login", { p_staff_id: person.id, p_email: email }, { token }));
      logins.set(person.id, result.email);
      drawLogin();
      drawSummary();
      toast(`${person.name} kan nu logge ind med ${result.email}.`);
    } catch (error) {
      button.disabled = false;
      report(error);
    }
  }

  async function unlink() {
    const ok = await confirmDialog({
      title: "Fjern login?",
      text: `${person.name} kan ikke længere logge ind og se sine bookinger. Brugeren bliver ikke slettet i Supabase.`,
      confirm: "Fjern login",
      cancel: "Behold login",
      danger: true,
    });
    if (!ok) return;
    try {
      await call((token) => rpc("link_staff_login", { p_staff_id: person.id, p_email: "" }, { token }));
      logins.delete(person.id);
      drawLogin();
      drawSummary();
      toast(`Login er fjernet fra ${person.name}.`);
    } catch (error) {
      report(error);
    }
  }

  drawLogin();
  drawSummary();
  return h("details", { class: "staff-card" }, summary, form);
}

// ---------------------------------------------------------------------
// Fravær (pr. frisør)
function describeAbsence(t) {
  const d1 = t.starts_at.slice(0, 10);
  const d2 = t.ends_at.slice(0, 10);
  const t1 = t.starts_at.slice(11, 16);
  const t2 = t.ends_at.slice(11, 16);
  if (t1 === "00:00" && t2 === "00:00") {
    const last = addDays(d2, -1);
    return last === d1 ? `${capitalize(dateLong(d1))}, hele dagen` : `${capitalize(dateLong(d1))} til ${dateLong(last)}`;
  }
  if (d1 === d2) return `${capitalize(dateLong(d1))} kl. ${timeRange(t1, t2)}`;
  return `${capitalize(dateLong(d1))} kl. ${clock(t1)} til ${dateLong(d2)} kl. ${clock(t2)}`;
}

function absenceDays(t) {
  const days = [];
  const last = t.ends_at.slice(11, 16) === "00:00" ? addDays(t.ends_at.slice(0, 10), -1) : t.ends_at.slice(0, 10);
  for (let d = t.starts_at.slice(0, 10); d <= last && days.length < 400; d = addDays(d, 1)) days.push(d);
  return days;
}

async function renderTimeOff() {
  const panel = $("#panel");
  const intro = "Fravær gælder én frisør ad gangen – fx ferie, sygdom, kursus eller et lægebesøg. I den tid kan frisøren ikke bookes. Årsagen ses kun af personalet.";
  fill(panel, panelHead("Fravær", intro), loading());
  try {
    state.timeOff = await call((token) => select("staff_time_off", "select=*&order=starts_at.asc", { token })) || [];
  } catch (error) {
    if (error instanceof SessionEnded) return;
    return fill(panel, panelHead("Fravær"), errorNotice(`Fraværet kunne ikke hentes. ${error.message}`));
  }
  const people = activeStaff();
  if (!people.length) {
    return fill(panel, panelHead("Fravær", intro), h("div", { class: "notice" }, icon("info"), h("span", { text: "Der er ingen aktive frisører." })));
  }

  let staffId = people[0].id;
  let range = { start: null, end: null };
  let showPast = false;

  const who = h("select", { class: "select", id: "off-staff" }, people.map((p) => h("option", { value: p.id, text: p.name })));
  const whole = h("input", { type: "checkbox", id: "off-whole", checked: true });
  const from = h("select", { class: "select", id: "off-from" }, timeOptions("09:00"));
  const to = h("select", { class: "select", id: "off-to" }, timeOptions("12:00", { end: true }));
  from.value = "09:00";
  to.value = "12:00";
  const times = h("div", { class: "off-times", hidden: true },
    h("label", { class: "label sr-only", for: "off-from", text: "Fra kl." }), from,
    h("span", { "aria-hidden": "true", text: "–" }),
    h("label", { class: "label sr-only", for: "off-to", text: "Til kl." }), to,
  );
  const selection = h("p", { class: "step__intro", "aria-live": "polite" });
  const warning = h("div");
  const reason = h("input", { class: "input", id: "off-reason", maxlength: "200", placeholder: "Fx ferie, kursus eller lægebesøg" });
  const save = h("button", { class: "btn btn--primary", type: "button", text: "Registrér fravær", disabled: true });
  const listWrap = h("div");

  const markedDays = () => new Set(state.timeOff.filter((t) => t.staff_id === staffId).flatMap(absenceDays));

  const calendar = createCalendar({
    label: "Vælg dage med fravær",
    min: today,
    max: addDays(today, 730),
    dayInfo: (iso) => {
      if (iso < today) return { status: "unavailable", disabled: true };
      return markedDays().has(iso) ? { status: "open", marked: true, label: "fravær" } : { status: "open" };
    },
    isSelected: (iso) => iso === range.start || iso === range.end,
    isInRange: (iso) => !!(range.start && range.end && iso > range.start && iso < range.end),
    onSelect: (iso) => {
      if (!range.start || range.end || iso < range.start) range = { start: iso, end: null };
      else if (iso === range.start) range = { start: null, end: null };
      else range = { ...range, end: iso };
      calendar.render();
      updateSelection();
    },
  });

  function selectedDates() {
    if (!range.start) return [];
    const dates = [];
    for (let d = range.start; d <= (range.end || range.start); d = addDays(d, 1)) dates.push(d);
    return dates;
  }

  function period() {
    const dates = selectedDates();
    if (!dates.length || dates.length > 92) return null;
    if (whole.checked || dates.length > 1) return { starts_at: `${dates[0]}T00:00:00`, ends_at: `${addDays(dates.at(-1), 1)}T00:00:00` };
    if (to.value <= from.value) return { error: "Sluttidspunktet skal ligge efter starttidspunktet." };
    return { starts_at: `${dates[0]}T${from.value}:00`, ends_at: `${dates[0]}T${to.value}:00` };
  }

  let checkSeq = 0;
  async function updateSelection() {
    const dates = selectedDates();
    const name = staffNameOf(staffId);
    warning.replaceChildren();
    whole.disabled = dates.length > 1;
    if (dates.length > 1) whole.checked = true;
    times.hidden = whole.checked;
    if (!dates.length) {
      selection.textContent = `Vælg den første dag, hvor ${name} er væk – og eventuelt den sidste, hvis det er flere dage.`;
      save.disabled = true;
      return;
    }
    if (dates.length > 92) {
      selection.textContent = "Vælg højst 92 dage ad gangen.";
      save.disabled = true;
      return;
    }
    const p = period();
    if (p?.error) {
      selection.textContent = p.error;
      save.disabled = true;
      return;
    }
    selection.textContent = `${name}: ${describeAbsence(p)}${dates.length > 1 ? ` (${dates.length} dage)` : ""}`;
    save.disabled = false;

    const seq = ++checkSeq;
    try {
      const rows = await call((token) => select("appointments",
        `select=id,appointment_date,start_time,end_time&staff_id=eq.${staffId}&appointment_date=gte.${dates[0]}&appointment_date=lte.${dates.at(-1)}&status=in.(pending,confirmed)`, { token }));
      if (seq !== checkSeq) return;
      const hits = (rows || []).filter((b) => `${b.appointment_date}T${b.start_time}` < p.ends_at && `${b.appointment_date}T${b.end_time}` > p.starts_at);
      if (hits.length) {
        fill(warning, h("div", { class: "notice notice--warn" }, icon("alert"), h("span", {
          text: `${name} har ${hits.length} ${hits.length === 1 ? "booking" : "bookinger"} i perioden. De bliver ikke flyttet eller aflyst automatisk – flyt dem til en anden frisør under Bookinger, eller kontakt kunderne.`,
        })));
      }
    } catch (error) {
      report(error);
    }
  }

  who.addEventListener("change", () => {
    staffId = who.value;
    calendar.render();
    updateSelection();
    drawList();
  });
  whole.addEventListener("change", updateSelection);
  from.addEventListener("change", updateSelection);
  to.addEventListener("change", updateSelection);

  save.addEventListener("click", async () => {
    const p = period();
    if (!p || p.error) return;
    save.disabled = true;
    try {
      const rows = await call((token) => insert("staff_time_off", [{ staff_id: staffId, starts_at: p.starts_at, ends_at: p.ends_at, reason: reason.value.trim() || null }], { token }));
      state.timeOff.push(...(rows || []));
      state.timeOff.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
      range = { start: null, end: null };
      reason.value = "";
      calendar.render();
      updateSelection();
      drawList();
      toast(`Fraværet for ${staffNameOf(staffId)} er registreret.`);
    } catch (error) {
      save.disabled = false;
      report(error);
    }
  });

  function drawList() {
    const now = `${today}T00:00:00`;
    const items = state.timeOff.filter((t) => showPast || t.ends_at > now);
    const pastCount = state.timeOff.filter((t) => t.ends_at <= now).length;
    fill(listWrap,
      h("h3", { class: "slots-title", text: showPast ? "Alt fravær" : "Kommende fravær" }),
      items.length
        ? h("ul", { class: "blocked-list" }, items.map((t) => h("li", null,
          h("div", null,
            h("strong", { text: staffNameOf(t.staff_id) }),
            h("span", { class: "reason", text: describeAbsence(t) }),
            t.reason ? h("span", { class: "reason", text: t.reason }) : null,
          ),
          h("button", {
            class: "btn btn--ghost btn--sm", type: "button", text: "Fjern",
            "aria-label": `Fjern fravær for ${staffNameOf(t.staff_id)}: ${describeAbsence(t)}`,
            onclick: async (e) => {
              e.currentTarget.disabled = true;
              const button = e.currentTarget;
              try {
                const removed = await call((token) => remove("staff_time_off", `id=eq.${t.id}`, { token }));
                if (!removed?.length) throw new ApiError("Du har ikke adgang til at ændre fraværet.");
                state.timeOff = state.timeOff.filter((x) => x.id !== t.id);
                calendar.render();
                drawList();
                toast(`Fraværet er fjernet. ${staffNameOf(t.staff_id)} kan bookes igen i perioden.`);
              } catch (error) {
                button.disabled = false;
                report(error);
              }
            },
          }),
        )))
        : h("p", { class: "muted step__body", text: "Der er intet kommende fravær." }),
      pastCount ? h("p", { class: "fine" }, h("button", {
        class: "link-btn", type: "button", text: showPast ? "Skjul tidligere fravær" : `Vis tidligere fravær (${pastCount})`,
        onclick: () => { showPast = !showPast; drawList(); },
      })) : null,
    );
  }

  fill(panel,
    panelHead("Fravær", intro),
    h("div", { class: "blocked-layout" },
      h("div", { class: "fieldset" },
        h("div", { class: "field" }, h("label", { class: "label", for: "off-staff", text: "Frisør" }), who),
        h("h3", { class: "slots-title step__body", text: "Vælg en eller flere dage" }),
        selection,
        h("div", { class: "step__body" }, calendar.el),
        h("div", { class: "step__body" },
          h("label", { class: "check" }, whole, h("span", { text: "Hele dagen" })),
          times,
        ),
        h("div", { class: "field step__body" }, h("label", { class: "label", for: "off-reason" }, "Årsag ", h("span", { class: "optional", text: "(valgfri, kun for personalet)" })), reason),
        warning,
        h("div", { class: "editor__foot" }, h("span", { class: "spacer" }), save),
      ),
      listWrap,
    ),
  );
  updateSelection();
  drawList();
}

// ---------------------------------------------------------------------
// Behandlinger
async function renderServices() {
  const list = h("div", { class: "editor-list" });
  const add = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icon("plus"), "Tilføj behandling");
  add.addEventListener("click", () => {
    if ($(".editor.is-new", list)) return $(".editor.is-new input", list).focus();
    const editor = serviceEditor({ name: "", description: "", duration_minutes: 30, price: "", is_active: true, price_is_demo: false }, list, true);
    list.prepend(editor);
    $("input", editor).focus();
  });
  fill($("#panel"),
    panelHead("Behandlinger", "Ændringer vises på hjemmesiden med det samme. Skjulte behandlinger kan ikke bookes, men gamle bookinger bevares.", add),
    list,
  );
  fill(list, state.services.length ? state.services.map((s) => serviceEditor(s, list, false)) : h("div", { class: "notice" }, icon("info"), h("span", { text: "Der er ingen behandlinger endnu." })));
}

function serviceEditor(service, list, isNew) {
  const n = ++editorSeq;
  const hasDemo = isNew || "price_is_demo" in service;
  const field = (label, control, { span = "", hint = "" } = {}) => {
    control.id = control.id || `svc${n}-${label.toLowerCase().replace(/\W+/g, "")}`;
    const error = h("p", { class: "error", id: `${control.id}-error` });
    control.setAttribute("aria-describedby", `${hint ? `${control.id}-hint ` : ""}${control.id}-error`);
    return h("div", { class: `field ${span}`.trim() },
      h("label", { class: "label", for: control.id, text: label }),
      control,
      hint ? h("p", { class: "hint", id: `${control.id}-hint`, text: hint }) : null,
      error,
    );
  };
  const name = h("input", { class: "input", value: service.name, maxlength: "80", required: true });
  const description = h("textarea", { class: "textarea", value: service.description || "", maxlength: "500", rows: "2" });
  const minutes = h("input", { class: "input", type: "number", inputmode: "numeric", min: "5", max: "600", step: "5", value: String(service.duration_minutes ?? "") });
  const price = h("input", { class: "input", inputmode: "decimal", value: service.price === "" || service.price == null ? "" : String(service.price).replace(".", ",").replace(/,00$/, "") });
  const active = h("input", { type: "checkbox", checked: service.is_active !== false });
  const demo = h("input", { type: "checkbox", checked: !!service.price_is_demo });
  const status = h("span", { class: "editor__status", "aria-live": "polite" });
  const save = h("button", { class: "btn btn--primary btn--sm", type: "submit", text: isNew ? "Opret behandling" : "Gem ændringer", disabled: !isNew });
  const doers = isNew ? [] : activeStaff().filter((p) => doesService(p.id, service.id)).map((p) => p.name);

  const form = h("form", { class: `editor${isNew ? " is-new" : ""}`, novalidate: true, "aria-label": isNew ? "Ny behandling" : service.name },
    h("div", { class: "editor__grid" },
      field("Navn", name, { span: "span-2" }),
      field("Varighed (minutter)", minutes),
      field("Pris (kr.)", price, { hint: service.price_is_demo ? "Demopris – ret den til salonens egen pris." : "" }),
      field("Beskrivelse", description, { span: "span-4" }),
    ),
    isNew
      ? h("p", { class: "editor__who", text: "Alle aktive frisører kan bookes til den nye behandling. Det kan rettes under Frisører." })
      : h("p", { class: "editor__who", text: doers.length ? `Udføres af ${listText(doers)}.` : "Ingen aktiv frisør laver behandlingen, så den kan ikke bookes online. Ret det under Frisører." }),
    h("div", { class: "editor__foot" },
      h("label", { class: "check" }, active, h("span", { text: "Vis på hjemmesiden og i bookingen" })),
      hasDemo ? h("label", { class: "check" }, demo, h("span", { text: "Demopris (vises med markering)" })) : null,
      h("span", { class: "spacer" }),
      status,
      isNew ? h("button", { class: "btn btn--ghost btn--sm", type: "button", text: "Annullér", onclick: () => form.remove() }) : null,
      save,
    ),
  );

  const errorFor = (control, message) => {
    control.setAttribute("aria-invalid", message ? "true" : "false");
    fill($(`#${control.id}-error`, form), message ? [icon("alert"), h("span", { text: message })] : []);
  };

  form.addEventListener("input", (e) => {
    save.disabled = false;
    status.textContent = "Ikke gemt";
    if (e.target === price && demo.checked) demo.checked = false; // en rettet pris er salonens egen
    if (e.target.getAttribute("aria-invalid") === "true") errorFor(e.target, "");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = {
      name: name.value.trim(),
      description: description.value.trim() || null,
      duration_minutes: Number(minutes.value),
      price: parseAmount(price.value),
      is_active: active.checked,
    };
    if (hasDemo) values.price_is_demo = demo.checked;

    let invalid = null;
    const check = (control, message) => { errorFor(control, message); if (message && !invalid) invalid = control; };
    check(name, values.name.length >= 2 ? "" : "Skriv et navn (mindst 2 tegn).");
    check(minutes, Number.isInteger(values.duration_minutes) && values.duration_minutes >= 5 && values.duration_minutes <= 600 ? "" : "Skriv et helt antal minutter mellem 5 og 600.");
    check(price, Number.isFinite(values.price) && values.price >= 0 && values.price <= 100000 ? "" : "Skriv en pris i kroner, fx 495 eller 495,50.");
    if (invalid) return invalid.focus();

    save.disabled = true;
    status.textContent = "Gemmer …";
    try {
      if (isNew) {
        const rows = await call((token) => insert("services", [values], { token }));
        const created = rows[0];
        state.services.push(created);
        state.services.sort(byName);
        // Nye behandlinger kan bookes hos alle aktive frisører
        const team = activeStaff();
        if (team.length) {
          await call((token) => insert("staff_services", team.map((p) => ({ staff_id: p.id, service_id: created.id })), { token }));
          for (const p of team) {
            if (!state.staffServices.has(p.id)) state.staffServices.set(p.id, new Set());
            state.staffServices.get(p.id).add(created.id);
          }
        }
        toast(`${values.name} er oprettet.`);
        renderServices();
      } else {
        const rows = await call((token) => update("services", `id=eq.${service.id}`, values, { token }));
        if (!rows?.length) throw new ApiError("Du har ikke adgang til at ændre behandlingen.");
        Object.assign(service, rows[0]);
        status.textContent = "Gemt";
        form.setAttribute("aria-label", service.name);
        toast(`${service.name} er gemt.`);
      }
    } catch (error) {
      save.disabled = false;
      status.textContent = "Ikke gemt";
      report(error);
    }
  });

  return form;
}

// ---------------------------------------------------------------------
// Åbningstider
function timeOptions(selected, { end = false } = {}) {
  const values = [];
  for (let m = 5 * 60 + (end ? 15 : 0); m <= (end ? 24 * 60 : 23 * 60 + 45); m += 15) {
    values.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  const current = selected ? selected.slice(0, 5) : null;
  if (current && !values.includes(current)) values.push(current);
  values.sort();
  return values.map((v) => h("option", { value: v, text: clock(v) }));
}

async function renderHours() {
  const rows = WEEK_ORDER.map((day) => {
    const existing = state.hours.filter((r) => r.weekday === day);
    const row = existing[0] || null;
    const open = h("input", { type: "checkbox", checked: !!row?.is_open });
    const from = h("select", { class: "select", "aria-label": `Åbner ${WEEKDAYS[day]}` }, timeOptions(row?.start_time || "09:00"));
    const to = h("select", { class: "select", "aria-label": `Lukker ${WEEKDAYS[day]}` }, timeOptions(row?.end_time || "17:00", { end: true }));
    from.value = (row?.start_time || "09:00").slice(0, 5);
    to.value = (row?.end_time || "17:00").slice(0, 5);
    const tr = h("tr", { class: row?.is_open ? null : "is-closed" },
      h("td", { class: "day" }, capitalize(WEEKDAYS[day]), existing.length > 1 ? h("span", { class: "hint", text: ` (${existing.length} perioder – kun den første kan rettes her)` }) : null),
      h("td", null, h("label", { class: "check" }, open, h("span", { text: "Åben" }))),
      h("td", { class: "times" }, from, h("span", { "aria-hidden": "true", text: "–" }), to),
    );
    open.addEventListener("change", () => tr.classList.toggle("is-closed", !open.checked));
    return { day, row, open, from, to, tr };
  });

  const error = h("div", { role: "alert" });
  const save = h("button", { class: "btn btn--primary", type: "button", text: "Gem åbningstider" });
  save.addEventListener("click", async () => {
    error.replaceChildren();
    const bad = rows.find((r) => r.open.checked && r.to.value <= r.from.value);
    if (bad) {
      fill(error, h("div", { class: "notice notice--error" }, icon("alert"), h("span", { text: `${capitalize(WEEKDAYS[bad.day])}: Lukketiden skal ligge efter åbningstiden.` })));
      return bad.to.focus();
    }
    save.disabled = true;
    try {
      for (const r of rows) {
        const values = r.open.checked
          ? { is_open: true, start_time: r.from.value, end_time: r.to.value }
          : { is_open: false };
        const unchanged = r.row && r.row.is_open === values.is_open
          && (!values.is_open || (r.row.start_time?.slice(0, 5) === values.start_time && r.row.end_time?.slice(0, 5) === values.end_time));
        if (unchanged) continue;
        const saved = r.row
          ? await call((token) => update("business_hours", `id=eq.${r.row.id}`, values, { token }))
          : await call((token) => insert("business_hours", [{ weekday: r.day, ...values }], { token }));
        if (!saved?.length) throw new ApiError("Du har ikke adgang til at ændre åbningstiderne.");
        if (r.row) Object.assign(r.row, saved[0]);
        else { r.row = saved[0]; state.hours.push(saved[0]); }
      }
      toast("Åbningstiderne er gemt.");
    } catch (err) {
      report(err);
    } finally {
      save.disabled = false;
    }
  });

  fill($("#panel"),
    panelHead("Åbningstider", "Bookingen viser kun tider, hvor hele behandlingen kan nås inden lukketid. Ændringer flytter ikke bookinger, der allerede er lavet. Frisørernes egne arbejdstider retter du under Frisører."),
    h("div", { class: "fieldset" },
      h("table", { class: "hours-table" },
        h("thead", null, h("tr", null, h("th", { text: "Dag" }), h("th", { text: "Status" }), h("th", { text: "Åbningstid" }))),
        h("tbody", null, rows.map((r) => r.tr)),
      ),
      error,
      h("div", { class: "editor__foot" }, h("span", { class: "spacer" }), save),
    ),
  );
}

// ---------------------------------------------------------------------
// Lukkedage (hele salonen)
async function renderBlocked() {
  const panel = $("#panel");
  fill(panel, panelHead("Lukkedage", "Lukkede dage kan ikke bookes hos nogen frisør. Årsagen ses kun af personalet. Fravær for én frisør registrerer du under Fravær."), loading());
  try {
    state.blocked = await call((token) => select("blocked_dates", "select=*&order=blocked_date.asc", { token })) || [];
  } catch (error) {
    if (error instanceof SessionEnded) return;
    return fill(panel, panelHead("Lukkedage"), errorNotice(`Lukkedagene kunne ikke hentes. ${error.message}`));
  }

  const blockedSet = () => new Set(state.blocked.map((b) => b.blocked_date));
  let range = { start: null, end: null };
  let showPast = false;

  const selection = h("p", { class: "step__intro", "aria-live": "polite" });
  const warning = h("div");
  const reason = h("input", { class: "input", id: "block-reason", maxlength: "200", placeholder: "Fx ferie eller kursus" });
  const save = h("button", { class: "btn btn--primary", type: "button", text: "Luk dagene", disabled: true });
  const listWrap = h("div");

  const calendar = createCalendar({
    label: "Vælg dage, der skal lukkes",
    min: today,
    max: addDays(today, 730),
    dayInfo: (iso) => {
      if (iso < today) return { status: "unavailable", disabled: true };
      return blockedSet().has(iso) ? { status: "open", marked: true, label: "lukket" } : { status: "open" };
    },
    isSelected: (iso) => iso === range.start || iso === range.end,
    isInRange: (iso) => !!(range.start && range.end && iso > range.start && iso < range.end),
    onSelect: (iso) => {
      if (!range.start || range.end || iso < range.start) range = { start: iso, end: null };
      else if (iso === range.start) range = { start: null, end: null };
      else range = { ...range, end: iso };
      calendar.render();
      updateSelection();
    },
  });

  function selectedDates() {
    if (!range.start) return [];
    const dates = [];
    for (let d = range.start; d <= (range.end || range.start); d = addDays(d, 1)) dates.push(d);
    return dates;
  }

  async function updateSelection() {
    const dates = selectedDates();
    warning.replaceChildren();
    if (!dates.length) {
      selection.textContent = "Vælg første dag i kalenderen – og eventuelt sidste dag, hvis der skal lukkes flere dage.";
      save.disabled = true;
      return;
    }
    if (dates.length > 92) {
      selection.textContent = "Vælg højst 92 dage ad gangen.";
      save.disabled = true;
      return;
    }
    selection.textContent = dates.length === 1
      ? `Valgt: ${dateLong(dates[0])}`
      : `Valgt: ${dateLong(dates[0])} til ${dateLong(dates.at(-1))} (${dates.length} dage)`;
    save.disabled = false;
    try {
      const rows = await call((token) => select("appointments", `select=id&appointment_date=gte.${dates[0]}&appointment_date=lte.${dates.at(-1)}&status=in.(pending,confirmed)`, { token }));
      if (rows?.length) {
        fill(warning, h("div", { class: "notice notice--warn" }, icon("alert"), h("span", {
          text: `Der er ${rows.length} ${rows.length === 1 ? "booking" : "bookinger"} i perioden. De bliver ikke aflyst automatisk – kontakt kunderne, og aflys dem under Bookinger.`,
        })));
      }
    } catch (error) {
      report(error);
    }
  }

  save.addEventListener("click", async () => {
    const existing = blockedSet();
    const dates = selectedDates().filter((d) => !existing.has(d));
    if (!dates.length) {
      toast("De valgte dage er allerede lukket.");
      return;
    }
    save.disabled = true;
    try {
      const rows = await call((token) => insert("blocked_dates", dates.map((d) => ({ blocked_date: d, reason: reason.value.trim() || null })), { token }));
      state.blocked.push(...(rows || []));
      state.blocked.sort((a, b) => a.blocked_date.localeCompare(b.blocked_date));
      range = { start: null, end: null };
      reason.value = "";
      calendar.render();
      updateSelection();
      drawList();
      toast(dates.length === 1 ? "Dagen er lukket for booking." : `${dates.length} dage er lukket for booking.`);
    } catch (error) {
      save.disabled = false;
      report(error);
    }
  });

  function drawList() {
    const items = state.blocked.filter((b) => showPast || b.blocked_date >= today);
    const pastCount = state.blocked.filter((b) => b.blocked_date < today).length;
    fill(listWrap,
      h("h3", { class: "slots-title", text: showPast ? "Alle lukkedage" : "Kommende lukkedage" }),
      items.length
        ? h("ul", { class: "blocked-list" }, items.map((b) => h("li", null,
          h("div", null, h("strong", { text: capitalize(dateLong(b.blocked_date)) }), b.reason ? h("span", { class: "reason", text: b.reason }) : null),
          h("button", {
            class: "btn btn--ghost btn--sm", type: "button", text: "Åbn igen",
            "aria-label": `Åbn ${dateLong(b.blocked_date)} igen`,
            onclick: async (e) => {
              const button = e.currentTarget;
              button.disabled = true;
              try {
                const removed = await call((token) => remove("blocked_dates", `id=eq.${b.id}`, { token }));
                if (!removed?.length) throw new ApiError("Du har ikke adgang til at ændre lukkedagene.");
                state.blocked = state.blocked.filter((x) => x.id !== b.id);
                calendar.render();
                drawList();
                toast("Dagen er åbnet for booking igen.");
              } catch (error) {
                button.disabled = false;
                report(error);
              }
            },
          }),
        )))
        : h("p", { class: "muted step__body", text: "Der er ingen kommende lukkedage." }),
      pastCount ? h("p", { class: "fine" }, h("button", {
        class: "link-btn", type: "button", text: showPast ? "Skjul tidligere lukkedage" : `Vis tidligere lukkedage (${pastCount})`,
        onclick: () => { showPast = !showPast; drawList(); },
      })) : null,
    );
  }

  fill(panel,
    panelHead("Lukkedage", "Lukkede dage kan ikke bookes hos nogen frisør. Årsagen ses kun af personalet. Fravær for én frisør registrerer du under Fravær."),
    h("div", { class: "blocked-layout" },
      h("div", { class: "fieldset" },
        h("h3", { class: "slots-title", text: "Luk en eller flere dage" }),
        selection,
        h("div", { class: "step__body" }, calendar.el),
        h("div", { class: "field step__body" }, h("label", { class: "label", for: "block-reason" }, "Årsag ", h("span", { class: "optional", text: "(valgfri, kun for personalet)" })), reason),
        warning,
        h("div", { class: "editor__foot" }, h("span", { class: "spacer" }), save),
      ),
      listWrap,
    ),
  );
  updateSelection();
  drawList();
}

// ---------------------------------------------------------------------
// Indstillinger
async function renderSettings() {
  const s = state.salon;
  if (!s) {
    return fill($("#panel"), panelHead("Indstillinger"), errorNotice("Der findes ingen saloninformation i databasen."));
  }
  let seq = 0;
  const input = (label, value, attrs = {}, hint = "") => {
    const id = `set-${++seq}`;
    const control = attrs.tag === "textarea"
      ? h("textarea", { class: "textarea", id, value: value ?? "", maxlength: attrs.maxlength || "1500", rows: "4" })
      : h("input", { class: "input", id, value: value ?? "", ...attrs });
    if (hint) control.setAttribute("aria-describedby", `${id}-hint`);
    return {
      control,
      el: h("div", { class: "field" }, h("label", { class: "label", for: id, text: label }), control, hint ? h("p", { class: "hint", id: `${id}-hint`, text: hint }) : null),
    };
  };

  const name = input("Salonens navn", s.salon_name, { maxlength: "100", required: true });
  const email = input("E-mail", s.salon_email, { type: "email", maxlength: "254" });
  const phone = input("Telefon", s.salon_phone, { type: "tel", maxlength: "30" });
  const address = input("Adresse", s.salon_address, { maxlength: "200" });
  const about = input("Om salonen", s.about_text, { tag: "textarea" }, "Vises på forsiden. Tom linje giver nyt afsnit.");
  const demo = h("input", { type: "checkbox", checked: !!s.is_demo });

  const intervalId = "set-interval";
  const interval = h("select", { class: "select", id: intervalId },
    [10, 15, 20, 30, 45, 60].map((m) => h("option", { value: String(m), text: `${m} minutter` })));
  if (![10, 15, 20, 30, 45, 60].includes(s.slot_interval_minutes)) interval.append(h("option", { value: String(s.slot_interval_minutes), text: `${s.slot_interval_minutes} minutter` }));
  interval.value = String(s.slot_interval_minutes ?? 30);
  const notice = input("Minimumsvarsling (timer)", String(s.booking_notice_hours ?? 2), { type: "number", inputmode: "numeric", min: "0", max: "720", step: "1" }, "Så mange timer før en tid kan den senest bookes.");
  const hasWindow = "booking_window_days" in s;
  const windowDays = input("Booking frem i tiden (dage)", String(s.booking_window_days ?? 60), { type: "number", inputmode: "numeric", min: "1", max: "365", step: "1" }, "Hvor mange dage frem kunderne kan booke.");

  const error = h("div", { role: "alert" });
  const save = h("button", { class: "btn btn--primary", type: "submit", text: "Gem indstillinger" });

  const form = h("form", { class: "settings", novalidate: true },
    h("fieldset", { class: "fieldset" },
      h("legend", { text: "Saloninformation" }),
      name.el,
      h("div", { class: "grid-2" }, email.el, phone.el),
      address.el,
      "about_text" in s ? about.el : null,
      "is_demo" in s ? h("label", { class: "check" }, demo, h("span", null, "Vis som demooplysninger ", h("span", { class: "muted", text: "(markeres tydeligt på hjemmesiden)" }))) : null,
    ),
    h("fieldset", { class: "fieldset" },
      h("legend", { text: "Booking" }),
      h("div", { class: "field" }, h("label", { class: "label", for: intervalId, text: "Tid mellem starttider" }), interval,
        h("p", { class: "hint", text: "Fx 30 minutter giver starttider kl. 9.00, 9.30, 10.00 osv." })),
      h("div", { class: "grid-2" }, notice.el, hasWindow ? windowDays.el : null),
    ),
    error,
    h("div", null, save),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.replaceChildren();
    const values = {
      salon_name: name.control.value.trim(),
      salon_email: email.control.value.trim() || null,
      salon_phone: phone.control.value.trim() || null,
      salon_address: address.control.value.trim() || null,
      slot_interval_minutes: Number(interval.value),
      booking_notice_hours: Number(notice.control.value),
    };
    if ("about_text" in s) values.about_text = about.control.value.trim() || null;
    if ("is_demo" in s) values.is_demo = demo.checked;
    if (hasWindow) values.booking_window_days = Number(windowDays.control.value);

    const problems = [];
    if (values.salon_name.length < 2) problems.push([name.control, "Skriv salonens navn."]);
    if (values.salon_email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.salon_email)) problems.push([email.control, "Skriv en gyldig e-mailadresse."]);
    if (!Number.isInteger(values.booking_notice_hours) || values.booking_notice_hours < 0 || values.booking_notice_hours > 720) problems.push([notice.control, "Minimumsvarslingen skal være et helt antal timer mellem 0 og 720."]);
    if (hasWindow && (!Number.isInteger(values.booking_window_days) || values.booking_window_days < 1 || values.booking_window_days > 365)) problems.push([windowDays.control, "Antal dage frem skal være mellem 1 og 365."]);
    $$("[aria-invalid]", form).forEach((el) => el.removeAttribute("aria-invalid"));
    if (problems.length) {
      problems.forEach(([control]) => control.setAttribute("aria-invalid", "true"));
      fill(error, h("div", { class: "notice notice--error" }, icon("alert"), h("div", null, problems.map(([, text]) => h("p", { text })))));
      return problems[0][0].focus();
    }

    save.disabled = true;
    try {
      const rows = await call((token) => update("salon_settings", `id=eq.${s.id}`, values, { token }));
      if (!rows?.length) throw new ApiError("Du har ikke adgang til at ændre indstillingerne.");
      Object.assign(s, rows[0]);
      $(".admin-header__title strong").textContent = salonName(s);
      document.title = `Administration – ${salonName(s)}`;
      toast("Indstillingerne er gemt.");
    } catch (err) {
      report(err);
    } finally {
      save.disabled = false;
    }
  });

  fill($("#panel"), panelHead("Indstillinger", "Saloninformationen vises på hjemmesiden. Bookingreglerne gælder for nye bookinger."), form);
}

boot();
