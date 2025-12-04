import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { WebClient } from "@slack/web-api";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,           // fallback token only
  SLACK_TENANT_LOOKUP_URL,   // returns { tenant_id, slack_bot_token, ... }
  RAG_QUERY_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  INTERNAL_LOOKUP_SECRET,    // 🔐 shared secret with slack-tenant-lookup
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

// Slack Bolt app – token is only used by Bolt's internal client; we won't use it for posting
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

// -----------------------------------------------------
// Helper: robust team ID extraction
// -----------------------------------------------------
function resolveTeamId({ message, command, context, body }) {
  return (
    command?.team_id ||                 // slash commands
    message?.team ||                    // many message events
    message?.source_team ||             // some events
    body?.team_id ||                    // raw payload
    context?.teamId ||                  // Bolt context
    (message?.event_context
      ? message.event_context.split("-")[1] // ECxxx-T{team}-C{channel}
      : null)
  );
}

// -----------------------------------------------------
// Helper: lookup tenant + per-tenant Slack client
// -----------------------------------------------------
async function getTenantAndSlackClient({ teamId }) {
  console.log("🔍 Looking up tenant for Slack team:", teamId);

  if (!SLACK_TENANT_LOOKUP_URL) {
    throw new Error("SLACK_TENANT_LOOKUP_URL is not set");
  }

  if (!SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_ANON_KEY is not set");
  }

  if (!INTERNAL_LOOKUP_SECRET) {
    console.error("❌ INTERNAL_LOOKUP_SECRET is not set – tenant lookup will fail (403)");
    throw new Error("INTERNAL_LOOKUP_SECRET is not configured");
  }

  const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      "x-internal-token": INTERNAL_LOOKUP_SECRET, // 🔐 secure internal auth
    },
    body: JSON.stringify({ slack_team_id: teamId })
  });

  if (!tenantRes.ok) {
    const text = await tenantRes.text().catch(() => "");
    console.error(
      `❌ Tenant lookup failed: ${tenantRes.status} ${tenantRes.statusText} – body: ${text}`
    );
    throw new Error(`Failed tenant lookup: ${tenantRes.status}`);
  }

  // ⬇️ This endpoint should return { tenant_id, slack_bot_token, ... }
  const { tenant_id, slack_bot_token } = await tenantRes.json();

  if (!tenant_id) {
    throw new Error("Tenant lookup did not return tenant_id");
  }

  if (!slack_bot_token) {
    console.warn(
      "⚠️ Tenant lookup did not return slack_bot_token – falling back to global SLACK_BOT_TOKEN (may cause cross-workspace issues)"
    );
  }

  const tokenToUse = slack_bot_token || SLACK_BOT_TOKEN;
  const slackClient = new WebClient(tokenToUse);

  return { tenant_id, slackClient, slack_bot_token: tokenToUse };
}

// -----------------------------------------------------
// Slash command: /ask
// -----------------------------------------------------
app.command("/ask", async ({ command, ack, respond, context, body }) => {
  await ack();
  console.log("✅ /ask acknowledged to Slack:", command.text);

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

  (async () => {
    const question = (command.text || "").trim();

    if (!question) {
      await respond({
        text: "Type a question after `/ask`, e.g. `/ask What is our leave policy?`",
        response_type: "ephemeral"
      });
      return;
    }

    try {
      const { tenant_id } = await getTenantAndSlackClient({ teamId });
      console.log("🏢 Tenant (for /ask) =", tenant_id);

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
      answer = answer.replace(/Source[s]?:[\s\S]*/gi, "").trim();

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
      console.error("❌ Slack bridge /ask error:", error);
      await respond({
        text: "❌ Something went wrong.",
        response_type: "ephemeral"
      });
    }
  })();
});

// -----------------------------------------------------
// Message event listener (interventions)
// -----------------------------------------------------
app.message(async ({ message, client, context, body }) => {
  try {
    if (
      message.subtype ||
      message.bot_id ||
      message.channel_type !== "channel"
    ) {
      return;
    }

    console.log(`📨 Message received: "${message.text}"`);

    // 1. Resolve team ID
    const teamId = resolveTeamId({ message, context, body });
    console.log("🏷 Intervention teamId =", teamId);

    if (!teamId) {
      console.error("❌ Could not determine Slack team ID from event");
      return;
    }

    const channelId = message.channel;
    console.log("📺 Channel ID:", channelId);

    // 2. Get tenant + per-tenant Slack client
    const { tenant_id, slackClient, slack_bot_token } =
      await getTenantAndSlackClient({ teamId });
    console.log("🏢 Tenant (intervention) =", tenant_id);

    // 3. Optional: verify token <-> team match for debugging
    try {
      const auth = await slackClient.auth.test();
      console.log("🔐 auth.test() (tenant-scoped):", auth);
      if (auth.team_id !== teamId) {
        console.warn(
          "⚠️ Token workspace mismatch (tenant client)!",
          "Token team:", auth.team_id,
          "Expected:", teamId
        );
      }
    } catch (err) {
      console.error("❌ auth.test() failed for tenant client:", err);
    }

    // 4. Call slack-intervention edge function
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

    if (!intervention.should_respond || !intervention.reply_text) {
      console.log(`ℹ️ No intervention needed`);
      return;
    }

    let sourcesText = "";
    if (intervention.sources?.length > 0) {
      const sourcesList = intervention.sources.map((s) => {
        return s.url ? `• <${s.url}|${s.title}>` : `• ${s.title}`;
      });
      sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
    }

    const fullText = `${intervention.reply_text}${sourcesText}`;

    // 5. Send response using *tenant-specific* Slack client
    if (intervention.respond_mode === "ephemeral") {
      try {
        await slackClient.chat.postEphemeral({
          channel: channelId,
          user: message.user,
          text: fullText
        });
        console.log("🟩 Intervention ephemeral response sent");
      } catch (err) {
        console.error(
          "❌ Ephemeral failed with tenant client, falling back to thread message:",
          err
        );
        await slackClient.chat.postMessage({
          channel: channelId,
          text: fullText,
          thread_ts: message.thread_ts || message.ts
        });
      }
    } else if (intervention.respond_mode === "thread_reply") {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: fullText,
        thread_ts: message.thread_ts || message.ts
      });
      console.log("🟩 Intervention thread reply sent");
    } else {
      await slackClient.chat.postMessage({
        channel: channelId,
        text: fullText
      });
      console.log("🟩 Intervention channel message sent");
    }
  } catch (error) {
    console.error("❌ Message intervention error:", error);
  }
});

// -----------------------------------------------------
// Start the app
// -----------------------------------------------------
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
