// Forbindelsen til Supabase.
// Den publicerbare nøgle må gerne ligge i browseren – adgangen styres af
// databasens politikker (RLS). Læg aldrig en secret- eller service_role-nøgle her.
export const SUPABASE_URL = "https://fiszpthonodetuqclzsn.supabase.co"; // NEXT_PUBLIC_SUPABASE_URL
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_SrZtFUrIpODh9Vd1WSmawA_hBR8dpGM"; // NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

// Stien, siden ligger under. Ret her, hvis siden flyttes.
export const BASE = "/koncepter/10-frisoer-booking";

// Demo: hele bookingforløbet kan prøves, men der sendes ingen booking.
// Sæt til true, hvis siden kun skal vises frem.
export const DEMO_ONLY = false;

// true = prototype uden database (faste demodata i lib/demo-data.js).
export const OFFLINE = false;
