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

// Slash command: /ask
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
    // 🪵 Log start
    console.log("🪵 LOG: Received /ask command");
    console.log(`🪵 LOG: Question: "${question}"`);
    console.log(`🪵 LOG: Slack user ID: ${userId}, Team ID: ${teamId}`);

    // 🔹 Step 1: Fetch Slack user email
    console.log("🪵 LOG: Fetching Slack user info from Slack API...");
    const userRes = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    const userData = await userRes.json();

    console.log("🪵 LOG: Slack user info response:", JSON.stringify(userData, null, 2));

    if (!userData.ok) {
      console.error("⚠️ Slack API error:", userData.error);
      throw new Error(`Slack API error: ${userData.error}`);
    }

    const userEmail = userData.user?.profile?.email || `${userId}@unknown.slack`;
    console.log(`✅ Slack user email resolved: ${userEmail}`);

    // 🔹 Step 2: Resolve tenant
    console.log(`🪵 LOG: Looking up tenant for Slack team: ${teamId}`);
    const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ slack_team_id: teamId })
    });

    console.log("🪵 LOG: Tenant lookup status:", tenantRes.status);

    if (!tenantRes.ok) {
      const text = await tenantRes.text();
      console.error("❌ Tenant lookup failed. Response:", text);
      throw new Error(`Failed to resolve tenant. Status: ${tenantRes.status}`);
    }

    const { tenant_id } = await tenantRes.json();
    console.log(`🏢 Tenant resolved: ${tenant_id}`);

    // 🔹 Step 3: Query InnsynAI / RAG endpoint
    console.log(`📤 Sending query with userEmail: ${userEmail}`);
    console.log(`🪵 LOG: RAG query endpoint: ${RAG_QUERY_URL}`);

    const ragRes = await fetch(RAG_QUERY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        "x-tenant-id": tenant_id
      },
      body: JSON.stringify({
        question,
        userEmail
      })
    });

    console.log("🪵 LOG: RAG query status:", ragRes.status);

    if (!ragRes.ok) {
      const text = await ragRes.text();
      console.error("❌ RAG query failed. Response:", text);
      throw new Error(`RAG query failed. Status: ${ragRes.status}`);
    }

    const ragData = await ragRes.json();
    console.log("🪵 LOG: RAG response:", JSON.stringify(ragData, null, 2));

    // ✅ Format the response
    let answer = ragData.answer || ragData.text || "No answer found.";
    answer = answer.replace(/\n?\*?Sources?:\n[\s\S]*/gi, "").trim();

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

    console.log("🪵 LOG: Sending final Slack response...");
    await respond({
      text: `💡 *Answer to:* ${question}\n\n${answer}${sourcesText}`,
      response_type: "ephemeral"
    });

    console.log("✅ Response sent successfully.");
  } catch (error) {
    console.error("❌ Slack bridge error:", error);
    await respond({
      text: "❌ Sorry, something went wrong while processing your question.",
      response_type: "ephemeral"
    });
  }
});

// Start app
(async () => {
  await app.start(PORT);
  console.log(`⚡️ Slack bridge running on port ${PORT}`);
})();
