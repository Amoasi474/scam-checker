const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const ADMIN_ID = "7221641395";
const users = new Set();
const PAYMENT_LINK = "https://paystack.shop/pay/zbxb4v15ns";
const FREE_DAILY_LIMIT = 5;

const PREMIUM_USERS = new Set();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS premium_users (
        user_id BIGINT PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS scan_usage (
        user_id BIGINT NOT NULL,
        scan_date DATE NOT NULL,
        count INT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, scan_date)
      )
    `);

    const result = await pool.query("SELECT user_id FROM premium_users");
    result.rows.forEach((row) => {
      PREMIUM_USERS.add(Number(row.user_id));
    });

    console.log("Database initialized.");
  } catch (err) {
    console.error("Database init error:", err);
  }
}

async function addPremiumUser(userId) {
  await pool.query(
    "INSERT INTO premium_users (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
    [userId]
  );
  PREMIUM_USERS.add(Number(userId));
}

async function removePremiumUser(userId) {
  await pool.query(
    "DELETE FROM premium_users WHERE user_id = $1",
    [userId]
  );
  PREMIUM_USERS.delete(Number(userId));
}

async function getTodayUsage(userId) {
  const result = await pool.query(
    "SELECT count FROM scan_usage WHERE user_id = $1 AND scan_date = CURRENT_DATE",
    [userId]
  );

  if (!result.rows.length) return 0;
  return Number(result.rows[0].count);
}

async function incrementTodayUsage(userId) {
  await pool.query(
    `
    INSERT INTO scan_usage (user_id, scan_date, count)
    VALUES ($1, CURRENT_DATE, 1)
    ON CONFLICT (user_id, scan_date)
    DO UPDATE SET count = scan_usage.count + 1
    `,
    [userId]
  );
}

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
  users.add(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
`Welcome to Scamchecker.

Send me any domain like:
google.com
heinekenapp.top

Useful commands:
/upgrade - see premium plan
/myplan - view your plan`
  );
});

bot.onText(/\/upgrade/, (msg) => {
  users.add(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
`⭐ Premium Plan

Premium users get:
• VirusTotal results
• Advanced scam detection
• Unlimited daily scans

Price: $3/month

Complete payment here:
${PAYMENT_LINK}

After payment, send:
/paid`
  );
});

bot.onText(/\/myplan/, async (msg) => {
  users.add(msg.from.id);

  const isPremium = PREMIUM_USERS.has(msg.from.id);

  if (isPremium) {
    return bot.sendMessage(
      msg.chat.id,
      "⭐ Your current plan: Premium\nUnlimited daily scans."
    );
  }

  const used = await getTodayUsage(msg.from.id);
  const remaining = Math.max(FREE_DAILY_LIMIT - used, 0);

  bot.sendMessage(
    msg.chat.id,
    `🆓 Your current plan: Free

Daily limit: ${FREE_DAILY_LIMIT}
Used today: ${used}
Remaining today: ${remaining}

Use /upgrade to unlock unlimited scans.`
  );
});

bot.onText(/\/paid/, (msg) => {
  users.add(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
    "Payment request received. Please wait while the admin confirms your premium access."
  );

  bot.sendMessage(
    ADMIN_ID,
`💰 New premium payment request

User ID: ${msg.from.id}
Username: @${msg.from.username || "none"}
Name: ${msg.from.first_name || ""} ${msg.from.last_name || ""}

If payment is confirmed, run:
/addpremium ${msg.from.id}`
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
/broadcast MESSAGE - send message to all users
/addpremium USER_ID
/removepremium USER_ID
/premiumlist`
  );
});

bot.onText(/\/stats/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;

  const todayResult = await pool.query(
    "SELECT COALESCE(SUM(count), 0) AS total FROM scan_usage WHERE scan_date = CURRENT_DATE"
  );

  const totalToday = Number(todayResult.rows[0].total || 0);

  bot.sendMessage(
    msg.chat.id,
`📊 Bot Stats

Users: ${users.size}
Premium users: ${PREMIUM_USERS.size}
Scans today: ${totalToday}
Free daily limit: ${FREE_DAILY_LIMIT}
Status: Online`
  );
});

bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;

  const message = match[1];

  users.forEach((userId) => {
    bot.sendMessage(userId, `📢 Admin Message:\n\n${message}`);
  });

  bot.sendMessage(msg.chat.id, "Broadcast sent.");
});

bot.onText(/\/addpremium (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;

  const userId = Number(match[1]);
  if (!userId) return bot.sendMessage(msg.chat.id, "Please provide a valid user ID.");

  await addPremiumUser(userId);

  bot.sendMessage(msg.chat.id, `✅ User ${userId} added to premium.`);
  bot.sendMessage(userId, "✅ Your premium access has been activated.");
});

bot.onText(/\/removepremium (.+)/, async (msg, match) => {
  if (String(msg.from.id) !== ADMIN_ID) return;

  const userId = Number(match[1]);
  if (!userId) return bot.sendMessage(msg.chat.id, "Please provide a valid user ID.");

  await removePremiumUser(userId);

  bot.sendMessage(msg.chat.id, `✅ User ${userId} removed from premium.`);
});

bot.onText(/\/premiumlist/, (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) return;

  const ids = [...PREMIUM_USERS];

  if (!ids.length) {
    return bot.sendMessage(msg.chat.id, "⭐ No premium users yet.");
  }

  bot.sendMessage(
    msg.chat.id,
`⭐ Premium users (${ids.length}):

${ids.join("\n")}`
  );
});

bot.on("message", async (msg) => {
  users.add(msg.from.id);

  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const domain = normalizeDomain(text);
  if (!domain) {
    return bot.sendMessage(msg.chat.id, "Please send a valid domain or URL.");
  }

  const isPremium = PREMIUM_USERS.has(msg.from.id);

  if (!isPremium) {
    const usedToday = await getTodayUsage(msg.from.id);

    if (usedToday >= FREE_DAILY_LIMIT) {
      return bot.sendMessage(
        msg.chat.id,
`🛑 You have reached your free daily limit of ${FREE_DAILY_LIMIT} scans.

Use /upgrade to unlock unlimited scans.`
      );
    }
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
      return bot.sendMessage(msg.chat.id, data.error || "Failed to check that domain.");
    }

    if (!isPremium) {
      await incrementTodayUsage(msg.from.id);
    }

    let premiumBadge = "";
    if (isPremium) {
      premiumBadge = "\n⭐ Premium User";
    }

    let vtInfo = "";
    if (isPremium && data.vtResult) {
      vtInfo = `
🛡 VirusTotal
Malicious: ${data.vtResult.malicious}
Suspicious: ${data.vtResult.suspicious}
Harmless: ${data.vtResult.harmless}
Undetected: ${data.vtResult.undetected}
`;
    } else {
      const usedNow = isPremium ? 0 : await getTodayUsage(msg.from.id);
      const remaining = isPremium ? "Unlimited" : Math.max(FREE_DAILY_LIMIT - usedNow, 0);

      vtInfo = `
🔒 VirusTotal results are premium.
Use /upgrade to unlock.

${isPremium ? "" : `Free scans remaining today: ${remaining}`}
`;
    }

    const reply = `
🔎 Domain: ${data.domain}${premiumBadge}

🚨 Risk Level: ${data.riskLevel}
📊 Risk score: ${data.score}/100

📅 Created: ${data.createdAt}
🕒 Age (days): ${data.ageDays ?? "Unknown"}

${vtInfo}
`;

    bot.sendMessage(msg.chat.id, reply.trim());
  } catch (error) {
    console.error(error);
    bot.sendMessage(msg.chat.id, "Failed to check domain.");
  }
});

initDatabase();