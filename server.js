import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import fetch from "node-fetch";
import bodyParser from "body-parser";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_TENANT_LOOKUP_URL,
  RAG_QUERY_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  PORT = 3000
} = process.env;

// Helper: relative date formatter
function getRelativeDate(dateString) {
  const now = new Date();
  const then = new Date(dateString);
  const diffMs = now - then;
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 1) return `${days} days ago`;
  if (days === 1) return `1 day ago`;
  if (hours >= 1) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (minutes >= 1) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  return `just now`;
}

// Express receiver for health check
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

// Slack Bolt app
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

// Slash command: /ask
app.command("/ask", async ({ command, ack, respond }) => {
  await ack();
  console.log("✅ /ask acknowledged to Slack:", command.text);
  await respond({
    text: "⚙️ Working on it...",
    response_type: "ephemeral"
  });

  (async () => {
    const question = (command.text || "").trim();
    const teamId = command.team_id;

    if (!question) {
      await respond({
        text: "Type a question after `/ask`, e.g. `/ask What is our leave policy?`",
        response_type: "ephemeral"
      });
      return;
    }

    try {
      console.log(`🔍 Looking up tenant for Slack team: ${teamId}`);
      const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY
        },
        body: JSON.stringify({ slack_team_id: teamId })
      });

      if (!tenantRes.ok) {
        throw new Error(`Failed to resolve tenant. Status: ${tenantRes.status}`);
      }

      const { tenant_id } = await tenantRes.json();
      console.log(`🏢 Tenant resolved: ${tenant_id}`);

      const payload = { question, source: "slack" };
      console.log("🪵 LOG: RAG payload keys:", Object.keys(payload));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      let ragData;
      try {
        const ragRes = await fetch(RAG_QUERY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SUPABASE_ANON_KEY,
            "x-tenant-id": tenant_id
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeout);

        console.log("📥 RAG status:", ragRes.status);
        ragData = await ragRes.json();
      } catch (err) {
        clearTimeout(timeout);
        console.error("❌ RAG fetch failed:", err);
        await respond({
          text: "⚠️ RAG service didn’t respond.",
          response_type: "ephemeral"
        });
        return;
      }

      let answer = ragData.answer || ragData.text || "No answer found.";
      answer = answer
        .replace(/Source[s]?:[\s\S]*/gi, "")
        .trim();

      let sourcesText = "";
      const sources = ragData.sources || [];
      if (sources.length > 0) {
        const sourcesList = sources.map((s) => {
          const title = s.title;
          const updated = getRelativeDate(s.updated_at);
          const url = s.url;
          return url
            ? `• <${url}|${title}> (Updated: ${updated})`
            : `• ${title} (Updated: ${updated})`;
        });
        sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
      }

      await respond({
        text: `💡 *Answer to:* ${question}\n\n${answer}${sourcesText}`,
        response_type: "ephemeral"
      });
    } catch (error) {
      console.error("❌ Slack bridge async error:", error);
      await respond({
        text: "❌ Something went wrong.",
        response_type: "ephemeral"
      });
    }
  })();
});

// Message event listener (interventions)
app.message(async ({ message, say, client }) => {
  if (
    message.subtype ||
    message.bot_id ||
    message.channel_type !== "channel"
  ) {
    return;
  }

  console.log(`📨 Message received: "${message.text}"`);

  try {
    const teamId = message.team;

    console.log(`🔍 Looking up tenant for message intervention`);
    const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ slack_team_id: teamId })
    });

    if (!tenantRes.ok) {
      console.error(`❌ Tenant lookup failed: ${tenantRes.status}`);
      return;
    }

    const { tenant_id } = await tenantRes.json();

    const interventionRes = await fetch(
      `${SUPABASE_URL}/functions/v1/slack-intervention`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          "x-tenant-id": tenant_id
        },
        body: JSON.stringify({
          tenant_id: tenant_id,
          slack_team_id: teamId,
          message_text: message.text,
          metadata: {
            channel_id: message.channel,
            thread_ts: message.thread_ts,
            user_id: message.user,
            message_ts: message.ts
          }
        })
      }
    );

    // 🔍 DEBUG: Intervention fetch logging
    console.log(`🔍 Intervention HTTP Status: ${interventionRes.status}`);
    const responseText = await interventionRes.text();
    console.log(`🔍 Intervention Raw Response: ${responseText}`);

    let intervention;
    try {
      intervention = JSON.parse(responseText);
    } catch (err) {
      console.error("❌ Failed to parse intervention JSON:", err);
      return;
    }

    console.log("📥 Intervention response:", intervention);

    if (intervention.should_respond && intervention.reply_text) {
      let sourcesText = "";
      if (intervention.sources?.length > 0) {
        const sourcesList = intervention.sources.map((s) => {
          return s.url ? `• <${s.url}|${s.title}>` : `• ${s.title}`;
        });
        sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
      }

      const fullText = `${intervention.reply_text}${sourcesText}`;

      if (intervention.respond_mode === "ephemeral") {
        await client.chat.postEphemeral({
          channel: message.channel,
          user: message.user,
          text: fullText
        });
      } else if (intervention.respond_mode === "thread_reply") {
        await say({
          text: fullText,
          thread_ts: message.thread_ts || message.ts
        });
      } else {
        await say({ text: fullText });
      }

      console.log(`🟩 Intervention response sent`);
    } else {
      console.log(`ℹ️ No intervention needed`);
    }
  } catch (error) {
    console.error("❌ Message intervention error:", error);
  }
});

// Start the app
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
