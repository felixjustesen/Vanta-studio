// Bookingflowet: behandling → frisør, dato og tid → oplysninger → gennemse → kvittering.
// Alle regler (åbningstider, arbejdstider, varsling, overlap osv.) håndhæves af
// databasen; browseren viser kun de tider, databasen melder ledige.
import { h, $, $$, fill, icon, toast } from "./lib/dom.js";
import { rpc, loadSalon, loadServices, loadStaff, isNotSetUp } from "./lib/api.js";
import { kr, duration, clock, timeRange, capitalize, dateLong, dateMedium, dateShort, todayInCopenhagen, addDays, isoFrom, daysInMonth, STATUS, firstName } from "./lib/format.js";
import { createCalendar } from "./lib/calendar.js";
import { applySalon, initHeader, salonName, telHref } from "./lib/site.js";
import { BASE, DEMO_ONLY } from "./config.js";

const FLOW = ["service", "time", "details", "review"];
const today = todayInCopenhagen();
const params = new URLSearchParams(location.search);

const state = {
  step: "service",
  salon: null,
  services: [],
  service: null,
  staff: [],
  staffEnabled: false, // falsk, hvis databasen endnu ikke kender frisører
  staffId: null, // null = første ledige
  date: null,
  slot: null,
  days: new Map(),
  loadedMonths: new Set(),
  autoAdvanced: false,
  notReady: false,
  submitting: false,
  booking: null,
  shared: false, // sand, når bookinger sendes til salonens kundesystem (Vanta Platform)
};

let calendar = null;
let maxDate = addDays(today, 60);
let slotRequest = 0;

// ---------------------------------------------------------------------
async function init() {
  const salonPromise = loadSalon().catch(() => null);
  const bookingId = params.get("booking");
  if (bookingId) {
    state.salon = await salonPromise;
    applySalon(state.salon, []);
    return showReceiptFromLink(bookingId);
  }

  const [salon, services, staff] = await Promise.all([
    salonPromise,
    loadServices().catch((error) => error),
    loadStaff().catch(() => null),
  ]);
  state.salon = salon;
  state.staffEnabled = Array.isArray(staff);
  state.staff = staff || [];
  if (state.staff.some((s) => s.id === params.get("frisoer"))) state.staffId = params.get("frisoer");
  const windowDays = Math.min(Math.max(Number(salon?.booking_window_days) || 60, 1), 365);
  maxDate = addDays(today, windowDays);
  document.title = `Book tid – ${salonName(salon)}`;

  if (services instanceof Error) {
    applySalon(salon, []);
    fill($("#service-options"), h("legend", { class: "sr-only", text: "Behandlinger" }));
    $("#service-options").removeAttribute("aria-busy");
    return showError("#service-error", services.message, { retry: () => location.reload() });
  }

  state.services = services;
  applySalon(salon, services);
  if (DEMO_ONLY) markDemoOnly();
  // Findes funktionen ikke (forbindelsen er ikke installeret), deles intet.
  else rpc("platform_link_enabled").then((shared) => { state.shared = shared === true; }).catch(() => {});
  renderServices();

  history.replaceState({ step: "service" }, "");
  const preselected = services.find((s) => s.id === params.get("behandling") && isBookable(s));
  if (preselected) {
    chooseService(preselected);
    goTo("time", { focus: false });
  } else {
    goTo("service", { push: false, focus: false });
  }
}

function bindEvents() {
  $("#next").addEventListener("click", () => {
    if (state.step === "service") goTo("time");
    else if (state.step === "time") goTo("details");
    else if (state.step === "details" && validateDetails(true)) goTo("review");
    else if (state.step === "review") submit();
  });
  $("#back").addEventListener("click", () => history.back());

  window.addEventListener("popstate", (e) => {
    if (state.step === "done") return startOver();
    const step = e.state?.step;
    if (FLOW.includes(step)) goTo(step, { push: false });
  });

  const form = $("#details-form");
  form.addEventListener("submit", (e) => e.preventDefault());
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      $("#next").click();
    }
  });
  form.addEventListener("input", (e) => {
    const key = Object.keys(FIELDS).find((k) => FIELDS[k].input === `#${e.target.id}`);
    if (key && e.target.getAttribute("aria-invalid") === "true") setFieldError(key, FIELDS[key].check(e.target.value));
    if (e.target.id === "f-notes") $("#h-notes").textContent = `${e.target.value.length} af 500 tegn`;
  });
}

// ---------------------------------------------------------------------
// Navigation mellem trin
function canEnter(step) {
  if (step === "time") return !!state.service;
  if (step === "details") return !!(state.service && state.date && state.slot);
  if (step === "review") return canEnter("details") && validateDetails(false);
  return true;
}

function goTo(step, { push = true, replace = false, focus = true } = {}) {
  while (!canEnter(step)) step = FLOW[FLOW.indexOf(step) - 1];
  state.step = step;
  $$(".step").forEach((section) => { section.hidden = section.dataset.step !== step; });

  $$("#progress li").forEach((li) => {
    const i = FLOW.indexOf(li.dataset.step);
    const current = FLOW.indexOf(step);
    li.classList.toggle("is-done", i < current);
    li.classList.toggle("is-current", i === current);
    if (i === current) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });

  if (step === "time") enterTime();
  if (step === "review") renderReview();
  updateActions();
  updateSummary();

  if (replace) history.replaceState({ step }, "");
  else if (push) history.pushState({ step }, "");

  if (focus) {
    $(`.step[data-step="${step}"] .step__title`)?.focus({ preventScroll: true });
    const top = $("#flow").getBoundingClientRect().top + window.scrollY - 96;
    if (window.scrollY > top) window.scrollTo({ top });
  }
}

function startOver() {
  state.booking = null;
  state.date = null;
  state.slot = null;
  state.days.clear();
  state.loadedMonths.clear();
  $("#booking-head").hidden = false;
  $("#progress").hidden = false;
  $("#summary").hidden = false;
  $("#layout").classList.remove("is-done");
  renderServices();
  goTo("service", { push: false });
}

function updateActions() {
  const next = $("#next");
  const back = $("#back");
  $("#actions").hidden = state.step === "done";
  back.hidden = state.step === "service";

  if (state.submitting) {
    fill(next, h("span", { class: "spinner", "aria-hidden": "true" }), "Sender …");
    next.disabled = true;
    next.setAttribute("aria-busy", "true");
  } else {
    next.textContent = state.step === "review" ? "Send booking" : "Fortsæt";
    next.removeAttribute("aria-busy");
    next.disabled = (state.step === "service" && !state.service) || (state.step === "time" && (!state.slot || state.notReady));
  }

  const m = $("#mobile-summary");
  if (!state.service) fill(m, h("strong", { text: "Vælg en behandling" }));
  else fill(m,
    h("strong", { text: state.service.name }),
    h("span", { text: state.slot ? `${dateShort(state.date)} kl. ${clock(state.slot.start_time)}` : state.step === "time" ? "Vælg dato og tid" : `${duration(state.service.duration_minutes)} · ${kr(state.service.price)}` }),
  );
}

function priceText(service) {
  return h("span", { class: "price" }, kr(service.price), service.price_is_demo ? h("span", { class: "tag tag--demo", text: "Demopris" }) : null);
}

// ---------------------------------------------------------------------
// Frisører
const qualifiedStaff = (service) => (service ? state.staff.filter((st) => st.services.has(service.id)) : []);
const isBookable = (service) => !state.staffEnabled || qualifiedStaff(service).length > 0;
const staffName = (id) => state.staff.find((st) => st.id === id)?.name || "";

// Tekst til opsummering og gennemsyn
function staffLabel() {
  if (!state.staffEnabled || !state.service) return null;
  if (state.staffId) return staffName(state.staffId);
  const qualified = qualifiedStaff(state.service);
  return qualified.length === 1 ? qualified[0].name : "Første ledige frisør";
}

function updateSummary() {
  const s = state.service;
  const rows = [
    ["Behandling", s?.name],
    ...(state.staffEnabled ? [["Frisør", staffLabel()]] : []),
    ["Dato", state.date && capitalize(dateMedium(state.date))],
    ["Tid", state.slot && timeRange(state.slot.start_time, state.slot.end_time)],
    ["Varighed", s && duration(s.duration_minutes)],
    ["Pris", s && priceText(s)],
  ];
  fill($("#summary-list"), rows.map(([label, value]) => [
    h("dt", { text: label }),
    h("dd", { class: value ? null : "empty" }, value || "Ikke valgt endnu"),
  ]));
}

// ---------------------------------------------------------------------
// Trin 1: behandling
function renderServices() {
  const wrap = $("#service-options");
  wrap.removeAttribute("aria-busy");
  if (!state.services.length) {
    fill(wrap, h("legend", { class: "sr-only", text: "Behandlinger" }));
    return showError("#service-error", "Der er ingen behandlinger, der kan bookes lige nu. Kontakt salonen.", { kind: "notice" });
  }
  const chosen = state.staffId ? staffName(state.staffId) : "";
  fill(wrap,
    h("legend", { class: "sr-only", text: "Behandlinger" }),
    state.services.map((s) => {
      const bookable = isBookable(s);
      const notHere = chosen && bookable && !qualifiedStaff(s).some((st) => st.id === state.staffId);
      return h("label", { class: `option${bookable ? "" : " is-disabled"}` },
        h("input", { type: "radio", name: "service", value: s.id, checked: state.service?.id === s.id, disabled: !bookable, onchange: () => chooseService(s) }),
        h("span", { class: "option__name", text: s.name }),
        s.description ? h("span", { class: "option__desc", text: s.description }) : null,
        h("span", { class: "option__meta" },
          h("span", null, duration(s.duration_minutes)),
          h("strong", { text: kr(s.price) }),
          s.price_is_demo ? h("span", { class: "tag tag--demo", text: "Demopris" }) : null,
        ),
        !bookable ? h("span", { class: "option__note", text: "Kan ikke bookes online lige nu." }) : null,
        notHere ? h("span", { class: "option__note", text: `${chosen} laver ikke denne behandling – du kan booke hos en anden frisør.` }) : null,
      );
    }),
  );
}

function chooseService(service) {
  if (state.service?.id !== service.id) {
    state.service = service;
    state.date = null;
    state.slot = null;
    state.days.clear();
    state.loadedMonths.clear();
    state.autoAdvanced = false;
  }
  const input = $(`#service-options input[value="${CSS.escape(service.id)}"]`);
  if (input) input.checked = true;
  hideError("#service-error");
  updateActions();
  updateSummary();
}

// ---------------------------------------------------------------------
// Trin 2: dato og tid
function dayInfo(iso) {
  if (iso < today || iso > maxDate) return { status: "unavailable", disabled: true, label: "kan ikke bookes" };
  const day = state.days.get(iso);
  if (!day) return { status: "", disabled: true };
  if (day.status === "available") return { status: "available", label: day.free_slots === 1 ? "1 ledig tid" : `${day.free_slots} ledige tider` };
  if (day.status === "full") return { status: "full", disabled: true, label: "ingen ledige tider" };
  if (day.status === "closed") return { status: "closed", disabled: true, label: "lukket" };
  if (day.status === "off") return { status: "off", disabled: true, label: state.staffId ? `${staffName(state.staffId)} arbejder ikke` : "ingen frisører på arbejde" };
  return { status: "unavailable", disabled: true, label: "kan ikke bookes" };
}

// Valg af frisør øverst i tidstrinnet. Vises kun, når der er noget at vælge imellem.
function renderStaffPicker() {
  const picker = $("#staff-picker");
  const qualified = qualifiedStaff(state.service);
  if (state.staffId && !qualified.some((st) => st.id === state.staffId)) state.staffId = null;
  if (!state.staffEnabled || !qualified.length) {
    picker.hidden = true;
    return;
  }
  picker.hidden = false;
  if (qualified.length === 1) {
    fill($("legend", picker), "Frisør");
    fill($("#staff-options"), h("p", { class: "staff-single" }, avatar(qualified[0].name), h("span", null, "Du bliver behandlet af ", h("strong", { text: qualified[0].name }), ".")));
    return;
  }
  fill($("legend", picker), "Vælg frisør");
  const option = (id, label) => h("label", { class: "staff-chip" },
    h("input", { type: "radio", name: "staff", value: id || "", checked: (state.staffId || null) === id, onchange: () => changeStaff(id) }),
    h("span", null, id ? avatar(label) : icon("user"), h("span", { text: label })),
  );
  fill($("#staff-options"),
    option(null, "Første ledige"),
    qualified.map((st) => option(st.id, st.name)),
  );
}

function avatar(name) {
  return h("span", { class: "avatar", "aria-hidden": "true", text: name.trim().charAt(0).toUpperCase() });
}

function changeStaff(id) {
  if ((state.staffId || null) === (id || null)) return;
  state.staffId = id || null;
  state.slot = null;
  state.days.clear();
  state.loadedMonths.clear();
  state.autoAdvanced = false;
  if (!state.notReady) hideError("#time-error");
  updateActions();
  updateSummary();
  const [y, m] = (state.date || today).split("-").map(Number);
  if (calendar.year !== y || calendar.month !== m) calendar.show(y, m);
  else loadMonth(y, m);
  if (state.date) loadSlots();
}

const monthKey = (y, m) => `${state.service?.id}:${state.staffId || "alle"}:${y}-${m}`;
const staffArg = () => (state.staffId ? { p_staff_id: state.staffId } : {});

function enterTime() {
  const length = duration(state.service.duration_minutes);
  $("#time-intro").textContent = `${state.service.name} varer ${length}${length.endsWith(".") ? "" : "."} Du ser kun tider, hvor hele behandlingen kan nås inden lukketid.`;
  renderStaffPicker();
  if (!calendar) {
    calendar = createCalendar({
      label: "Vælg dato",
      min: today,
      max: maxDate,
      start: state.date || today,
      dayInfo,
      isSelected: (iso) => iso === state.date,
      onSelect: (iso) => selectDate(iso),
      onMonthChange: (y, m) => loadMonth(y, m),
    });
    fill($("#calendar"), calendar.el, h("div", { class: "cal__legend", "aria-hidden": "true" },
      h("span", null, h("i"), "Ledige tider"),
      h("span", null, h("i", { class: "is-off" }), "Lukket eller optaget"),
    ));
  }
  const [y, m] = (state.date || today).split("-").map(Number);
  if (calendar.year !== y || calendar.month !== m) calendar.show(y, m);
  else loadMonth(y, m);
  if (state.date) loadSlots();
  else {
    $("#slots-title").textContent = "Ledige tider";
    fill($("#slots-body"), h("p", { class: "slots-empty", text: "Vælg en dato i kalenderen." }));
  }
}

async function loadMonth(y, m) {
  if (!state.service || state.notReady) return;
  const service = state.service;
  const key = monthKey(y, m);
  const from = isoFrom(y, m, 1) < today ? today : isoFrom(y, m, 1);
  const last = isoFrom(y, m, daysInMonth(y, m));
  const to = last > maxDate ? maxDate : last;
  if (from > to) return calendar.render();

  if (!state.loadedMonths.has(key)) {
    calendar.el.classList.add("cal__loading");
    try {
      const rows = await rpc("get_available_dates", { p_service_id: service.id, p_from: from, p_to: to, ...staffArg() });
      if (monthKey(y, m) !== key) return; // kunden har skiftet behandling eller frisør imens
      for (const row of rows || []) state.days.set(row.calendar_date, row);
      state.loadedMonths.add(key);
    } catch (error) {
      if (isNotSetUp(error)) return showNotReady();
      return showError("#time-error", `Kalenderen kunne ikke hentes. ${error.message}`, {
        retry: () => { hideError("#time-error"); loadMonth(y, m); },
      });
    } finally {
      calendar.el.classList.remove("cal__loading");
    }
  }
  if (calendar.year !== y || calendar.month !== m) return;

  // Er den valgte dag ikke længere ledig (fx efter skift af frisør), vælges en ny.
  if (state.date?.startsWith(isoFrom(y, m, 1).slice(0, 8)) && state.days.get(state.date)?.status !== "available") {
    state.date = null;
    state.slot = null;
    updateActions();
    updateSummary();
  }
  calendar.render();

  // Vælg selv første ledige dag, så kunden straks ser tider.
  if (!state.date) {
    const days = Array.from({ length: daysInMonth(y, m) }, (_, i) => isoFrom(y, m, i + 1));
    const first = days.find((iso) => state.days.get(iso)?.status === "available");
    if (first) selectDate(first);
    else if (!state.autoAdvanced && to < maxDate) {
      state.autoAdvanced = true;
      calendar.show(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
    } else {
      fill($("#slots-body"), h("p", { class: "slots-empty", text: "Der er ingen ledige tider i denne måned. Prøv næste måned." }));
    }
  }
}

function selectDate(iso) {
  state.date = iso;
  state.slot = null;
  calendar.render();
  updateActions();
  updateSummary();
  loadSlots();
}

async function loadSlots() {
  const request = ++slotRequest;
  const body = $("#slots-body");
  $("#slots-title").textContent = `Ledige tider ${dateMedium(state.date)}`;
  body.setAttribute("aria-busy", "true");
  fill(body, h("p", { class: "muted", text: "Henter ledige tider …" }));
  try {
    const slots = await rpc("get_available_slots", { p_service_id: state.service.id, p_date: state.date, ...staffArg() });
    if (request !== slotRequest) return;
    renderSlots(slots || []);
  } catch (error) {
    if (request !== slotRequest) return;
    if (isNotSetUp(error)) return showNotReady();
    fill(body, h("div", { class: "notice notice--error" }, icon("alert"),
      h("div", null, h("p", { text: `Tiderne kunne ikke hentes. ${error.message}` }),
        h("button", { class: "link-btn", type: "button", text: "Prøv igen", onclick: loadSlots }))));
  } finally {
    if (request === slotRequest) body.removeAttribute("aria-busy");
  }
}

function renderSlots(slots) {
  const body = $("#slots-body");
  if (!slots.length) {
    const day = state.days.get(state.date);
    if (day) { day.status = "full"; day.free_slots = 0; calendar.render(); }
    return fill(body, h("p", { class: "slots-empty", text: "Der er ingen ledige tider denne dag. Vælg en anden dato." }));
  }
  const groups = [
    ["Formiddag", slots.filter((s) => s.start_time < "12:00")],
    ["Eftermiddag", slots.filter((s) => s.start_time >= "12:00" && s.start_time < "17:00")],
    ["Aften", slots.filter((s) => s.start_time >= "17:00")],
  ].filter(([, list]) => list.length);

  fill(body, groups.map(([label, list]) => h("div", { class: "slot-group" },
    h("h4", { text: label }),
    h("div", { class: "slot-grid" }, list.map((slot) => h("label", { class: "slot" },
      h("input", {
        type: "radio",
        name: "slot",
        value: slot.start_time,
        checked: state.slot?.start_time === slot.start_time,
        "aria-label": `Kl. ${clock(slot.start_time)} til ${clock(slot.end_time)}`,
        onchange: () => {
          state.slot = slot;
          if (!state.notReady) hideError("#time-error");
          updateActions();
          updateSummary();
        },
      }),
      h("span", { text: clock(slot.start_time) }),
    ))),
  )));
}

function contactParts() {
  const s = state.salon;
  const parts = [];
  if (s?.salon_phone) parts.push(s.is_demo ? h("span", { text: s.salon_phone }) : h("a", { href: telHref(s.salon_phone), text: s.salon_phone }));
  if (s?.salon_email) parts.push(s.is_demo ? h("span", { text: s.salon_email }) : h("a", { href: `mailto:${s.salon_email}`, text: s.salon_email }));
  return parts.flatMap((p, i) => (i ? [" eller ", p] : [p]));
}

function showNotReady() {
  state.notReady = true;
  $("#time-layout").hidden = true;
  const contact = contactParts();
  showError("#time-error", [
    h("strong", { text: "Online booking er ikke aktiveret endnu." }),
    contact.length ? h("p", null, "Kontakt salonen på ", contact, " for at booke en tid.") : h("p", { text: "Kontakt salonen for at booke en tid." }),
  ], { kind: "warn" });
  updateActions();
}

// ---------------------------------------------------------------------
// Trin 3: oplysninger (samme regler som i databasen)
const FIELDS = {
  full_name: {
    input: "#f-name", error: "#e-name",
    check: (v) => {
      const name = v.trim().replace(/\s+/g, " ");
      return name.length >= 2 && name.length <= 100 ? "" : "Skriv dit navn.";
    },
  },
  email: {
    input: "#f-email", error: "#e-email",
    check: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) && v.trim().length <= 254 ? "" : "Skriv en gyldig e-mailadresse, fx navn@eksempel.dk."),
  },
  phone: {
    input: "#f-phone", error: "#e-phone",
    check: (v) => {
      const phone = v.trim().replace(/\s+/g, " ");
      const digits = phone.replace(/\D/g, "");
      return /^\+?[0-9][0-9 ()-]*$/.test(phone) && digits.length >= 8 && digits.length <= 15 ? "" : "Skriv et telefonnummer med mindst 8 cifre, fx 12 34 56 78.";
    },
  },
  notes: {
    input: "#f-notes", error: "#e-notes",
    check: (v) => (v.trim().length <= 500 ? "" : "Bemærkningen må højst være 500 tegn."),
  },
};

function details() {
  return Object.fromEntries(Object.entries(FIELDS).map(([key, f]) => [key, $(f.input).value.trim()]));
}

function setFieldError(key, message) {
  const field = FIELDS[key];
  $(field.input).setAttribute("aria-invalid", message ? "true" : "false");
  fill($(field.error), message ? [icon("alert"), h("span", { text: message })] : []);
}

function validateDetails(show) {
  let firstInvalid = null;
  for (const [key, field] of Object.entries(FIELDS)) {
    const message = field.check($(field.input).value);
    if (show) setFieldError(key, message);
    if (message && !firstInvalid) firstInvalid = $(field.input);
  }
  if (show && firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

// ---------------------------------------------------------------------
// Trin 4: gennemse og send
function reviewGroup(title, editStep, editLabel, rows) {
  return h("div", { class: "review-group" },
    h("div", { class: "review-group__head" },
      h("h3", { text: title }),
      h("button", { class: "link-btn", type: "button", "aria-label": editLabel, onclick: () => goTo(editStep) }, "Ret"),
    ),
    h("dl", { class: "details" }, rows.map(([label, value]) => h("div", null, h("dt", { text: label }), h("dd", null, value)))),
  );
}

function renderReview() {
  const s = state.service;
  const d = details();
  fill($("#review-body"),
    reviewGroup("Behandling og tid", "time", state.staffEnabled ? "Ret frisør, dato og tid" : "Ret dato og tid", [
      ["Behandling", s.name],
      ...(state.staffEnabled ? [["Frisør", staffLabel()]] : []),
      ["Dato", capitalize(dateLong(state.date))],
      ["Tid", `Kl. ${timeRange(state.slot.start_time, state.slot.end_time)}`],
      ["Varighed", duration(s.duration_minutes)],
      ["Pris", priceText(s)],
    ]),
    reviewGroup("Dine oplysninger", "details", "Ret dine oplysninger", [
      ["Navn", d.full_name],
      ["E-mail", d.email],
      ["Telefon", d.phone],
      ["Bemærkning", d.notes || "Ingen"],
    ]),
    h("p", { class: "fine", text: DEMO_ONLY
      ? "Dette er en demo. Der bliver ikke sendt nogen booking, og dine oplysninger gemmes ikke."
      : state.shared
        ? "Bookingen er ikke endelig, før salonen har bekræftet den. Dine oplysninger bruges til at håndtere bookingen og gemmes i salonens kundesystem."
        : "Bookingen er ikke endelig, før salonen har bekræftet den. Dine oplysninger bruges kun til at håndtere bookingen." }),
  );
}

// ---------------------------------------------------------------------
// Demo: hele forløbet kan prøves, men intet sendes til databasen
function markDemoOnly() {
  const bar = $("#demo-bar");
  if (!bar) return;
  const text = $("[data-demo-text]", bar);
  text.textContent = `${bar.hidden ? "" : `${text.textContent} `}Bookinger bliver ikke sendt.`;
  bar.hidden = false;
}

function showDemoReceipt() {
  enterReceiptMode();
  const s = state.service;
  document.title = `Demo – ${salonName(state.salon)}`;
  fill($("#receipt"),
    h("div", { class: "receipt__icon receipt__icon--pending" }, icon("info")),
    h("h1", { class: "step__title", tabindex: "-1", text: "Sådan ser det ud, når en kunde booker" }),
    h("div", { class: "receipt__status" }, h("span", { class: "badge badge--pending", text: "Demo" }),
      h("span", { text: "Bookingen er ikke sendt, og tiden er stadig ledig." })),
    h("dl", { class: "details" }, [
      ["Behandling", s.name],
      ...(state.staffEnabled ? [["Frisør", staffLabel()]] : []),
      ["Dato", capitalize(dateLong(state.date))],
      ["Tid", `Kl. ${timeRange(state.slot.start_time, state.slot.end_time)}`],
      ["Pris", priceText(s)],
    ].map(([label, value]) => h("div", null, h("dt", { text: label }), h("dd", null, value)))),
    h("p", { class: "fine", text: "På den rigtige side gemmes bookingen hos salonen, og kunden får et link til at følge den." }),
    h("div", { class: "receipt__actions" },
      h("a", { class: "btn btn--primary", href: `${BASE}/book`, text: "Prøv igen" }),
      h("a", { class: "btn btn--ghost", href: BASE, text: "Til forsiden" }),
    ),
  );
  $("#receipt .step__title").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

async function submit() {
  if (state.submitting) return;
  if ($("#f-website").value) return; // udfyldt af en robot
  if (!validateDetails(false)) return goTo("details");
  if (DEMO_ONLY) return showDemoReceipt();
  hideError("#review-error");
  state.submitting = true;
  updateActions();
  const d = details();
  try {
    const booking = await rpc("create_booking", {
      p_service_id: state.service.id,
      p_date: state.date,
      p_start_time: state.slot.start_time,
      p_full_name: d.full_name,
      p_email: d.email,
      p_phone: d.phone,
      p_notes: d.notes || null,
      ...staffArg(),
    });
    state.booking = { ...booking, full_name: d.full_name, email: d.email, phone: d.phone, notes: d.notes };
    history.replaceState({ step: "done" }, "", `${BASE}/book?booking=${encodeURIComponent(booking.id)}`);
    showReceipt(state.booking, { fresh: true });
  } catch (error) {
    handleSubmitError(error);
  } finally {
    state.submitting = false;
    updateActions();
  }
}

function handleSubmitError(error) {
  const fieldByHint = { invalid_name: "full_name", invalid_email: "email", invalid_phone: "phone", invalid_notes: "notes" };
  if (error.hint === "slot_unavailable") {
    const [y, m] = state.date.split("-").map(Number);
    state.loadedMonths.delete(monthKey(y, m));
    state.slot = null;
    goTo("time", { replace: true });
    showError("#time-error", "Tiden blev desværre booket af en anden lige før dig. Vælg en ny tid.");
  } else if (fieldByHint[error.hint]) {
    goTo("details", { replace: true });
    setFieldError(fieldByHint[error.hint], error.message);
    $(FIELDS[fieldByHint[error.hint]].input).focus();
  } else if (error.hint === "service_unavailable") {
    state.service = null;
    state.slot = null;
    goTo("service", { replace: true });
    showError("#service-error", error.message);
    loadServices().then((list) => { state.services = list; renderServices(); }).catch(() => {});
  } else {
    showError("#review-error", error.message);
  }
}

// ---------------------------------------------------------------------
// Kvittering
function enterReceiptMode() {
  state.step = "done";
  $$(".step").forEach((section) => { section.hidden = section.dataset.step !== "done"; });
  $("#booking-head").hidden = true;
  $("#summary").hidden = true;
  $("#actions").hidden = true;
  $("#layout").classList.add("is-done");
}

const RECEIPT_TEXT = {
  pending: "Salonen har modtaget din booking, men har ikke bekræftet den endnu.",
  confirmed: "Salonen har bekræftet din tid.",
  cancelled: "Bookingen er aflyst. Kontakt salonen, hvis du har spørgsmål.",
  completed: "Behandlingen er gennemført.",
};

function showReceipt(b, { fresh }) {
  enterReceiptMode();
  const status = STATUS[b.status] ? b.status : "pending";
  const iconName = { pending: "hourglass", confirmed: "checkCircle", completed: "checkCircle", cancelled: "xCircle" }[status];
  const title = fresh ? `Tak, ${firstName(b.full_name)}. Din booking er modtaget.` : "Din booking";
  const link = `${location.origin}${BASE}/book?booking=${encodeURIComponent(b.id)}`;
  document.title = `${fresh ? "Booking modtaget" : "Din booking"} – ${salonName(state.salon)}`;

  const rows = [
    ["Bookingnr.", b.reference],
    ["Behandling", b.service_name || "–"],
    ...(b.staff_name ? [["Frisør", b.staff_name]] : []),
    ["Dato", capitalize(dateLong(b.appointment_date))],
    ["Tid", `Kl. ${timeRange(b.start_time, b.end_time)}`],
    ["Varighed", duration(b.duration_minutes)],
    ["Pris", b.price != null ? h("span", { class: "price" }, kr(b.price), b.price_is_demo ? h("span", { class: "tag tag--demo", text: "Demopris" }) : null) : "–"],
  ];
  if (fresh) {
    rows.push(["Navn", b.full_name], ["E-mail", b.email], ["Telefon", b.phone]);
    if (b.notes) rows.push(["Bemærkning", b.notes]);
  }

  const linkInput = h("input", { class: "input", type: "text", readonly: true, value: link, "aria-label": "Link til din booking" });
  const contact = contactParts();

  fill($("#receipt"),
    h("div", { class: `receipt__icon receipt__icon--${status}` }, icon(iconName)),
    h("h1", { class: "step__title", tabindex: "-1", text: title }),
    h("div", { class: "receipt__status" }, h("span", { class: `badge badge--${status}`, text: STATUS[status] }), h("span", { text: RECEIPT_TEXT[status] })),
    h("dl", { class: "details" }, rows.map(([label, value]) => h("div", null, h("dt", { text: label }), h("dd", null, value)))),
    status === "pending" || status === "confirmed" ? h("div", { class: "receipt__follow" },
      h("h2", { class: "slots-title", text: "Følg din booking" }),
      h("p", { class: "muted", text: "Der sendes ikke automatisk e-mail eller sms. Gem linket, så kan du altid se, om bookingen er bekræftet." }),
      h("div", { class: "receipt__link" }, linkInput,
        h("button", { class: "btn btn--ghost btn--sm", type: "button", onclick: () => copyLink(link, linkInput) }, icon("copy"), "Kopiér link")),
    ) : null,
    contact.length ? h("p", { class: "fine" }, "Spørgsmål? Kontakt salonen på ", contact, ".") : null,
    h("div", { class: "receipt__actions" },
      h("a", { class: "btn btn--primary", href: `${BASE}/book`, text: "Book en tid mere" }),
      h("a", { class: "btn btn--ghost", href: BASE, text: "Til forsiden" }),
    ),
  );
  $("#receipt .step__title").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

async function copyLink(link, input) {
  try {
    await navigator.clipboard.writeText(link);
    toast("Linket er kopieret.");
  } catch {
    input.select();
    toast("Markér linket, og kopiér det manuelt.", { error: true });
  }
}

async function showReceiptFromLink(id) {
  enterReceiptMode();
  document.title = `Din booking – ${salonName(state.salon)}`;
  const receipt = $("#receipt");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return receiptNotFound();
  fill(receipt, h("p", { class: "muted", text: "Henter din booking …" }));
  try {
    const booking = await rpc("get_booking_receipt", { p_booking_id: id });
    if (!booking) return receiptNotFound();
    showReceipt(booking, { fresh: false });
  } catch (error) {
    if (isNotSetUp(error)) return receiptNotFound();
    fill(receipt,
      h("h1", { class: "step__title", text: "Din booking" }),
      h("div", { class: "notice notice--error step__body" }, icon("alert"), h("div", null,
        h("p", { text: `Bookingen kunne ikke hentes. ${error.message}` }),
        h("button", { class: "link-btn", type: "button", text: "Prøv igen", onclick: () => showReceiptFromLink(id) }))),
    );
  }
}

function receiptNotFound() {
  fill($("#receipt"),
    h("div", { class: "receipt__icon receipt__icon--cancelled" }, icon("info")),
    h("h1", { class: "step__title", text: "Vi kan ikke finde bookingen" }),
    h("p", { class: "step__intro", text: "Tjek, at linket er helt rigtigt, eller kontakt salonen." }),
    h("div", { class: "receipt__actions" },
      h("a", { class: "btn btn--primary", href: `${BASE}/book`, text: "Book tid" }),
      h("a", { class: "btn btn--ghost", href: BASE, text: "Til forsiden" }),
    ),
  );
}

// ---------------------------------------------------------------------
function showError(selector, content, { retry, kind = "error" } = {}) {
  const el = $(selector);
  const iconName = kind === "warn" ? "info" : kind === "notice" ? "info" : "alert";
  fill(el, h("div", { class: kind === "notice" ? "notice" : `notice notice--${kind}`, role: kind === "error" ? "alert" : "status" },
    icon(iconName),
    h("div", null, content, retry ? h("p", null, h("button", { class: "link-btn", type: "button", text: "Prøv igen", onclick: retry })) : null),
  ));
  el.hidden = false;
}

function hideError(selector) {
  const el = $(selector);
  el.hidden = true;
  el.replaceChildren();
}

initHeader();
bindEvents();
init();
