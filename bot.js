require("./server");


const TelegramBot = require("node-telegram-bot-api");

global.bot = bot;
global.addPremiumUser = addPremiumUser;
const { Pool } = require("pg");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const ADMIN_ID = "7221641395";
const users = new Set();
const FREE_DAILY_LIMIT = 5;
const REFERRAL_REWARD_EVERY = 3;
const REFERRAL_BONUS_SCANS = 5;

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        referred_id BIGINT PRIMARY KEY,
        referrer_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referral_bonus (
        user_id BIGINT NOT NULL,
        bonus_date DATE NOT NULL,
        bonus_scans INT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, bonus_date)
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

async function getReferralCount(userId) {
  const result = await pool.query(
    "SELECT COUNT(*) AS total FROM referrals WHERE referrer_id = $1",
    [userId]
  );
  return Number(result.rows[0].total || 0);
}

async function getTodayBonusScans(userId) {
  const result = await pool.query(
    "SELECT bonus_scans FROM referral_bonus WHERE user_id = $1 AND bonus_date = CURRENT_DATE",
    [userId]
  );

  if (!result.rows.length) return 0;
  return Number(result.rows[0].bonus_scans || 0);
}

async function addTodayBonusScans(userId, scans) {
  await pool.query(
    `
    INSERT INTO referral_bonus (user_id, bonus_date, bonus_scans)
    VALUES ($1, CURRENT_DATE, $2)
    ON CONFLICT (user_id, bonus_date)
    DO UPDATE SET bonus_scans = referral_bonus.bonus_scans + EXCLUDED.bonus_scans
    `,
    [userId, scans]
  );
}

async function getDailyLimit(userId) {
  if (PREMIUM_USERS.has(userId)) return Infinity;
  const bonus = await getTodayBonusScans(userId);
  return FREE_DAILY_LIMIT + bonus;
}

async function registerReferral(referrerId, referredId) {
  if (!referrerId || !referredId) return { created: false };
  if (Number(referrerId) === Number(referredId)) return { created: false, self: true };

  const existing = await pool.query(
    "SELECT referrer_id FROM referrals WHERE referred_id = $1",
    [referredId]
  );

  if (existing.rows.length) {
    return { created: false, alreadyExists: true };
  }

  await pool.query(
    "INSERT INTO referrals (referred_id, referrer_id) VALUES ($1, $2)",
    [referredId, referrerId]
  );

  const total = await getReferralCount(referrerId);

  let rewardGiven = false;
  if (total % REFERRAL_REWARD_EVERY === 0) {
    await addTodayBonusScans(referrerId, REFERRAL_BONUS_SCANS);
    rewardGiven = true;
  }

  return { created: true, total, rewardGiven };
}

const axios = require("axios");

async function createPaymentLink(telegramId) {
  if (!telegramId) {
    throw new Error("Telegram ID is required.");
  }

  if (!process.env.PAYSTACK_SECRET) {
    throw new Error("PAYSTACK_SECRET is missing.");
  }

  if (!process.env.PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL is missing.");
  }

  const email = `tg${telegramId}@scamchecker.app`;

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: 300,
        currency: "GHS",
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
        timeout: 15000,
      }
    );

    const paymentLink = response.data?.data?.authorization_url;

    if (!paymentLink) {
      throw new Error("Paystack did not return a payment link.");
    }

    return paymentLink;
  } catch (error) {
    console.error(
      "Direct Paystack createPaymentLink error:",
      error.response?.data || error.message || error
    );

    throw new Error(
      error.response?.data?.message || "Failed to create payment link."
    );
  }
}
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

function extractDomainFromText(text) {
  if (!text) return null;

  const urlMatch = text.match(/https?:\/\/[^\s]+/i);
  if (urlMatch) {
    return normalizeDomain(urlMatch[0]);
  }

  const domainMatch = text.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
  if (domainMatch) {
    return normalizeDomain(domainMatch[0]);
  }

  return null;
}

async function quickCheckDomain(domain) {
  try {
    const response = await fetch(`${process.env.PUBLIC_BASE_URL}/api/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();
    if (!response.ok) return null;
    return data;
  } catch {
    return null;
  }
}

console.log("Telegram bot is running...");

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  users.add(msg.from.id);

  const payload = match?.[1];

  if (payload && payload.startsWith("ref_")) {
    const referrerId = Number(payload.replace("ref_", ""));

    try {
      const result = await registerReferral(referrerId, msg.from.id);

      if (result.created) {
        await bot.sendMessage(
          msg.chat.id,
          "🎉 Referral detected. You joined through an invite link."
        );

        await bot.sendMessage(
          referrerId,
          `🎉 New referral joined!\n\nTotal referrals: ${result.total}`
        );

        if (result.rewardGiven) {
          await bot.sendMessage(
            referrerId,
            `🔥 Referral reward unlocked!\n\nYou earned +${REFERRAL_BONUS_SCANS} extra scans for today for reaching ${result.total} referrals.`
          );
        }
      }
    } catch (error) {
      console.error("Referral error:", error);
    }
  }

  bot.sendMessage(
    msg.chat.id,
`Welcome to Scamchecker.

Send me any domain like:
google.com
heinekenapp.top

Useful commands:
/check domain.com
/upgrade - see premium plan
/myplan - view your plan
/invite - invite friends`
  );
});

bot.onText(/\/invite/, async (msg) => {
  users.add(msg.from.id);

  const botUsername = process.env.BOT_USERNAME;

  if (!botUsername) {
    return bot.sendMessage(
      msg.chat.id,
      "Invite links are not ready yet. Set BOT_USERNAME in Railway first."
    );
  }

  const referralCount = await getReferralCount(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
`🚀 Invite friends and earn rewards

Your invite link:
https://t.me/${botUsername}?start=ref_${msg.from.id}

Current referrals: ${referralCount}

Reward system:
Every ${REFERRAL_REWARD_EVERY} successful invites = +${REFERRAL_BONUS_SCANS} extra scans for today.`
  );
});

bot.onText(/\/upgrade/, async (msg) => {
  users.add(msg.from.id);

  try {
    const paymentLink = await createPaymentLink(msg.from.id);

    bot.sendMessage(
      msg.chat.id,
`⭐ Premium Plan

Premium users get:
• VirusTotal results
• Advanced scam detection
• Unlimited daily scans

Price: $3/month

Complete payment here:
${paymentLink}

✅ Premium should activate automatically after successful payment.`
    );
  } catch (error) {
    console.error("Upgrade error:", error);
    bot.sendMessage(
      msg.chat.id,
      "Failed to create payment link. Please try again in a moment."
    );
  }
});

bot.onText(/\/myplan/, async (msg) => {
  users.add(msg.from.id);

  const isPremium = PREMIUM_USERS.has(msg.from.id);

  if (isPremium) {
    const referralCount = await getReferralCount(msg.from.id);
    return bot.sendMessage(
      msg.chat.id,
      `⭐ Your current plan: Premium

Unlimited daily scans
Referrals: ${referralCount}`
    );
  }

  const used = await getTodayUsage(msg.from.id);
  const limit = await getDailyLimit(msg.from.id);
  const remaining = Math.max(limit - used, 0);
  const referralCount = await getReferralCount(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
    `🆓 Your current plan: Free

Base daily limit: ${FREE_DAILY_LIMIT}
Bonus scans today: ${limit - FREE_DAILY_LIMIT}
Total limit today: ${limit}
Used today: ${used}
Remaining today: ${remaining}
Referrals: ${referralCount}

Use /upgrade to unlock unlimited scans.
Use /invite to earn extra scans.`
  );
});

bot.onText(/\/paid/, (msg) => {
  users.add(msg.from.id);

  bot.sendMessage(
    msg.chat.id,
    "If your payment was successful, premium should activate automatically shortly. If it does not, contact the admin."
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

  const referralResult = await pool.query(
    "SELECT COUNT(*) AS total FROM referrals"
  );

  const totalReferrals = Number(referralResult.rows[0].total || 0);

  bot.sendMessage(
    msg.chat.id,
`📊 Bot Stats

Users: ${users.size}
Premium users: ${PREMIUM_USERS.size}
Scans today: ${totalToday}
Total referrals: ${totalReferrals}
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

bot.on("callback_query", async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data === "check_another") {
    await bot.sendMessage(
      chatId,
      "Send another domain or use:\n/check example.com"
    );
  }

  if (data === "share_bot_unavailable") {
    await bot.sendMessage(
      chatId,
      "Set BOT_USERNAME in Railway variables to enable the share button."
    );
  }

  if (data === "upgrade_dynamic") {
    try {
      const paymentLink = await createPaymentLink(query.from.id);
      await bot.sendMessage(
        chatId,
        `⭐ Complete your premium payment here:\n\n${paymentLink}`
      );
    } catch (error) {
      await bot.sendMessage(chatId, "Failed to create payment link.");
    }
  }

  await bot.answerCallbackQuery(query.id);
});
async function runDomainCheck(msg, domainInput) {
  const domain = normalizeDomain(domainInput);

  if (!domain) {
    return bot.sendMessage(msg.chat.id, "Please send a valid domain or URL.");
  }

  if (!process.env.PUBLIC_BASE_URL) {
    return bot.sendMessage(msg.chat.id, "PUBLIC_BASE_URL is missing.");
  }

  try {
    const url = `${process.env.PUBLIC_BASE_URL}/api/check`;
    console.log("Checking URL:", url);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();
    console.log("API response:", data);

    if (!response.ok) {
      return bot.sendMessage(msg.chat.id, data.error || "Failed to check that domain.");
    }

    return bot.sendMessage(msg.chat.id, "Check worked.");
  } catch (error) {
    console.error("runDomainCheck error:", error);
    return bot.sendMessage(msg.chat.id, `Failed to check domain.\n${error.message}`);
  }
}
async function runGroupDomainCheck(msg, domainInput) {
  const domain = normalizeDomain(domainInput);
  if (!domain) return;

  try {
    const data = await quickCheckDomain(domain);
    if (!data) return;

    if (data.riskLevel === "HIGH" || data.score >= 60) {
      await bot.sendMessage(
        msg.chat.id,
        `⚠️ Scamchecker warning

Domain: ${data.domain}
Risk: ${data.riskLevel}
Score: ${data.score}/100

Top reasons:
${data.reasons?.slice(0, 3).map((r) => `• ${r}`).join("\n") || "• High risk detected"}`,
        {
          reply_to_message_id: msg.message_id
        }
      );
    }
  } catch (error) {
    console.error("Group check error:", error);
  }
}

bot.onText(/\/check (.+)/, async (msg, match) => {
  users.add(msg.from.id);
  await runDomainCheck(msg, match[1]);
});

bot.on("message", async (msg) => {
  users.add(msg.from.id);

  const text = msg.text;
  if (!text || text.startsWith("/")) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (isGroup) {
    const domain = extractDomainFromText(text);
    if (!domain) return;

    await runGroupDomainCheck(msg, domain);
    return;
  }

  await runDomainCheck(msg, text);
});

initDatabase();