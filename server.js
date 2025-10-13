import { App, ExpressReceiver } from '@slack/bolt';
import fetch from 'node-fetch';
import express from 'express';

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const LOVABLE_API_URL = process.env.LOVABLE_API_URL;
const TENANT_ID = process.env.TENANT_ID;
const PORT = process.env.PORT || 3000;

console.log('✅ Loaded TENANT_ID:', TENANT_ID);

const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

// Slack command handler
app.command('/ask', async ({ command, ack, client }) => {
  await ack();

  try {
    // 1. Send immediate processing message and capture the message timestamp + channel
    const interim = await client.chat.postMessage({
      channel: command.channel_id,
      text: '🔍 Processing your question, please wait...',
    });

    const responseUrl = `${LOVABLE_API_URL}/ask`;
    const payload = {
      question: command.text,
      user: command.user_id,
      tenantId: TENANT_ID,
    };

    console.log('📤 Sending request to Lovable with tenantId:', payload.tenantId);

    const res = await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await res.json();
    const answer = result.answer || '⚠️ No answer found. Please check with HR or IT.';

    // 2. Update the original message with the real answer
    await client.chat.update({
      channel: interim.channel,
      ts: interim.ts,
      text: answer,
    });

  } catch (err) {
    console.error('❌ Error handling /ask command:', err);

    try {
      // Send fallback error message if we can't update
      await client.chat.postMessage({
        channel: command.channel_id,
        text: '⚠️ There was an error while processing your question.',
      });
    } catch (e) {
      console.error('💥 Failed to send fallback error message:', e);
    }
  }
});

receiver.app.listen(PORT, () => {
  console.log(`🚀 Slack bridge is running on port ${PORT}`);
});
