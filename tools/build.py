#!/usr/bin/env python3
"""Genererer Vanta Studios undersider, menu og sitemap som statisk HTML.

Kør fra projektroden:  python3 tools/build.py
Alt output er almindelige .html-filer, som Vercel serverer direkte (intet build-trin).
Indholdet ligger i dette script; ret her og kør igen.
"""
import json
import os
import re
from html import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = "https://www.vantastudio.dk"
BRAND = "Vanta Studio"
FOUNDER = "Felix Nylander Justesen"
EMAIL = "kontakt@vantastudio.dk"
UPDATED = "2026-10-25"
OG_IMAGE = SITE + "/assets/og-vanta.jpg"

ARROW = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>'
RIGHT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'

# ---------------------------------------------------------------------------
# Navigation
# ---------------------------------------------------------------------------
YDELSER = [
    ("/ydelser/hjemmesider", "Hjemmesider"),
    ("/ydelser/ai-automatisering", "AI & automatisering"),
    ("/ydelser/seo-aeo-geo", "SEO, AEO & GEO"),
    ("/ydelser/integrationer", "Digitale integrationer"),
]
LOESNINGER = [
    ("/loesninger/ai-chatbot", "AI-chatbot"),
    ("/loesninger/automatisk-genbooking", "Automatisk genbooking"),
    ("/loesninger/bookingpaamindelser", "Bookingpåmindelser"),
    ("/loesninger/kundeopfoelgning", "Kundeopfølgning"),
]
MENU = [
    ("/", "Forside", None),
    ("/ydelser", "Ydelser", YDELSER),
    ("/loesninger", "Løsninger", LOESNINGER),
    ("/metode", "Metode", None),
    ("/om-vanta", "Om Vanta", None),
    ("/faq", "FAQ", None),
    ("/indsigter", "Indsigter", None),
    ("/kontakt", "Kontakt", None),
]

# Fremtidige branchesider: tilføj fx ("frisoerer", "Hjemmesider til frisører", ...) og kør scriptet.
# De bliver lagt under /ydelser/hjemmesider/<slug> og kommer automatisk med i sitemap.
BRANCHER = []


def cur(href, path):
    return ' aria-current="page"' if href == path else ""


def menu_html(path):
    """Selve menu-overlayet. path = den aktuelle sides URL."""
    items = []
    for i, (href, label, sub) in enumerate(MENU):
        li = f'<li style="--i:{i}"><div class="vm-row"><a class="vm-link" href="{href}"{cur(href, path)}>{label}</a>'
        if sub:
            sid = "vm-sub-" + href.strip("/")
            opened = path.startswith(href + "/") or path == href
            li += (f'<button class="vm-toggle" type="button" aria-expanded="{str(opened).lower()}" aria-controls="{sid}" '
                   f'aria-label="Vis undersider til {label}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" '
                   f'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>')
            li += f'<div class="vm-sub{" open" if opened else ""}" id="{sid}"><ul>'
            li += "".join(f'<li><a href="{h}"{cur(h, path)}>{l}</a></li>' for h, l in sub)
            li += "</ul></div>"
        else:
            li += "</div>"
        items.append(li + "</li>")
    return f'''<div class="vm" id="vm" role="dialog" aria-modal="true" aria-label="Menu">
  <div class="vm-top"><a href="/" style="color:inherit;text-decoration:none">{BRAND}</a><button class="vm-close" type="button" aria-label="Luk menu"><i></i><i></i></button></div>
  <div class="vm-body">
    <nav aria-label="Hovedmenu"><ol class="vm-list">{"".join(items)}</ol></nav>
    <div class="vm-aside">
      <p>Har du en idé eller et problem, der skal løses? Skriv direkte til mig – jeg svarer inden for 24 timer.</p>
      <a class="mail" href="mailto:{EMAIL}">{EMAIL}</a>
      <a class="glass-btn" href="/kontakt" style="justify-self:start">Start et projekt {ARROW}</a>
    </div>
  </div>
</div>'''


BURGER = '<button class="vm-burger" type="button" data-vm-open aria-expanded="false" aria-controls="vm" aria-label="Åbn menu"><i></i><i></i><i></i></button>'

# ---------------------------------------------------------------------------
# Skabelon
# ---------------------------------------------------------------------------
ORG = {
    "@type": "ProfessionalService",
    "@id": SITE + "/#org",
    "name": BRAND,
    "url": SITE + "/",
    "email": EMAIL,
    "image": OG_IMAGE,
    "description": "Digitalt bureau, der udvikler hjemmesider, AI-løsninger og automatiseringer til virksomheder.",
    "founder": {"@type": "Person", "name": FOUNDER},
    "areaServed": {"@type": "Country", "name": "Danmark"},
    "knowsLanguage": "da",
}


def crumbs_ld(crumbs):
    return {
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": i + 1, "name": n, "item": SITE + (h if h != "/" else "/")}
            for i, (h, n) in enumerate(crumbs)
        ],
    }


def crumbs_html(crumbs):
    parts = []
    for i, (h, n) in enumerate(crumbs):
        if i == len(crumbs) - 1:
            parts.append(f'<li aria-current="page">{n}</li>')
        else:
            parts.append(f'<li><a href="{h}">{n}</a></li>')
    return f'<nav aria-label="Brødkrummer"><ol class="crumbs">{"".join(parts)}</ol></nav>'


def footer_html():
    def col(title, links):
        return f'<div><h2>{title}</h2><ul>' + "".join(f'<li><a href="{h}">{l}</a></li>' for h, l in links) + "</ul></div>"
    return f'''<footer class="sp-foot"><div class="wrap">
  <div class="foot-grid">
    <div><p class="foot-brand">{BRAND}</p><p style="margin:0 0 18px"><a href="mailto:{EMAIL}">{EMAIL}</a></p><nav class="socials" aria-label="Sociale medier"><a href="#" aria-label="Vanta Studio på X"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.48 21H2.4l7.17-8.19L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.18h1.7L7.4 4.73H5.58l11.09 14.45Z"/></svg></a><a href="#" aria-label="Vanta Studio på Instagram"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg></a></nav></div>
    {col("Ydelser", YDELSER)}
    {col("Løsninger", LOESNINGER)}
    {col("Vanta", [("/metode", "Metode"), ("/om-vanta", "Om Vanta"), ("/faq", "FAQ"), ("/indsigter", "Indsigter"), ("/kontakt", "Kontakt")])}
  </div>
  <div class="foot-legal"><span>© 2026 {BRAND}</span><a href="/">Til forsiden</a></div>
</div></footer>'''


def ending_html(title="Lad os finde ud af, hvad der giver mening for din virksomhed",
                text="Det starter med en uforpligtende samtale. Du taler direkte med mig – den samme person, som analyserer og bygger løsningen."):
    return f'''<section class="ending" aria-labelledby="end-t"><div class="wrap rv">
  <h2 class="serif" id="end-t">{title}</h2>
  <p>{text}</p>
  <a class="glass-btn" href="/kontakt">Start et projekt {ARROW}</a>
</div></section>'''


def page(path, title, desc, h1, body, crumbs=None, lead=None, actions=True, ld=None, og_type="website"):
    url = SITE + (path if path != "/" else "/")
    graph = [dict(ORG)]
    if crumbs:
        graph.append(crumbs_ld(crumbs))
    graph += ld or []
    ldjson = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, indent=1)
    hero_actions = ""
    if actions:
        hero_actions = f'<div class="actions"><a class="glass-btn" href="/kontakt">Start et projekt {ARROW}</a></div>'
    return f'''<!doctype html>
<html lang="da">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{escape(title)}</title>
<meta name="description" content="{escape(desc)}">
<link rel="canonical" href="{url}">
<meta name="theme-color" content="#0F172A">
<meta property="og:type" content="{og_type}">
<meta property="og:locale" content="da_DK">
<meta property="og:site_name" content="{BRAND}">
<meta property="og:title" content="{escape(title)}">
<meta property="og:description" content="{escape(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23030318'/%3E%3Cpath d='M8 9h3.4l4.6 11.2L20.6 9H24l-6.6 15h-2.8z' fill='%23fff'/%3E%3C/svg%3E">
<link rel="preload" href="/assets/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/menu.css">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">
{ldjson}
</script>
</head>
<body class="sp">
<div class="sp-glow" aria-hidden="true"></div>
<a href="#indhold" style="position:absolute;left:-9999px" onfocus="this.style.left='12px';this.style.top='12px';this.style.zIndex=200" onblur="this.style.left='-9999px'">Spring til indhold</a>
<header class="sp-hdr"><div class="sp-bar">
  <a href="/">{BRAND}</a>
  <div class="sp-right"><a class="sp-cta" href="/kontakt">Start et projekt {ARROW}</a>{BURGER}</div>
</div></header>
<main id="indhold">
<section class="pg-hero"><div class="wrap">
  {crumbs_html(crumbs) if crumbs else ""}
  <h1 class="serif">{h1}</h1>
  {f'<p class="lead">{lead}</p>' if lead else ""}
  {hero_actions}
</div></section>
{body}
</main>
{footer_html()}
{menu_html(path)}
<script src="/assets/menu.js" defer></script>
</body>
</html>
'''


def card(href, nr, title, text, more="Læs mere"):
    return f'<a class="card rv" href="{href}"><span class="nr">{nr}</span><h3>{title}</h3><p>{text}</p><span class="more">{more} {RIGHT}</span></a>'


def sec(inner, label=None):
    lab = f' aria-labelledby="{label}"' if label else ""
    return f'<section class="sec"{lab}><div class="wrap">{inner}</div></section>'


def prose(inner):
    return sec(f'<div class="prose rv">{inner}</div>')


def related(title, links):
    cards = "".join(card(h, f"{i + 1:02d}", t, d) for i, (h, t, d) in enumerate(links))
    return sec(f'<div class="sec-head rv"><h2 class="serif">{title}</h2></div><div class="cards c3">{cards}</div>')


def service_ld(path, name, desc):
    return {"@type": "Service", "name": name, "description": desc, "url": SITE + path,
            "provider": {"@id": SITE + "/#org"}, "areaServed": {"@type": "Country", "name": "Danmark"}}


PAGES = {}


def add(path, html):
    PAGES[path] = html


# ---------------------------------------------------------------------------
# Ydelser
# ---------------------------------------------------------------------------
Y_INTRO = {
    "/ydelser/hjemmesider": "Skræddersyede, moderne hjemmesider med fokus på design, brugeroplevelse, performance og konvertering.",
    "/ydelser/ai-automatisering": "Løsninger, der automatiserer gentagne opgaver, forbedrer kundekommunikationen og letter den daglige drift.",
    "/ydelser/seo-aeo-geo": "Synlighed i Google – og i de AI-tjenester, flere og flere bruger til at finde svar og leverandører.",
    "/ydelser/integrationer": "Nye funktioner koblet sammen med de systemer, din virksomhed allerede bruger – hvor det teknisk er muligt.",
}

add("/ydelser", page(
    "/ydelser",
    "Ydelser – hjemmesider, AI, SEO og integrationer | Vanta Studio",
    "Vanta Studio udvikler hjemmesider, AI og automatisering, SEO/AEO/GEO og digitale integrationer – sammensat efter, hvad din virksomhed faktisk har brug for.",
    'Fire ydelser. <span class="grad">Én samlet tilgang.</span>',
    sec('<div class="cards c4">' + "".join(card(h, f"{i + 1:02d}", l, Y_INTRO[h]) for i, (h, l) in enumerate(YDELSER)) + "</div>")
    + prose('''
<h2 class="serif">Kombineret efter behov – ikke solgt i pakker</h2>
<p>En virksomhed har brug for en ny hjemmeside. En anden har en fin hjemmeside, men mister kunder, fordi ingen følger op efter første besøg. En tredje bruger for mange timer på at svare på de samme spørgsmål.</p>
<p>Derfor starter jeg altid med at forstå, hvordan din virksomhed fungerer i dag. Først derefter anbefaler jeg de ydelser – eller den kombination af dem – der giver mest mening. Læs mere om <a href="/metode">min metode</a>, eller se de <a href="/loesninger">konkrete løsninger</a>, jeg kan bygge.</p>''')
    + ending_html(),
    crumbs=[("/", "Forside"), ("/ydelser", "Ydelser")],
    lead="Hjemmesider, AI, automatisering, synlighed og integrationer. Hver ydelse kan stå alene, men værdien opstår ofte, når de spiller sammen.",
    ld=[{"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": SITE + h, "name": l} for i, (h, l) in enumerate(YDELSER)]}],
))

HJ_FAQ = [
    ("Hvad koster en professionel hjemmeside til en virksomhed?",
     "Prisen afhænger af antal sider, funktioner, integrationer og hvor meget indhold der skal udarbejdes. Efter en uforpligtende samtale får du et konkret tilbud, før arbejdet går i gang."),
    ("Hvor lang tid tager det at få lavet en hjemmeside?",
     "En hjemmeside er typisk klar inden for 14 dage. Mere komplekse projekter kan tage længere tid, men du får altid en klar tidsplan, inden arbejdet går i gang."),
    ("Bruger du færdige skabeloner?",
     "Nej. Jeg designer og udvikler hver hjemmeside fra bunden, så struktur, udtryk og funktioner passer til netop din virksomhed og dine kunder."),
    ("Skal jeg selv skrive teksterne?",
     "Du kender din virksomhed bedst, så din viden er vigtig. Jeg hjælper med at strukturere og formulere teksterne, så de er klare for dine kunder og gode for søgemaskinerne."),
]

add("/ydelser/hjemmesider", page(
    "/ydelser/hjemmesider",
    "Professionelle hjemmesider til virksomheder | Vanta Studio",
    "Få en skræddersyet hjemmeside med fokus på design, hastighed og flere kundehenvendelser. Vanta Studio udvikler professionelle hjemmesider på typisk 14 dage.",
    'Hjemmesider, der <span class="grad">arbejder for din virksomhed.</span>',
    prose('''
<h2 class="serif">Hvad får du med en hjemmeside fra Vanta Studio?</h2>
<p>En professionel hjemmeside til din virksomhed er ofte det første møde, en ny kunde har med dig. Den skal se godt ud – men den skal også gøre det let at forstå, hvad du tilbyder, og tage næste skridt: ringe, booke eller skrive.</p>
<p>Når du får lavet en hjemmeside hos mig, får du:</p>
<ul>
<li><strong>Design og udvikling fra bunden</strong>, tilpasset din virksomhed, dit brand og dine kunder.</li>
<li><strong>En mobilvenlig og hurtig hjemmeside</strong>, bygget med fokus på lav indlæsningstid og gode Core Web Vitals.</li>
<li><strong>Struktur og tekster, der leder mod handling</strong>, med tydelige kontaktmuligheder på de rigtige steder.</li>
<li><strong>Teknisk SEO fra start</strong>: titler, beskrivelser, overskriftsstruktur, sitemap og strukturerede data.</li>
<li><strong>Opsætning og lancering</strong>, så hjemmesiden er live på dit domæne og fungerer, som den skal.</li>
</ul>
<h2 class="serif">Skræddersyet hjemmeside frem for en standardskabelon</h2>
<p>En skabelon er lavet til at passe til mange virksomheder på én gang – og derfor sjældent helt til din. Webdesign til virksomheder handler for mig om at starte med dine kunder: hvad de leder efter, hvilke spørgsmål de har, og hvad der skal til, før de tager kontakt.</p>
<h3>Design, der passer til din virksomhed</h3>
<p>Et visuelt udtryk, der matcher dit brand og dine kunder – fra stilrent og eksklusivt til varmt og personligt.</p>
<h3>Brugeroplevelse</h3>
<p>Tydelig struktur, korte veje til det vigtigste og en oplevelse, der fungerer lige så godt på mobilen som på computeren.</p>
<h3>Bygget til at blive fundet</h3>
<p>Den tekniske SEO er en del af fundamentet. Vil du gå videre med synlighed i både Google og AI-tjenester, kan hjemmesiden kombineres med <a href="/ydelser/seo-aeo-geo">SEO, AEO og GEO</a>.</p>
<h3>Plads til at vokse</h3>
<p>Hjemmesiden kan senere udvides med fx booking, en AI-chatbot eller forbindelser til de systemer, du allerede bruger. Læs mere om <a href="/ydelser/integrationer">digitale integrationer</a>.</p>
<h2 class="serif">Hvor lang tid tager det?</h2>
<p>En hjemmeside er typisk klar inden for 14 dage. Tidsrammen afhænger af projektets kompleksitet – fx antallet af sider, særlige funktioner og hvor meget indhold der skal udarbejdes – men du får altid en klar tidsplan, inden arbejdet går i gang.</p>
<h2 class="serif">Hvad bestemmer prisen?</h2>
<p>Prisen afhænger af, hvad din hjemmeside skal kunne. De vigtigste faktorer er:</p>
<ul>
<li>antallet af sider og hvor meget indhold, der skal udarbejdes,</li>
<li>særlige funktioner som booking, formularer eller en chatbot,</li>
<li>integrationer med eksisterende systemer,</li>
<li>og hvor meget hjælp du ønsker til tekster og billeder.</li>
</ul>
<p>Efter en uforpligtende samtale får du et konkret tilbud, så du kender prisen, før noget går i gang.</p>''')
    + sec('<div class="sec-head rv"><h2 class="serif">Sådan foregår samarbejdet</h2><p>Du har direkte kontakt med mig hele vejen – det er mig, der rådgiver, designer og udvikler. Forløbet bygger på <a href="/metode">min metode</a>: først forstår jeg din virksomhed, derefter bygger jeg løsningen.</p></div><ol class="steps rv">'
          '<li><h3>Samtale og afklaring</h3><p>Du fortæller om din virksomhed, dine kunder og målet med hjemmesiden. Jeg stiller spørgsmål og ser på, hvad du har i dag.</p></li>'
          '<li><h3>Struktur og design</h3><p>Jeg lægger sidestruktur og visuelt udtryk fast, så du kan se retningen tidligt og give feedback.</p></li>'
          '<li><h3>Udvikling</h3><p>Jeg bygger hjemmesiden, tester den på mobil og computer og optimerer den for hastighed.</p></li>'
          '<li><h3>Lancering</h3><p>Jeg sætter domæne og teknisk SEO op og sørger for, at alt virker, når siden går live.</p></li></ol>')
    + sec('<div class="sec-head rv"><h2 class="serif">Sådan kommer du i gang</h2></div><div class="prose rv">'
          '<p>Det første skridt er en uforpligtende samtale. Du fortæller kort om din virksomhed, og hvad du gerne vil have ud af en ny hjemmeside – så vender jeg tilbage inden for 24 timer.</p>'
          '<p><a href="/kontakt">Skriv til mig via kontaktsiden</a>, så ser jeg på, om en ny hjemmeside er det rigtige for dig.</p></div>')
    + sec('<div class="faq-group rv"><h2 class="serif">Spørgsmål om hjemmesider</h2>'
          + "".join(f'<details class="faq"><summary>{q}</summary><div class="ans"><p>{a}</p></div></details>' for q, a in HJ_FAQ)
          + '</div>')
    + related("Kan kombineres med", [
        ("/ydelser/seo-aeo-geo", "SEO, AEO & GEO", Y_INTRO["/ydelser/seo-aeo-geo"]),
        ("/ydelser/integrationer", "Digitale integrationer", Y_INTRO["/ydelser/integrationer"]),
        ("/loesninger/ai-chatbot", "AI-chatbot", "Svar til dine besøgende døgnet rundt – direkte på hjemmesiden."),
    ])
    + ending_html("Skal din næste hjemmeside arbejde for din virksomhed?"),
    crumbs=[("/", "Forside"), ("/ydelser", "Ydelser"), ("/ydelser/hjemmesider", "Hjemmesider")],
    lead="En hjemmeside skal gøre mere end at se godt ud. Jeg udvikler skræddersyede hjemmesider, der præsenterer din virksomhed professionelt og gør det nemmere for besøgende at blive kunder.",
    ld=[service_ld("/ydelser/hjemmesider", "Professionelle hjemmesider til virksomheder",
                   "Skræddersyede hjemmesider til virksomheder med fokus på design, hastighed og flere kundehenvendelser. Typisk klar inden for 14 dage."),
        {"@type": "FAQPage", "mainEntity": [{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in HJ_FAQ]}],
))

add("/ydelser/ai-automatisering", page(
    "/ydelser/ai-automatisering",
    "AI og automatisering for virksomheder | Vanta Studio",
    "Automatisering af gentagne opgaver, bedre kundekommunikation og mere effektiv drift med AI – tilpasset din virksomheds behov og systemer.",
    'AI og automatisering, <span class="grad">der letter hverdagen</span>',
    prose('''
<h2 class="serif">Hvor går tiden?</h2>
<p>I mange virksomheder bliver en stor del af ugen brugt på opgaver, der gentager sig: at svare på de samme spørgsmål, sortere mails, flytte information mellem systemer eller minde kunder om aftaler. Opgaverne er nødvendige – men de kræver sjældent menneskelig vurdering hver gang.</p>
<p>Her kan AI og automatisering frigive tid, så du og dine medarbejdere kan bruge den på kunderne og det arbejde, der kræver jer.</p>
<h2 class="serif">Eksempler på, hvad der kan automatiseres</h2>
<ul>
<li><strong>Kundehenvendelser:</strong> En <a href="/loesninger/ai-chatbot">AI-chatbot</a> besvarer almindelige spørgsmål og hjælper besøgende videre.</li>
<li><strong>Sortering og svarudkast:</strong> Indkomne mails sorteres efter emne, og der laves udkast til svar, som en medarbejder godkender.</li>
<li><strong>Påmindelser:</strong> <a href="/loesninger/bookingpaamindelser">Automatiske beskeder</a> før aftaler.</li>
<li><strong>Opfølgning:</strong> <a href="/loesninger/automatisk-genbooking">Genbooking</a> og <a href="/loesninger/kundeopfoelgning">kundeopfølgning</a>, der holder kontakten ved lige.</li>
<li><strong>Dataflow:</strong> Information, der i dag tastes ind flere steder, overføres automatisk.</li>
</ul>
<h2 class="serif">Mennesket bevarer kontrollen</h2>
<p>Automatisering skal gøre arbejdet lettere – ikke tage beslutninger, den ikke bør tage. Jeg designer løsningerne, så det er tydeligt, hvad der sker automatisk, og hvor en person skal godkende eller tage over.</p>
<p class="note">Hvilke opgaver der kan automatiseres, afhænger af dine arbejdsgange og systemer. Det afklarer jeg sammen med dig, før noget bliver bygget.</p>''')
    + related("Læs videre", [
        ("/loesninger", "Løsninger", "Se de konkrete værktøjer, jeg kan udvikle eller integrere."),
        ("/indsigter/hvad-kan-automatiseres", "Hvilke opgaver kan automatiseres?", "En gennemgang af typiske opgaver – og hvornår det ikke giver mening."),
        ("/ydelser/integrationer", "Digitale integrationer", Y_INTRO["/ydelser/integrationer"]),
    ])
    + ending_html("Hvilke opgaver tager unødvendig tid i din virksomhed?"),
    crumbs=[("/", "Forside"), ("/ydelser", "Ydelser"), ("/ydelser/ai-automatisering", "AI & automatisering")],
    lead=Y_INTRO["/ydelser/ai-automatisering"],
    ld=[service_ld("/ydelser/ai-automatisering", "AI og automatisering", Y_INTRO["/ydelser/ai-automatisering"])],
))

add("/ydelser/seo-aeo-geo", page(
    "/ydelser/seo-aeo-geo",
    "SEO, AEO og GEO – synlighed i Google og AI-søgning | Vanta Studio",
    "Forstå forskellen på SEO, AEO og GEO, og hvordan din virksomhed bliver lettere at finde – både i Google og i AI-tjenester som ChatGPT og Gemini.",
    'Synlig i Google. <span class="grad">Og i AI-svarene.</span>',
    prose('''
<h2 class="serif">Kunderne søger på flere måder end før</h2>
<p>Mange starter stadig på Google. Men flere og flere stiller i dag deres spørgsmål direkte til AI-tjenester som ChatGPT, Google Gemini eller Perplexity – og får et samlet svar i stedet for en liste med links. Derfor arbejder jeg med tre discipliner, der supplerer hinanden.</p>
<h3>SEO – Search Engine Optimization</h3>
<p>Klassisk søgemaskineoptimering. Målet er, at din hjemmeside er teknisk sund, hurtig og har indhold, der svarer på det, dine kunder søger efter – så den har gode forudsætninger for at blive vist i Googles almindelige søgeresultater.</p>
<h3>AEO – Answer Engine Optimization</h3>
<p>Optimering til svar. Her er fokus på, at dit indhold giver klare, direkte svar på konkrete spørgsmål, så søgemaskiner og stemmeassistenter lettere kan bruge det, fx i Googles fremhævede uddrag og spørgsmålsbokse.</p>
<h3>GEO – Generative Engine Optimization</h3>
<p>Optimering til generative AI-tjenester. Her handler det om, at din virksomhed er let at forstå og omtale korrekt for AI-modeller: tydelige beskrivelser af hvad du tilbyder og hvor, ensartede oplysninger på tværs af nettet og indhold, der er struktureret, så det kan citeres.</p>
<h2 class="serif">Hvad jeg konkret arbejder med</h2>
<ul>
<li>Teknisk gennemgang: hastighed, mobilvenlighed, indeksering, sitemap og robots.txt.</li>
<li>Sidestruktur, titler, beskrivelser og overskrifter, der afspejler det, kunderne søger efter.</li>
<li>Indhold, der besvarer kundernes spørgsmål klart – fx FAQ-sider og artikler.</li>
<li>Strukturerede data (schema.org), så maskiner lettere forstår, hvem du er, og hvad du tilbyder.</li>
<li>Ensartede virksomhedsoplysninger, fx på din Google-virksomhedsprofil.</li>
</ul>
<p class="note">Ingen kan love bestemte placeringer i Google eller garantere, at en virksomhed bliver nævnt i AI-svar – søgemaskinerne og AI-tjenesterne bestemmer selv. Det, jeg kan, er at give din virksomhed de bedst mulige forudsætninger.</p>''')
    + related("Læs videre", [
        ("/indsigter/seo-aeo-geo-forskel", "Hvad er forskellen på SEO, AEO og GEO?", "En længere forklaring med eksempler."),
        ("/ydelser/hjemmesider", "Hjemmesider", Y_INTRO["/ydelser/hjemmesider"]),
        ("/faq", "FAQ", "Svar på de mest almindelige spørgsmål."),
    ])
    + ending_html("Skal din virksomhed være lettere at finde?"),
    crumbs=[("/", "Forside"), ("/ydelser", "Ydelser"), ("/ydelser/seo-aeo-geo", "SEO, AEO & GEO")],
    lead=Y_INTRO["/ydelser/seo-aeo-geo"],
    ld=[service_ld("/ydelser/seo-aeo-geo", "SEO, AEO og GEO", Y_INTRO["/ydelser/seo-aeo-geo"])],
))

add("/ydelser/integrationer", page(
    "/ydelser/integrationer",
    "Digitale integrationer mellem systemer | Vanta Studio",
    "Forbind dine eksisterende booking-, kunde- og administrationssystemer med nye funktioner og automatiseringer – i det omfang systemerne tillader det.",
    'Systemer, der <span class="grad">arbejder sammen</span>',
    prose('''
<h2 class="serif">Byg videre på det, du allerede har</h2>
<p>De fleste virksomheder har allerede et bookingsystem, et kundekartotek, en mailudbyder eller et regnskabsprogram. Ofte er problemet ikke systemerne i sig selv, men at de ikke taler sammen – så information må tastes ind flere gange, eller gode muligheder for opfølgning går tabt.</p>
<p>Jeg undersøger, hvordan dine nuværende systemer kan forbindes med nye funktioner, så du ikke nødvendigvis behøver at skifte dem ud. Du skal fx ikke altid skifte bookingsystem for at få <a href="/loesninger/kundeopfoelgning">bedre kundeopfølgning</a>.</p>
<h2 class="serif">Eksempler på integrationer</h2>
<ul>
<li>Bookingdata, der bruges til automatiske påmindelser eller genbooking.</li>
<li>Henvendelser fra hjemmesiden, der lander direkte i dit kundesystem.</li>
<li>En chatbot, der kan slå op i informationer fra dine egne systemer.</li>
<li>Data, der flyttes automatisk mellem to programmer i stedet for manuelt.</li>
</ul>
<h2 class="serif">Det afhænger af systemerne</h2>
<p>Om en integration kan lade sig gøre, afhænger af de tekniske muligheder i de systemer, du bruger – typisk om de har en åben API, eksport eller webhooks, og hvad leverandørens vilkår tillader. Nogle systemer er lette at forbinde, andre giver kun begrænset adgang.</p>
<p class="note">Derfor undersøger jeg altid mulighederne først og fortæller dig ærligt, hvad der kan lade sig gøre, før noget bliver aftalt.</p>''')
    + related("Læs videre", [
        ("/ydelser/ai-automatisering", "AI & automatisering", Y_INTRO["/ydelser/ai-automatisering"]),
        ("/loesninger/automatisk-genbooking", "Automatisk genbooking", "Få tidligere kunder tilbage – ofte bygget på data fra dit bookingsystem."),
        ("/metode", "Metode", "Sådan går jeg fra analyse til løsning."),
    ])
    + ending_html("Hvilke systemer bruger din virksomhed i dag?"),
    crumbs=[("/", "Forside"), ("/ydelser", "Ydelser"), ("/ydelser/integrationer", "Digitale integrationer")],
    lead=Y_INTRO["/ydelser/integrationer"],
    ld=[service_ld("/ydelser/integrationer", "Digitale integrationer", Y_INTRO["/ydelser/integrationer"])],
))

# ---------------------------------------------------------------------------
# Løsninger
# ---------------------------------------------------------------------------
L_INTRO = {
    "/loesninger/ai-chatbot": "En AI-chatbot, der besvarer kundernes spørgsmål døgnet rundt og hjælper dem videre.",
    "/loesninger/automatisk-genbooking": "Påmindelser til tidligere kunder, når det er tid til at booke igen.",
    "/loesninger/bookingpaamindelser": "Automatiske beskeder før aftaler, der kan mindske antallet af udeblivelser.",
    "/loesninger/kundeopfoelgning": "Systematisk opfølgning, der holder kontakten med eksisterende kunder ved lige.",
}


def loesning(path, label, title, desc, h1, problem, cost, how, value, example):
    return page(
        path, title, desc, h1,
        prose(f'''
<h2 class="serif">Problemet</h2>{problem}
<h2 class="serif">Hvad det kan koste</h2>{cost}
<h2 class="serif">Sådan fungerer løsningen</h2>{how}
<h2 class="serif">Den mulige værdi</h2>{value}
<h3>Et eksempel</h3>{example}''')
        + sec('<div class="sec-head rv"><h2 class="serif">Sådan kommer du i gang</h2></div><ol class="steps rv">'
              '<li><h3>Kort samtale</h3><p>Du fortæller, hvordan det fungerer i dag, og hvor det driller.</p></li>'
              '<li><h3>Afklaring</h3><p>Jeg undersøger dine nuværende systemer og vurderer, hvad der realistisk kan lade sig gøre.</p></li>'
              '<li><h3>Forslag</h3><p>Du får et konkret forslag til løsning og tidsplan, før noget går i gang.</p></li>'
              '<li><h3>Opsætning og test</h3><p>Løsningen bygges, testes sammen med dig og justeres, når den er i brug.</p></li></ol>')
        + related("Andre løsninger", [(h, l, L_INTRO[h]) for h, l in LOESNINGER if h != path][:3])
        + ending_html(),
        crumbs=[("/", "Forside"), ("/loesninger", "Løsninger"), (path, label)],
        lead=L_INTRO[path],
        ld=[service_ld(path, label, L_INTRO[path])],
    )


EX = '<p class="note">Eksemplet er tænkt til at illustrere, hvordan løsningen fungerer – det er ikke en dokumenteret kundecase.</p>'

add("/loesninger", page(
    "/loesninger",
    "Løsninger – chatbot, genbooking, påmindelser og opfølgning | Vanta Studio",
    "Konkrete digitale værktøjer, Vanta Studio kan udvikle eller integrere: AI-chatbot, automatisk genbooking, bookingpåmindelser og kundeopfølgning.",
    'Konkrete værktøjer til <span class="grad">konkrete problemer</span>',
    sec('<div class="cards c4">' + "".join(card(h, f"{i + 1:02d}", l, L_INTRO[h]) for i, (h, l) in enumerate(LOESNINGER)) + "</div>")
    + prose('''
<h2 class="serif">Problemet kommer først</h2>
<p>Løsningerne her er eksempler på værktøjer, jeg kan udvikle eller integrere. Hvilke der giver mening for dig, afhænger af, hvor din virksomhed i dag mister tid, kunder eller omsætning. Det finder jeg ud af sammen med dig – se hvordan på siden om <a href="/metode">min metode</a>.</p>
<p>Listen er ikke udtømmende. Er der et konkret behov, kan jeg også udvikle en skræddersyet løsning.</p>''')
    + ending_html(),
    crumbs=[("/", "Forside"), ("/loesninger", "Løsninger")],
    lead="Fire eksempler på digitale værktøjer, der kan spare tid, fastholde kunder og gøre den daglige drift lettere.",
    ld=[{"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "position": i + 1, "url": SITE + h, "name": l} for i, (h, l) in enumerate(LOESNINGER)]}],
))

add("/loesninger/ai-chatbot", loesning(
    "/loesninger/ai-chatbot", "AI-chatbot",
    "AI-chatbot til virksomheder – svar døgnet rundt | Vanta Studio",
    "En AI-chatbot, der besvarer kundernes spørgsmål på din hjemmeside døgnet rundt, guider besøgende og tager imod henvendelser.",
    'En AI-chatbot, der <span class="grad">svarer døgnet rundt</span>',
    "<p>Kunderne har spørgsmål på alle tider af døgnet: Hvad koster det? Har I åbent lørdag? Kan jeg booke online? Mange henvendelser kommer om aftenen, når ingen kan svare – og i åbningstiden bliver de samme spørgsmål besvaret igen og igen.</p>",
    "<p>Når et spørgsmål ikke bliver besvaret med det samme, finder nogle kunder et andet sted at gå hen. Samtidig bruger medarbejderne tid på rutinesvar i stedet for på de kunder, der står foran dem.</p>",
    "<p>Chatbotten bliver placeret på din hjemmeside og får viden om din virksomhed: ydelser, priser, åbningstider og de spørgsmål, kunderne typisk stiller. Den svarer i et naturligt sprog og kan sende besøgende videre til booking, kontaktformular eller telefon.</p><p>Hvis den ikke kender svaret, siger den det – og kan tage imod kundens kontaktoplysninger, så en person kan følge op. Hvor dine systemer giver teknisk adgang, kan den også kobles på fx booking eller kundedata.</p>",
    "<ul><li>Svar til kunderne med det samme – også uden for åbningstiden.</li><li>Færre gentagne spørgsmål i telefonen og indbakken.</li><li>Flere henvendelser, der bliver til bookinger eller kontakt.</li></ul>",
    "<p>Forestil dig en tandklinik, hvor en patient klokken 22 vil vide, om klinikken tager imod akutte patienter, og hvad en tandrens koster. Chatbotten svarer ud fra klinikkens egne oplysninger og viser vej til online booking – i stedet for at patienten venter til næste morgen.</p>" + EX,
))

add("/loesninger/automatisk-genbooking", loesning(
    "/loesninger/automatisk-genbooking", "Automatisk genbooking",
    "Automatisk genbooking – få tidligere kunder tilbage | Vanta Studio",
    "Automatiske påmindelser til tidligere kunder, når det er tid til at booke igen. Til frisører, klinikker og andre virksomheder med tilbagevendende kunder.",
    'Få tidligere kunder <span class="grad">tilbage</span>',
    "<p>Mange virksomheder lever af kunder, der kommer igen: frisøren, tandlægen, fysioterapeuten, værkstedet. Men kunderne glemmer at booke, og i en travl hverdag er der sjældent tid til at holde øje med, hvem der burde være kommet tilbage.</p>",
    "<p>En kunde, der ikke booker igen, er ikke nødvendigvis utilfreds – hun er måske bare ikke blevet mindet om det. Hvert udeblevet genbesøg er tabt omsætning, og det er som regel billigere at fastholde en eksisterende kunde end at finde en ny.</p>",
    "<p>Løsningen holder øje med, hvornår hver kunde sidst var der. Når der er gået den tid, der passer til ydelsen – fx seks uger efter en klipning – får kunden en venlig påmindelse på sms eller mail med et direkte link til at booke.</p><p>Tidspunkt, tekst og kanal tilpasses din virksomhed. Hvor dit bookingsystem giver teknisk adgang, bygges løsningen oven på det, så du ikke behøver at skifte system.</p>",
    "<ul><li>Flere kunder, der kommer igen.</li><li>Færre huller i kalenderen.</li><li>Opfølgning, der sker af sig selv i stedet for at blive glemt.</li></ul>",
    "<p>Forestil dig en frisørsalon, hvor en kunde normalt bliver klippet hver sjette uge. Efter syv uger uden booking får hun en kort besked: <em>“Hej Mette – det er snart tid til en ny klipning. Book her.”</em> Mange vil blot have glemt det og booker med det samme.</p>" + EX,
))

add("/loesninger/bookingpaamindelser", loesning(
    "/loesninger/bookingpaamindelser", "Bookingpåmindelser",
    "Bookingpåmindelser – færre udeblivelser | Vanta Studio",
    "Automatiske sms- og mailpåmindelser før aftaler, der kan mindske udeblivelser og gøre det let for kunderne at flytte eller aflyse i tide.",
    'Færre <span class="grad">tomme tider</span>',
    "<p>Kunder, der glemmer en aftale, efterlader et hul i kalenderen. Det rammer især virksomheder, hvor hver tid er planlagt: klinikker, saloner, behandlere og rådgivere.</p>",
    "<p>En udeblivelse er en tid, der hverken kan sælges eller bruges på en anden kunde. Bliver det til flere om ugen, løber det op – både i omsætning og i frustration.</p>",
    "<p>Før hver aftale sender løsningen automatisk en påmindelse på sms eller mail – fx dagen før. Kunden kan bekræfte, eller nemt flytte og aflyse, så tiden kan gives videre til en anden.</p><p>Tidspunkter og tekster tilpasses din virksomhed. Hvor dit bookingsystem giver teknisk adgang, hentes aftalerne automatisk derfra.</p>",
    "<ul><li>Færre udeblivelser og mindre spildtid.</li><li>Aflysninger i tide, så tiderne kan genbruges.</li><li>En mere professionel kundeoplevelse.</li></ul>",
    "<p>Forestil dig en fysioterapeut, der sender en sms dagen før hver behandling: <em>“Påmindelse: Du har en tid i morgen kl. 10.00. Svar NEJ, hvis du ikke kan komme.”</em> Svarer en kunde nej, kan tiden tilbydes til en på ventelisten.</p>" + EX,
))

add("/loesninger/kundeopfoelgning", loesning(
    "/loesninger/kundeopfoelgning", "Kundeopfølgning",
    "Kundeopfølgning og fastholdelse – automatisk | Vanta Studio",
    "Systematisk og automatisk opfølgning på kunder efter køb eller besøg, så flere vender tilbage, og relationen holdes ved lige.",
    'Hold kontakten <span class="grad">ved lige</span>',
    "<p>Efter et køb eller et besøg hører kunden ofte ikke mere fra virksomheden. Der bliver ikke spurgt til tilfredsheden, ikke bedt om en anmeldelse og ikke fortalt om nye tilbud – ikke af mangel på vilje, men fordi tiden ikke rækker.</p>",
    "<p>Kunder, der ikke hører fra dig, glemmer dig lettere. Samtidig går muligheder tabt: tilfredse kunder, der gerne ville have skrevet en anmeldelse, og utilfredse kunder, du aldrig fik chancen for at hjælpe.</p>",
    "<p>Løsningen sender automatisk de rigtige beskeder på de rigtige tidspunkter: en tak efter besøget, en opfølgning et stykke tid efter, en invitation til at skrive en anmeldelse eller en relevant påmindelse om en ydelse. Hvad der sendes og hvornår, bliver tilpasset din virksomhed og dine kunder.</p><p>Hvor dine systemer giver teknisk adgang, bruges data fra fx bookingsystem eller kundekartotek. Beskederne sendes med respekt for kundernes samtykke og gældende regler for markedsføring.</p>",
    "<ul><li>Flere tilbagevendende kunder.</li><li>Flere anmeldelser fra tilfredse kunder.</li><li>Tidlig mulighed for at rette op på dårlige oplevelser.</li></ul>",
    "<p>Forestil dig et autoværksted, der to dage efter et service sender en kort mail: tak for besøget, et spørgsmål om alt var i orden og et link til at skrive en anmeldelse. Et år senere kommer en påmindelse om, at det er tid til næste service.</p>" + EX,
))

# ---------------------------------------------------------------------------
# Om Vanta
# ---------------------------------------------------------------------------
add("/om-vanta", page(
    "/om-vanta",
    f"Om Vanta Studio – {FOUNDER}",
    f"Vanta Studio er et selvstændigt digitalt bureau, grundlagt og drevet af {FOUNDER}. Du har direkte kontakt med den, der analyserer og bygger din løsning.",
    'Én person. <span class="grad">Hele vejen.</span>',
    prose(f'''
<h2 class="serif">Hvem står bag?</h2>
<p>Vanta Studio er et selvstændigt digitalt bureau, grundlagt og drevet af mig, {FOUNDER}. Jeg hjælper virksomheder med at udnytte deres digitale potentiale gennem hjemmesider, AI, automatisering og skræddersyede løsninger.</p>
<h2 class="serif">Direkte kontakt – fra første samtale til færdig løsning</h2>
<p>Hos Vanta Studio bliver du ikke sendt videre mellem en sælger, en projektleder og en udvikler. Du taler med mig – og det er også mig, der analyserer dine behov, designer og udvikler løsningen. Det giver korte beslutningsveje, og intet går tabt i oversættelsen.</p>
<h2 class="serif">Design og teknologi</h2>
<p>Jeg interesserer mig for skæringspunktet mellem design og teknologi: hjemmesider, der ser gennemarbejdede ud og føles levende, og bagved løsninger, der faktisk gør en forskel i hverdagen – med AI og automatisering, hvor det giver mening.</p>
<h2 class="serif">Min tilgang</h2>
<p>Min tilgang er enkel: Først forstår jeg virksomheden og dens behov. Derefter udvikler jeg de løsninger, der kan skabe størst værdi. Jeg starter ikke med at sælge et bestemt produkt – jeg starter med problemet. Læs mere om <a href="/metode">metoden</a>.</p>''')
    + related("Det kan jeg hjælpe med", [
        ("/ydelser", "Ydelser", "Hjemmesider, AI og automatisering, SEO/AEO/GEO og integrationer."),
        ("/loesninger", "Løsninger", "Konkrete værktøjer som chatbot, genbooking og påmindelser."),
        ("/faq", "FAQ", "Svar på de mest almindelige spørgsmål."),
    ])
    + ending_html("Lad os tage en snak", "Fortæl mig om din virksomhed. Jeg svarer selv – inden for 24 timer."),
    crumbs=[("/", "Forside"), ("/om-vanta", "Om Vanta")],
    lead="Et selvstændigt digitalt bureau med fokus på design, teknologi, AI og automatisering.",
    ld=[{"@type": "AboutPage", "url": SITE + "/om-vanta", "about": {"@id": SITE + "/#org"}},
        {"@type": "Person", "name": FOUNDER, "worksFor": {"@id": SITE + "/#org"}, "jobTitle": "Grundlægger"}],
))

# ---------------------------------------------------------------------------
# FAQ
# ---------------------------------------------------------------------------
FAQ = [
    ("Generelt", [
        ("Hvad er Vanta Studio?",
         [f"Vanta Studio er et digitalt bureau grundlagt og drevet af mig, {FOUNDER}. Jeg hjælper virksomheder med at udnytte deres digitale potentiale gennem hjemmesider, AI, automatiseringer og skræddersyede løsninger.",
          "Min tilgang er enkel: Først forstår jeg virksomheden og dens behov. Derefter udvikler jeg de løsninger, der kan skabe størst værdi."]),
        ("Hvilke virksomheder arbejder du med?",
         ["Jeg arbejder med virksomheder på tværs af brancher. Løsningerne tilpasses den enkelte virksomheds behov, uanset om det handler om en ny hjemmeside, mere effektiv kundehåndtering eller automatisering af arbejdsprocesser."]),
        ("Hvad adskiller Vanta Studio fra andre bureauer?",
         ["Jeg starter ikke med at sælge en bestemt løsning. Jeg undersøger først virksomhedens situation, finder områder med forbedringspotentiale og anbefaler derefter de digitale løsninger, der giver mening.",
          "Og du har direkte kontakt med mig hele vejen – den samme person, som analyserer dine behov og udvikler løsningen."]),
    ]),
    ("Hjemmesider", [
        ("Hvad koster en hjemmeside hos Vanta Studio?",
         ["Prisen afhænger af hjemmesidens omfang og funktioner. Efter en uforpligtende samtale får du et konkret tilbud, så du kender prisen, før noget går i gang."]),
        ("Hvor lang tid tager det at få lavet en hjemmeside?",
         ["En hjemmeside hos Vanta Studio er som udgangspunkt klar inden for 14 dage. Tidsrammen afhænger af projektets omfang, men du får altid en klar tidsplan, inden arbejdet går i gang."]),
        ("Kan I hjælpe min virksomhed med at blive mere synlig online?",
         ["Ja. Jeg arbejder med SEO (Search Engine Optimization), AEO (Answer Engine Optimization) og GEO (Generative Engine Optimization).",
          "Det betyder, at jeg ikke kun fokuserer på synlighed i traditionelle søgemaskiner som Google, men også på at gøre din virksomhed lettere at finde og forstå i AI-baserede søge- og svartjenester som ChatGPT og Google Gemini."]),
    ]),
    ("AI og automatisering", [
        ("Er AI og automatisering kun relevant for store virksomheder?",
         ["Nej. En kunde har værdi, uanset om din virksomhed er stor eller lille. For en mindre virksomhed kan det være mindst lige så vigtigt at fastholde en eksisterende kunde, spare en times administrativt arbejde eller undgå en mistet booking.",
          "Hos Vanta Studio handler det ikke om virksomhedens størrelse, men om at finde løsninger, der giver mening for netop din forretning."]),
        ("Kan løsningerne kobles på de systemer, jeg allerede bruger?",
         ["Ofte, men ikke altid. Det afhænger af de tekniske muligheder i dine nuværende systemer, fx om de giver adgang via en API. Jeg undersøger det altid først og fortæller dig ærligt, hvad der kan lade sig gøre."]),
    ]),
    ("Samarbejde", [
        ("Hvordan kommer jeg i gang?",
         ["Du kontakter mig, og så tager jeg en uforpligtende samtale med dig om din virksomhed. Derefter undersøger jeg, hvor der er muligheder, og du får et konkret forslag med tidsplan, før noget bliver sat i gang."]),
        ("Hvem skal jeg tale med undervejs?",
         ["Med mig. Vanta Studio drives af én person, så du har direkte kontakt med den, der analyserer dine behov og udvikler din løsning – fra første samtale til færdig løsning."]),
    ]),
]

faq_html = ""
faq_ld = []
for group, qs in FAQ:
    head = f'<h2 class="serif">{group}</h2>'
    if not faq_html:
        # Søgefeltet står i højre side på samme linje som første kategori
        head = (f'<div class="faq-head">{head}<div class="faq-search" role="search">'
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
                '<label class="sr-only" for="faq-q">Søg i spørgsmål og svar</label>'
                '<input id="faq-q" type="search" placeholder="Søg i FAQ" autocomplete="off"></div></div>')
    faq_html += f'<div class="faq-group rv">{head}'
    for q, ans in qs:
        faq_html += f'<details class="faq"><summary>{q}</summary><div class="ans">' + "".join(f"<p>{a}</p>" for a in ans) + "</div></details>"
        faq_ld.append({"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": " ".join(ans)}})
    faq_html += "</div>"

add("/faq", page(
    "/faq",
    "FAQ – ofte stillede spørgsmål | Vanta Studio",
    "Svar på de mest almindelige spørgsmål om Vanta Studio: hjemmesider, tidsramme, synlighed med SEO, AEO og GEO, AI, automatisering og samarbejde.",
    'Ofte stillede <span class="grad">spørgsmål</span>',
    sec(faq_html + '<p class="faq-empty" hidden>Ingen spørgsmål matcher din søgning. <a href="/kontakt">Skriv til mig</a>, så svarer jeg direkte.</p>'
        + r'''<script>
(function () {
  var input = document.getElementById("faq-q");
  var items = Array.prototype.slice.call(document.querySelectorAll(".faq"));
  var groups = document.querySelectorAll(".faq-group");
  var empty = document.querySelector(".faq-empty");
  var norm = function (t) { return t.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, ""); };
  items.forEach(function (d) { d.dataset.text = norm(d.textContent); });
  input.addEventListener("input", function () {
    var words = norm(input.value.trim()).split(/\s+/).filter(Boolean);
    var hits = 0;
    var has = function (d, w) { return d.dataset.text.indexOf(w) !== -1; };
    // Først kræves alle ord; giver det intet, vises spørgsmål med mindst ét ord (min. 3 tegn)
    var strict = items.some(function (d) { return words.every(function (w) { return has(d, w); }); });
    items.forEach(function (d) {
      var ok = strict
        ? words.every(function (w) { return has(d, w); })
        : words.some(function (w) { return w.length >= 3 && has(d, w); });
      d.hidden = !ok;
      if (ok) hits++;
      // Åbn svarene, så man kan se, hvad der matcher
      d.open = ok && words.length > 0;
    });
    groups.forEach(function (g) {
      var any = g.querySelector(".faq:not([hidden])");
      g.classList.toggle("is-empty", !any);
    });
    empty.hidden = hits > 0;
  });
})();
</script>''') + ending_html("Fandt du ikke svaret?", "Skriv til mig, så svarer jeg dig direkte – inden for 24 timer."),
    crumbs=[("/", "Forside"), ("/faq", "FAQ")],
    lead="Svar på det, potentielle kunder oftest spørger om – fra pris og tidsramme til AI og samarbejde.",
    actions=False,
    ld=[{"@type": "FAQPage", "mainEntity": faq_ld}],
))

# ---------------------------------------------------------------------------
# Indsigter (artikler)
# ---------------------------------------------------------------------------
ARTICLES = [
    {
        "slug": "seo-aeo-geo-forskel",
        "title": "Hvad er forskellen på SEO, AEO og GEO?",
        "desc": "SEO, AEO og GEO forklaret i et letforståeligt sprog: hvad de tre former for optimering går ud på, hvordan de adskiller sig, og hvad din virksomhed kan gøre.",
        "teaser": "Tre forkortelser, ét mål: at blive fundet. Her er forskellen – og hvad du konkret kan gøre.",
        "date": "2026-10-25",
        "body": '''
<p>Når kunder leder efter en virksomhed som din, foregår det ikke længere kun på Google. Mange spørger i dag en AI-tjeneste som ChatGPT, Google Gemini eller Perplexity og får et samlet svar tilbage. Derfor bliver tre begreber nævnt oftere og oftere: SEO, AEO og GEO. De overlapper, men de har hver deres fokus.</p>
<h2 class="serif">SEO – at blive vist i søgeresultaterne</h2>
<p>SEO (Search Engine Optimization) er den klassiske disciplin. Målet er, at din hjemmeside har gode forudsætninger for at blive vist, når nogen søger på Google eller Bing. Det handler om tre ting:</p>
<ul>
<li><strong>Teknik:</strong> Siden skal være hurtig, fungere på mobilen og kunne læses af søgemaskinerne – med fx sitemap, korrekte titler og ingen døde links.</li>
<li><strong>Indhold:</strong> Siderne skal svare på det, kunderne faktisk søger efter, i et sprog de selv bruger.</li>
<li><strong>Troværdighed:</strong> Links fra andre relevante sider, anmeldelser og en opdateret virksomhedsprofil viser, at virksomheden findes og er til at stole på.</li>
</ul>
<h2 class="serif">AEO – at blive brugt som svar</h2>
<p>AEO (Answer Engine Optimization) handler om at give klare, direkte svar på konkrete spørgsmål. Søgemaskiner viser i stigende grad svaret direkte – i fremhævede uddrag, spørgsmålsbokse eller via stemmeassistenter – i stedet for kun at vise et link.</p>
<p>Indhold, der egner sig til det, stiller ofte spørgsmålet tydeligt og besvarer det i de første sætninger. En velstruktureret FAQ-side er et godt eksempel. Strukturerede data (schema.org) kan desuden hjælpe søgemaskinerne med at forstå, hvad der er spørgsmål, og hvad der er svar.</p>
<h2 class="serif">GEO – at blive forstået af AI</h2>
<p>GEO (Generative Engine Optimization) er det nyeste af de tre. Når en AI-tjeneste formulerer et svar, sammenstykker den information fra mange kilder. GEO handler om at gøre det let for den at forstå og omtale din virksomhed korrekt:</p>
<ul>
<li>Beskriv tydeligt, hvad du tilbyder, til hvem og hvor.</li>
<li>Hold dine virksomhedsoplysninger ens på tværs af hjemmeside, Google-profil og andre steder.</li>
<li>Skriv indhold med konkrete fakta, som kan citeres – frem for vage formuleringer.</li>
<li>Vær til stede de steder, hvor din branche bliver omtalt og anmeldt.</li>
</ul>
<h2 class="serif">Hvordan hænger de sammen?</h2>
<p>De tre discipliner bygger ovenpå hinanden. En teknisk sund hjemmeside med godt indhold (SEO) er fundamentet. Klare svar på konkrete spørgsmål (AEO) gør indholdet lettere at bruge. Og tydelige, ensartede oplysninger om virksomheden (GEO) gør det lettere for AI-tjenester at forstå, hvem du er.</p>
<p>Ingen kan garantere en bestemt placering på Google eller at blive nævnt i et AI-svar – det bestemmer tjenesterne selv. Men du kan give din virksomhed de bedste forudsætninger.</p>
<p>Vil du vide mere om, hvordan jeg arbejder med det, kan du læse om <a href="/ydelser/seo-aeo-geo">SEO, AEO og GEO hos Vanta Studio</a>.</p>''',
    },
    {
        "slug": "hvad-kan-automatiseres",
        "title": "Hvilke arbejdsopgaver kan virksomheder automatisere?",
        "desc": "En praktisk gennemgang af arbejdsopgaver, som mindre og mellemstore virksomheder ofte kan automatisere – og hvornår automatisering ikke giver mening.",
        "teaser": "Fra kundehenvendelser til påmindelser: typiske opgaver, der egner sig til automatisering – og nogle, der ikke gør.",
        "date": "2026-10-25",
        "body": '''
<p>Automatisering lyder ofte som noget for store virksomheder med IT-afdelinger. Men nogle af de opgaver, der egner sig bedst, findes i helt almindelige mindre virksomheder: salonen, klinikken, håndværkeren og rådgiveren. Her er en gennemgang af, hvor man typisk kan starte.</p>
<h2 class="serif">Kendetegn ved en god opgave at automatisere</h2>
<p>En opgave er som regel en god kandidat, hvis den:</p>
<ul>
<li>gentager sig ofte – dagligt eller ugentligt,</li>
<li>følger de samme trin hver gang,</li>
<li>ikke kræver en faglig vurdering hver eneste gang,</li>
<li>og i dag tager tid, som kunne bruges bedre.</li>
</ul>
<h2 class="serif">Fem typiske eksempler</h2>
<h3>1. Svar på de samme spørgsmål</h3>
<p>Åbningstider, priser, parkering, hvordan man booker. En <a href="/loesninger/ai-chatbot">AI-chatbot</a> på hjemmesiden kan besvare de almindelige spørgsmål – også om aftenen – og sende resten videre til en person.</p>
<h3>2. Påmindelser før aftaler</h3>
<p>En automatisk sms eller mail dagen før en aftale er en af de enkleste automatiseringer og kan hjælpe med at mindske udeblivelser. Læs om <a href="/loesninger/bookingpaamindelser">bookingpåmindelser</a>.</p>
<h3>3. Opfølgning og genbooking</h3>
<p>At huske, hvilke kunder der burde være kommet igen, er svært i en travl hverdag. Et system kan holde øje og sende en venlig påmindelse på det rigtige tidspunkt. Se <a href="/loesninger/automatisk-genbooking">automatisk genbooking</a>.</p>
<h3>4. Sortering af henvendelser og svarudkast</h3>
<p>Mails og formularer kan sorteres efter emne og sendes til den rette person, og AI kan lave et udkast til svar, som en medarbejder læser igennem og sender.</p>
<h3>5. Data, der tastes ind flere gange</h3>
<p>Hvis de samme oplysninger skrives ind i både bookingsystem, kundekartotek og regneark, kan en <a href="/ydelser/integrationer">integration</a> ofte flytte dem automatisk – i det omfang systemerne giver adgang til det.</p>
<h2 class="serif">Hvornår giver det ikke mening?</h2>
<p>Automatisering er ikke altid svaret. Opgaver, der sjældent forekommer, ændrer sig hele tiden eller kræver personlig vurdering og empati, er ofte bedst løst af et menneske. Og hvis en arbejdsgang i forvejen er rodet, bliver den ikke bedre af at blive automatiseret – så skal den først gøres enklere.</p>
<h2 class="serif">Hvor skal man starte?</h2>
<p>Start med at notere, hvad der tager tid i en almindelig uge, og hvor kunder falder fra. Ofte er der én eller to opgaver, der giver mest værdi at løse først. Det er også her, jeg selv starter – læs mere om <a href="/metode">metoden</a> eller om <a href="/ydelser/ai-automatisering">AI og automatisering</a>.</p>''',
    },
]

for a in ARTICLES:
    path = "/indsigter/" + a["slug"]
    add(path, page(
        path, a["title"] + " | Vanta Studio", a["desc"], a["title"],
        sec(f'<article class="prose rv">{a["body"]}</article>')
        + ending_html("Vil du vide, hvad det kan betyde for din virksomhed?"),
        crumbs=[("/", "Forside"), ("/indsigter", "Indsigter"), (path, a["title"])],
        lead=a["teaser"] + f'</p><p class="art-meta">Af {FOUNDER} · <time datetime="{a["date"]}">25. oktober 2026</time>',
        actions=False,
        og_type="article",
        ld=[{"@type": "Article", "headline": a["title"], "description": a["desc"], "datePublished": a["date"],
             "dateModified": a["date"], "inLanguage": "da", "image": OG_IMAGE, "mainEntityOfPage": SITE + path,
             "author": {"@type": "Person", "name": FOUNDER}, "publisher": {"@id": SITE + "/#org"}}],
    ))

posts = "".join(
    f'<a class="post rv" href="/indsigter/{a["slug"]}"><time datetime="{a["date"]}">25. oktober 2026</time><h2>{a["title"]}</h2><p>{a["teaser"]}</p></a>'
    for a in ARTICLES)
add("/indsigter", page(
    "/indsigter",
    "Indsigter – artikler om hjemmesider, SEO og AI | Vanta Studio",
    "Artikler og viden om hjemmesider, synlighed i Google og AI-søgning, AI-chatbots og automatisering for virksomheder.",
    'Indsigter',
    sec(f'<div class="posts">{posts}</div>')
    + ending_html(),
    crumbs=[("/", "Forside"), ("/indsigter", "Indsigter")],
    lead="Viden om hjemmesider, synlighed, AI og automatisering – skrevet til virksomhedsejere, ikke teknikere.",
    actions=False,
    ld=[{"@type": "Blog", "name": "Indsigter", "url": SITE + "/indsigter", "publisher": {"@id": SITE + "/#org"},
         "blogPost": [{"@type": "BlogPosting", "headline": a["title"], "url": SITE + "/indsigter/" + a["slug"]} for a in ARTICLES]}],
))


# ---------------------------------------------------------------------------
# Skriv filer
# ---------------------------------------------------------------------------
def out_file(path):
    # /ydelser -> ydelser/index.html ; /ydelser/hjemmesider -> ydelser/hjemmesider.html
    parts = path.strip("/").split("/")
    if len(parts) == 1:
        if parts[0] in ("ydelser", "loesninger", "indsigter"):
            return os.path.join(ROOT, parts[0], "index.html")
        return os.path.join(ROOT, parts[0] + ".html")
    return os.path.join(ROOT, *parts[:-1], parts[-1] + ".html")


for path, html in PAGES.items():
    f = out_file(path)
    os.makedirs(os.path.dirname(f), exist_ok=True)
    with open(f, "w", encoding="utf-8") as fh:
        fh.write(html)

# Menuen sættes ind i de håndskrevne sider mellem markørerne <!-- vm:menu --> … <!-- /vm:menu -->
for fname, path in (("index.html", "/"), ("metode.html", "/metode"), ("kontakt.html", "/kontakt")):
    fp = os.path.join(ROOT, fname)
    s = open(fp, encoding="utf-8").read()
    block = f"<!-- vm:menu -->\n{menu_html(path)}\n<!-- /vm:menu -->"
    s, n = re.subn(r"<!-- vm:menu -->.*?<!-- /vm:menu -->", lambda m: block, s, flags=re.S)
    if n != 1:
        raise SystemExit(f"Mangler menu-markør i {fname}")
    open(fp, "w", encoding="utf-8").write(s)

# OG-tags og strukturerede data i de håndskrevne sider (mellem <!-- vm:seo --> … <!-- /vm:seo -->)
HAND = {
    "index.html": ("/", "Vanta Studio – Design og teknologi der skaber vækst",
                   "Vanta Studio udvikler hjemmesider, AI-løsninger og automatiseringer, der sparer tid, reducerer omkostninger og øger omsætningen.",
                   [{"@type": "WebSite", "@id": SITE + "/#site", "url": SITE + "/", "name": BRAND, "inLanguage": "da", "publisher": {"@id": SITE + "/#org"}}]),
    "metode.html": ("/metode", "Metode – fra analyse til løsning | Vanta Studio",
                    "Jeg starter ikke med løsningen. Jeg starter med problemet. Sådan går Vanta Studio fra analyse til hjemmesider, AI og automatisering.",
                    [crumbs_ld([("/", "Forside"), ("/metode", "Metode")])]),
    "kontakt.html": ("/kontakt", "Kontakt – start et projekt | Vanta Studio",
                     "Fortæl kort om din virksomhed, så vender Vanta Studio tilbage inden for 24 timer.",
                     [{"@type": "ContactPage", "url": SITE + "/kontakt", "about": {"@id": SITE + "/#org"}}]),
}
for fname, (path, title, desc, extra) in HAND.items():
    fp = os.path.join(ROOT, fname)
    s = open(fp, encoding="utf-8").read()
    url = SITE + path
    ldjson = json.dumps({"@context": "https://schema.org", "@graph": [dict(ORG)] + extra}, ensure_ascii=False, indent=1)
    block = f"""<!-- vm:seo -->
<meta property="og:type" content="website">
<meta property="og:locale" content="da_DK">
<meta property="og:site_name" content="{BRAND}">
<meta property="og:title" content="{escape(title)}">
<meta property="og:description" content="{escape(desc)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">
{ldjson}
</script>
<!-- /vm:seo -->"""
    s, n = re.subn(r"<!-- vm:seo -->.*?<!-- /vm:seo -->", lambda m: block, s, flags=re.S)
    if n != 1:
        raise SystemExit(f"Mangler seo-markør i {fname}")
    open(fp, "w", encoding="utf-8").write(s)

# Sitemap
public = ["/", "/ydelser"] + [h for h, _ in YDELSER] + ["/loesninger"] + [h for h, _ in LOESNINGER] + \
         ["/metode", "/om-vanta", "/faq", "/indsigter"] + ["/indsigter/" + a["slug"] for a in ARTICLES] + ["/kontakt"]
sm = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
for p in public:
    sm.append(f"  <url>\n    <loc>{SITE}{p}</loc>\n    <lastmod>{UPDATED}</lastmod>\n  </url>")
sm.append("</urlset>\n")
open(os.path.join(ROOT, "sitemap.xml"), "w").write("\n".join(sm))

print(f"Skrev {len(PAGES)} sider + sitemap med {len(public)} URL'er")
