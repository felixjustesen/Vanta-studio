// Forbindelsen til Supabase.
// Den publicerbare nøgle må gerne ligge i browseren – adgangen styres af
// databasens politikker (RLS). Læg aldrig en secret- eller service_role-nøgle her.
export const SUPABASE_URL = ""; // prototype: ingen database
export const SUPABASE_PUBLISHABLE_KEY = "";

// Stien, siden ligger under. Ret her, hvis siden flyttes.
export const BASE = "/koncepter/08-skarp";

// Demo: hele bookingforløbet kan prøves, men der sendes ingen booking.
// Sæt til false, når siden skal tage imod rigtige bookinger.
export const DEMO_ONLY = true;

// Prototype på vantastudio.dk: alt indhold kommer fra lib/demo-data.js, og intet
// hentes fra eller sendes til en database. Sæt til false på en rigtig kundeside.
export const OFFLINE = true;
