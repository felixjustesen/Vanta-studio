// SKARPs forside: priser, barberer, præsentation, åbningstider og kontakt – alt fra databasen.
import { h, $, $$, fill, icon } from "./lib/dom.js";
import { loadSalon, loadServices, loadHours, loadStaff } from "./lib/api.js";
import { kr, duration, clock, capitalize, WEEKDAYS, WEEK_ORDER, todayInCopenhagen, weekday } from "./lib/format.js";
import { applySalon, telHref } from "./lib/site.js";
import { BASE } from "./config.js";

const today = todayInCopenhagen();
$$("[data-year]").forEach((el) => { el.textContent = today.slice(0, 4); });

const [salonResult, servicesResult, hoursResult, staffResult] = await Promise.allSettled([loadSalon(), loadServices(), loadHours(), loadStaff()]);
const salon = salonResult.status === "fulfilled" ? salonResult.value : null;
const services = servicesResult.status === "fulfilled" ? servicesResult.value : null;
const hours = hoursResult.status === "fulfilled" ? hoursResult.value : null;
const staff = staffResult.status === "fulfilled" ? staffResult.value : null;

const { name, contactDemo } = applySalon(salon, services || []);
document.title = `${name} – Barbershop · Book tid online`;
$$("[data-salon-address]").forEach((el) => { el.textContent = salon?.salon_address || ""; });

renderServices();
renderTeam();
renderAbout();
renderHours();
renderContact();

// "Klip, Skæg og Fade"
function listText(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} og ${items.at(-1)}`;
}

function failed(message) {
  return h("li", { class: "notice notice--error" }, icon("alert"), h("span", { text: message }));
}

// Prisliste som menutavle: navn ........ varighed · pris
function renderServices() {
  const list = $("#services");
  list.removeAttribute("aria-busy");
  if (!services) return fill(list, failed("Behandlingerne kunne ikke hentes lige nu. Prøv at genindlæse siden."));
  if (!services.length) return fill(list, h("li", { class: "notice" }, icon("info"), h("span", { text: "Der er ingen behandlinger at vise lige nu." })));
  fill(list, services.map((s) => h("li", { class: "menu__item" },
    h("div", { class: "menu__row" },
      h("h3", { class: "menu__name", text: s.name }),
      h("span", { class: "menu__dots", "aria-hidden": "true" }),
      h("span", { class: "menu__price" }, kr(s.price), s.price_is_demo ? h("span", { class: "tag tag--demo", text: "Demopris" }) : null),
    ),
    h("div", { class: "menu__meta" },
      h("span", { class: "menu__duration" }, icon("clock"), h("span", { class: "sr-only", text: "Varighed: " }), duration(s.duration_minutes)),
      s.description ? h("p", { class: "menu__desc", text: s.description }) : null,
      h("a", { class: "menu__book", href: `${BASE}/book?behandling=${encodeURIComponent(s.id)}`, "aria-label": `Book ${s.name}` }, "Book", icon("arrowRight")),
    ),
  )));

  // Under heroen: "Behandlinger fra 195 kr."
  const cheapest = Math.min(...services.map((s) => Number(s.price)).filter(Number.isFinite));
  if (Number.isFinite(cheapest)) $("#from-price").textContent = `Behandlinger fra ${kr(cheapest)}`;
}

// Barbererne vises kun, når databasen kender dem, og de laver mindst én aktiv behandling.
function renderTeam() {
  if (!staff || !services) return;
  const team = staff
    .map((person) => ({ ...person, offers: services.filter((s) => person.services.has(s.id)).map((s) => s.name) }))
    .filter((person) => person.offers.length);
  if (!team.length) return;
  fill($("#team"), team.map((person) => h("li", { class: "crew__item" },
    h("span", { class: "crew__mark", "aria-hidden": "true", text: person.name.trim().charAt(0).toUpperCase() }),
    h("h3", { class: "crew__name", text: person.name }),
    h("p", { class: "crew__offers", text: listText(person.offers) }),
    h("a", { class: "menu__book", href: `${BASE}/book?frisoer=${encodeURIComponent(person.id)}` }, `Book hos ${person.name}`, icon("arrowRight")),
  )));
  $("#barberer").hidden = false;
  $$("[data-team-link]").forEach((el) => { el.hidden = false; });
}

function renderAbout() {
  const text = salon?.about_text?.trim()
    || "Book din tid online, eller kontakt os, hvis du har spørgsmål til en behandling.";
  fill($("#about-text"), text.split(/\n\s*\n/).map((p) => h("p", { text: p.trim() })));
}

function hoursFor(day) {
  return (hours || [])
    .filter((r) => r.weekday === day && r.is_open && r.start_time && r.end_time)
    .map((r) => `${clock(r.start_time)}–${clock(r.end_time)}`)
    .join(", ");
}

function renderHours() {
  const list = $("#hours");
  list.removeAttribute("aria-busy");
  if (!hours) return fill(list, failed("Åbningstiderne kunne ikke hentes lige nu."));
  const todayIndex = weekday(today);
  fill(list, WEEK_ORDER.map((day) => {
    const text = hoursFor(day);
    const isToday = day === todayIndex;
    return h("li", { class: isToday ? "is-today" : null },
      h("span", null, capitalize(WEEKDAYS[day]), isToday ? h("span", { class: "tag", text: "I dag" }) : null),
      h("span", { class: "hours__time", text: text || "Lukket" }),
    );
  }));

  const todayText = hoursFor(todayIndex);
  const line = $("#today");
  $("[data-today-text]", line).textContent = todayText ? `Åbent i dag ${todayText}` : "Lukket i dag";
  line.classList.toggle("is-closed", !todayText);
  line.hidden = false;
}

function renderContact() {
  const list = $("#contact");
  list.removeAttribute("aria-busy");
  if (!salon) return fill(list, failed("Kontaktoplysningerne kunne ikke hentes lige nu."));
  // Demooplysninger vises som tekst, så ingen ringer eller skriver til et opdigtet nummer/adresse.
  const item = (iconName, label, value, href) => h("li", null, icon(iconName),
    h("div", null, h("span", { class: "label", text: label }), href && !contactDemo ? h("a", { href, text: value }) : h("span", { text: value })),
  );
  fill(list,
    salon.salon_address ? item("pin", "Adresse", salon.salon_address) : null,
    salon.salon_phone ? item("phone", "Telefon", salon.salon_phone, telHref(salon.salon_phone)) : null,
    salon.salon_email ? item("mail", "E-mail", salon.salon_email, `mailto:${salon.salon_email}`) : null,
    contactDemo ? h("li", null, h("span", { class: "tag tag--demo", text: "Demooplysninger – udskiftes af salonen" })) : null,
  );
}
