const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
console.log("Telegram bot is running...");

function normalizeDomain(input) {
  try {
    let value = input.trim();
    if (!value) return null;
    return value;
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

bot.on("message", async (msg) => {
  const text = msg.text;

  if (!text || text.startsWith("/start")) return;

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

    const reply = `
🔎 Domain: ${data.domain}
🚨 Risk Level: ${data.riskLevel}
📅 Created: ${data.createdAt}
🕒 Age (days): ${data.ageDays ?? "Unknown"}
🙈 Owner hidden: ${data.hiddenOwner ? "Yes" : "No"}
⚠️ Risky extension: ${data.riskyTld}
📊 Risk score: ${data.score}/100

Reasons:
${data.reasons.length ? data.reasons.map((r) => `- ${r}`).join("\n") : "- No major red flags found"}
`;

    bot.sendMessage(msg.chat.id, reply.trim());
  } catch (error) {
    console.error("Bot error:", error);
    bot.sendMessage(msg.chat.id, "Failed to connect to the scam checker API.");
  }
});