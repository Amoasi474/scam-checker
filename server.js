const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf?.toString();
    },
  })
);

// Health check
app.get("/", (req, res) => {
  res.status(200).send("ScamChecker API is running.");
});

// Test route
app.get("/payment-success", (req, res) => {
  console.log("GET /payment-success hit");
  return res.status(200).send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
        <h1>✅ Payment Successful</h1>
        <p>Your payment was received.</p>
        <p>You can return to Telegram now.</p>
      </body>
    </html>
  `);
});

// Webhook route
app.post("/paystack/webhook", async (req, res) => {
  console.log("POST /paystack/webhook hit");

  try {
    const secret = process.env.PAYSTACK_SECRET;
    if (!secret) {
      console.log("Missing PAYSTACK_SECRET");
      return res.status(500).send("Missing PAYSTACK_SECRET");
    }

    const signature = req.headers["x-paystack-signature"];
    const hash = crypto
      .createHmac("sha512", secret)
      .update(req.rawBody || JSON.stringify(req.body))
      .digest("hex");

    if (hash !== signature) {
      console.log("Invalid Paystack signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;
    console.log("Webhook event:", event?.event);

    if (event?.event === "charge.success") {
      const telegramId = Number(event?.data?.metadata?.telegram_id);

      if (!telegramId) {
        console.log("No telegram_id in metadata");
        return res.sendStatus(200);
      }

      console.log("Successful payment for telegramId:", telegramId);

      if (global.addPremiumUser) {
        await global.addPremiumUser(telegramId);
        console.log("Premium user added to database");
      } else {
        console.log("global.addPremiumUser is missing");
      }

      if (global.bot) {
        await global.bot.sendMessage(
          telegramId,
          "✅ Payment confirmed. Your premium access has been activated."
        );
        console.log("Telegram confirmation sent");
      } else {
        console.log("global.bot is missing");
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).send("Webhook failed");
  }
});

app.listen(PORT, () => {
  console.log(`Scam Checker running on port ${PORT}`);
});