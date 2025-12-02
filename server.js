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

// -----------------------------------------------------
// Helper: Robust team ID extraction
// -----------------------------------------------------
function resolveTeamId({ message, command, context, body }) {
  return (
    command?.team_id ||
    message?.team ||
    message?.source_team ||
    body?.team_id ||
    context?.teamId ||
    (message?.event_context ? message.event_context.split("-")[1] : null)
  );
}

// -----------------------------------------------------
// Slash command: /ask
// -----------------------------------------------------
app.command("/ask", async ({ command, ack, respond, context, body }) => {
  await ack();

  const teamId = resolveTeamId({ command, context, body });

  console.log("🏷 /ask teamId =", teamId);

  if (!teamId) {
    await respond({
      text: "❌ Could not determine Slack workspace.",
      response_type: "ephemeral"
    });
    return;
  }

  await respond({
    text: "⚙️ Working on it...",
    response_type: "ephemeral"
  });

  const question = (command.text || "").trim();

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
      throw new Error(`Failed tenant lookup: ${tenantRes.status}`);
    }

    const { tenant_id } = await tenantRes.json();
    console.log("🏢 Tenant =", tenant_id);

    // Build RAG payload
    const payload = { question, source: "slack" };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

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

    const ragData = await ragRes.json();

    let answer = ragData.answer || ragData.text || "No answer found.";
    answer = answer.replace(/Source[s]?:[\s\S]*/gi, "").trim();

    let sourcesText = "";
    if (ragData.sources?.length > 0) {
      const sourcesList = ragData.sources.map((s) => {
        const updated = getRelativeDate(s.updated_at);
        return s.url
          ? `• <${s.url}|${s.title}> (Updated: ${updated})`
          : `• ${s.title} (Updated: ${updated})`;
      });
      sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
    }

    await respond({
      text: `💡 *Answer to:* ${question}\n\n${answer}${sourcesText}`,
      response_type: "ephemeral"
    });
  } catch (err) {
    console.error("❌ /ask error:", err);
    await respond({
      text: "❌ Something went wrong.",
      response_type: "ephemeral"
    });
  }
});

// -----------------------------------------------------
// Message event listener (interventions)
// -----------------------------------------------------
app.message(async ({ message, say, client, context, body }) => {
  try {
    if (
      message.subtype ||
      message.bot_id ||
      message.channel_type !== "channel"
    ) {
      return;
    }

    console.log(`📨 Message received: "${message.text}"`);

    // 1. Resolve Slack team ID
    const teamId = resolveTeamId({ message, context, body });
    console.log("🏷 Intervention teamId =", teamId);

    if (!teamId) {
      console.error("❌ Could not determine Slack team ID");
      return;
    }

    // 2. Channel ID
    const channelId = message.channel;
    console.log("📺 Channel ID:", channelId);

    // 3. Debug: Check token workspace matches
    try {
      const auth = await client.auth.test();
      console.log("🔐 auth.test():", auth);
      if (auth.team_id !== teamId) {
        console.warn(
          "⚠️ Token workspace mismatch! Token team:",
          auth.team_id,
          "Expected:",
          teamId
        );
      }
    } catch (err) {
      console.error("❌ auth.test() failed:", err);
    }

    // 4. Tenant lookup
    const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ slack_team_id: teamId })
    });

    if (!tenantRes.ok) {
      console.error("❌ Tenant lookup failed:", tenantRes.status);
      return;
    }

    const { tenant_id } = await tenantRes.json();
    console.log("🏢 Tenant =", tenant_id);

    // 5. Call intervention function
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
          tenant_id,
          slack_team_id: teamId,
          message_text: message.text,
          metadata: {
            channel_id: channelId,
            thread_ts: message.thread_ts,
            user_id: message.user,
            message_ts: message.ts
          }
        })
      }
    );

    const raw = await interventionRes.text();
    console.log("📥 Intervention Raw:", raw);

    let intervention;
    try {
      intervention = JSON.parse(raw);
    } catch {
      console.error("❌ Intervention JSON parse failed");
      return;
    }

    if (!intervention.should_respond || !intervention.reply_text) {
      console.log("ℹ️ No intervention needed");
      return;
    }

    // Build sources text
    let sourcesText = "";
    if (intervention.sources?.length > 0) {
      const sourcesList = intervention.sources.map((s) =>
        s.url ? `• <${s.url}|${s.title}>` : `• ${s.title}`
      );
      sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
    }

    const fullText = `${intervention.reply_text}${sourcesText}`;

    // Respond mode handling
    if (intervention.respond_mode === "ephemeral") {
      try {
        await client.chat.postEphemeral({
          channel: channelId,
          user: message.user,
          text: fullText
        });
      } catch (err) {
        console.error("❌ Ephemeral failed, falling back:", err);
        await say({
          text: fullText,
          thread_ts: message.thread_ts || message.ts
        });
      }
    } else if (intervention.respond_mode === "thread_reply") {
      await say({
        text: fullText,
        thread_ts: message.thread_ts || message.ts
      });
    } else {
      await say({ text: fullText });
    }

    console.log("🟩 Intervention sent");
  } catch (err) {
    console.error("❌ Intervention error:", err);
  }
});

// -----------------------------------------------------
// Start the service
// -----------------------------------------------------
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
