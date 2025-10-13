import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  TENANT_ID,
  LOVABLE_API_URL,
  PORT = 3000
} = process.env;

// --- Express setup for health checks ---
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

// --- Initialize Slack Bolt app ---
const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

// --- /ask command handler ---
app.command("/ask", async ({ command, ack, respond }) => {
  await ack();

  const question = (command.text || "").trim();
  const user = command.user_id;

  if (!question) {
    await respond({
      text: "Type a question after `/ask`, e.g. `/ask What is our leave policy?`",
      response_type: "ephemeral"
    });
    return;
  }

  // 1️⃣ Immediate feedback (always works, even in DMs)
  await respond({
    text: `⏳ Searching for: *${question}* ...`,
    response_type: "ephemeral"
  });

  try {
    // 2️⃣ Call Lovable backend
    const res = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, user })
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || "No answer found.";

    // 3️⃣ Respond with final answer
    await respond({
      text: `💡 *Answer to:* ${question}\n\n${text}`,
      response_type: "ephemeral"
    });

  } catch (error) {
    console.error("Slack bridge error:", error);
    await respond({
      text: "❌ Sorry, something went wrong talking to the knowledge service.",
      response_type: "ephemeral"
    });
  }
});

// --- Start the Bolt app ---
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
