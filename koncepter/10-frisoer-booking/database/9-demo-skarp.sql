-- =====================================================================
--  Demodata til SKARP (koncept 08) – kør efter 6-migration-flere-frisoerer.sql.
--
--  Gør demosalonen til en barbershop: navn, adresse, præsentation og de
--  fem behandlinger. Kun felter, der stadig har demoværdierne, ændres –
--  salonens egne oplysninger og priser røres ikke. Der oprettes ingen
--  dubletter, og filen kan køres igen uden skade.
--
--  OBS: Koncept 10 bruger samme database og viser derefter også SKARP.
-- =====================================================================

begin;

do $$
begin
  if to_regclass('public.staff') is null then
    raise exception 'Kør 6-migration-flere-frisoerer.sql før denne fil. Intet er ændret.';
  end if;
end $$;

-- Saloninformation (kun demooplysninger)
update public.salon_settings
set salon_name    = case when salon_name = 'Demosalonen' then 'SKARP' else salon_name end,
    salon_address = case when salon_address = 'Demovej 1, 0000 Demoby' then 'Vesterbro, København (demo)' else salon_address end,
    about_text    = case
      when about_text = 'Vi tilbyder klip, farve og hårpleje til damer og herrer. Se behandlinger og priser herunder, og book din tid online, når det passer dig. Har du spørgsmål til en behandling, er du velkommen til at kontakte salonen.'
      then 'Klassisk barberhåndværk: klip, fades, skæg og barbering med kniv og varmt håndklæde. Se priserne herover, og book din tid online, når det passer dig. Har du spørgsmål til en behandling, er du velkommen til at kontakte os.'
      else about_text end
where is_demo;

-- Behandlinger: kun rækker med de danske demonavne, som stadig har demopris
with demo (old_name, new_name, minutes, price, description) as (
  values
    ('Dameklip',    'Klip',         30, 295.00, 'Klip med saks og maskine efter dine ønsker, afsluttet med styling.'),
    ('Herreklip',   'Skin fade',    45, 345.00, 'Fade helt ned til huden med en skarp overgang, afsluttet med styling.'),
    ('Hårfarvning', 'Klip og skæg', 60, 445.00, 'Klip og skægtrim i én behandling, afsluttet med varmt håndklæde.'),
    ('Vask og føn', 'Skæg',         20, 195.00, 'Trim og form af skægget med skarpe linjer og skægolie.'),
    ('Hårkur',      'Barbering',    30, 245.00, 'Klassisk barbering med kniv og varmt håndklæde.')
)
update public.services s
set name = demo.new_name,
    duration_minutes = demo.minutes,
    price = demo.price,
    description = demo.description,
    price_is_demo = true
from demo
where s.name = demo.old_name
  and s.price_is_demo;

notify pgrst, 'reload schema';

commit;

-- Resultat
select name, duration_minutes, price, price_is_demo from public.services order by price;
