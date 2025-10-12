import { App, ExpressReceiver } from "@slack/bolt";
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  LOVABLE_API_URL,
  PORT = 3000
} = process.env;

const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

app.command("/ask", async ({ command, ack, respond }) => {
  await ack();
  const question = (command.text || "").trim();

  if (!question) {
    await respond({ text: "Type a question after /ask, e.g. /ask What is our leave policy?", response_type: "ephemeral" });
    return;
  }

  try {
    const res = await fetch(LOVABLE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, user: command.user_id })
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || "No answer found.";

    await respond({ text, response_type: "ephemeral" });
  } catch (e) {
    await respond({ text: "Sorry, something went wrong talking to the knowledge service.", response_type: "ephemeral" });
  }
});

receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

(async () => {
  await app.start(PORT);
  console.log(`Slack bridge running on ${PORT}`);
})();
