async function getTenantAndSlackClient({ teamId }) {
  console.log("🔍 Looking up tenant for Slack team:", teamId);

  const tenantRes = await fetch(SLACK_TENANT_LOOKUP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      "x-internal-token": process.env.INTERNAL_LOOKUP_SECRET  // ← NEW SECURITY
    },
    body: JSON.stringify({ slack_team_id: teamId })
  });

  if (!tenantRes.ok) {
    throw new Error(`Failed tenant lookup: ${tenantRes.status}`);
  }

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
