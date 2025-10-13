import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  LOVABLE_API_URL,
  TENANT_ID,
  PORT = 3000
} = process.env;

// Setup receiver
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET
});

// Setup Bolt app
const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

// Slash command: /ask
app.command('/ask', async ({ command, ack, respond, client }) => {
  await ack();

  const question = (command.text || '').trim();

  if (!question) {
    await respond({
      text: "Type a question after /ask, e.g. `/ask What is our leave policy?`",
      response_type: "ephemeral"
    });
    return;
  }

  // Send immediate feedback to Slack user
  const processingMessage = await respond({
    text: "_Processing your question..._",
    response_type: "ephemeral"
  });

  try {
    console.log("Sending request to Lovable with tenantId:", TENANT_ID);
    const res = await fetch(LOVABLE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        user: command.user_id,
        tenantId: TENANT_ID
      })
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || "No answer found.";

    // Replace processing message with answer
    await client.chat.update({
      channel: command.channel_id,
      ts: processingMessage.ts,
      text,
    });

  } catch (e) {
    console.error("Error querying Lovable:", e);
    await client.chat.update({
      channel: command.channel_id,
      ts: processingMessage.ts,
      text: "⚠️ Sorry, something went wrong talking to the knowledge service."
    });
  }
});

// Health check
receiver.app.use(bodyParser.json());
receiver.app.get('/health', (_req, res) => res.status(200).send('ok'));

// Start app
(async () => {
  await app.start(PORT);
  console.log(`Slack bridge running on port ${PORT}`);
})();
