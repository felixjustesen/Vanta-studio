"""Browsertest af SKARP (koncept 08) mod den lokale testserver.

Start først:  node server.mjs
Kør derefter: python3 browser-skarp.test.py
"""
import json, os, re, sys, urllib.request
from playwright.sync_api import sync_playwright

SITE = "http://127.0.0.1:8790/koncepter/08-skarp"
API = "http://127.0.0.1:8791"
SHOTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".screenshots")
os.makedirs(SHOTS, exist_ok=True)

passed, failures = 0, []


def check(name, cond, detail=""):
    global passed
    if cond:
        passed += 1
    else:
        failures.append(f"{name} – {detail}" if detail else name)
        print("  ✗", name, detail)


def api(path, body=None):
    req = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or "null")


def sql(q):
    return api("/__test/sql", {"sql": q})


def new_page(browser, mobile=False, real_booking=False):
    opts = dict(locale="da-DK", timezone_id="Europe/Copenhagen")
    if mobile:
        opts.update(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    else:
        opts.update(viewport={"width": 1440, "height": 900})
    ctx = browser.new_context(**opts)
    ctx.route(re.compile(r"https://[a-z0-9]+\.supabase\.co/.*"), lambda r: r.abort())
    ctx.route(re.compile(r"https://fonts\.(googleapis|gstatic)\.com/.*"), lambda r: r.abort())
    ctx.add_init_script("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));")
    if real_booking:
        def real(route):
            body = route.fetch().text().replace("DEMO_ONLY = true", "DEMO_ONLY = false")
            route.fulfill(body=body, content_type="text/javascript")
        ctx.route("**/08-skarp/assets/config.js", real)
    page = ctx.new_page()
    page.errors, page.external = [], []
    page.on("console", lambda m: m.type == "error" and page.errors.append(m.text))
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("request", lambda r: not r.url.startswith(("http://127.0.0.1", "data:")) and page.external.append(r.url))
    return ctx, page


def clean(page, label):
    errs = [e for e in page.errors if "Failed to load resource" not in e]
    check(f"{label}: ingen JS-fejl", not errs, "; ".join(errs[:3]))
    csp = page.evaluate("window.__csp")
    check(f"{label}: ingen CSP-blokeringer", not csp, "; ".join(csp[:3]))
    check(f"{label}: ingen kald til eksterne servere", not page.external, "; ".join(page.external[:3]))


def no_overflow(page, label):
    w = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    check(f"{label}: ingen vandret scroll", w[0] <= w[1], str(w))


def shot(page, name, full=True):
    page.screenshot(path=os.path.join(SHOTS, name + ".png"), full_page=full, animations="disabled")


with sync_playwright() as p:
    browser = p.chromium.launch()
    api("/__test/reset?demo=skarp")

    print("1) Forside – computer")
    ctx, page = new_page(browser)
    page.goto(SITE)
    page.wait_for_selector("#team .crew__item")
    check("logo med salonnavn", page.inner_text(".logo b") == "SKARP")
    check("film med poster", page.locator(".film video source[src$='skarp.mp4']").count() == 1)
    names = page.locator("#services .menu__name").all_inner_texts()
    check("barbershop-behandlinger fra databasen", sorted(n.lower() for n in names) == ["barbering", "klip", "klip og skæg", "skin fade", "skæg"], str(names))
    prices = page.inner_text("#services").replace(" ", " ")
    check("priser i kroner", "295 kr." in prices.lower() and "445 kr." in prices.lower(), prices[:120])
    check("demopriser markeret", page.locator("#services .tag--demo").count() == 5)
    check("hero: laveste pris fra databasen", page.inner_text("#from-price").replace(" ", " ").lower() == "behandlinger fra 195 kr.")
    check("hero: dagens åbningstid", re.search(r"(åbent i dag \d\d\.\d\d–\d\d\.\d\d|lukket i dag)", page.inner_text("#today").lower()) is not None, page.inner_text("#today"))
    check("hero: adresse fra databasen", "vesterbro" in page.inner_text(".foot .addr").lower())
    check("barbererne vises", page.locator("#team .crew__name").all_inner_texts() == ["Anna", "Mikkel", "Sara"])
    check("Book hos-link", page.locator("#team a[href*='/book?frisoer=']").count() == 3)
    check("Book pr. behandling", page.locator("#services a[href*='/book?behandling=']").count() == 5)
    check("menupunkter peger på sektioner", page.locator(".links a[href='#priser']").count() == 1 and page.is_visible(".links a[href='#barberer']"))
    check("demobjælke", page.is_visible("#demo-bar"))
    check("om-tekst fra databasen", "barber" in page.inner_text("#about-text").lower())
    check("åbningstider: 7 dage", page.locator("#hours li").count() == 7)
    check("demo-telefon er ikke et link", page.locator('#contact a[href^="tel:"]').count() == 0)
    page.click(".pause")
    check("filmen kan sættes på pause", page.get_attribute(".pause", "aria-pressed") == "true")
    check("skrifttyper hentes lokalt", page.evaluate("document.fonts.check('16px \"Bebas Neue\"') && document.fonts.check('16px Manrope')"))
    hero = page.evaluate("(() => { const r = document.querySelector('.hero').getBoundingClientRect(); return [Math.round(r.bottom), innerHeight]; })()")
    check("heroen fylder præcis skærmen under demobjælken", abs(hero[0] - hero[1]) <= 1, str(hero))
    no_overflow(page, "forside computer")
    clean(page, "forside computer")
    shot(page, "skarp-01-forside-computer")
    ctx.close()

    print("2) Forside – mobil")
    ctx, page = new_page(browser, mobile=True)
    page.goto(SITE)
    page.wait_for_selector("#team .crew__item")
    no_overflow(page, "forside mobil")
    check("menuknap synlig, links skjult", page.is_visible(".burger") and not page.is_visible(".links"))
    page.click(".burger")
    check("mobilmenu åbner", page.get_attribute(".burger", "aria-expanded") == "true" and page.is_visible("#sheet a[href='#priser']"))
    page.click("#sheet a[href='#priser']")
    check("mobilmenu lukker ved valg", page.get_attribute(".burger", "aria-expanded") == "false")
    clean(page, "forside mobil")
    page.evaluate("window.scrollTo(0,0)")
    shot(page, "skarp-02-forside-mobil")
    ctx.close()

    print("3) Booking – demo, intet sendes")
    ctx, page = new_page(browser, mobile=True)
    page.goto(SITE + "/book")
    page.wait_for_selector("#service-options .option")
    check("demo: bjælken siger, at bookinger ikke sendes", "ikke sendt" in page.inner_text("#demo-bar"))
    page.click("#service-options .option:has-text('Klip og skæg')")
    page.click("#next")
    page.wait_for_selector(".slot input", state="attached")
    page.locator(".slot").first.click()
    page.click("#next")
    page.fill("#f-name", "Demo Person"); page.fill("#f-email", "demo@example.com"); page.fill("#f-phone", "11 22 33 44")
    page.click("#next")
    page.wait_for_selector("#t-review:visible")
    check("demo: gennemse siger, at intet sendes", "ikke sendt nogen booking" in page.inner_text("#review-body"))
    page.click("#next")
    page.wait_for_selector("#receipt h1")
    check("demo: demokvittering", page.inner_text("#receipt h1") == "Sådan ser det ud, når en kunde booker" and page.inner_text("#receipt .badge") == "Demo")
    check("demo: intet gemt i databasen", sql("select count(*)::int as n from public.appointments where full_name = 'Demo Person'")[0]["n"] == 0)
    check("demo: ingen bookingkald", not any("create_booking" in u for u in page.evaluate("performance.getEntriesByType('resource').map(e => e.name)")))
    no_overflow(page, "demo mobil")
    clean(page, "demo mobil")
    shot(page, "skarp-03-demo-kvittering-mobil")
    ctx.close()

    print("3b) Booking – rigtig booking (DEMO_ONLY slået fra)")
    ctx, page = new_page(browser, mobile=True, real_booking=True)
    page.goto(SITE + "/book")
    page.wait_for_selector("#service-options .option")
    check("bookingsiden har SKARP-udtryk", page.evaluate("getComputedStyle(document.body).backgroundColor") == "rgb(15, 11, 9)")
    page.click("#service-options .option:has-text('Skin fade')")
    page.click("#next")
    page.wait_for_selector(".slot input", state="attached")
    chips = [c.split("\n")[-1] for c in page.locator("#staff-options .staff-chip").all_inner_texts()]
    check("skin fade: Anna og Mikkel kan vælges", chips == ["Første ledige", "Anna", "Mikkel"], str(chips))
    page.locator(".staff-chip", has_text="Mikkel").click()
    page.wait_for_load_state("networkidle")
    page.wait_for_selector(".slot input", state="attached")
    sel = page.locator(".cal__day.is-selected")
    check("valgt dag er tydelig", page.evaluate("(el) => getComputedStyle(el).backgroundColor", sel.element_handle()) == "rgb(201, 138, 91)")
    page.locator(".slot").first.click()
    shot(page, "skarp-03-booking-tid-mobil")
    page.click("#next")
    page.fill("#f-name", "Kasper Holm"); page.fill("#f-email", "kasper@example.com"); page.fill("#f-phone", "12 34 56 78")
    page.click("#next")
    page.wait_for_selector("#t-review:visible")
    check("gennemse viser Mikkel", "Mikkel" in page.inner_text("#review-body"))
    page.click("#next")
    page.wait_for_selector("#receipt h1")
    receipt = page.inner_text("#receipt")
    check("kvittering: modtaget og afventer", "Tak, Kasper." in receipt and page.inner_text("#receipt .badge") == "Afventer")
    check("kvittering: Mikkel", "Mikkel" in receipt)
    check("booking gemt hos Mikkel", sql("select st.name from public.appointments a join public.staff st on st.id = a.staff_id where a.full_name = 'Kasper Holm'")[0]["name"] == "Mikkel")
    no_overflow(page, "booking mobil")
    clean(page, "booking mobil")
    shot(page, "skarp-04-kvittering-mobil")
    ctx.close()

    print("4) Administration")
    for mobile in (False, True):
        label = "mobil" if mobile else "computer"
        ctx, page = new_page(browser, mobile=mobile)
        page.goto(SITE + "/admin")
        page.wait_for_selector("#login-email")
        page.fill("#login-email", "admin@test.dk"); page.fill("#login-password", "Hemmelig-123")
        page.click("button[type=submit]")
        page.wait_for_selector(".booking-card")
        check(f"admin {label}: SKARP i sidehovedet", "SKARP" in page.inner_text(".admin-header"))
        check(f"admin {label}: bookingen fra trin 3", "Kasper Holm" in page.inner_text(".booking-list"))
        for tab in ["dagsplan", "frisoerer", "fravaer", "behandlinger", "aabningstider", "lukkedage", "indstillinger"]:
            page.click(f"#tab-{tab}")
            page.wait_for_timeout(500)
        no_overflow(page, f"admin {label}")
        clean(page, f"admin {label}")
        shot(page, f"skarp-05-admin-{label}", full=False)
        ctx.close()

    ctx, page = new_page(browser)
    page.goto(SITE + "/admin")
    page.wait_for_selector("#login-email")
    page.fill("#login-email", "frisoer@test.dk"); page.fill("#login-password", "Hemmelig-789")
    page.click("button[type=submit]")
    page.wait_for_selector(".booking-card, .notice")
    check("frisørlogin: kun egne bookinger", page.locator(".booking-card__name").all_inner_texts() == ["Kasper Holm"])
    clean(page, "frisørlogin")
    ctx.close()

    api("/__test/reset")
    browser.close()

print(f"\n{passed} bestået, {len(failures)} fejlet")
for f in failures:
    print("  ✗", f)
sys.exit(1 if failures else 0)
