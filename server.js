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
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.sendStatus(401);
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const telegramId = event.data.metadata.telegram_id;

      if (!telegramId) {
        console.log("No telegram id in metadata");
        return res.sendStatus(200);
      }

      console.log("Payment received for:", telegramId);

      /* ACTIVATE PREMIUM */
      global.PREMIUM_USERS.add(Number(telegramId));

      /* SEND TELEGRAM MESSAGE */
      if (global.bot) {
        await global.bot.sendMessage(
          telegramId,
          "🎉 Payment successful!\n\nYour Premium plan is now active."
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
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