import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  LOVABLE_API_URL,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  PORT = 3000,
} = process.env;

const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET,
});

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

app.command('/ask', async ({ command, ack, respond, client }) => {
  await ack();

  const question = (command.text || '').trim();
  const userId = command.user_id;

  if (!question) {
    await respond({
      text: 'Type a question after /ask, e.g. `/ask What is our leave policy?`',
      response_type: 'ephemeral',
    });
    return;
  }

  // Initial feedback to user
  await respond({
    text: '🤖 Thinking... looking up the answer securely for your org.',
    response_type: 'ephemeral',
  });

  try {
    // Get Slack user email
    const userInfo = await client.users.info({ user: userId });
    const userEmail = userInfo.user?.profile?.email;

    if (!userEmail) {
      await respond({
        text: '❌ Could not retrieve your email from Slack. Please try again.',
        response_type: 'ephemeral',
      });
      return;
    }

    // Look up tenant_id in Supabase
    const { data: userRow, error } = await supabase
      .from('user_roles')
      .select('tenant_id')
      .eq('email', userEmail)
      .single();

    if (error || !userRow?.tenant_id) {
      await respond({
        text: '❌ You are not assigned to an organization yet. Ask an admin to invite you properly.',
        response_type: 'ephemeral',
      });
      return;
    }

    const tenantId = userRow.tenant_id;

    // Call Lovable RAG backend
    const res = await fetch(`${LOVABLE_API_URL}/functions/v1/rag-query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({
        question,
        userEmail,
        tenantId, // 🟢 Important!
      }),
    });

    const data = await res.json().catch(() => ({}));
    const text = data.answer || data.text || '⚠️ No answer found.';

    await respond({
      text,
      response_type: 'ephemeral',
    });
  } catch (e) {
    console.error('Slack bridge error:', e);
    await respond({
      text: '❌ Something went wrong talking to the knowledge system.',
      response_type: 'ephemeral',
    });
  }
});

receiver.app.use(bodyParser.json());
receiver.app.get('/health', (_req, res) => res.status(200).send('ok'));

(async () => {
  await app.start(PORT);
  console.log(`Slack bridge running on port ${PORT}`);
})();
