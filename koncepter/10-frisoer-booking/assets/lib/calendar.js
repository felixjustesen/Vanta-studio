// Månedskalender (mandag først) med tastaturnavigation.
import { h, icon } from "./dom.js";
import { WEEK_ORDER, WEEKDAYS, WEEKDAYS_SHORT, addDays, capitalize, daysInMonth, isoFrom, weekday, dateLong, monthTitle, todayInCopenhagen } from "./format.js";

/**
 * options:
 *   label           tilgængeligt navn for kalenderen
 *   min, max        første og sidste dato, man kan navigere til (ISO)
 *   dayInfo(iso)    → { status, label, disabled, marked }
 *   isSelected(iso) → boolean
 *   isInRange(iso)  → boolean
 *   onSelect(iso)
 *   onMonthChange(year, month)
 */
export function createCalendar(options) {
  const today = todayInCopenhagen();
  let [year, month] = (options.start || options.min || today).split("-").map(Number);
  let focusIso = null;

  const title = h("h3", { class: "cal__title", "aria-live": "polite" });
  const prev = h("button", { class: "cal__nav", type: "button", "aria-label": "Forrige måned" }, icon("left"));
  const next = h("button", { class: "cal__nav", type: "button", "aria-label": "Næste måned" }, icon("right"));
  const body = h("tbody");
  const grid = h("table", { class: "cal__grid", role: "grid", "aria-label": options.label || "Kalender" },
    h("thead", null, h("tr", null, WEEK_ORDER.map((d) => h("th", { scope: "col", abbr: WEEKDAYS[d] }, WEEKDAYS_SHORT[d])))),
    body,
  );
  const el = h("div", { class: "cal" }, h("div", { class: "cal__head" }, prev, title, next), grid);

  const monthKey = (y, m) => y * 12 + (m - 1);
  const limit = (iso) => (iso ? iso.split("-").map(Number) : null);

  function canGo(delta) {
    const target = monthKey(year, month) + delta;
    const lo = limit(options.min);
    const hi = limit(options.max);
    if (lo && target < monthKey(lo[0], lo[1])) return false;
    if (hi && target > monthKey(hi[0], hi[1])) return false;
    return true;
  }

  function show(y, m, { notify = true } = {}) {
    year = y;
    month = m;
    render();
    if (notify) options.onMonthChange?.(year, month);
  }

  function step(delta) {
    if (!canGo(delta)) return;
    const k = monthKey(year, month) + delta;
    show(Math.floor(k / 12), (k % 12) + 1);
  }

  function render() {
    const hadFocus = body.contains(document.activeElement);
    title.textContent = capitalize(monthTitle(year, month));
    prev.disabled = !canGo(-1);
    next.disabled = !canGo(1);

    const first = isoFrom(year, month, 1);
    const offset = (weekday(first) + 6) % 7;
    const total = daysInMonth(year, month);
    const days = Array.from({ length: total }, (_, i) => isoFrom(year, month, i + 1));

    if (!focusIso || !focusIso.startsWith(first.slice(0, 7))) {
      focusIso = days.find((d) => options.isSelected?.(d)) || days.find((d) => !(options.dayInfo?.(d) || {}).disabled) || first;
    }

    const rows = [];
    let cells = Array.from({ length: offset }, () => h("td"));
    for (const iso of days) {
      const info = options.dayInfo?.(iso) || {};
      const selected = !!options.isSelected?.(iso);
      const classes = ["cal__day"];
      if (iso === today) classes.push("is-today");
      if (selected) classes.push("is-selected");
      if (!selected && options.isInRange?.(iso)) classes.push("is-range");
      if (info.marked) classes.push("is-marked");
      const button = h("button", {
        type: "button",
        class: classes.join(" "),
        tabindex: iso === focusIso ? "0" : "-1",
        "aria-pressed": String(selected),
        "aria-disabled": info.disabled ? "true" : null,
        "aria-label": `${dateLong(iso)}${info.label ? `, ${info.label}` : ""}`,
        dataset: { date: iso, status: info.status || "" },
      }, String(Number(iso.slice(8))));
      cells.push(h("td", { role: "gridcell" }, button));
      if (cells.length === 7) {
        rows.push(h("tr", null, cells));
        cells = [];
      }
    }
    if (cells.length) {
      while (cells.length < 7) cells.push(h("td"));
      rows.push(h("tr", null, cells));
    }
    body.replaceChildren(...rows);
    if (hadFocus) body.querySelector('[tabindex="0"]')?.focus();
  }

  function focusDay(iso) {
    const [y, m] = iso.split("-").map(Number);
    if (y !== year || m !== month) {
      const delta = monthKey(y, m) - monthKey(year, month);
      if (!canGo(delta)) return;
      focusIso = iso;
      show(y, m);
    } else {
      focusIso = iso;
      render();
    }
    body.querySelector(`[data-date="${iso}"]`)?.focus();
  }

  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));

  body.addEventListener("click", (e) => {
    const button = e.target.closest(".cal__day");
    if (!button || button.getAttribute("aria-disabled") === "true") return;
    focusIso = button.dataset.date;
    options.onSelect?.(button.dataset.date);
  });

  body.addEventListener("keydown", (e) => {
    const button = e.target.closest(".cal__day");
    if (!button) return;
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let target = null;
    if (e.key in moves) target = addDays(button.dataset.date, moves[e.key]);
    else if (e.key === "Home") target = addDays(button.dataset.date, -((weekday(button.dataset.date) + 6) % 7));
    else if (e.key === "End") target = addDays(button.dataset.date, 6 - ((weekday(button.dataset.date) + 6) % 7));
    else if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      step(e.key === "PageUp" ? -1 : 1);
      body.querySelector('[tabindex="0"]')?.focus();
      return;
    }
    if (!target) return;
    e.preventDefault();
    if ((options.min && target < options.min) || (options.max && target > options.max)) return;
    focusDay(target);
  });

  render();
  return {
    el,
    render,
    show,
    get year() { return year; },
    get month() { return month; },
  };
}
