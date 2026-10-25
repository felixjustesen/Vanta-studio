// Vanta Studio – modtager henvendelser fra formularerne og sender dem via Resend.
// Kræver miljøvariablen RESEND_API_KEY i Vercel (Settings → Environment Variables).

const TO = "kontakt@vantastudio.dk";
// Afsenderen skal ligge på et domæne, der er verificeret i Resend (mail.vantastudio.dk).
// Kan overskrives med miljøvariablen RESEND_FROM.
const FROM = process.env.RESEND_FROM || "Vanta Studio <kontakt@mail.vantastudio.dk>";

const clean = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Metoden er ikke tilladt." });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Honeypot: et skjult felt, som kun spam-robotter udfylder
  if (clean(body.website, 200)) return res.status(200).json({ ok: true });

  const data = {
    type: clean(body.type, 40) === "booking" ? "booking" : "kontakt",
    navn: clean(body.navn, 120),
    virksomhed: clean(body.virksomhed, 160),
    email: clean(body.email, 200),
    telefon: clean(body.telefon, 40),
    besked: clean(body.besked, 5000),
  };

  if (!data.navn || !isEmail(data.email)) {
    return res.status(400).json({ ok: false, error: "Udfyld venligst navn og en gyldig e-mail." });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(500).json({ ok: false, error: "Formularen er ikke sat op endnu." });

  const subject = data.type === "booking"
    ? `Forespørgsel om samtale – ${data.navn}${data.virksomhed ? ` (${data.virksomhed})` : ""}`
    : `Ny henvendelse – ${data.navn}`;

  const rows = [
    ["Navn", data.navn],
    ["Virksomhed", data.virksomhed || "–"],
    ["E-mail", data.email],
    ["Telefon", data.telefon || "Ingen – svar på mail"],
  ];
  if (data.besked) rows.push(["Besked", data.besked]);

  const text = (data.type === "booking" ? "Ny forespørgsel om en kort, uforpligtende samtale. Kontakt kunden for at aftale et tidspunkt.\n\n" : "Ny henvendelse fra hjemmesiden.\n\n")
    + rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const html = `<p>${data.type === "booking" ? "Ny forespørgsel om en kort, uforpligtende samtale. Kontakt kunden for at aftale et tidspunkt." : "Ny henvendelse fra hjemmesiden."}</p>`
    + `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">`
    + rows.map(([k, v]) => `<tr><td style="color:#666;vertical-align:top">${k}</td><td>${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("")
    + `</table>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [TO], reply_to: data.email, subject, text, html }),
    });
    if (!r.ok) {
      console.error("Resend-fejl", r.status, await r.text());
      return res.status(502).json({ ok: false, error: "Beskeden kunne ikke sendes lige nu." });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Resend-fejl", err);
    return res.status(502).json({ ok: false, error: "Beskeden kunne ikke sendes lige nu." });
  }
}
