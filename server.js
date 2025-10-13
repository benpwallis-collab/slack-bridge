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

const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

app.command("/ask", async ({ command, ack, respond, client }) => {
  await ack();

  const question = (command.text || "").trim();
  if (!question) {
    await respond({
      text: "Type a question after /ask, e.g. `/ask What is our leave policy?`",
      response_type: "ephemeral"
    });
    return;
  }

  // 1️⃣ Send immediate “processing…” message
  const processing = await respond({
    text: `⏳ Searching for: *${question}* ...`,
    response_type: "ephemeral"
  });

  try {
    // 2️⃣ Call your Lovable backend
    const res = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, user: command.user_id })
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || "No answer found.";

    // 3️⃣ Update the message once done
    await client.chat.update({
      channel: processing.channel,
      ts: processing.ts,
      text: `💡 *Answer to:* ${question}\n\n${text}`
    });

  } catch (e) {
    await client.chat.update({
      channel: processing.channel,
      ts: processing.ts,
      text: "❌ Sorry, something went wrong talking to the knowledge service."
    });
  }
});

(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
