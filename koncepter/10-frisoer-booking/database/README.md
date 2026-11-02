# Frisørbooking – database og opsætning

Databasen bruges af to sider: koncept 10 (`koncepter/10-frisoer-booking/`) og SKARP (`koncepter/08-skarp/`), som er det fulde site i barbershop-design. Begge har samme JavaScript-moduler og hver sin `assets/config.js`. Hver af dem har tre sider: forsiden, `/book` til booking og `/admin` til administration. De bruger Supabase-projektet `fiszpthonodetuqclzsn` med den publicerbare nøgle i `assets/config.js`. Der er ingen server ud over Supabase. Alle bookingregler og rettigheder håndhæves i databasen, så browseren kan ikke snyde.

Salonen kan have flere frisører. Hver frisør har sin egen kalender, sine egne behandlinger, arbejdstider og fravær. Kunden kan vælge en bestemt frisør eller *Første ledige*.

**Status:**
- **Migration 2** blev kørt på projektet 2. november 2026, og `4-test-uden-spor.sql` gav "TEST OK: alle 29 kontroller bestået".
- **Migration 6 (flere frisører)** og `9-demo-skarp.sql` blev kørt 2. november 2026, og `8-test-flere-frisoerer.sql` gav "TEST OK: alle 41 kontroller bestået".
- **Forbindelsen til Vanta Platform** (`10-forbindelse-til-platform.sql`) er ikke kørt endnu. Den er kun til saloner, der også har Vanta Platform.

## Filerne

| Fil | Ændrer data? | Hvad den gør |
|---|---|---|
| `1-kontrol-foer.sql` | Nej | Viser nuværende RLS, politikker, rettigheder, regler, antal rækker og eventuelle overlappende aftaler. |
| `2-migration.sql` | Ja | Grundmigrationen: bookingregler, adgang og danske eksempeldata. Kører i én transaktion, er ikke-destruktiv og kan køres igen uden skade. |
| `3-kontrol-efter.sql` | Nej | 16 kontroller efter migration 2. Den sidste række, `alt_ok`, skal være `true`. |
| `4-test-uden-spor.sql` | Nej (ruller tilbage) | Tester migration 2 i den rigtige database og fejler med vilje til sidst, så intet bliver gemt. |
| `5-opret-administrator.sql` | Ja | Gør en eksisterende bruger til administrator. |
| `6-migration-flere-frisoerer.sql` | Ja | Flere frisører. Kører i én transaktion, er ikke-destruktiv og kan køres igen uden skade. |
| `7-kontrol-flere-frisoerer.sql` | Nej | 20 kontroller efter migration 6. Den sidste række, `alt_ok`, skal være `true`. |
| `8-test-flere-frisoerer.sql` | Nej (ruller tilbage) | Tester flere frisører, roller og regler i den rigtige database. Intet bliver gemt. |
| `9-demo-skarp.sql` | Ja | Gør demodata til en barbershop: navnet SKARP, adressen "Vesterbro, København (demo)" og fem barberbehandlinger med demopriser. Kun demoværdier ændres. |
| `10-forbindelse-til-platform.sql` | Ja | Valgfri forbindelse til Vanta Platform: bookinger sendes automatisk til platformen, når ejeren slår den til. Kræver pg_cron og pg_net. Kører i én transaktion, er ikke-destruktiv og kan køres igen uden skade. |
| `11-test-forbindelse.sql` | Nej (ruller tilbage) | Tester forbindelsen i den rigtige database: data, kø, svar, nøgle i Vault og adgang. Intet bliver gemt eller sendt. |
| `tilbagerulning.sql` | Ja | Genskaber tilstanden fra før migration 2. Den virker kun, før migration 6 er kørt, og stopper ellers uden ændringer. |
| `tilbagerulning-forbindelse.sql` | Ja | Fjerner forbindelsen til Vanta Platform igen (job, trigger, funktioner, tabeller og nøgle). Bookinger røres ikke. |
| `tests/` | – | Lokale tests mod PGlite og Playwright. De rører ikke Supabase. |

Fil 3 og 4 passer til tilstanden efter migration 2. Efter migration 6 bruges fil 7 og 8. Mappen `database/` står i `.vercelignore` og bliver ikke udgivet.

## Hvad migration 2 ændrer

- **Sikkerhedskopi:** De nuværende politikker, tabelrettigheder og RLS-status gemmes i skemaet `salon_backup`. Skemaet er ikke tilgængeligt via API'et.
- **Fire nye kolonner** med standardværdier:
  - `services.price_is_demo`
  - `salon_settings.booking_window_days` (60 dage)
  - `salon_settings.about_text`
  - `salon_settings.is_demo`

  Tabeller og eksisterende kolonner bevares.
- **Kontrolregler** for nye værdier, fx varighed 5–600 min., interval 5–240 min. og gyldige statusværdier. De er `NOT VALID`, så eksisterende rækker ikke afvises.
- **Ingen dobbeltbooking:** En exclusion constraint forhindrer, at to aktive aftaler overlapper, også når to kunder booker samtidig. Aftaler med status `cancelled` tæller ikke. Overlapper eksisterende aftaler allerede, stopper migrationen uden ændringer og fortæller hvilke. Migration 6 gør reglen gældende pr. frisør.
- **Funktioner:**
  - Offentlige: `get_available_dates`, `get_available_slots`, `create_booking` og `get_booking_receipt`. De viser kun tider og status, aldrig kundedata.
  - Til administrationen: `is_admin`.
  - Hjælpefunktionerne ligger i det lukkede skema `salon_private`.
- **Adgang:** Alle politikker på de seks tabeller erstattes af 15 kendte politikker, og tabelrettighederne strammes.
- **Danske eksempeldata:**
  - De fem engelske behandlinger får danske navne og beskrivelser.
  - Uændrede eksempelpriser erstattes af danske demopriser, markeret med `price_is_demo`.
  - De amerikanske saloninformationer erstattes af tydelige demooplysninger: "Demosalonen", `kontakt@example.com`, `+45 00 00 00 00` og "Demovej 1, 0000 Demoby".

  Kun felter, der stadig har de oprindelige eksempelværdier, ændres. Der oprettes ingen dubletter.

## Hvad migration 6 (flere frisører) ændrer

- **Fem nye tabeller:**
  - `staff`: frisørerne (navn, aktiv, rækkefølge)
  - `staff_services`: hvilke behandlinger hver frisør laver
  - `staff_hours`: arbejdstid pr. ugedag
  - `staff_time_off`: fravær, fx ferie, sygdom eller et lægebesøg
  - `staff_users`: kobler en frisør til et login
- **Bookinger får en frisør:** `appointments.staff_id` er ny og påkrævet. Eksisterende bookinger knyttes til den første frisør. Ingen bookinger ændres ellers.
- **Dobbeltbooking pr. frisør:** Den fælles regel erstattes af `appointments_no_overlap_per_staff`. To frisører kan have kunder på samme tid, men én frisør kan aldrig have to aktive aftaler, der overlapper. Reglen kræver udvidelsen `btree_gist`, som migrationen slår til.
- **Funktioner:**
  - De offentlige bookingfunktioner får den valgfri parameter `p_staff_id`. Uden den gælder *første ledige*, så kald som før virker stadig.
  - De gamle udgaver fjernes, så API'et kun kender én udgave af hver funktion.
  - Nye funktioner:
    - `get_my_access`: brugerens rolle
    - `my_staff_id`: bruges af politikkerne
    - `admin_staff_logins` og `link_staff_login`: kun for administratorer
- **Adgang:** Politikkerne på de nye tabeller og på `appointments` erstattes af et kendt sæt. Der er 30 politikker i alt. De øvrige tabeller røres ikke.
- **Demofrisører:** Findes der ingen frisører, oprettes Anna, Mikkel og Sara.
  - Anna laver alle behandlinger.
  - Mikkel laver herreklip, vask og føn og hårkur og har fri om mandagen.
  - Sara laver dameklip, farvning, vask og føn og hårkur og har fri om lørdagen.

  Arbejdstiderne sættes til salonens åbningstider.

Migration 6 har ingen tilbagerulning. Den sletter intet, og fejler den, ændres intet.

## Hvad forbindelsen til Vanta Platform (fil 10) ændrer

Forbindelsen er en tilvalgsfunktion: bookingsystemet og Vanta Platform kan sælges hver for sig. Uden fil 10, eller med forbindelsen slået fra, virker bookingsystemet præcis som før.

- **To tabeller i `salon_private`**, som API'et ikke udstiller: `platform_settings` (adresse, til/fra, gennemførte besøg) og `platform_sync` (én række pr. booking, der skal eller er blevet sendt). API-nøglen ligger krypteret i Supabase Vault under navnet `vanta_platform_api_key`. Tabellen gemmer kun nøglens id og de første 14 tegn, så ejeren kan genkende den i platformens nøgleliste.
- **Trigger på `appointments`:** Når en booking oprettes eller ændres, og forbindelsen er slået til, markeres den til afsendelse. Bookingen venter aldrig på platformen, og en fejl i køen kan ikke stoppe en booking.
- **Job hvert minut (pg_cron, `vanta-platform-sync`):** Sender markerede bookinger med `POST <adresse>/api/v1/appointments` (pg_net), læser svarene og prøver igen ved fejl efter 2, 4, 8 … minutter, højst 6 timer. Hver udgave af en booking har sin egen `Idempotency-Key`, så platformen aldrig opretter et besøg to gange, heller ikke når et kald gentages. Uændrede data sendes ikke igen.
- **Hvad der sendes:** bookingens id (`external_id`), start og slut (UTC), status (`pending`/`confirmed` → `booked`, `cancelled`, `completed`), behandling, frisør, pris i DKK og kundens fornavn, efternavn, e-mail og telefon. Kundens bemærkning og marketingsamtykke sendes aldrig. En e-mail eller et telefonnummer, platformen ikke kan læse, udelades.
- **Svar:** 2xx er sendt. Afviser platformen bookingens data (422), vises bookingen i administrationen med årsagen og prøves igen, når den ændres. Fejl på forbindelsen (forkert nøgle, forkert adresse, platformen nede) vises øverst på fanen *Integrationer* og prøves igen automatisk.
- **Gennemførte besøg (valgfrit, slået fra):** Bekræftede bookinger, hvis tid er gået, markeres som `completed`. Afventende og aflyste røres ikke. Vanta Platform bruger gennemførte besøg til genbookinger.
- **Funktioner:** `get_platform_link`, `save_platform_link` og `resend_platform_sync` kan kun bruges af administratorer. `platform_link_enabled` er offentlig og fortæller kun bookingsiden, om kunden skal have at vide, at oplysningerne gemmes i salonens kundesystem.
- Slås forbindelsen til, eller skiftes nøgle eller adresse, sendes alle bookinger, også tidligere og aflyste.

## Manuelle trin i Supabase

Alt foregår i Supabase Dashboard for projektet `fiszpthonodetuqclzsn`.

**Grundopsætning (gjort 2. november 2026):**

1. **SQL Editor:** Kør `1-kontrol-foer.sql`, og gem resultatet (Export → CSV).
2. Kør `2-migration.sql`.
3. Kør `3-kontrol-efter.sql`. `alt_ok` skal være `true`. Kontrol 16 er `false`, indtil trin 5 er gjort.
4. **Authentication → Users → Add user → Create new user:** Brug en e-mail og en stærk adgangskode, og sæt flueben i *Auto Confirm User*.
5. Skriv e-mailen i `5-opret-administrator.sql`, og kør filen.
6. Kør `4-test-uden-spor.sql`. Forventet resultat er en **rød** besked, der begynder med `TEST OK: alle 29 kontroller bestået`. Den røde farve er meningen: fejlen ruller testen tilbage.
7. **Authentication → Sign In / Providers:** Slå *Allow new users to sign up* fra.
8. Log ind på `/koncepter/10-frisoer-booking/admin`, og ret saloninformation, priser, varigheder og åbningstider. Fjern fluebenene *Vis som demooplysninger* og *Demopris*, når oplysningerne er salonens egne.

**Flere frisører:**

9. Kør `6-migration-flere-frisoerer.sql`.
10. Kør `7-kontrol-flere-frisoerer.sql`. `alt_ok` skal være `true`.
11. Kør `8-test-flere-frisoerer.sql`. Forventet resultat er en rød besked, der begynder med `TEST OK: alle 41 kontroller bestået`. Står der 34, er det fordi testbrugeren til frisørlogin ikke kunne oprettes. Det står i så fald i beskeden.
12. Udgiv den nye udgave af siden. Udgiver du den før trin 9, virker bookingen stadig, men administrationen beder om migration 6.
13. Ret frisørerne i administrationen under **Frisører**: navne, behandlinger og arbejdstider. Registrér ferie og fridage under **Fravær**.
14. Til SKARP-prototypen: Kør `9-demo-skarp.sql`. Koncept 10 bruger samme database og viser derefter også SKARPs navn og behandlinger.

**Forbindelse til Vanta Platform (kun når salonen også har Vanta Platform):**

15. **Database → Extensions:** Slå `pg_cron` og `pg_net` til. Vault (`supabase_vault`) er slået til i forvejen.
16. Kør `10-forbindelse-til-platform.sql`. Resultatet skal sige "Forbindelsen er installeret og slået fra." og `job_planlagt` = 1.
17. Kør `11-test-forbindelse.sql`. Forventet resultat er en rød besked, der begynder med `TEST OK: alle 36 kontroller bestået`. Står der 31, er der ingen administrator endnu. Det står i så fald i beskeden.
18. Udgiv den nye udgave af siden. Fanen *Integrationer* vises kun for administratorer, og kun når fil 10 er kørt.
19. **I Vanta Platform:** Integrationer → Vanta Booking → *Ny API-nøgle* med adgang til aftaler. Kopiér nøglen og adressen.
20. **I bookingens administration:** *Integrationer* → indsæt platformens adresse og nøglen → sæt flueben i *Send bookinger til Vanta Platform* → *Gem*. Alle bookinger sendes inden for et par minutter. Status og eventuelle fejl står på samme fane.
21. Skriv i salonens privatlivspolitik, at kundens oplysninger også gemmes i salonens kundesystem (Vanta Platform), og nævn det i databehandleraftalen.

Sælges bookingsystemet uden Vanta Platform, springes trin 15–21 over.

**Login til en frisør (valgfrit):**

1. **Authentication → Users → Add user:** Opret frisørens bruger med *Auto Confirm User*.
2. I administrationen: **Frisører → frisøren → Login**. Skriv e-mailen, og tryk *Giv login*.

Frisøren kan derefter logge ind på `/admin` og ser kun sine egne bookinger og sin egen dagsplan. Et login virker kun, så længe frisøren er aktiv.

## Adgang efter migration 6

| Tabel | Besøgende | Indlogget uden rolle | Frisør | Administrator |
|---|---|---|---|---|
| `services` | Se aktive | Se aktive | Se aktive | Se alle, oprette, rette |
| `business_hours` | Se | Se | Se | Oprette, rette |
| `salon_settings` | Se | Se | Se | Rette |
| `blocked_dates` | – | – | – | Se, oprette, rette, slette |
| `appointments` | – (kun via `create_booking`) | – | Se egne, ændre **status** på egne | Se alle, ændre **status** og **frisør** |
| `staff` | Se aktive | Se aktive | Se aktive | Se alle, oprette, rette |
| `staff_services` | Se | Se | Se | Tilføje, fjerne |
| `staff_hours` | – | – | Se egne | Se, oprette, rette |
| `staff_time_off` | – | – | Se egne | Se, oprette, slette |
| `staff_users` | – | – | Se egen række | Kun via `link_staff_login` |
| `admin_users` | – | Se egen række | Se egen række | Se egen række |

Forbindelsen til Vanta Platform (fil 10): Tabellerne i `salon_private` og Vault kan ingen læse via API'et. Kun administratorer kan se og ændre forbindelsen (`get_platform_link`, `save_platform_link`, `resend_platform_sync`), og API-nøglen gives aldrig tilbage. Besøgende kan kun kalde `platform_link_enabled`, som svarer sand eller falsk.

Ingen kan slette behandlinger, frisører, bookinger eller saloninformation via API'et. Ingen kan ændre kundens oplysninger på en booking. Ingen kan skrive i `admin_users` eller direkte i `staff_users`. Administratorer oprettes kun i SQL Editor (`5-opret-administrator.sql`).

## Bookingregler (håndhæves i databasen)

- **Hele behandlingen** skal ligge inden for både salonens åbningstid og frisørens arbejdstid. Sluttiden beregnes ud fra `duration_minutes`.
- **Frisøren** skal være aktiv og lave behandlingen.
- **Fravær:** Tider, der overlapper frisørens fravær, kan ikke bookes. En hel fraværsdag vises som "arbejder ikke" i kalenderen.
- **Starttider** følger salonens interval (`slot_interval_minutes`) regnet fra det tidspunkt, frisøren møder.
- **Minimumsvarsling** (`booking_notice_hours`) og "i dag" regnes i `Europe/Copenhagen`, også hen over sommertid.
- **Lukkedage:** Ugedage med `is_open = false` og datoer i `blocked_dates` kan ikke bookes hos nogen frisør.
- **Bookingvindue:** Der kan bookes højst `booking_window_days` dage frem.
- **Én kunde ad gangen pr. frisør.** Aflyste aftaler blokerer ikke.
- **Første ledige:** Vælger kunden ikke en frisør, får bookingen den ledige frisør med færrest bookinger den dag. Står flere lige, afgør frisørernes rækkefølge.
- **Status:** Nye bookinger får altid `pending` (Afventer). Administratoren eller frisøren selv kan bekræfte.
- **Bremser mod misbrug:** Højst 3 kommende bookinger pr. e-mail eller telefonnummer og højst 20 nye bookinger på 15 minutter i alt.

## Tests

Testsættene bruger PGlite (rigtig Postgres i WebAssembly) med udvidelsen `btree_gist`. PGlite lånes fra `vanta-platform/node_modules`, og stien kan overskrives med `PGLITE=<sti>`.

```sh
cd koncepter/10-frisoer-booking/database/tests
node db.test.mjs            # 145 kontroller af migration 2: regler, sommertid, adgang, idempotens, tilbagerulning
node db-frisoerer.test.mjs  # 139 kontroller af migration 6 og demoscriptet: frisører, fravær, roller, idempotens, fil 7–9
node server.mjs &           # lokal testserver på :8790 (side) og :8791 (efterligner Supabase)
python3 browser.test.py     # 185 kontroller i Chromium: mobil, computer, booking, dagsplan, frisører, roller
python3 browser-skarp.test.py  # 66 kontroller af SKARP (koncept 08): forside, demo uden booking, administration
node db-platform.test.mjs   # 117 kontroller af forbindelsen til Vanta Platform (fil 10, 11 og tilbagerulning)
python3 browser-platform.test.py  # 62 kontroller af fanen Integrationer og bookingsiden med forbindelsen
```

Forbindelsen testes uden Supabase og uden en rigtig platform: `platform-stub.sql` efterligner pg_net, pg_cron og Vault, og `platform-mock.mjs` er en falsk Vanta Platform (på :8793 under `server.mjs`). Den svarer som den rigtige og kontrollerer de modtagne data med Vanta Platforms egen validering (`vanta-platform/src/lib/integrations/schema.ts`, indlæst via `platform-contract.mjs`). Platformen har den modsatte test: `vanta-platform/tests/unit/vanta-booking-contract.test.ts`.

## Kendte begrænsninger

- **Ingen besked til kunden:** Kunden får hverken e-mail eller sms, når bookingen modtages, bekræftes, flyttes eller aflyses. Kvitteringen siger det tydeligt og giver et link, hvor status kan følges.
- **Ingen robotbeskyttelse:** Der er ingen CAPTCHA. Bremserne i databasen begrænser skaden, men en målrettet angriber kan stadig oprette falske bookinger med skiftende e-mails. Overvej Cloudflare Turnstile eller hCaptcha via en Edge Function, hvis siden bliver offentlig.
- **Ingen telefonbookinger:** Administrationen kan ikke oprette bookinger. Personalet kan bruge den almindelige bookingside og derefter bekræfte bookingen i administrationen. Minimumsvarslingen gælder også her.
- **Ingen stole eller vaskepladser:** Kun frisørerne begrænser, hvor mange kunder der kan være på én gang.
- **Samme pris og varighed for alle frisører:** En frisør kan ikke have sin egen pris eller varighed på en behandling.
- **Frisøren retter ikke selv:** Frisører kan ikke rette egne arbejdstider eller registrere eget fravær. Det gør administratoren.
- **Intet flyttes automatisk:** Fravær, lukkedage og en frisør, der gøres inaktiv, flytter eller aflyser ikke eksisterende bookinger. Administrationen advarer, og bookingerne flyttes til en anden frisør under Bookinger.
- **Ingen kundeaflysning:** Kunden kan ikke selv aflyse eller flytte en tid.
- **Pris på kvitteringen:** Kvitteringen viser behandlingens nuværende pris. Prisen gemmes ikke på bookingen.
- **Ingen "glemt adgangskode":** Siden har ingen nulstilling af adgangskode. Den kan nulstilles under Authentication → Users.
- **Forbindelsen går kun den ene vej:** Bookinger sendes til Vanta Platform, men ændringer i platformen kommer ikke tilbage til bookingsystemet. En booking, der slettes i SQL Editor, bliver liggende i platformen.
- **Op til et par minutter:** Jobbet kører hvert minut, så en booking når frem til platformen inden for 1–2 minutter, når alt virker.
- **Persondata:** Personoplysninger slettes ikke automatisk. Sletning på anmodning sker i Table Editor. Salonen skal have en privatlivspolitik, før siden bruges rigtigt.
