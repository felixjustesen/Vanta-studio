// Forsiden: behandlinger, præsentation, frisører, åbningstider og kontakt – alt fra databasen.
import { h, $, $$, fill, icon } from "./lib/dom.js";
import { loadSalon, loadServices, loadHours, loadStaff } from "./lib/api.js";
import { kr, duration, clock, capitalize, WEEKDAYS, WEEK_ORDER, todayInCopenhagen, weekday } from "./lib/format.js";
import { applySalon, initHeader, telHref } from "./lib/site.js";
import { BASE } from "./config.js";

initHeader();
const today = todayInCopenhagen();
$$("[data-year]").forEach((el) => { el.textContent = today.slice(0, 4); });

const [salonResult, servicesResult, hoursResult, staffResult] = await Promise.allSettled([loadSalon(), loadServices(), loadHours(), loadStaff()]);
const salon = salonResult.status === "fulfilled" ? salonResult.value : null;
const services = servicesResult.status === "fulfilled" ? servicesResult.value : null;
const hours = hoursResult.status === "fulfilled" ? hoursResult.value : null;
const staff = staffResult.status === "fulfilled" ? staffResult.value : null;

const { name, contactDemo } = applySalon(salon, services || []);
document.title = `${name} – frisør · Book tid online`;

renderServices();
renderAbout();
renderTeam();
renderHours();
renderContact();

function failed(message) {
  return h("li", { class: "notice notice--error" }, icon("alert"), h("span", { text: message }));
}

function renderServices() {
  const list = $("#services");
  list.removeAttribute("aria-busy");
  if (!services) return fill(list, failed("Behandlingerne kunne ikke hentes lige nu. Prøv at genindlæse siden."));
  if (!services.length) return fill(list, h("li", { class: "notice" }, icon("info"), h("span", { text: "Der er ingen behandlinger at vise lige nu." })));
  fill(list, services.map((s) => h("li", { class: "price-item" },
    h("h3", { class: "price-item__name", text: s.name }),
    h("div", { class: "price-item__price" },
      kr(s.price),
      s.price_is_demo ? h("span", { class: "tag tag--demo", text: "Demopris" }) : null,
    ),
    s.description ? h("p", { class: "price-item__desc", text: s.description }) : null,
    h("div", { class: "price-item__meta" },
      h("span", { class: "price-item__duration" }, icon("clock"), h("span", { class: "sr-only", text: "Varighed: " }), duration(s.duration_minutes)),
      h("a", { class: "link-btn price-item__book", href: `${BASE}/book?behandling=${encodeURIComponent(s.id)}`, "aria-label": `Book ${s.name}` }, "Book", icon("arrowRight")),
    ),
  )));
}

function renderAbout() {
  const text = salon?.about_text?.trim()
    || "Book din tid online, eller kontakt salonen, hvis du har spørgsmål til en behandling.";
  fill($("#about-text"), text.split(/\n\s*\n/).map((p) => h("p", { text: p.trim() })));
}

// "Dameklip, Hårfarvning og Vask og føn"
function listText(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} og ${items.at(-1)}`;
}

// Frisørerne vises kun, når databasen kender dem, og de laver mindst én aktiv behandling.
function renderTeam() {
  if (!staff || !services) return;
  const team = staff
    .map((person) => ({ ...person, offers: services.filter((s) => person.services.has(s.id)).map((s) => s.name) }))
    .filter((person) => person.offers.length);
  if (!team.length) return;
  fill($("#team"), team.map((person) => h("li", { class: "team__item" },
    h("span", { class: "avatar avatar--lg", "aria-hidden": "true", text: person.name.trim().charAt(0).toUpperCase() }),
    h("div", null,
      h("h3", { class: "team__name", text: person.name }),
      h("p", { class: "team__offers", text: listText(person.offers) }),
      h("a", { class: "link-btn team__book", href: `${BASE}/book?frisoer=${encodeURIComponent(person.id)}` }, `Book hos ${person.name}`, icon("arrowRight")),
    ),
  )));
  $("#frisoerer").hidden = false;
  $$("[data-team-link]").forEach((el) => { el.hidden = false; });
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
  $("[data-today-text]", line).textContent = todayText ? `I dag har vi åbent ${todayText}` : "Lukket i dag";
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
