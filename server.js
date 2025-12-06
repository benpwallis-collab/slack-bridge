import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { WebClient } from "@slack/web-api";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import crypto from "crypto";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,           // fallback token only
  SLACK_TENANT_LOOKUP_URL,   // returns { tenant_id, slack_bot_token, ... }
  RAG_QUERY_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  INTERNAL_LOOKUP_SECRET,    // shared secret with slack-tenant-lookup
  LOVABLE_API_KEY,
  INSIGHTS_SAMPLE_RATE,      // optional, for example "0.25"
  INSIGHTS_MAX_CHARS,        // optional, for example "1500"
  INSIGHTS_MIN_CHARS_FOR_EMBEDDING, // optional, for example "20"
  PORT = 3000
} = process.env;

// ----------------------------------------------
// INSIGHTS CONFIG (SAMPLING + LIMITS)
// ----------------------------------------------
const INSIGHTS_SAMPLE = (() => {
  const v = parseFloat(INSIGHTS_SAMPLE_RATE || "0.25");
  if (Number.isNaN(v)) return 0.25;
  return Math.min(1, Math.max(0, v));
})();

const INSIGHTS_MAX_LEN = (() => {
  const v = parseInt(INSIGHTS_MAX_CHARS || "1500", 10);
  if (Number.isNaN(v) || v <= 0) return 1500;
  return v;
})();

const INSIGHTS_MIN_LEN = (() => {
  const v = parseInt(INSIGHTS_MIN_CHARS_FOR_EMBEDDING || "20", 10);
  if (Number.isNaN(v) || v <= 0) return 20;
  return v;
})();

// ----------------------------------------------
// RELATIVE DATE FORMATTER
// ----------------------------------------------
function getRelativeDate(dateString) {
  const now = new Date();
  const then = new Date(dateString);
  const diff = now - then;

  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  if (day > 1) return `${day} days ago`;
  if (day === 1) return "1 day ago";
  if (hr >= 1) return `${hr} hour${hr > 1 ? "s" : ""} ago`;
  if (min >= 1) return `${min} minute${min > 1 ? "s" : ""} ago`;
  return "just now";
}

// ----------------------------------------------
// EXPRESS RECEIVER + HEALTH CHECK
// ----------------------------------------------
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

// Slack Bolt app - token is only used by Bolt's internal client; we do not use it for posting
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
    console.error("❌ INTERNAL_LOOKUP_SECRET is not set - tenant lookup will fail (403)");
    throw new Error("INTERNAL_LOOKUP_SECRET is not configured");
  }

  const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      "x-internal-token": INTERNAL_LOOKUP_SECRET
    },
    body: JSON.stringify({ slack_team_id: teamId })
  });

  if (!tenantRes.ok) {
    const text = await tenantRes.text().catch(() => "");
    console.error(
      `❌ Tenant lookup failed: ${tenantRes.status} ${tenantRes.statusText} - body: ${text}`
    );
    throw new Error(`Failed tenant lookup: ${tenantRes.status}`);
  }

  const { tenant_id, slack_bot_token } = await tenantRes.json();

  if (!tenant_id) {
    throw new Error("Tenant lookup did not return tenant_id");
  }

  if (!slack_bot_token) {
    console.warn(
      "⚠️ Tenant lookup did not return slack_bot_token - falling back to global SLACK_BOT_TOKEN (may cause cross-workspace issues)"
    );
  }

  const tokenToUse = slack_bot_token || SLACK_BOT_TOKEN;
  const slackClient = new WebClient(tokenToUse);

  return { tenant_id, slackClient, slack_bot_token: tokenToUse };
}

// -----------------------------------------------------
// INSIGHTS HELPERS
// -----------------------------------------------------

// More robust public-channel and privacy check
function isPublicChannel(message) {
  const channelType = message?.channel_type;
  const channelId = message?.channel;

  // Slack semantics:
  // D... = DM
  // G... = private channel or group
  // C... = public channel
  if (channelType && channelType !== "channel") return false;
  if (typeof channelId === "string" && !channelId.startsWith("C")) return false;

  return true;
}

// Basic eligibility gating (cheap checks)
function isEligibleForInsights(message) {
  if (!message || typeof message !== "object") return false;

  // Skip DMs, private channels etc
  if (!isPublicChannel(message)) return false;

  // Skip bot and system messages
  if (message.bot_id || message.subtype === "bot_message") return false;
  if (message.subtype === "file_share") return false;

  const systemSubtypes = ["channel_join", "channel_leave", "channel_topic", "channel_purpose"];
  if (systemSubtypes.includes(message.subtype)) return false;

  const text = typeof message.text === "string" ? message.text : "";
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 4) return false;

  // Skip emoji-only messages
  if (/^(:\w+:\s*)+$/.test(text.trim())) return false;

  return true;
}

// Skip messages that are basically numeric or date noise
function isNumericOrDateOnly(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Only digits, spaces, separators, punctuation common in dates and times
  if (!/^[\d\s:\/\-.,]+$/.test(trimmed)) return false;

  // Must contain at least one digit
  if (!/\d/.test(trimmed)) return false;

  return true;
}

// Sanitize text to strip obvious PII type patterns
function sanitizeTextForInsights(text) {
  if (!text) return "";

  let sanitized = String(text);

  // Remove Slack user and channel mentions
  sanitized = sanitized
    .replace(/<@[\w]+>/g, " ")
    .replace(/<#[\w]+>/g, " ");

  // Remove URLs
  sanitized = sanitized.replace(/https?:\/\/\S+/gi, " ");

  // Remove emails
  sanitized = sanitized.replace(/[\w.+-]+@[\w.-]+/gi, " ");

  // Remove phone like patterns
  sanitized = sanitized.replace(/\b\+?\d{1,3}[-.\s]?\d{2,4}[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/g, " ");

  // Remove obvious date formats to reduce re-identification
  sanitized = sanitized.replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ");

  // Remove long digit sequences (IDs, postcodes, etc)
  sanitized = sanitized.replace(/\b\d{4,}\b/g, " ");

  // Remove most punctuation
  sanitized = sanitized.replace(/[^\w\s]/g, " ");

  // Collapse whitespace
  sanitized = sanitized.replace(/\s+/g, " ").trim();

  return sanitized;
}

// Simple sentiment classification (no LLM needed)
function classifySentiment(text) {
  const lower = text.toLowerCase();

  const negativeWords = [
    "unsafe", "frustrated", "angry", "worried", "concerned", "problem",
    "issue", "hate", "bad", "worst", "terrible", "disappointed", "annoyed",
    "confused", "stuck", "broken", "failing", "urgent", "emergency"
  ];

  const positiveWords = [
    "great", "love", "excellent", "amazing", "happy", "excited", "thanks",
    "helpful", "appreciate", "awesome", "fantastic", "perfect", "wonderful",
    "good", "nice", "pleased", "delighted"
  ];

  const negScore = negativeWords.filter(w => lower.includes(w)).length;
  const posScore = positiveWords.filter(w => lower.includes(w)).length;

  if (negScore > posScore) return "negative";
  if (posScore > negScore) return "positive";
  return "neutral";
}

// Extract non-identifying keywords
function extractKeywords(text) {
  const cleaned = text.toLowerCase();

  const words = cleaned.split(/\s+/).filter(w => w.length > 3);

  const stopWords = new Set([
    "this", "that", "with", "from", "have", "been", "were", "they",
    "their", "would", "could", "should", "about", "what", "when",
    "where", "which", "there", "here", "just", "also", "only", "some",
    "very", "really", "actually", "basically", "literally"
  ]);

  const freq = {};
  for (const word of words) {
    if (!stopWords.has(word)) {
      freq[word] = (freq[word] || 0) + 1;
    }
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);
}

// Hash message for deduplication (one-way, cannot reconstruct)
function hashMessage(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// Get embedding from Lovable AI (cheapish operation)
async function getEmbedding(text) {
  if (!LOVABLE_API_KEY) {
    console.log("LOVABLE_API_KEY not set, skipping embedding");
    return null;
  }

  try {
    const response = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        input: text,
        model: "text-embedding-3-small"
      })
    });

    if (!response.ok) {
      console.error(
        "Embedding API error:",
        response.status,
        await response.text().catch(() => "")
      );
      return null;
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (err) {
    console.error("Embedding generation failed:", err);
    return null;
  }
}

// Process message for insights (async, non-blocking) with detailed logging
async function processInsightsSignal(message, tenantId) {
  try {
    console.log("🔬 Insights: Starting processing for message");

    // 0. Sampling gate to control costs
    if (INSIGHTS_SAMPLE <= 0) {
      console.log("🔬 Insights: Sampling disabled (rate=0)");
      return;
    }
    if (Math.random() > INSIGHTS_SAMPLE) {
      console.log(`🔬 Insights: Sampled out (rate=${INSIGHTS_SAMPLE})`);
      return;
    }

    // 1. Cheap eligibility and privacy gating
    if (!isEligibleForInsights(message)) {
      console.log("🔬 Insights: Failed eligibility check");
      return;
    }

    console.log("🔬 Insights: Passed eligibility, processing...");

    // 2. Defensive text handling
    let rawText = typeof message.text === "string" ? message.text : "";
    if (!rawText.trim()) {
      console.log("🔬 Insights: Empty text after cleaning");
      return;
    }

    // 3. Hard cap on text length
    if (rawText.length > INSIGHTS_MAX_LEN) {
      console.log(
        `🔬 Insights: Text exceeds max length (${INSIGHTS_MAX_LEN}), truncating`
      );
      rawText = rawText.slice(0, INSIGHTS_MAX_LEN);
    }

    // 4. Sanitize to remove PII type signals
    const sanitized = sanitizeTextForInsights(rawText);
    if (!sanitized) {
      console.log("🔬 Insights: Sanitized text became empty");
      return;
    }

    // 5. Skip tiny and numeric or date only noise
    if (sanitized.length < INSIGHTS_MIN_LEN) {
      console.log(
        `🔬 Insights: Sanitized text too short (<${INSIGHTS_MIN_LEN} chars)`
      );
      return;
    }

    if (isNumericOrDateOnly(sanitized)) {
      console.log("🔬 Insights: Text appears to be numeric or date only noise");
      return;
    }

    console.log("🔬 Insights: Extracting anonymous signals");

    // 6. Extract anonymous signals locally
    const [embedding, sentiment, keywords] = await Promise.all([
      getEmbedding(sanitized),
      Promise.resolve(classifySentiment(sanitized)),
      Promise.resolve(extractKeywords(sanitized))
    ]);

    if (!embedding) {
      console.log("🔬 Insights: Embedding unavailable, skipping ingest");
      return;
    }

    console.log(
      `🔬 Insights: Signals ready - sentiment=${sentiment}, keywords=${JSON.stringify(
        keywords
      )}`
    );

    // 7. Send only anonymous signals to Supabase
    const response = await fetch(`${SUPABASE_URL}/functions/v1/insights-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_LOOKUP_SECRET
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        content_hash: hashMessage(sanitized),
        embedding,
        sentiment,
        keywords,
        source: "slack"
      })
    });

    if (!response.ok) {
      console.error(
        "🔬 Insights: Ingest failed:",
        await response.text().catch(() => "")
      );
    } else {
      console.log("🔬 Insights: Ingest successful");
    }
  } catch (err) {
    console.error("🔬 Insights: Processing error:", err);
  }
}

// -----------------------------------------------------
// Helper: format answer with feedback buttons
// -----------------------------------------------------
function formatAnswerBlocks(question, answer, sources, qaLogId) {
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `💡 *Answer to:* ${question}\n\n${answer}`
      }
    }
  ];

  // Add sources if available
  if (sources && sources.length > 0) {
    const sourcesList = sources.map((s) => {
      const title = s.title;
      const updated = getRelativeDate(s.updated_at);
      const url = s.url;
      return url
        ? `• <${url}|${title}> (Updated: ${updated})`
        : `• ${title} (Updated: ${updated})`;
    });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Sources:*\n${sourcesList.join("\n")}`
      }
    });
  }

  // Add feedback buttons if we have a qa_log_id
  if (qaLogId) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      block_id: `feedback_${qaLogId}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "👍 Helpful", emoji: true },
          action_id: "feedback_up",
          value: qaLogId
        },
        {
          type: "button",
          text: { type: "plain_text", text: "👎 Not Helpful", emoji: true },
          action_id: "feedback_down",
          value: qaLogId
        }
      ]
    });
  }

  return blocks;
}

// -----------------------------------------------------
// Feedback action handlers
// -----------------------------------------------------
app.action("feedback_up", async ({ body, ack, respond, context }) => {
  await ack();
  await handleFeedbackAction(body, "up", respond, context);
});

app.action("feedback_down", async ({ body, ack, respond, context }) => {
  await ack();
  await handleFeedbackAction(body, "down", respond, context);
});

async function handleFeedbackAction(body, feedback, respond, context) {
  try {
    const qaLogId = body.actions?.[0]?.value;
    const userId = body.user?.id;
    const teamId = body.team?.id || context?.teamId;

    console.log(`📝 Feedback received: ${feedback} for qa_log_id: ${qaLogId}`);

    if (!qaLogId || !teamId) {
      console.error("❌ Missing qa_log_id or team_id for feedback");
      return;
    }

    const { tenant_id, slackClient } = await getTenantAndSlackClient({ teamId });

    const feedbackRes = await fetch(`${SUPABASE_URL}/functions/v1/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_LOOKUP_SECRET
      },
      body: JSON.stringify({
        qa_log_id: qaLogId,
        feedback,
        source: "slack",
        tenant_id: tenant_id,
        slack_user_id: userId
      })
    });

    if (!feedbackRes.ok) {
      const errorText = await feedbackRes.text().catch(() => "");
      console.error("❌ Feedback submission failed:", errorText);
    } else {
      console.log("✅ Feedback submitted successfully");
    }

    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    const originalBlocks = body.message?.blocks || [];

    if (channelId && messageTs) {
      const updatedBlocks = originalBlocks
        .filter((block) => block.type !== "actions")
        .concat([
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: "✅ Thanks for your feedback!"
              }
            ]
          }
        ]);

      await slackClient.chat.update({
        channel: channelId,
        ts: messageTs,
        blocks: updatedBlocks,
        text: body.message?.text || "Answer updated"
      });
    }
  } catch (error) {
    console.error("❌ Error handling feedback action:", error);
  }
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
        text: "Type a question after `/ask`, for example `/ask What is our leave policy?`",
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
          text: "⚠️ RAG service did not respond.",
          response_type: "ephemeral"
        });
        return;
      }

      let answer = ragData.answer || ragData.text || "No answer found.";
      answer = answer.replace(/Source[s]?:[\s\S]*/gi, "").trim();

      const sources = ragData.sources || [];
      const qaLogId = ragData.qa_log_id;

      console.log(`📤 RAG response received, qa_log_id: ${qaLogId || "none"}`);

      const blocks = formatAnswerBlocks(question, answer, sources, qaLogId);

      await respond({
        blocks: blocks,
        text: `💡 *Answer to:* ${question}\n\n${answer}`,
        response_type: "ephemeral"
      });

      console.log("✅ Answer sent with feedback buttons");
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
// Message event listener (interventions + insights)
// -----------------------------------------------------
app.message(async ({ message, client, context, body }) => {
  try {
    if (!message || typeof message !== "object") return;

    // Keep original behaviour: skip non-channel, bots, system
    if (
      message.subtype ||
      message.bot_id ||
      message.channel_type !== "channel"
    ) {
      return;
    }

    console.log(`📨 Message received: "${message.text}"`);

    const teamId = resolveTeamId({ message, context, body });
    console.log("🏷 Intervention teamId =", teamId);

    if (!teamId) {
      console.error("❌ Could not determine Slack team ID from event");
      return;
    }

    const channelId = message.channel;
    console.log("📺 Channel ID:", channelId);

    const { tenant_id, slackClient, slack_bot_token } =
      await getTenantAndSlackClient({ teamId });
    console.log("🏢 Tenant (intervention) =", tenant_id);

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

    // Fire and forget passive insights
    processInsightsSignal(message, tenant_id).catch(err => {
      console.error("Insights background processing failed:", err);
    });

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
      console.log("ℹ️ No intervention needed");
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
        console.log("🟩 Intervention thread reply (fallback) sent");
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
