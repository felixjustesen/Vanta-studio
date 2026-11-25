# Heatmap på Vantas forside

Forsiden bruger Vanta Heatmap efter et udtrykkeligt valg. Kontaktformularen,
samtykkebanneret og cookieindstillingerne er udeladt fra tracking.
Cookiebanneret styrer både Vercel Web Analytics på alle sider og heatmap på
forsiden. Begge kræver “Tillad alle”; “Tillad kun nødvendige” stopper nye
hændelser. Det tidligere heatmapvalg genbruges ikke som tilladelse til statistik.
Valget kan ændres via det diskrete link “Cookieindstillinger” i footeren; der
er ingen fast knap oven på siden. Valget gemmes i `vanta-statistics-consent:v2` i højst 30 dage. Vercels
`beforeSend`-kontrol kontrollerer også tilladelsen før hver hændelse.

## Forbindelse

- Browseren henter `/assets/vanta-heatmap.js` efter tilladelse.
- Den sender kun til `/api/heatmap` på samme domæne.
- Serverfunktionen validerer data og sender dem til den faste private
  heatmap-installation. Den kan hverken læse dashboarddata eller bruges som
  generel proxy.
- Vercels Production-miljø skal have `VANTA_HEATMAP_SERVICE_TOKEN` som Secret.
  Værdien skal komme fra den eksisterende private Sites-installations
  understøttede serviceadgang. Den må aldrig ligge i HTML, JavaScript til
  browseren, Git eller logs. Serviceadgangens levetid er ikke garanteret her.

Tilladt adresse er præcist `https://www.vantastudio.dk`, side `/`, version `a`.
Et besøg på apex-domænet omdirigeres allerede til www. Preview-domæner kan
ikke sende sessionsdata gennem modtageren.

## Afprøvning

Kør `node --test tests/heatmap-collector.test.mjs tests/heatmap-consent.test.mjs`.
Efter udgivelse: kontrollér afvisning, tilladelse og tilbagetrækning på den
rigtige side og bekræft et eget testbesøg i det private dashboard.
Et sidebillede med matchende skærmbredde skal uploades for et præcist overlay.

Vis først forbindelsen som tilsluttet i dashboardet, når rigtig modtagelse er
bekræftet. Dets serverindstilling `VANTA_COLLECTOR_ORIGIN` skal derefter sættes
til `https://www.vantastudio.dk` og dashboardet genudgives.

HTTP 503 betyder manglende serverindstilling. HTTP 502 betyder fejl i den
private forbindelse. Kontroller serviceadgangen uden at udskrive nøglen.
Ratebegrænsningen i modtageren gælder den enkelte serverinstans; den erstatter
ikke distribueret beskyttelse mod misbrug.

## Ændringer og tilbagestilling

Formularafsendelse og eksisterende animationer er ikke ændret. Ved væsentlige
layoutændringer skal version, modtagerens tilladte version og sidebillede
opdateres sammen. Den fælles `/assets/heatmap-consent.js` styrer samtykket og indlæser kun
heatmap på forsiden; eksisterende data administreres i dashboardet.
