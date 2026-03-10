const express = require("express");
const path = require("path");
const whois = require("whois");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Keep raw body for Paystack webhook signature verification
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

function normalizeDomain(input) {
  try {
    let value = input.trim().toLowerCase();

    if (!value) return null;

    if (!/^https?:\/\//i.test(value)) {
      value = `http://${value}`;
    }

    const url = new URL(value);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function calculateAgeInDays(createdAt) {
  if (!createdAt) return null;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;

  const now = new Date();
  const diffMs = now - created;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function getRiskTld(domain) {
  const riskyTlds = [".top", ".vip", ".xyz", ".click", ".shop", ".live", ".buzz"];
  return riskyTlds.find((tld) => domain.endsWith(tld)) || null;
}

function extractCreationDate(raw) {
  if (!raw) return null;

  const patterns = [
    /Creation Date:\s*(.+)/i,
    /Created On:\s*(.+)/i,
    /Created:\s*(.+)/i,
    /Registered On:\s*(.+)/i,
    /Domain Registration Date:\s*(.+)/i,
    /Registration Time:\s*(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function detectHiddenOwner(raw) {
  if (!raw) return false;

  const hiddenIndicators = [
    "redacted for privacy",
    "privacy service",
    "whois privacy",
    "contact privacy",
    "data protected",
    "privacyguardian",
    "domains by proxy",
    "namecheap privacy",
    "hidden",
    "not disclosed",
  ];

  const lower = raw.toLowerCase();
  return hiddenIndicators.some((term) => lower.includes(term));
}

function scoreRisk({ ageDays, hiddenOwner, riskyTld }) {
  let score = 0;
  const reasons = [];

  if (ageDays !== null) {
    if (ageDays < 30) {
      score += 45;
      reasons.push("Domain is less than 30 days old");
    } else if (ageDays < 180) {
      score += 30;
      reasons.push("Domain is less than 6 months old");
    } else if (ageDays < 365) {
      score += 15;
      reasons.push("Domain is less than 1 year old");
    }
  } else {
    score += 10;
    reasons.push("Could not verify domain age");
  }

  if (hiddenOwner) {
    score += 20;
    reasons.push("Owner or registrant details appear hidden");
  }

  if (riskyTld) {
    score += 20;
    reasons.push(`Uses a higher-risk domain extension (${riskyTld})`);
  }

  let riskLevel = "LOW";
  if (score >= 60) riskLevel = "HIGH";
  else if (score >= 30) riskLevel = "MEDIUM";

  return { score, riskLevel, reasons };
}

function lookupWhois(domain) {
  return new Promise((resolve, reject) => {
    whois.lookup(domain, { follow: 2, timeout: 10000 }, (err, data) => {
      if (err) return reject(err);
      resolve(data || "");
    });
  });
}

async function checkVirusTotalDomain(domain) {
  const apiKey = process.env.VT_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await axios.get(
      `https://www.virustotal.com/api/v3/domains/${domain}`,
      {
        headers: {
          "x-apikey": apiKey,
        },
      }
    );

    const attributes = response.data?.data?.attributes || {};
    const stats = attributes.last_analysis_stats || {};

    return {
      malicious: stats.malicious || 0,
      suspicious: stats.suspicious || 0,
      harmless: stats.harmless || 0,
      undetected: stats.undetected || 0,
      reputation: attributes.reputation ?? null,
    };
  } catch (error) {
    console.log("VirusTotal check failed");
    return null;
  }
}

async function addPremiumUser(userId) {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS premium_users (
      user_id BIGINT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `
  );

  await pool.query(
    "INSERT INTO premium_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  );
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
    });
  } catch (error) {
    console.error("Failed to send Telegram message:", error.response?.data || error.message);
  }
}
app.get("/api/check", (req, res) => {
  res.json({ message: "API route is alive. Use POST to check domains." });
});
  try {
    const input = req.body.domain;
    const domain = normalizeDomain(input);

    if (!domain) {
      return res.status(400).json({ error: "Please enter a valid domain or URL." });
    }

    let rawWhois = "";
    try {
      rawWhois = await lookupWhois(domain);
    } catch (error) {
      console.log("WHOIS lookup failed:", error.message);
      rawWhois = "";
    }

    const createdAtRaw = extractCreationDate(rawWhois);
    const ageDays = calculateAgeInDays(createdAtRaw);
    const hiddenOwner = detectHiddenOwner(rawWhois);
    const riskyTld = getRiskTld(domain);

    const risk = scoreRisk({
      ageDays,
      hiddenOwner,
      riskyTld,
    });

    let vtResult = null;
    try {
      vtResult = await checkVirusTotalDomain(domain);
    } catch (error) {
      console.log("VirusTotal lookup failed:", error.message);
      vtResult = null;
    }

    if (vtResult) {
      if (vtResult.malicious > 0) {
        risk.score += 50;
        risk.reasons.push(`VirusTotal marked this domain as malicious (${vtResult.malicious})`);
      }

      if (vtResult.suspicious > 0) {
        risk.score += 25;
        risk.reasons.push(`VirusTotal marked this domain as suspicious (${vtResult.suspicious})`);
      }

      if (risk.score >= 60) {
        risk.riskLevel = "HIGH";
      } else if (risk.score >= 30) {
        risk.riskLevel = "MEDIUM";
      } else {
        risk.riskLevel = "LOW";
      }
    }

    return res.json({
      domain,
      createdAt: createdAtRaw || "Not found",
      ageDays,
      hiddenOwner,
      riskyTld: riskyTld || "None",
      riskLevel: risk.riskLevel,
      score: risk.score,
      reasons: risk.reasons,
      vtResult,
    });
  } catch (error) {
    console.error("API /api/check error:", error);
    return res.status(500).json({
      error: error.message || "Failed to analyze domain. Try again with another website.",
    });
  }
});

// Create Paystack payment link with telegram metadata
app.post("/api/payment-link", async (req, res) => {
  try {
    const { telegramId } = req.body;

    if (!telegramId) {
      return res.status(400).json({ error: "Telegram ID required" });
    }

    if (!process.env.PAYSTACK_SECRET) {
      return res.status(500).json({ error: "PAYSTACK_SECRET is missing on server." });
    }

    if (!process.env.PUBLIC_BASE_URL) {
      return res.status(500).json({ error: "PUBLIC_BASE_URL is missing on server." });
    }

    // Fake internal email for Paystack initialization
    const email = `tg${telegramId}@scamchecker.app`;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: 300, // $3.00 equivalent if your Paystack account is in USD minor units; adjust if needed
        currency: "USD",
        callback_url: `${process.env.PUBLIC_BASE_URL}/payment-success`,
        metadata: {
          telegram_id: String(telegramId),
          source: "telegram_bot",
          plan: "premium_monthly",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.json({
      paymentLink: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (error) {
    console.error("Payment link error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to create payment link" });
  }
});

// Optional success page
app.get("/payment-success", (req, res) => {
  res.send(`
    <html>
      <head><title>Payment Received</title></head>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h2>Payment received</h2>
        <p>If your payment was successful, your Telegram premium will activate automatically in a moment.</p>
        <p>You can return to Telegram now.</p>
      </body>
    </html>
  `);
});

// Paystack webhook
app.post("/paystack/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const secret = process.env.PAYSTACK_SECRET;

    if (!secret) {
      return res.status(500).send("Missing PAYSTACK_SECRET");
    }

    const hash = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody)
      .digest("hex");

    if (hash !== signature) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const telegramId = event.data?.metadata?.telegram_id;

      if (telegramId) {
        await addPremiumUser(Number(telegramId));

        await sendTelegramMessage(
          Number(telegramId),
          "✅ Payment confirmed. Your premium access has been activated automatically."
        );
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message || error);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Scam Checker running on port ${PORT}`);
});