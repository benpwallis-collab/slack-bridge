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
app.command("/ask", async ({ command, ack, client }) => {
  await ack();

  const question = (command.text || "").trim();
  const user = command.user_id;
  const channel = command.channel_id;

  if (!question) {
    await client.chat.postEphemeral({
      channel,
      user,
      text: "Type a question after `/ask`, e.g. `/ask What is our leave policy?`"
    });
    return;
  }

  // 1️⃣ Send initial “processing…” message (ephemeral, includes message_ts + channel)
  const processing = await client.chat.postEphemeral({
    channel,
    user,
    text: `⏳ Searching for: *${question}* ...`
  });

  try {
    // Optional: show Slack “typing…” indicator
    await client.chat.typing({ channel });

    // 2️⃣ Call your Lovable knowledge API
    const res = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, user })
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || "No answer found.";

    // 3️⃣ Update ephemeral message with the final answer
    await client.chat.update({
      channel: processing.channel,
      ts: processing.message_ts,
      text: `💡 *Answer to:* ${question}\n\n${text}`
    });

  } catch (error) {
    console.error("Slack bridge error:", error);
    await client.chat.postEphemeral({
      channel,
      user,
      text: "❌ Sorry, something went wrong talking to the knowledge service."
    });
  }
});

// --- Start the Bolt app ---
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
