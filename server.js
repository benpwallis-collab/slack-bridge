/********************************************************************************************
 * Slack Bridge - Render Hosted
 * Version: Multi-Label Insights + Server-Side Embeddings
 * Fully corrected: ALL handlers safe-acked, insights hardened, sentiment guarded
 ********************************************************************************************/

import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { WebClient } from "@slack/web-api";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import crypto from "crypto";

/********************************************************************************************
 * ENV
 ********************************************************************************************/
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
 * SAFE ACK WRAPPER
 ********************************************************************************************/
function safeAck(ack) {
  let called = false;
  return async () => {
    if (!called) {
      called = true;
      try {
        await ack();
      } catch (e) {
        console.error("ack() failed:", e);
      }
    }
  };
}

/********************************************************************************************
 * EXPRESS RECEIVER
 ********************************************************************************************/
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET
});

receiver.router.use(bodyParser.json());
receiver.router.get("/health", (_req, res) => res.status(200).send("ok"));

const app = new App({
  token: SLACK_BOT_TOKEN,
  receiver
});

/********************************************************************************************
 * TEAM ID RESOLUTION
 ********************************************************************************************/
function resolveTeamId({ message, command, context, body }) {
  try {
    return (
      command?.team_id ||
      message?.team ||
      message?.source_team ||
      body?.team_id ||
      context?.teamId ||
      (message?.event_context ? message.event_context.split("-")[1] : null)
    );
  } catch {
    return null;
  }
}

/********************************************************************************************
 * TENANT LOOKUP
 ********************************************************************************************/
async function getTenantAndSlackClient({ teamId }) {
  if (!teamId) throw new Error("Missing teamId");

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
    const t = await res.text().catch(() => "");
    console.error("❌ Tenant lookup failed:", t);
    throw new Error("Tenant lookup failed");
  }

  const data = await res.json();
  if (!data.tenant_id) throw new Error("No tenant_id returned");

  return {
    tenant_id: data.tenant_id,
    slack_bot_token: data.slack_bot_token || SLACK_BOT_TOKEN,
    slackClient: new WebClient(data.slack_bot_token || SLACK_BOT_TOKEN)
  };
}

/********************************************************************************************
 * INSIGHTS CONFIG + HARDENED SANITIZER
 ********************************************************************************************/
const INSIGHTS_SAMPLE = Math.min(1, Math.max(0, parseFloat(INSIGHTS_SAMPLE_RATE || "1.0")));
const INSIGHTS_MAX_LEN = parseInt(INSIGHTS_MAX_CHARS || "1500", 10);
const INSIGHTS_MIN_LEN = parseInt(INSIGHTS_MIN_CHARS_FOR_EMBEDDING || "20", 10);

function sanitizeTextForInsights(text) {
  if (!text || typeof text !== "string") return "";

  try {
    return text
      .replace(/<@[\w]+>/g, " ")
      .replace(/<#[\w]+>/g, " ")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/[\w.+-]+@[\w.-]+/gi, " ")
      .replace(/\b\+?\d{1,3}[-.\s]?\d{2,4}[-.\s]?\d{3,4}\b/g, " ")
      .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")   // SAFE unicode-friendly strip
      .replace(/\s+/g, " ")
      .trim();
  } catch (e) {
    console.error("❌ sanitizeTextForInsights failed:", e);
    return "";
  }
}

function extractKeywords(text) {
  if (!text) return [];

  const stopWords = new Set([
    "this","that","with","from","have","been","were","they",
    "their","would","could","should","about","what","when",
    "where","which","there","here","just","also","only","some",
    "very","really","actually","basically","literally"
  ]);

  const freq = {};
  text.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w))
    .forEach(w => freq[w] = (freq[w] || 0) + 1);

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([w]) => w);
}

function hashMessage(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/********************************************************************************************
 * HARDENED SENTIMENT CLASSIFIER (safe edge cases)
 ********************************************************************************************/
function classifySentiment(text) {
  if (!text || typeof text !== "string") {
    return { primary: "neutral", labels: [] };
  }

  let tokens = [];
  try {
    tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
  } catch (e) {
    console.error("❌ Tokenisation error:", e);
    return { primary: "neutral", labels: [] };
  }

  const NEGATORS = new Set([
    "not","don't","doesn't","isn't","aren't","won't","can't",
    "couldn't","wouldn't","never","no","nope","hardly","barely"
  ]);

  const INTENSIFIERS = new Set([
    "very","really","extremely","super","incredibly","highly","deeply"
  ]);

  const WORDS = {
    positive: { great:2, excellent:3, love:3, amazing:3, helpful:1, appreciate:2, awesome:2, perfect:3, wonderful:3, happy:2, excited:1, good:1, nice:1, delighted:2 },
    negative: { bad:2, terrible:3, awful:3, frustrated:2, angry:2, annoyed:1, confused:1, stuck:1, broken:1, failing:2, disappointed:2, unsafe:2, worried:1, concerned:1, problem:1, issue:1, toxic:3 },
    burnout: { exhausted:3, burnout:3, overwhelmed:3, tired:1, drained:2, overloaded:2, stressed:2, stress:2 },
    attrition: { quit:3, quitting:3, resign:3, resigning:3, resigned:3, leaving:2, leave:1, exit:2, departure:2 },
    conflict: { fight:2, blame:2, disagree:1, conflict:2, tension:2, hostile:3 },
    workload: { deadline:1, pressure:1, urgent:1, overloaded:2, swamped:2, backlog:1 },
    tooling: { slow:1, buggy:1, broken:1, failing:2, error:1, unstable:1 },
    emotional: { anger:2, fear:2, anxious:2, nervous:1, excited:1, grateful:1, thankful:1 }
  };

  let posScore = 0, negScore = 0;
  const labels = new Set();

  tokens.forEach((token, i) => {
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];
    let mult = INTENSIFIERS.has(prev) || INTENSIFIERS.has(prev2) ? 2 : 1;

    function hit(cat, label = null) {
      if (WORDS[cat][token]) {
        let score = WORDS[cat][token] * mult;

        if (cat === "positive" || cat === "negative") {
          for (let j = 1; j <= 3; j++) {
            if (NEGATORS.has(tokens[i - j])) {
              if (cat === "positive") negScore += score;
              else posScore += score;
              return;
            }
          }
        }

        if (cat === "positive") posScore += score;
        if (cat === "negative") negScore += score;
        if (label) labels.add(label);
      }
    }

    hit("positive");
    hit("negative");
    hit("burnout", "burnout_risk");
    hit("attrition", "attrition_risk");
    hit("conflict", "conflict_risk");
    hit("workload", "workload_pressure");
    hit("tooling", "tooling_frustration");
    hit("emotional", "emotional_signal");
  });

  let primary = "neutral";
  if (negScore > posScore) primary = "negative";
  else if (posScore > negScore) primary = "positive";

  if (labels.has("burnout_risk") && negScore > 2) labels.add("wellbeing_concern");
  if (labels.has("attrition_risk") && negScore > 1) labels.add("retention_flag");
  if (labels.has("conflict_risk") && negScore > 1) labels.add("team_dynamics_issue");

  return { primary, labels: Array.from(labels) };
}

/********************************************************************************************
 * PROCESS INSIGHTS (completely safe + non-blocking)
 ********************************************************************************************/
async function processInsightsSignal(message, tenantId) {
  try {
    if (!message || typeof message !== "object") return;

    let text = message.text || "";
    if (!text) return;

    if (text.length > INSIGHTS_MAX_LEN) text = text.slice(0, INSIGHTS_MAX_LEN);

    const sanitized = sanitizeTextForInsights(text);
    if (!sanitized || sanitized.length < INSIGHTS_MIN_LEN) return;

    const sentiment = classifySentiment(sanitized);
    const keywords = extractKeywords(sanitized);
    const hash = hashMessage(sanitized);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/insights-ingest`, {
      method: "POST",
      headers: {
        "Content-Type":"application/json",
        "x-internal-token": INTERNAL_LOOKUP_SECRET
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        sanitized_text: sanitized,
        sentiment,
        keywords,
        content_hash: hash,
        source: "slack"
      })
    });

    if (!res.ok) {
      console.error("❌ Insights ingest failed:", await res.text());
    }
  } catch (err) {
    console.error("❌ Insights error:", err);
  }
}

/********************************************************************************************
 * /ASK HANDLER (fixed + logs)
 ********************************************************************************************/
app.command("/ask", async (args) => {
  const ack = safeAck(args.ack);
  await ack(); // MUST BE FIRST

  const { command, respond } = args;

  (async () => {
    try {
      console.log("🔍 /ask question:", command.text);

      const teamId = resolveTeamId(args);
      console.log("🔍 Resolved teamId:", teamId);

      const { tenant_id } = await getTenantAndSlackClient({ teamId });
      console.log("🔍 Tenant:", tenant_id);

      const ragRes = await fetch(RAG_QUERY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          "x-internal-token": INTERNAL_LOOKUP_SECRET
        },
        body: JSON.stringify({
          tenant_id,
          query: command.text,
          channel: "slack"
        })
      });

      console.log("🔍 RAG status:", ragRes.status);

      if (!ragRes.ok) {
        console.error("❌ RAG error:", await ragRes.text());
        await respond("Something went wrong retrieving the answer.");
        return;
      }

      const payload = await ragRes.json().catch(() => null);
      console.log("🔍 RAG payload:", payload);

      await respond(payload?.answer || "No answer found.");
    } catch (err) {
      console.error("❌ /ask error:", err);
      await respond("Something went wrong.");
    }
  })();
});

/********************************************************************************************
 * FEEDBACK BUTTONS (safe ack)
 ********************************************************************************************/
app.action("feedback_positive", async (args) => {
  const ack = safeAck(args.ack);
  await ack();

  console.log("👍 Positive feedback:", args.body?.message?.ts);
});

app.action("feedback_negative", async (args) => {
  const ack = safeAck(args.ack);
  await ack();

  console.log("👎 Negative feedback:", args.body?.message?.ts);
});

/********************************************************************************************
 * MESSAGE EVENT HANDLER (fully safe)
 ********************************************************************************************/
app.event("message", async ({ event, context }) => {
  try {
    const teamId = event.team || context.teamId;
    if (!teamId) return;

    const { tenant_id } = await getTenantAndSlackClient({ teamId });

    // non-blocking insights
    processInsightsSignal(event, tenant_id)
      .catch(err => console.error("❌ Insights async error:", err));

  } catch (err) {
    console.error("❌ Message handler error:", err);
  }
});

/********************************************************************************************
 * START SERVER
 ********************************************************************************************/
(async () => {
  await app.start(PORT);
  console.log(`⚡ Slack bridge running on port ${PORT}`);
})();
