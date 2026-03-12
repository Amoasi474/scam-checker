const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------------------------
BODY PARSING
----------------------------*/
app.use(express.json());

/* ---------------------------
SUCCESS PAGE
----------------------------*/
app.get("/payment-success", (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:50px;">
        <h1>✅ Payment Successful</h1>
        <p>Your premium plan will activate shortly.</p>
        <p>You can now return to Telegram.</p>
      </body>
    </html>
  `);
});

/* ---------------------------
PAYSTACK WEBHOOK
----------------------------*/
app.post("/paystack/webhook", async (req, res) => {
  try {

    const event = req.body;

    if (!event || !event.event) {
      console.log("Invalid webhook payload");
      return res.sendStatus(200);
    }

    if (event.event === "charge.success") {

      const metadata = event.data?.metadata;

      if (!metadata || !metadata.telegram_id) {
        console.log("No telegram_id in metadata");
        return res.sendStatus(200);
      }

      const telegramId = Number(metadata.telegram_id);

      console.log("Activating premium for:", telegramId);

      PREMIUM_USERS.add(telegramId);

      await bot.sendMessage(
        telegramId,
        "🎉 Payment received! Premium activated."
      );
    }

    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(200);
  }
});

/* ---------------------------
HEALTH CHECK
----------------------------*/
app.get("/", (req, res) => {
  res.send("ScamChecker API is running.");
});

/* ---------------------------
START SERVER
----------------------------*/
app.listen(PORT, () => {
  console.log(`Scam Checker running on port ${PORT}`);
});