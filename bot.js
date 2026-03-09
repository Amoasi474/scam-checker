const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const ADMIN_ID = "7221641395";
const users = new Set();
const PAYMENT_LINK = "https://paystack.shop/pay/zbxb4v15ns";
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
          `🎉 New referral joined!

Total referrals: ${result.total}`
        );

        if (result.rewardGiven) {
          await bot.sendMessage(
            referrerId,
            `🔥 Referral reward unlocked!

You earned +${REFERRAL_BONUS_SCANS} extra scans for today for reaching ${result.total} referrals.`
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

async function runDomainCheck(msg, domainInput) {
  const domain = normalizeDomain(domainInput);

  if (!domain) {
    return bot.sendMessage(msg.chat.id, "Please send a valid domain or URL.");
  }

  const isPremium = PREMIUM_USERS.has(msg.from.id);

  if (!isPremium) {
    const usedToday = await getTodayUsage(msg.from.id);
    const limit = await getDailyLimit(msg.from.id);

    if (usedToday >= limit) {
      return bot.sendMessage(
        msg.chat.id,
`🛑 You have reached your free daily limit of ${limit} scans for today.

Use /upgrade to unlock unlimited scans.
Use /invite to earn extra scans.`
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
      const limit = isPremium ? Infinity : await getDailyLimit(msg.from.id);
      const remaining = isPremium ? "Unlimited" : Math.max(limit - usedNow, 0);

      vtInfo = `
🔒 VirusTotal results are premium.
Use /upgrade to unlock.

${isPremium ? "" : `Free scans remaining today: ${remaining}`}
`;
    }

    const shareText = process.env.BOT_USERNAME
      ? `\n📣 Share this bot:\nhttps://t.me/${process.env.BOT_USERNAME}`
      : "";

    const reply = `
🔎 Domain: ${data.domain}${premiumBadge}

🚨 Risk Level: ${data.riskLevel}
📊 Risk score: ${data.score}/100

📅 Created: ${data.createdAt}
🕒 Age (days): ${data.ageDays ?? "Unknown"}

${vtInfo}${shareText}
`;

    bot.sendMessage(msg.chat.id, reply.trim());
  } catch (error) {
    console.error(error);
    bot.sendMessage(msg.chat.id, "Failed to check domain.");
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

  await runDomainCheck(msg, text);
});

initDatabase();