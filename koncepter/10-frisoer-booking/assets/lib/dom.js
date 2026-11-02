// Små DOM-hjælpere. Indhold sættes altid som tekst – aldrig som HTML –
// så data fra databasen (fx kunders bemærkninger) ikke kan køre som kode.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [key, val] of Object.entries(props || {})) {
    if (val == null || val === false) continue;
    if (key === "value") value = val;
    else if (key === "class") el.className = val;
    else if (key === "text") el.textContent = val;
    else if (key === "dataset") Object.assign(el.dataset, val);
    else if (key.startsWith("on") && typeof val === "function") el.addEventListener(key.slice(2).toLowerCase(), val);
    else if (key in el && typeof val !== "string") el[key] = val;
    else el.setAttribute(key, val === true ? "" : val);
  }
  append(el, children);
  if (value !== undefined) el.value = value; // efter børn, så <select> kender sine valg
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
const PATHS = {
  clock: ["M12 7v5l3 2", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  phone: ["M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"],
  mail: ["M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z", "m3 7 9 6 9-6"],
  pin: ["M12 21s-7-5.6-7-11a7 7 0 0 1 14 0c0 5.4-7 11-7 11Z", "M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"],
  check: ["m5 12.5 4.5 4.5L19 7.5"],
  checkCircle: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "m8 12.5 2.8 2.8L16.5 9.5"],
  hourglass: ["M7 3h10", "M7 21h10", "M8 3c0 4 4 5 4 9s-4 5-4 9", "M16 3c0 4-4 5-4 9s4 5 4 9"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  xCircle: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "m15 9-6 6", "m9 9 6 6"],
  info: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 11v5", "M12 8h.01"],
  alert: ["M12 9v4", "M12 17h.01", "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"],
  left: ["m15 18-6-6 6-6"],
  right: ["m9 18 6-6-6-6"],
  arrowLeft: ["M19 12H5", "m12 19-7-7 7-7"],
  arrowRight: ["M5 12h14", "m12 5 7 7-7 7"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  calendar: ["M7 3v3", "M17 3v3", "M4 9h16", "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"],
  copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  external: ["M14 4h6v6", "M20 4 10 14", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  logout: ["M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3", "M10 17l5-5-5-5", "M15 12H4"],
  plus: ["M12 5v14", "M5 12h14"],
  scissors: ["M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M20 4 8.1 15.9", "M14.5 14.5 20 20", "M8.1 8.1 12 12"],
  user: ["M20 21a8 8 0 0 0-16 0", "M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z"],
};

export function icon(name, className = "icon") {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  for (const d of PATHS[name] || []) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

// Kortvarig besked nederst på skærmen (læses også op af skærmlæsere).
let toastRoot;
export function toast(message, { error = false, ms = 3800 } = {}) {
  if (!toastRoot) {
    toastRoot = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastRoot);
  }
  const el = h("div", { class: `toast${error ? " toast--error" : ""}` }, icon(error ? "alert" : "check"), h("span", { text: message }));
  toastRoot.append(el);
  while (toastRoot.children.length > 2) toastRoot.firstElementChild.remove();
  setTimeout(() => el.remove(), ms);
}

// Bekræftelsesdialog med danske knapper (window.confirm viser browserens sprog).
export function confirmDialog({ title, text, confirm = "Fortsæt", cancel = "Annullér", danger = false }) {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "dialog", "aria-labelledby": "dialog-title" },
      h("div", { class: "dialog__body" }, h("h2", { id: "dialog-title", text: title }), h("p", { text })),
      h("div", { class: "dialog__actions" },
        h("button", { class: "btn btn--ghost", type: "button", value: "cancel", text: cancel }),
        h("button", { class: `btn ${danger ? "btn--danger" : "btn--primary"}`, type: "button", value: "ok", text: confirm }),
      ),
    );
    dialog.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (button) dialog.close(button.value);
      else if (e.target === dialog) dialog.close("cancel");
    });
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector(".btn--ghost").focus();
  });
}
