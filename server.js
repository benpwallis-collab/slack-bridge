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
  // --- Immediate ACK + debug ---
  await ack();
  console.log("✅ /ask acknowledged to Slack:", command.text);
  await respond({
    text: "⚙️ Working on it...",
    response_type: "ephemeral"
  });

  // --- Run heavy logic asynchronously to avoid Slack timeout ---
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

      // --- RAG query with timeout ---
      console.log(`📤 Sending query to RAG`);
      console.log(`🪵 LOG: RAG query endpoint: ${RAG_QUERY_URL}`);

      const payload = { question, source: "slack" };
      console.log("🪵 LOG: RAG payload keys:", Object.keys(payload));

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000); // 10 s timeout

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
        console.log("📄 RAG response keys:", Object.keys(ragData));
      } catch (err) {
        clearTimeout(timeout);
        console.error("❌ RAG fetch failed or timed out:", err);
        await respond({
          text: "⚠️ The RAG service didn’t respond (timeout or network error).",
          response_type: "ephemeral"
        });
        return;
      }

      // --- Parse and clean answer ---
      let answer = ragData.answer || ragData.text || "No answer found.";
      answer = answer
        .replace(/Source[s]?:[\s\S]*/gi, "")
        .replace(
          /\n[\*\-•]\s*[A-Za-z0-9_\-().,\s]+(Updated|No Link Available|Link|http).*$/gim,
          ""
        )
        .replace(
          /\n\*\s*[A-Za-z0-9_\-().,\s]+Updated:[^\n]*/gim,
          ""
        )
        .trim();

      // --- Format sources ---
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

      // --- Respond to Slack ---
      await respond({
        text: `💡 *Answer to:* ${question}\n\n${answer}${sourcesText}`,
        response_type: "ephemeral"
      });
      console.log("🟩 Response sent to Slack successfully");
    } catch (error) {
      console.error("❌ Slack bridge async error:", error);
      await respond({
        text: "❌ Sorry, something went wrong while processing your question.",
        response_type: "ephemeral"
      });
    }
  })();
});

// Message event listener for keyword-triggered interventions
app.message(async ({ message, say, client }) => {
  // Filter: Only process channel messages, ignore bot messages, threads, and edits
  if (
    message.subtype ||
    message.bot_id ||
    message.channel_type !== "channel"
  ) {
    return;
  }

  console.log(
    `📨 Message received in channel ${message.channel}: "${message.text}"`
  );

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

    // Call slack-intervention edge function
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

    const intervention = await interventionRes.json();
    console.log(`📥 Intervention response:`, {
      enabled: intervention.enabled,
      should_respond: intervention.should_respond,
      respond_mode: intervention.respond_mode
    });

    // If intervention triggered, post response
    if (intervention.should_respond && intervention.reply_text) {
      console.log(`✅ Intervention triggered: ${intervention.respond_mode}`);

      // Format sources similar to /ask
      let sourcesText = "";
      if (intervention.sources && intervention.sources.length > 0) {
        const sourcesList = intervention.sources.map((s) => {
          const title = s.title;
          const url = s.url;
          return url ? `• <${url}|${title}>` : `• ${title}`;
        });
        sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
      }

      const fullText = `${intervention.reply_text}${sourcesText}`;

      // Handle different response modes
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
        // channel_message - post as normal message
        await say({
          text: fullText
        });
      }

      console.log(`🟩 Intervention response sent successfully`);
    } else {
      console.log(`ℹ️ No intervention needed for this message`);
    }
  } catch (error) {
    console.error("❌ Message intervention error:", error);
    // Silent fail - don't post error messages for every message
  }
});

// Start the app
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
