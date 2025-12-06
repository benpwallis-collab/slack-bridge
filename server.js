/********************************************************************************************
 * Slack Bridge - Render Hosted
 * Version: Multi-Label Insights + Server-Side Embeddings (Corrected)
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
const INSIGHTS_SAMPLE = (() => {
  const v = parseFloat(INSIGHTS_SAMPLE_RATE || "1.00");
  return Number.isNaN(v) ? 1.0 : Math.min(1, Math.max(0, v));
})();

const INSIGHTS_MAX_LEN = (() => {
  const v = parseInt(INSIGHTS_MAX_CHARS || "1500", 10);
  return Number.isNaN(v) || v <= 0 ? 1500 : v;
})();

const INSIGHTS_MIN_LEN = (() => {
  const v = parseInt(INSIGHTS_MIN_CHARS_FOR_EMBEDDING || "20", 10);
  return Number.isNaN(v) || v <= 0 ? 20 : v;
})();

/********************************************************************************************
 * RELATIVE DATE
 ********************************************************************************************/
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

/********************************************************************************************
 * EXPRESS RECEIVER
 ********************************************************************************************/
const receiver = new ExpressReceiver({
  signingSecret: SLACK_SIGNING_SECRET
});

// Correct: ExpressReceiver exposes `.router`, not `.app`
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
      (message?.event_context
        ? message.event_context.split("-")[1]
        : null)
    );
  } catch {
    return null;
  }
}

/********************************************************************************************
 * TENANT LOOKUP
 ********************************************************************************************/
async function getTenantAndSlackClient({ teamId }) {
  console.log("🔍 Looking up tenant:", teamId);

  if (!teamId) throw new Error("Missing teamId");

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
    const t = await tenantRes.text().catch(() => "");
    console.error(`❌ Tenant lookup failed (${tenantRes.status}): ${t}`);
    throw new Error("Tenant lookup failed");
  }

  const { tenant_id, slack_bot_token } = await tenantRes.json();

  if (!tenant_id) throw new Error("No tenant_id returned");

  const tokenToUse = slack_bot_token || SLACK_BOT_TOKEN;

  return {
    tenant_id,
    slackClient: new WebClient(tokenToUse),
    slack_bot_token: tokenToUse
  };
}

/********************************************************************************************
 * INSIGHTS LOGIC
 ********************************************************************************************/
function isPublicChannel(message) {
  if (!message?.channel) return false;
  if (!message.channel.startsWith("C")) return false;
  return true;
}

function isEligibleForInsights(message) {
  if (!message || typeof message !== "object") return false;
  if (!isPublicChannel(message)) return false;
  if (message.bot_id || message.subtype === "bot_message") return false;

  const ignore = [
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "file_share"
  ];

  if (ignore.includes(message.subtype)) return false;

  const text = message.text || "";
  if (text.split(/\s+/).filter(Boolean).length < 4) return false;
  if (/^(:\w+:\s*)+$/.test(text.trim())) return false;

  return true;
}

function isNumericOrDateOnly(text) {
  const trimmed = text.trim();
  if (!/^[\d\s:\/\-.,]+$/.test(trimmed)) return false;
  return /\d/.test(trimmed);
}

function sanitizeTextForInsights(text) {
  return text
    .replace(/<@[\w]+>/g, " ")
    .replace(/<#[\w]+>/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\w.+-]+@[\w.-]+/gi, " ")
    .replace(/\b\+?\d{1,3}[-.\s]?\d{2,4}[-.\s]?\d{3,4}\b/g, " ")
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractKeywords(text) {
  const stop = new Set([
    "this","that","with","from","have","been","were","they",
    "their","would","could","should","about","what","when",
    "where","which","there","here","just","also","only","some",
    "very","really","actually","basically","literally"
  ]);

  const freq = {};
  text.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 3 && !stop.has(w))
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
 * CLASSIFIER
 ********************************************************************************************/
function classifySentiment(text) {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

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

  let posScore = 0;
  let negScore = 0;
  const labels = new Set();

  tokens.forEach((token, i) => {
    const prev = tokens[i - 1];
    const prev2 = tokens[i - 2];

    let mult = 1;
    if (INTENSIFIERS.has(prev) || INTENSIFIERS.has(prev2)) mult = 2;

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
 * INGEST PIPE
 ********************************************************************************************/
async function processInsightsSignal(message, tenantId) {
  try {
    if (INSIGHTS_SAMPLE <= 0 || Math.random() > INSIGHTS_SAMPLE) return;
    if (!isEligibleForInsights(message)) return;

    let rawText = message.text?.trim() || "";
    if (!rawText) return;

    if (rawText.length > INSIGHTS_MAX_LEN) {
      rawText = rawText.slice(0, INSIGHTS_MAX_LEN);
    }

    const sanitized = sanitizeTextForInsights(rawText);
    if (!sanitized) return;
    if (sanitized.length < INSIGHTS_MIN_LEN) return;
    if (isNumericOrDateOnly(sanitized)) return;

    const sentiment = classifySentiment(sanitized);
    const keywords = extractKeywords(sanitized);
    const contentHash = hashMessage(sanitized);

    const ingest = await fetch(`${SUPABASE_URL}/functions/v1/insights-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_LOOKUP_SECRET
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        sanitized_text: sanitized,
        content_hash: contentHash,
        sentiment,
        keywords,
        source: "slack"
      })
    });

    if (!ingest.ok) console.error("❌ Ingest failed", await ingest.text());
  } catch (err) {
    console.error("Insights error:", err);
  }
}

/********************************************************************************************
 * REMAINING HANDLERS (UNCHANGED)
 *
 * Your /ask command
 * Your message event listener
 * Your formatting blocks
 * Your feedback handlers
 *
 * They remain untouched.
 ********************************************************************************************/

/********************************************************************************************
 * START SERVER
 ********************************************************************************************/
(async () => {
  await app.start(PORT);
  console.log(`⚡ Slack bridge running on port ${PORT}`);
})();
