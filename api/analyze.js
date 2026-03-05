module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (req.body && req.body.scrapeUrl) {
    return scrapeHandler(req, res);
  }
  return chatHandler(req, res);
};

async function scrapeHandler(req, res) {
  var key = process.env.SCRAPER_API_KEY;
  if (!key) return res.status(200).json({ error: "SCRAPER_API_KEY not set" });

  var url = req.body.scrapeUrl;
  if (!url) return res.status(200).json({ error: "No url" });

  try {
    var endpoint = "https://api.scraperapi.com?api_key=" + key + "&url=" + encodeURIComponent(url);
    var resp = await fetch(endpoint);
    if (!resp.ok) return res.status(200).json({ error: "HTTP " + resp.status });

    var html = await resp.text();
    var result = {};

    var titleM = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    result.pageTitle = titleM ? titleM[1].trim() : "";

    var ogTitleM = html.match(/property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)/i);
    if (!ogTitleM) ogTitleM = html.match(/content\s*=\s*["']([^"']*?)["'][^>]*property\s*=\s*["']og:title/i);
    result.ogTitle = ogTitleM ? ogTitleM[1] : "";

    var ogDescM = html.match(/property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)/i);
    if (!ogDescM) ogDescM = html.match(/content\s*=\s*["']([^"']*?)["'][^>]*property\s*=\s*["']og:description/i);
    result.ogDescription = ogDescM ? ogDescM[1] : "";

    var descM = html.match(/name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)/i);
    result.description = descM ? descM[1] : "";

    var prices = [];
    var priceRe = /\$\s?([\d,]+\.?\d{0,2})/g;
    var pm;
    while ((pm = priceRe.exec(html)) !== null) {
      var v = parseFloat(pm[1].replace(/,/g, ""));
      if (v > 0.5 && v < 100000 && prices.indexOf(v) === -1) prices.push(v);
    }
    result.prices = prices.slice(0, 10);

    var headings = [];
    var h1Re = /<h1[^>]*>([\s\S]*?)<\/h1>/gi;
    var hm;
    while ((hm = h1Re.exec(html)) !== null) {
      var t = hm[1].replace(/<[^>]+>/g, "").trim();
      if (t.length > 3) headings.push(t);
    }
    result.headings = headings.slice(0, 5);

    var body = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    result.bodyExcerpt = body.slice(0, 2000);

    var jsonLd = [];
    var ldRe = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    var ldm;
    while ((ldm = ldRe.exec(html)) !== null) {
      try { jsonLd.push(JSON.parse(ldm[1].trim())); } catch (e) {}
    }
    result.jsonLd = jsonLd.length > 0 ? JSON.stringify(jsonLd).slice(0, 3000) : "";

    return res.status(200).json(result);
  } catch (err) {
    return res.status(200).json({ error: err.message });
  }
}

async function chatHandler(req, res) {
  var key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: "GROQ_API_KEY not set" });

  var raw = (req.body && req.body.messages) ? req.body.messages : [];
  var messages = [];
  for (var i = 0; i < raw.length; i++) {
    var c = raw[i].content;
    if (Array.isArray(c)) {
      var parts = [];
      for (var j = 0; j < c.length; j++) {
        if (c[j].type === "text" && c[j].text) parts.push(c[j].text);
      }
      c = parts.join("\n");
    }
    if (c && typeof c === "string" && c.length > 0) {
      messages.push({ role: raw[i].role || "user", content: c });
    }
  }
  if (messages.length === 0) return res.status(400).json({ error: "No messages" });

  var models = [
    "llama-3.3-70b-versatile",
    "llama-3.1-70b-versatile",
    "llama-3.1-8b-instant",
    "mixtral-8x7b-32768"
  ];

  var lastErr = null;
  for (var m = 0; m < models.length; m++) {
    try {
      var resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + key
        },
        body: JSON.stringify({
          model: models[m],
          max_tokens: 1200,
          temperature: 0.3,
          messages: messages
        })
      });
      var data = await resp.json();
      if (!resp.ok) { lastErr = data; continue; }

      var text = "";
      if (data.choices && data.choices[0] && data.choices[0].message) {
        text = data.choices[0].message.content || "";
      }
      if (!text) { lastErr = { error: { message: "Empty from " + models[m] } }; continue; }

      return res.status(200).json({ content: [{ type: "text", text: text }] });
    } catch (err) {
      lastErr = { error: { message: err.message } };
    }
  }
  return res.status(500).json({ error: "All models failed", details: lastErr });
}
