// Faste demodata til SKARP-prototypen på vantastudio.dk (OFFLINE i config.js).
// Siden henter intet fra en database: priser, barberer, åbningstider og ledige
// tider kommer herfra, og en booking kan ikke sendes.
import { todayInCopenhagen, addDays } from "./format.js";

const SALON = [
  {
    "id": "2068f5f5-12a4-4542-a7fe-2ec721bca4ac",
    "salon_name": "SKARP",
    "salon_email": "kontakt@example.com",
    "salon_phone": "+45 00 00 00 00",
    "salon_address": "Vesterbro, København (demo)",
    "slot_interval_minutes": 30,
    "booking_notice_hours": 2,
    "created_at": "2026-11-02T00:18:27.806389+00:00",
    "booking_window_days": 60,
    "about_text": "Klassisk barberhåndværk: klip, fades, skæg og barbering med kniv og varmt håndklæde. Se priserne herover, og book din tid online, når det passer dig. Har du spørgsmål til en behandling, er du velkommen til at kontakte os.",
    "is_demo": true
  }
];

const SERVICES = [
  {
    "id": "46d76786-57c6-4325-9d23-f07b991f064b",
    "name": "Klip",
    "description": "Klip med saks og maskine efter dine ønsker, afsluttet med styling.",
    "duration_minutes": 30,
    "price": 295.0,
    "is_active": true,
    "created_at": "2026-11-02T00:18:27.806389+00:00",
    "price_is_demo": true
  },
  {
    "id": "6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900",
    "name": "Skin fade",
    "description": "Fade helt ned til huden med en skarp overgang, afsluttet med styling.",
    "duration_minutes": 45,
    "price": 345.0,
    "is_active": true,
    "created_at": "2026-11-02T00:18:27.806389+00:00",
    "price_is_demo": true
  },
  {
    "id": "72d8b7a9-98e4-4327-b1c3-34f977aeb8ec",
    "name": "Klip og skæg",
    "description": "Klip og skægtrim i én behandling, afsluttet med varmt håndklæde.",
    "duration_minutes": 60,
    "price": 445.0,
    "is_active": true,
    "created_at": "2026-11-02T00:18:27.806389+00:00",
    "price_is_demo": true
  },
  {
    "id": "9e50c1ed-7fb4-4e70-8651-244a99ef60e7",
    "name": "Skæg",
    "description": "Trim og form af skægget med skarpe linjer og skægolie.",
    "duration_minutes": 20,
    "price": 195.0,
    "is_active": true,
    "created_at": "2026-11-02T00:18:27.806389+00:00",
    "price_is_demo": true
  },
  {
    "id": "ac9c094a-7a65-4939-9b2e-5c858644b9ed",
    "name": "Barbering",
    "description": "Klassisk barbering med kniv og varmt håndklæde.",
    "duration_minutes": 30,
    "price": 245.0,
    "is_active": true,
    "created_at": "2026-11-02T00:18:27.806389+00:00",
    "price_is_demo": true
  }
];

const HOURS = [
  {
    "id": "13128b98-c9d8-4a0e-9b17-552415d21b96",
    "weekday": 0,
    "is_open": false,
    "start_time": null,
    "end_time": null
  },
  {
    "id": "1b369c7c-6513-4731-a4c4-7547c88c82a3",
    "weekday": 1,
    "is_open": true,
    "start_time": "09:00:00",
    "end_time": "18:00:00"
  },
  {
    "id": "5ca10191-eb30-4315-b545-17eca9cf278e",
    "weekday": 2,
    "is_open": true,
    "start_time": "09:00:00",
    "end_time": "18:00:00"
  },
  {
    "id": "a1792668-6752-46b2-9651-5a603e4cf985",
    "weekday": 3,
    "is_open": true,
    "start_time": "09:00:00",
    "end_time": "18:00:00"
  },
  {
    "id": "0560d6f1-5d32-42d8-a391-71f615a281ac",
    "weekday": 4,
    "is_open": true,
    "start_time": "09:00:00",
    "end_time": "18:00:00"
  },
  {
    "id": "b5e7a7fc-b033-4715-a279-2832bc0153cc",
    "weekday": 5,
    "is_open": true,
    "start_time": "09:00:00",
    "end_time": "19:00:00"
  },
  {
    "id": "9db86883-6689-4e2d-a0a1-8deece000f02",
    "weekday": 6,
    "is_open": true,
    "start_time": "10:00:00",
    "end_time": "16:00:00"
  }
];

const STAFF = [
  {
    "id": "be4c914a-2370-445c-9180-5f05b812bd9d",
    "name": "Anna",
    "sort_order": 1,
    "is_active": true
  },
  {
    "id": "565d3b9e-ddf8-426b-9d7a-fce922e432c2",
    "name": "Mikkel",
    "sort_order": 2,
    "is_active": true
  },
  {
    "id": "cb8b28e2-9209-43f4-9320-75d154bff4f9",
    "name": "Sara",
    "sort_order": 3,
    "is_active": true
  }
];

const STAFF_SERVICES = [
  {
    "staff_id": "be4c914a-2370-445c-9180-5f05b812bd9d",
    "service_id": "46d76786-57c6-4325-9d23-f07b991f064b"
  },
  {
    "staff_id": "be4c914a-2370-445c-9180-5f05b812bd9d",
    "service_id": "6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900"
  },
  {
    "staff_id": "be4c914a-2370-445c-9180-5f05b812bd9d",
    "service_id": "72d8b7a9-98e4-4327-b1c3-34f977aeb8ec"
  },
  {
    "staff_id": "be4c914a-2370-445c-9180-5f05b812bd9d",
    "service_id": "9e50c1ed-7fb4-4e70-8651-244a99ef60e7"
  },
  {
    "staff_id": "be4c914a-2370-445c-9180-5f05b812bd9d",
    "service_id": "ac9c094a-7a65-4939-9b2e-5c858644b9ed"
  },
  {
    "staff_id": "565d3b9e-ddf8-426b-9d7a-fce922e432c2",
    "service_id": "6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900"
  },
  {
    "staff_id": "565d3b9e-ddf8-426b-9d7a-fce922e432c2",
    "service_id": "9e50c1ed-7fb4-4e70-8651-244a99ef60e7"
  },
  {
    "staff_id": "565d3b9e-ddf8-426b-9d7a-fce922e432c2",
    "service_id": "ac9c094a-7a65-4939-9b2e-5c858644b9ed"
  },
  {
    "staff_id": "cb8b28e2-9209-43f4-9320-75d154bff4f9",
    "service_id": "46d76786-57c6-4325-9d23-f07b991f064b"
  },
  {
    "staff_id": "cb8b28e2-9209-43f4-9320-75d154bff4f9",
    "service_id": "72d8b7a9-98e4-4327-b1c3-34f977aeb8ec"
  },
  {
    "staff_id": "cb8b28e2-9209-43f4-9320-75d154bff4f9",
    "service_id": "9e50c1ed-7fb4-4e70-8651-244a99ef60e7"
  },
  {
    "staff_id": "cb8b28e2-9209-43f4-9320-75d154bff4f9",
    "service_id": "ac9c094a-7a65-4939-9b2e-5c858644b9ed"
  }
];

// Ugedage (0 = søndag), hvor frisøren har fri
const STAFF_OFF = {
  "be4c914a-2370-445c-9180-5f05b812bd9d": [],
  "565d3b9e-ddf8-426b-9d7a-fce922e432c2": [
    1
  ],
  "cb8b28e2-9209-43f4-9320-75d154bff4f9": [
    6
  ]
};

const TABLES = { salon_settings: SALON, services: SERVICES, business_hours: HOURS, staff: STAFF, staff_services: STAFF_SERVICES };

const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
const weekdayOf = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

// Fast "tilfældighed", så nogle tider ser optagede ud – den samme hver gang
function busy(...parts) {
  let x = 0;
  for (const ch of parts.join("|")) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 100 < 35;
}

function nowMinutes() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

function slotsFor(serviceId, iso, staffId) {
  const service = SERVICES.find((s) => s.id === serviceId);
  const day = HOURS.find((x) => x.weekday === weekdayOf(iso));
  if (!service || !day?.is_open) return [];
  const crew = STAFF.filter((s) => (!staffId || s.id === staffId)
    && STAFF_SERVICES.some((l) => l.staff_id === s.id && l.service_id === serviceId)
    && !STAFF_OFF[s.id]?.includes(weekdayOf(iso)));
  const earliest = iso === todayInCopenhagen() ? nowMinutes() + SALON[0].booking_notice_hours * 60 : 0;
  const out = [];
  for (let t = toMin(day.start_time); t + service.duration_minutes <= toMin(day.end_time); t += SALON[0].slot_interval_minutes) {
    if (t < earliest) continue;
    if (crew.some((s) => !busy(iso, t, s.id))) out.push({ start_time: hhmm(t), end_time: hhmm(t + service.duration_minutes) });
  }
  return out;
}

function dates({ p_service_id, p_from, p_to, p_staff_id = null }) {
  const rows = [];
  for (let iso = p_from; iso <= p_to; iso = addDays(iso, 1)) {
    const day = HOURS.find((x) => x.weekday === weekdayOf(iso));
    if (!day?.is_open) { rows.push({ calendar_date: iso, status: "closed", free_slots: 0 }); continue; }
    if (p_staff_id && STAFF_OFF[p_staff_id]?.includes(weekdayOf(iso))) { rows.push({ calendar_date: iso, status: "off", free_slots: 0 }); continue; }
    const n = slotsFor(p_service_id, iso, p_staff_id).length;
    rows.push({ calendar_date: iso, status: n ? "available" : "full", free_slots: n });
  }
  return rows;
}

export function demoSelect(path) {
  const table = path.replace(/^\/rest\/v1\//, "").split("?")[0];
  if (!(table in TABLES)) return null;
  return structuredClone(TABLES[table]);
}

export function demoRpc(fn, args = {}) {
  if (fn === "get_available_dates") return dates(args);
  if (fn === "get_available_slots") return slotsFor(args.p_service_id, args.p_date, args.p_staff_id ?? null);
  if (fn === "platform_link_enabled") return false;
  return undefined;
}
