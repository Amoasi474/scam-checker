require("./server");

const TelegramBot = require("node-telegram-bot-api");
const { Pool } = require("pg");
const axios = require("axios");

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

// expose after bot exists
global.bot = bot;
global.PREMIUM_USERS = PREMIUM_USERS;
global.addPremiumUser = addPremiumUser;