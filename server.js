import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import fetch from "node-fetch";
import bodyParser from "body-parser";

// ENV
const {
  SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN,
  SLACK_TENANT_LOOKUP_URL,
  RAG_QUERY_URL,
  SUPABASE_ANON_KEY,
  PORT = 3000
} = process.env;

// Helper: format relative date
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

// Express health check
const receiver = new ExpressReceiver({ signingSecret: SLACK_SIGNING_SECRET });
receiver.app.use(bodyParser.json());
receiver.app.get("/health", (_req, res) => res.status(200).send("ok"));

// Slack Bolt app
const app = new App({ token: SLACK_BOT_TOKEN, receiver });

app.command("/ask", async ({ command, ack, respond }) => {
  await ack();

  const question = (command.text || "").trim();
  const userId = command.user_id;
  const teamId = command.team_id;

  if (!question) {
    await respond({
      text: "Type a question after `/ask`, e.g. `/ask What is our leave policy?`",
      response_type: "ephemeral"
    });
    return;
  }

  await respond({
    text: `⏳ Searching for: *${question}* ...`,
    response_type: "ephemeral"
  });

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

    const ragRes = await fetch(RAG_QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        "x-tenant-id": tenant_id
      },
      body: JSON.stringify({
        question,
        userEmail: userId
      })
    });

    const ragData = await ragRes.json();
    const answer = ragData.answer || ragData.text || "No answer found.";

    let sourcesText = "";
    const sources = ragData.sources || [];

    if (sources.length > 0) {
      const sourcesList = sources.map((s) => {
        const title = s.title;
        const updated = getRelativeDate(s.updated_at);
        const url = s.url;

        if (url) {
          return `• <${url}|${title}> (Updated: ${updated})`;
        } else {
          return `• ${title} (Updated: ${updated})`;
        }
      });

      sourcesText = `\n\n*Sources:*\n${sourcesList.join("\n")}`;
    }

    await respond({
      text: `💡 *Answer to:* ${question}\n\n${answer}${sourcesText}`,
      response_type: "ephemeral"
    });
  } catch (error) {
    console.error("Slack bridge error:", error);
    await respond({
      text: "❌ Sorry, something went wrong while processing your question.",
      response_type: "ephemeral"
    });
  }
}); // ✅ properly closed

(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})(); // ✅ also closed
