// Fælles for de offentlige sider: salonnavn, demomarkering, sidehoved og mobilmenu.
import { $, $$ } from "./dom.js";

export function salonName(salon) {
  return salon?.salon_name?.trim() || "Frisørsalon";
}

export function applySalon(salon, services = []) {
  const name = salonName(salon);
  $$("[data-salon-name]").forEach((el) => { el.textContent = name; });
  $$("[data-salon-initial]").forEach((el) => { el.textContent = name.charAt(0).toUpperCase(); });

  const contactDemo = !!salon?.is_demo;
  const priceDemo = services.some((s) => s.price_is_demo);
  const bar = $("#demo-bar");
  if (bar) {
    const text = contactDemo && priceDemo
      ? "Salonens navn, kontaktoplysninger og priser er eksempler – ikke en rigtig salon."
      : contactDemo
        ? "Salonens navn og kontaktoplysninger er eksempler – ikke en rigtig salon."
        : "Priserne er demopriser og ikke salonens endelige priser.";
    $("[data-demo-text]", bar).textContent = text;
    bar.hidden = !(contactDemo || priceDemo);
  }
  return { name, contactDemo, priceDemo };
}

export function initHeader() {
  const header = $(".site-header");
  if (header) {
    const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  const button = $(".menu-btn");
  const panel = $("#mobile-nav");
  if (!button || !panel) return;
  const setOpen = (open) => {
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Luk menu" : "Åbn menu");
    panel.hidden = !open;
  };
  button.addEventListener("click", () => setOpen(button.getAttribute("aria-expanded") !== "true"));
  panel.addEventListener("click", (e) => { if (e.target.closest("a")) setOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && button.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      button.focus();
    }
  });
}

// tel:-link ud fra et visningsnummer
export const telHref = (phone) => `tel:${String(phone).replace(/[^\d+]/g, "")}`;
