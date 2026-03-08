const express = require("express");
const path = require("path");
const whois = require("whois");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
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

app.post("/api/check", async (req, res) => {
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
      console.log("WHOIS lookup failed");
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

    const vtResult = await checkVirusTotalDomain(domain);

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

    res.json({
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
    console.error(error);
    res.status(500).json({
      error: "Failed to analyze domain. Try again with another website.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Scam Checker running on port ${PORT}`);
});