-- Genskabelse af den nuværende database (kolonner og typer aflæst via API'et 2026-11-02)
create table public.services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  duration_minutes integer not null,
  price numeric(10,2) not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  service_id uuid references public.services(id) on delete set null,
  full_name text not null,
  email text not null,
  phone text,
  appointment_date date not null,
  start_time time not null,
  end_time time not null,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','completed')),
  notes text,
  created_at timestamptz not null default now()
);
create table public.business_hours (
  id uuid primary key default gen_random_uuid(),
  weekday integer not null unique check (weekday between 0 and 6),
  is_open boolean not null default true,
  start_time time,
  end_time time
);
create table public.blocked_dates (
  id uuid primary key default gen_random_uuid(),
  blocked_date date not null unique,
  reason text,
  created_at timestamptz not null default now()
);
create table public.salon_settings (
  id uuid primary key default gen_random_uuid(),
  salon_name text not null,
  salon_email text,
  salon_phone text,
  salon_address text,
  slot_interval_minutes integer not null default 30,
  booking_notice_hours integer not null default 2,
  created_at timestamptz not null default now()
);
create table public.admin_users (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

insert into public.services (id, name, description, duration_minutes, price, is_active, created_at) values
('46d76786-57c6-4325-9d23-f07b991f064b','Women''s Haircut','Personalized haircut with consultation and styling finish.',60,65.00,true,'2026-11-02T00:18:27.806389+00:00'),
('6ddbe3c5-bca1-4ef3-bcfa-7a1ee53ff900','Men''s Haircut','Clean haircut with professional styling.',45,45.00,true,'2026-11-02T00:18:27.806389+00:00'),
('72d8b7a9-98e4-4327-b1c3-34f977aeb8ec','Hair Coloring','Full color service with consultation and finish.',120,140.00,true,'2026-11-02T00:18:27.806389+00:00'),
('9e50c1ed-7fb4-4e70-8651-244a99ef60e7','Blow Dry Styling','Wash, blow dry, and polished styling.',45,50.00,true,'2026-11-02T00:18:27.806389+00:00'),
('ac9c094a-7a65-4939-9b2e-5c858644b9ed','Hair Treatment','Deep conditioning treatment for softer and healthier-looking hair.',60,75.00,true,'2026-11-02T00:18:27.806389+00:00');

insert into public.business_hours (id, weekday, is_open, start_time, end_time) values
('13128b98-c9d8-4a0e-9b17-552415d21b96',0,false,null,null),
('1b369c7c-6513-4731-a4c4-7547c88c82a3',1,true,'09:00','18:00'),
('5ca10191-eb30-4315-b545-17eca9cf278e',2,true,'09:00','18:00'),
('a1792668-6752-46b2-9651-5a603e4cf985',3,true,'09:00','18:00'),
('0560d6f1-5d32-42d8-a391-71f615a281ac',4,true,'09:00','18:00'),
('b5e7a7fc-b033-4715-a279-2832bc0153cc',5,true,'09:00','19:00'),
('9db86883-6689-4e2d-a0a1-8deece000f02',6,true,'10:00','16:00');

insert into public.salon_settings (id, salon_name, salon_email, salon_phone, salon_address, slot_interval_minutes, booking_notice_hours, created_at) values
('2068f5f5-12a4-4542-a7fe-2ec721bca4ac','Luxe Hair Studio','hello@luxehair.com','+1 555 234 7890','245 Madison Avenue, New York, NY',30,2,'2026-11-02T00:18:27.806389+00:00');

-- Typiske skabelonpolitikker (bevidst med huller, så nulstillingen kan testes)
alter table public.services enable row level security;
alter table public.appointments enable row level security;
alter table public.business_hours enable row level security;
alter table public.blocked_dates enable row level security;
alter table public.salon_settings enable row level security;
alter table public.admin_users enable row level security;
create policy "Public can view active services" on public.services for select using (is_active = true);
create policy "Public can view business hours" on public.business_hours for select using (true);
create policy "Public can view blocked dates" on public.blocked_dates for select using (true);
create policy "Public can view salon settings" on public.salon_settings for select using (true);
create policy "Anyone can create appointments" on public.appointments for insert with check (true);
create policy "Anyone can view appointments" on public.appointments for select using (true);
create policy "Authenticated users can manage admins" on public.admin_users for all to authenticated using (true) with check (true);
