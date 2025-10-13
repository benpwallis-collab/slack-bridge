import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  LOVABLE_API_URL,
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

  try {
    console.log(`Received /ask from ${command.user_name}: ${question}`);
    const res = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, user: command.user_id })
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || "No answer found.";

    await respond({ text, response_type: "ephemeral" });
  } catch (error) {
    console.error("Error communicating with Lovable:", error);
    await respond({
      text: "Sorry, something went wrong talking to the knowledge service.",
      response_type: "ephemeral"
    });
  }
});

// ---------- Start the app ----------
(async () => {
  await app.start(PORT);
  console.log(`✅ Slack bridge running on port ${PORT}`);
  console.log(`🌍 Health check: https://slack-bridge.onrender.com/health`);
})();
