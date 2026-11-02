// Dansk formatering: kroner, datoer, 24-timers klokkeslæt og statusnavne.
// Datoer fra databasen ("2026-11-04") og klokkeslæt ("10:30:00") er salonens
// lokaltid (Europe/Copenhagen) og regnes derfor ikke om.

export const TIME_ZONE = "Europe/Copenhagen";

export const STATUS = {
  pending: "Afventer",
  confirmed: "Bekræftet",
  cancelled: "Aflyst",
  completed: "Gennemført",
};

// Indeks = weekday i business_hours (0 = søndag)
export const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
export const WEEKDAYS_SHORT = ["søn", "man", "tir", "ons", "tor", "fre", "lør"];
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
const MONTHS_SHORT = ["jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec."];

export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const currency0 = new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const currency2 = new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function kr(value) {
  const n = Number(value);
  if (value == null || value === "" || !Number.isFinite(n)) return "";
  return (Number.isInteger(n) ? currency0 : currency2).format(n);
}

// "1.095,50" / "1095.5" / "495" → tal (eller NaN)
export function parseAmount(input) {
  let s = String(input ?? "").trim().replace(/\s|kr\.?/gi, "");
  if (!s) return NaN;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : NaN;
}

export function duration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return "";
  if (m < 60) return `${m} min.`;
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (rest === 0) return hours === 1 ? "1 time" : `${hours} timer`;
  return `${hours} t. ${rest} min.`;
}

// "10:30:00" → "10.30"
export function clock(value) {
  if (!value) return "";
  const [hh, mm] = String(value).split(":");
  return `${hh.padStart(2, "0")}.${(mm || "00").padStart(2, "0")}`;
}

export const timeRange = (start, end) => `${clock(start)}–${clock(end)}`;

// ---------- Datoer som "YYYY-MM-DD" ----------
const parts = (iso) => iso.split("-").map(Number);

export function weekday(iso) {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(iso, days) {
  const [y, m, d] = parts(iso);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

export function isoFrom(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// I dag i København – uanset hvilken tidszone kundens enhed står i.
export function todayInCopenhagen(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// "onsdag den 4. november 2026"
export function dateLong(iso) {
  const [y, m, d] = parts(iso);
  return `${WEEKDAYS[weekday(iso)]} den ${d}. ${MONTHS[m - 1]} ${y}`;
}

// "onsdag den 4. november"
export function dateMedium(iso) {
  const [, m, d] = parts(iso);
  return `${WEEKDAYS[weekday(iso)]} den ${d}. ${MONTHS[m - 1]}`;
}

// "ons. 4. nov."
export function dateShort(iso) {
  const [, m, d] = parts(iso);
  return `${WEEKDAYS_SHORT[weekday(iso)]}. ${d}. ${MONTHS_SHORT[m - 1]}`;
}

// "04.11.2026"
export function dateNumeric(iso) {
  const [y, m, d] = parts(iso);
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y}`;
}

export const monthTitle = (y, m) => `${MONTHS[m - 1]} ${y}`;

// Tidsstempel (fx created_at) vist i dansk tid: "2. nov. 2026 kl. 14.05"
export function timestamp(value) {
  if (!value) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("da-DK", {
      timeZone: TIME_ZONE, day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(value)).map((x) => [x.type, x.value]),
  );
  return `${p.day}. ${MONTHS_SHORT[Number(p.month) - 1]} ${p.year} kl. ${p.hour}.${p.minute}`;
}

export function firstName(fullName) {
  return String(fullName || "").trim().split(/\s+/)[0] || "";
}
