// Vercel-funktion: sender kontaktformularen videre som Telegram-besked.
// Kræver miljøvariablerne TELEGRAM_BOT_TOKEN og TELEGRAM_CHAT_ID i Vercel.
module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false });
  }

  var token = process.env.TELEGRAM_BOT_TOKEN;
  var chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return res.status(500).json({ ok: false });

  var b = req.body || {};
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { b = {}; }
  }

  // Honeypot: et skjult felt, som kun bots udfylder
  if (b.firma) return res.status(200).json({ ok: true });

  var navn = String(b.navn || "").trim().slice(0, 200);
  var email = String(b.email || "").trim().slice(0, 200);
  var besked = String(b.besked || "").trim().slice(0, 3000);
  if (!navn || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false });
  }

  var text = "Ny henvendelse fra vantastudio.dk\n\n" +
    "Navn: " + navn + "\n" +
    "E-mail: " + email + "\n\n" +
    (besked || "(ingen besked)");

  try {
    var r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: true })
    });
    if (!r.ok) return res.status(502).json({ ok: false });
  } catch (e) {
    return res.status(502).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
};
