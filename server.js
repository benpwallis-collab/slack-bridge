import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  LOVABLE_API_URL,
  LOVABLE_API_KEY, // optional
  PORT = 3000
} = process.env;

// ---------- Setup Slack + Express ----------
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

// ---------- Health + Root Routes ----------
receiver.app.use(bodyParser.json());

receiver.app.get("/", (_req, res) => {
  res.status(200).send("Slack Bridge is running 🚀");
});

receiver.app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

// ---------- Optional test endpoint ----------
receiver.app.get("/test-lovable", async (_req, res) => {
  console.log("Testing Lovable connectivity:", LOVABLE_API_URL);
  try {
    const testRes = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LOVABLE_API_KEY ? { apikey: LOVABLE_API_KEY } : {})
      },
      body: JSON.stringify({ question: "ping test" }),
      timeout: 10000
    });
    const text = await testRes.text();
    console.log("Lovable test status:", testRes.status);
    console.log("Lovable test body:", text);
    res.status(testRes.status).send(text);
  } catch (err) {
    console.error("Lovable connectivity test failed:", err);
    res.status(500).send("Lovable connection failed");
  }
});

// ---------- Slack Event Verification ----------
receiver.app.post("/slack/events", (req, res, next) => {
  if (req.body?.type === "url_verification") {
    console.log("Responding to Slack URL verification challenge");
    return res.status(200).send({ challenge: req.body.challenge });
  }
  next(); // Continue to Bolt handlers
});

// ---------- Slash Command /ask ----------
app.command("/ask", async ({ command, ack, respond }) => {
  await ack();
  const question = (command.text || "").trim();

  if (!question) {
    await respond({
      text: "Type a question after /ask, e.g. `/ask What is our leave policy?`",
      response_type: "ephemeral"
    });
    return;
  }

  console.log("----- /ask START -----");
  console.log("Question:", question);
  console.log("LOVABLE_API_URL:", LOVABLE_API_URL);

  try {
    const res = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LOVABLE_API_KEY ? { apikey: LOVABLE_API_KEY } : {})
      },
      body: JSON.stringify({ question, user: command.user_id }),
      timeout: 15000
    });

    console.log("Lovable fetch status:", res.status);
    console.log("Lovable response headers:", Object.fromEntries(res.headers.entries()));

    const textBody = await res.text();
    console.log("Lovable raw response:", textBody);

    let data = {};
    try { data = JSON.parse(textBody); } catch { console.warn("Response not JSON-parsable"); }

    const text = data.answer || data.text || "No answer found.";
    await respond({ text, response_type: "ephemeral" });
  } catch (error) {
    console.error("Lovable fetch failed:", error);
    await respond({
      text: "Error reaching Lovable backend.",
      response_type: "ephemeral"
    });
  }

  console.log("----- /ask END -----");
});

// ---------- Start the app ----------
(async () => {
  await app.start(PORT);
  console.log(`✅ Slack bridge running on port ${PORT}`);
  console.log(`🌍 Health check: https://slack-bridge.onrender.com/health`);
})();
