const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const ADMIN_ID = "YOUR_TELEGRAM_ID";
const users = new Set();

console.log("Telegram bot is running...");

function normalizeDomain(input) {
  try {
    let value = input.trim().toLowerCase();

    if (!/^https?:\/\//i.test(value)) {
      value = "http://" + value;
    }

    const url = new URL(value);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "Send me any domain like google.com or heinekenapp.top and I will check the risk."
  );
});

bot.onText(/\/admin/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "⛔ You are not authorized.");
  }

  bot.sendMessage(
    msg.chat.id,
`🛠 Admin Panel

/stats - bot statistics
/broadcast MESSAGE - send message to all users`
  );
});

bot.onText(/\/stats/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }

  bot.sendMessage(
    msg.chat.id,
`📊 Bot Stats

Users: ${users.size}
Status: Online`
  );
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
  }

  const message = match[1];

  users.forEach((userId) => {
    bot.sendMessage(userId, `📢 Admin Message:\n\n${message}`);
  });

  bot.sendMessage(msg.chat.id, "Broadcast sent.");
});

bot.on("message", async (msg) => {
  users.add(msg.from.id);

  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  const domain = normalizeDomain(text);

  if (!domain) {
    bot.sendMessage(msg.chat.id, "Please send a valid domain or URL.");
    return;
  }

  try {
    const response = await fetch("https://scam-checker.onrender.com/api/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();

    if (!response.ok) {
      bot.sendMessage(msg.chat.id, data.error || "Failed to check that domain.");
      return;
    }

    let vtInfo = "";
    if (data.vtResult) {
      vtInfo = `
🛡 VirusTotal
Malicious: ${data.vtResult.malicious}
Suspicious: ${data.vtResult.suspicious}
Harmless: ${data.vtResult.harmless}
`;
    }

    const reply = `
🔎 Domain: ${data.domain}

🚨 Risk Level: ${data.riskLevel}
📊 Risk score: ${data.score}/100

📅 Created: ${data.createdAt}
🕒 Age (days): ${data.ageDays ?? "Unknown"}
🙈 Owner hidden: ${data.hiddenOwner ? "Yes" : "No"}
⚠️ Risky extension: ${data.riskyTld}

Reasons:
${data.reasons.length ? data.reasons.map((r) => `- ${r}`).join("\n") : "- No major red flags found"}

${vtInfo}
`;

    bot.sendMessage(msg.chat.id, reply.trim());
  } catch (error) {
    console.error("Bot error:", error);
    bot.sendMessage(msg.chat.id, "Failed to connect to the scam checker API.");
  }
});