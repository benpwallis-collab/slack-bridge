/********************************************************************************************
 * Slack Bridge (Render)
 * CLEAN, FIXED, WORKING VERSION
 ********************************************************************************************/

import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { WebClient } from "@slack/web-api";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import crypto from "crypto";

const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_TENANT_LOOKUP_URL,
  RAG_QUERY_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  INTERNAL_LOOKUP_SECRET,
  INSIGHTS_SAMPLE_RATE,
  INSIGHTS_MAX_CHARS,
  INSIGHTS_MIN_CHARS_FOR_EMBEDDING,
  PORT = 3000
} = process.env;

/********************************************************************************************
 * INSIGHTS CONFIG
 ********************************************************************************************/
const INSIGHTS_SAMPLE = Math.min(
  1,
  Math.max(0, parseFloat(INSIGHTS_SAMPLE_RATE || "1.0"))
);

const INSIGHTS_MAX_LEN = parseInt(INSIGHTS_MAX_CHARS || "1500", 10);
const INSIGHTS_MIN_LEN = parseInt(INSIGHTS_MIN_CHARS_FOR_EMBEDDING || "20", 10);

/********************************************************************************************
 * DATE FORMATTER
 ********************************************************************************************/
function getRelativeDate(dateString) {
  const now = new Date();
  const then = new Date(dateString);
  const diff = now - then;
  const sec = diff / 1000;
  const min = sec / 60;
  const hr = min / 60;
  const day = hr / 24;

  if (day >= 2) return `${Math.floor(day)} days ago`;
  if (day >= 1) return "1 day ago";
  if (hr >= 1) return `${Math.floor(hr)} hours ago`;
  if (min >= 1) return `${Math.floor(min)} minutes ago`;
  return "just now";
}

/********************************************************************************************
 * EXPRESS RECEIVER
 ********************************************************************************************/
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

const app = new App({ token: SLACK_BOT_TOKEN, receiver });

/********************************************************************************************
 * TEAM ID RESOLUTION
 ********************************************************************************************/
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

/********************************************************************************************
 * TENANT LOOKUP
 ********************************************************************************************/
async function getTenantAndSlackClient({ teamId }) {
  console.log("🔍 Tenant lookup:", teamId);

  const res = await fetch(SLACK_TENANT_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      "x-internal-token": INTERNAL_LOOKUP_SECRET
    },
    body: JSON.stringify({ slack_team_id: teamId })
  });

  if (!res.ok) {
    console.error("❌ Tenant lookup failed:", await res.text());
    throw new Error("Tenant lookup failed");
  }

  const { tenant_id, slack_bot_token } = await res.json();
  const tokenToUse = slack_bot_token || SLACK_BOT_TOKEN;

  return { tenant_id, slackClient: new WebClient(tokenToUse) };
}

/********************************************************************************************
 * INSIGHTS HELPERS
 ********************************************************************************************/
function isPublicChannel(message) {
  if (!message?.channel) return false;
  return message.channel.startsWith("C");
}

function isEligibleForInsights(message) {
  if (!message || message.bot_id) return false;
  if (!isPublicChannel(message)) return false;

  const skip = ["channel_join", "channel_leave", "channel_topic", "channel_purpose", "file_share"];
  if (skip.includes(message.subtype)) return false;

  const text = message.text || "";
  if (text.trim().split(/\s+/).length < 4) return false;
  if (/^(:\w+:\s*)+$/.test(text.trim())) return false;

  return true;
}

function isNumericOrDateOnly(text) {
  if (!/^[\d\s:\/\-.,]+$/.test(text)) return false;
  return /\d/.test(text);
}

function sanitizeTextForInsights(text) {
  if (!text) return "";
  return text
    .replace(/<@[\w]+>/g, " ")
    .replace(/<#[\w]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w.-]+/g, " ")
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/********************************************************************************************
 * SAFE MULTI-LABEL SENTIMENT CLASSIFIER
 ********************************************************************************************/
function classifySentiment(text) {
  if (!text) return { primary: "neutral", labels: [] };

  const tokens = text.toLowerCase().split(/\s+/);

  const WORDS = {
    positive: { great:2, excellent:3, love:3, amazing:3, helpful:1, excited:1 },
    negative: { bad:2, terrible:3, awful:3, frustrated:2, angry:2, broken:1 },
    burnout: { exhausted:3, overwhelmed:3, stressed:2, burnout:3 },
    attrition: { quit:3, resign:3, leaving:2 },
    conflict: { fight:2, conflict:2, hostile:3 },
    workload: { overloaded:2, urgent:1 },
    tooling: { slow:1, buggy:1, failing:2 }
  };

  let pos = 0, neg = 0;
  const labels = new Set();

  for (const t of tokens) {
    if (WORDS.positive[t]) pos += WORDS.positive[t];
    if (WORDS.negative[t]) neg += WORDS.negative[t];
    if (WORDS.burnout[t]) labels.add("burnout_risk");
    if (WORDS.attrition[t]) labels.add("attrition_risk");
    if (WORDS.conflict[t]) labels.add("conflict_risk");
    if (WORDS.workload[t]) labels.add("workload_pressure");
    if (WORDS.tooling[t]) labels.add("tooling_frustration");
  }

  let primary = "neutral";
  if (neg > pos) primary = "negative";
  else if (pos > neg) primary = "positive";

  return { primary, labels: [...labels] };
}

function extractKeywords(text) {
  if (!text) return [];

  const stop = new Set(["this","that","with","from","have","were","they","also","just","very"]);
  const freq = {};

  for (const w of text.toLowerCase().split(/\s+/)) {
    if (w.length > 3 && !stop.has(w)) freq[w] = (freq[w] || 0) + 1;
  }

  return Object.entries(freq)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,5)
    .map(([w]) => w);
}

function hashMessage(t) {
  return crypto.createHash("sha256").update(t).digest("hex");
}

/********************************************************************************************
 * PROCESS INSIGHTS (NON BLOCKING)
 ********************************************************************************************/
async function processInsightsSignal(message, tenantId) {
  try {
    if (Math.random() > INSIGHTS_SAMPLE) return;
    if (!isEligibleForInsights(message)) return;

    let text = message.text || "";
    if (text.length > INSIGHTS_MAX_LEN) text = text.slice(0, INSIGHTS_MAX_LEN);

    const sanitized = sanitizeTextForInsights(text);
    if (!sanitized || sanitized.length < INSIGHTS_MIN_LEN) return;
    if (isNumericOrDateOnly(sanitized)) return;

    const sentiment = classifySentiment(sanitized);
    const keywords = extractKeywords(sanitized);
    const content_hash = hashMessage(sanitized);

    await fetch(`${SUPABASE_URL}/functions/v1/insights-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_LOOKUP_SECRET
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        content_hash,
        sentiment,
        keywords,
        sanitized_text: sanitized,
        source: "slack"
      })
    });
  } catch (err) {
    console.error("Insights error:", err);
  }
}

/********************************************************************************************
 * FORMAT ANSWER BLOCKS
 ********************************************************************************************/
function formatAnswerBlocks(question, answer, sources, qaLogId) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `💡 *Answer to:* ${question}\n\n${answer}` }
    }
  ];

  if (sources?.length) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          "*Sources:*\n" +
          sources
            .map(
              (s) =>
                `• ${s.url ? `<${s.url}|${s.title}>` : s.title} (Updated ${getRelativeDate(
                  s.updated_at
                )})`
            )
            .join("\n")
      }
    });
  }

  if (qaLogId) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "feedback_up",
          text: { type: "plain_text", text: "👍 Helpful" },
          value: qaLogId
        },
        {
          type: "button",
          action_id: "feedback_down",
          text: { type: "plain_text", text: "👎 Not Helpful" },
          value: qaLogId
        }
      ]
    });
  }

  return blocks;
}

/********************************************************************************************
 * FEEDBACK HANDLERS
 ********************************************************************************************/
app.action("feedback_up", async ({ ack }) => await ack());
app.action("feedback_down", async ({ ack }) => await ack());

/********************************************************************************************
 * /ASK COMMAND
 ********************************************************************************************/
app.command("/ask", async ({ command, ack, respond, context, body }) => {
  await ack();

  const teamId = resolveTeamId({ command, context, body });
  if (!teamId) return respond("❌ Could not determine workspace.");

  await respond("⚙️ Working on it...");

  try {
    const { tenant_id } = await getTenantAndSlackClient({ teamId });

    const ragRes = await fetch(RAG_QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        "x-tenant-id": tenant_id
      },
      body: JSON.stringify({ question: command.text, source: "slack" })
    });

    if (!ragRes.ok) return respond("⚠️ RAG service failed.");

    const data = await ragRes.json();
    const blocks = formatAnswerBlocks(command.text, data.answer, data.sources, data.qa_log_id);

    await respond({ blocks, text: data.answer });
  } catch (err) {
    console.error("❌ /ask error:", err);
    await respond("❌ Something went wrong.");
  }
});

/********************************************************************************************
 * MESSAGE EVENT LISTENER
 ********************************************************************************************/
app.message(async ({ message, context, body }) => {
  try {
    if (!message || message.bot_id || message.subtype) return;

    const teamId = resolveTeamId({ message, context, body });
    if (!teamId) return;

    const { tenant_id } = await getTenantAndSlackClient({ teamId });

    processInsightsSignal(message, tenant_id);
  } catch (err) {
    console.error("Message error:", err);
  }
});

/********************************************************************************************
 * START SERVER
 ********************************************************************************************/
(async () => {
  await app.start(PORT);
  console.log(`⚡ Slack bridge running on port ${PORT}`);
})();
