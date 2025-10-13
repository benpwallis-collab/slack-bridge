// server.js
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const expressReceiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: expressReceiver,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getTenantIdBySlackTeamId(teamId) {
  const { data, error } = await supabase
    .from('tenants')
    .select('id')
    .eq('slack_team_id', teamId)
    .single();

  if (error || !data) {
    console.error('❌ Tenant not found for team:', teamId, error);
    throw new Error(`Tenant not found for Slack team: ${teamId}`);
  }

  return data.id;
}

app.command('/ask', async ({ command, ack, respond, client }) => {
  await ack();

  // 🧠 Log the Slack team_id (copy this from Render logs to update Supabase)
  console.log('🌍 Slack team_id:', command.team_id);
  console.log('👤 Slack user_id:', command.user_id);
  console.log('💬 Question asked:', command.text);

  try {
    await respond({ text: '🤖 Processing your question...' });

    const tenantId = await getTenantIdBySlackTeamId(command.team_id);

    const response = await fetch(`${process.env.LOVABLE_API_URL}/rag-query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
      },
      body: JSON.stringify({
        question: command.text,
        userEmail: command.user_id, // Or fetch actual email if needed
      }),
    });

    const data = await response.json();

    await client.chat.postMessage({
      channel: command.channel_id,
      text: data.answer || 'No answer found.',
      thread_ts: command.ts,
    });
  } catch (error) {
    console.error('❗ Error handling /ask:', error);
    await respond({
      text: '⚠️ Sorry, I couldn’t process your request. Please try again or contact support.',
    });
  }
});

(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ Slack Bolt app is running!');
})();
