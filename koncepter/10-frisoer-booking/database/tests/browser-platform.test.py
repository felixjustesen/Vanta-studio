"""Browsertest af forbindelsen til Vanta Platform (fanen Integrationer og bookingsiden)
mod den lokale testserver og den falske platform (platform-mock.mjs).

Start først:  node server.mjs
Kør derefter: python3 browser-platform.test.py
"""
import json, os, re, sys, urllib.request
from playwright.sync_api import sync_playwright

SITE10 = "http://127.0.0.1:8790/koncepter/10-frisoer-booking"
SITE08 = "http://127.0.0.1:8790/koncepter/08-skarp"
API = "http://127.0.0.1:8791"
KEY = "vk_live_" + "Ab12" * 10 + "xyz"
KEY2 = "vk_live_" + "Zz9_" * 10 + "abc"
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


def tick():
    return api("/__test/platform-tick")


def received(mode=None):
    return api("/__test/platform" + (f"?mode={mode}" if mode else ""))


def new_page(browser, mobile=False):
    opts = dict(locale="da-DK", timezone_id="Europe/Copenhagen")
    if mobile:
        opts.update(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    else:
        opts.update(viewport={"width": 1280, "height": 900})
    ctx = browser.new_context(**opts)
    ctx.route(re.compile(r"https://[a-z0-9]+\.supabase\.co/.*"), lambda r: r.abort())
    ctx.add_init_script("window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+e.blockedURI));")
    page = ctx.new_page()
    page.errors, page.external, page.bodies = [], [], []
    page.on("console", lambda m: m.type == "error" and page.errors.append(m.text))
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("request", lambda r: not r.url.startswith(("http://127.0.0.1", "data:")) and page.external.append(r.url))
    page.on("response", lambda r: "/rest/v1/rpc/" in r.url and page.bodies.append((r.url, r)))
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


def login(page, site, email, password):
    page.goto(site + "/admin")
    page.wait_for_selector("#login-email")
    page.fill("#login-email", email)
    page.fill("#login-password", password)
    page.click("button[type=submit]")
    page.wait_for_selector(".tabs")


def open_integrations(page):
    page.click("#tab-integrationer")
    page.wait_for_selector("#pl-url")


def toast(page, text):
    page.wait_for_selector(f".toast >> text={text}")


def book(page, site, name, email, phone):
    page.goto(site + "/book")
    page.wait_for_selector("#service-options .option")
    page.locator("#service-options .option").first.click()
    page.click("#next")
    page.wait_for_selector(".slot input", state="attached")
    page.locator(".slot").first.click()
    page.click("#next")
    page.fill("#f-name", name); page.fill("#f-email", email); page.fill("#f-phone", phone)
    page.click("#next")
    page.wait_for_selector("#t-review:visible")
    fine = page.inner_text("#review-body .fine")
    page.click("#next")
    page.wait_for_selector("#receipt h1")
    return fine


with sync_playwright() as p:
    browser = p.chromium.launch()
    api("/__test/reset?migrate=10")

    print("1) Ejeren forbinder bookingsystemet med platformen")
    ctx, page = new_page(browser)
    login(page, SITE10, "admin@test.dk", "Hemmelig-123")
    check("fanen Integrationer vises for ejeren", page.is_visible("#tab-integrationer"))
    open_integrations(page)
    check("ikke forbundet fra start", "Ikke forbundet" in page.inner_text("#panel"))
    check("ingen status før forbindelsen er sat op", page.locator("#panel .details").count() == 0)
    page.check("#panel .check input >> nth=0")
    page.click("button[type=submit]")
    page.wait_for_selector("#panel [role=alert] .notice--error")
    check("kan ikke slås til uden adresse", "Udfyld platformens adresse" in page.inner_text("#panel [role=alert]"))
    page.fill("#pl-url", "http://platform.test")
    page.click("button[type=submit]")
    check("adresse uden https afvises", "fx https://app.vantastudio.dk" in page.inner_text("#panel [role=alert]"))
    page.fill("#pl-url", "https://platform.test")
    page.fill("#pl-key", "forkert-nøgle")
    page.click("button[type=submit]")
    check("forkert nøgle afvises", "starte med vk_live_" in page.inner_text("#panel [role=alert]"))
    check("intet gemt efter afviste forsøg", sql("select enabled from salon_private.platform_settings")[0]["enabled"] is False)
    page.fill("#pl-key", KEY)
    page.bodies.clear()
    page.click("button[type=submit]")
    toast(page, "Forbindelsen er slået til")
    page.wait_for_selector("#panel .notice--ok")
    check("status: forbundet", "Forbundet" in page.inner_text("#panel .notice--ok"))
    check("nøglefeltet er tømt, gemt nøgle vises som begyndelse", page.input_value("#pl-key") == "" and KEY[:14] in page.get_attribute("#pl-key", "placeholder"))
    saved = [r for u, r in page.bodies if u.endswith("/save_platform_link")]
    check("svaret fra databasen indeholder ikke nøglen", saved and KEY not in saved[0].text(), str(len(saved)))
    check("nøglen står ingen steder på siden", KEY not in page.content())
    check("status vises", "Sidst sendt" in page.inner_text("#panel .details") and "Endnu ikke" in page.inner_text("#panel .details"))
    check("send alle igen kan vælges", page.is_visible("text=Send alle bookinger igen"))
    no_overflow(page, "integrationer computer")
    shot(page, "platform-01-forbundet", full=True)
    clean(page, "integrationer")
    ctx.close()

    print("2) En kunde booker – bookingen når frem til platformen")
    ctx, page = new_page(browser, mobile=True)
    fine = book(page, SITE10, "Karla Kunde", "Karla@Example.com", "12 34 56 78")
    check("bookingsiden fortæller, at oplysningerne gemmes i kundesystemet", "gemmes i salonens kundesystem" in fine, fine)
    check("kvittering som før", "Tak, Karla." in page.inner_text("#receipt"))
    clean(page, "booking")
    ctx.close()
    booking_id = sql("select id from public.appointments where full_name = 'Karla Kunde'")[0]["id"]
    t = tick()
    got = [r for r in received() if r["item"] and r["item"]["external_id"] == booking_id]
    check("bookingen er sendt til platformen", len(got) == 1 and got[0]["status"] == 200, json.dumps(t))
    if got:
        item = got[0]["item"]
        check("med nøglen, kilden og en Idempotency-Key", got[0]["authorization"] == f"Bearer {KEY}" and got[0]["source"] == "vanta_booking" and got[0]["key"].startswith("vb-2-"), json.dumps(got[0])[:200])
        check("med kundens oplysninger", item["customer"] == {"first_name": "Karla", "last_name": "Kunde", "email": "karla@example.com", "phone": "12 34 56 78"}, json.dumps(item["customer"]))
        check("som booked med behandling og frisør", item["status"] == "booked" and item["service_name"] and item["staff_name"] and item["currency"] == "DKK")

    print("3) Ejeren følger med og markerer besøget som gennemført")
    ctx, page = new_page(browser)
    login(page, SITE10, "admin@test.dk", "Hemmelig-123")
    open_integrations(page)
    details = page.inner_text("#panel .details")
    check("sidst sendt vises med tidspunkt", "Endnu ikke" not in details and re.search(r"kl\. \d\d\.\d\d", details), details)
    check("intet i kø, én sendt", re.search(r"Venter på at blive sendt\s+0", details) and re.search(r"Sendt\s+1", details), details)
    page.click("#tab-bookinger")
    page.wait_for_selector(".booking-card")
    page.locator(".booking-card", has_text="Karla Kunde").locator("select").first.select_option("completed")
    toast(page, "Status ændret til Gennemført")
    tick()
    last = [r for r in received() if r["item"] and r["item"]["external_id"] == booking_id][-1]
    check("gennemført sendes som completed", last["item"]["status"] == "completed" and last["status"] == 200)

    print("4) Nøglen afvises – ejeren indsætter en ny")
    received("unauthorized")
    page.locator(".booking-card", has_text="Karla Kunde").locator("select").first.select_option("confirmed")
    toast(page, "Status ændret til Bekræftet")
    tick()
    open_integrations(page)
    page.wait_for_selector("#panel .notice--error")
    check("fejlen vises tydeligt", "afviste API-nøglen" in page.inner_text("#panel .notice--error"))
    check("bookingen venter", re.search(r"Venter på at blive sendt\s+1", page.inner_text("#panel .details")), page.inner_text("#panel .details"))
    shot(page, "platform-02-noegle-afvist", full=True)
    received("ok")
    page.fill("#pl-key", KEY2)
    page.click("button[type=submit]")
    toast(page, "Integrationen er gemt")
    page.wait_for_selector("#panel .notice--ok")
    check("fejlen er væk efter ny nøgle", page.locator("#panel .notice--error").count() == 0)
    check("den nye nøgle vises som begyndelse", KEY2[:14] in page.get_attribute("#pl-key", "placeholder"))
    tick(); tick()
    last = [r for r in received() if r["item"] and r["item"]["external_id"] == booking_id][-1]
    check("sendt med den nye nøgle", last["authorization"] == f"Bearer {KEY2}" and last["status"] == 200 and last["item"]["status"] == "booked")

    print("5) Platformen afviser en booking")
    received("reject-phone")
    page.click("#tab-bookinger")
    page.wait_for_selector(".booking-card")
    page.locator(".booking-card", has_text="Karla Kunde").locator("select").first.select_option("completed")
    toast(page, "Status ændret til Gennemført")
    tick()
    received("ok")
    open_integrations(page)
    page.wait_for_selector("#panel .notice--warn")
    warn = page.inner_text("#panel .notice--warn")
    ref = booking_id[:8].upper()
    check("afvist booking vises med navn, bookingnr. og årsag", "Karla Kunde" in warn and ref in warn and "telefonnummeret" in warn, warn)
    check("forbindelsen er stadig ok", page.locator("#panel .notice--ok").count() == 1)
    page.click("text=Send alle bookinger igen")
    page.wait_for_selector("dialog.dialog[open]")
    page.click("dialog.dialog button[value=ok]")
    toast(page, "Alle bookinger sendes igen")
    tick()
    page.click("text=Opdatér status")
    page.wait_for_selector("#panel .details")
    check("efter send igen: intet afvist", page.locator("#panel .notice--warn").count() == 0, page.inner_text("#panel"))

    print("6) Gennemførte besøg og slå fra")
    page.check("#panel .check input >> nth=1")
    page.click("button[type=submit]")
    toast(page, "Integrationen er gemt")
    check("gennemførte besøg gemt", sql("select auto_complete from salon_private.platform_settings")[0]["auto_complete"] is True)
    page.uncheck("#panel .check input >> nth=0")
    page.click("button[type=submit]")
    page.wait_for_selector("#panel .notice >> text=Forbindelsen er slået fra")
    check("slået fra vises", "slået fra" in page.inner_text("#panel .notice"))
    check("send alle igen skjules, når den er slået fra", page.locator("text=Send alle bookinger igen").count() == 0)
    clean(page, "administration")
    ctx.close()

    ctx, page = new_page(browser, mobile=True)
    fine = book(page, SITE10, "Bo Uden", "bo@example.com", "87 65 43 21")
    check("slået fra: bookingsiden nævner ikke kundesystemet", "bruges kun til at håndtere bookingen" in fine, fine)
    ctx.close()
    check("slået fra: intet sendt", not [r for r in received() if r["item"] and r["item"]["customer"].get("first_name") == "Bo"])

    sql("update salon_private.platform_settings set enabled = true")
    ctx, page = new_page(browser, mobile=True)
    login(page, SITE10, "admin@test.dk", "Hemmelig-123")
    open_integrations(page)
    no_overflow(page, "integrationer mobil")
    shot(page, "platform-03-integrationer-mobil", full=True)
    clean(page, "integrationer mobil")
    ctx.close()

    print("7) Frisøren og SKARP")
    ctx, page = new_page(browser)
    login(page, SITE10, "frisoer@test.dk", "Hemmelig-789")
    check("frisøren ser ikke Integrationer", page.locator("#tab-integrationer").count() == 0)
    ctx.close()
    ctx, page = new_page(browser)
    login(page, SITE08, "admin@test.dk", "Hemmelig-123")
    check("SKARP-administrationen har også Integrationer", page.is_visible("#tab-integrationer"))
    open_integrations(page)
    check("SKARP viser samme forbindelse", "Forbundet" in page.inner_text("#panel"))
    clean(page, "SKARP-administration")
    ctx.close()
    ctx, page = new_page(browser)
    page.goto(SITE08 + "/book")
    page.wait_for_selector("#service-options .option")
    page.wait_for_timeout(300)
    check("SKARP-demoen spørger ikke om forbindelsen", not [u for u, r in page.bodies if u.endswith("/platform_link_enabled")])
    ctx.close()

    print("8) Uden migration 10 (som i dag)")
    api("/__test/reset?migrate=6")
    ctx, page = new_page(browser)
    login(page, SITE10, "admin@test.dk", "Hemmelig-123")
    page.wait_for_selector(".booking-list, .notice")
    check("ingen Integrationer-fane uden migration 10", page.locator("#tab-integrationer").count() == 0)
    clean(page, "administration uden migration 10")
    ctx.close()
    ctx, page = new_page(browser, mobile=True)
    fine = book(page, SITE10, "Ida Før", "ida@example.com", "11 22 33 44")
    check("uden migration 10: bookingen virker med den kendte tekst", "bruges kun til at håndtere bookingen" in fine, fine)
    errs = [e for e in page.errors if "Failed to load resource" not in e]
    check("uden migration 10: ingen JS-fejl på bookingsiden", not errs, "; ".join(errs[:3]))
    ctx.close()

    api("/__test/reset")
    browser.close()

print(f"\n{passed} bestået, {len(failures)} fejlet")
for f in failures:
    print("  ✗", f)
sys.exit(1 if failures else 0)
