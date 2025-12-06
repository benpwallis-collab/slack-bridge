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

    // 1. Cheap eligibility / privacy gating
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

    // 4. Sanitize to remove PII-ish signals
    const sanitized = sanitizeTextForInsights(rawText);
    if (!sanitized) {
      console.log("🔬 Insights: Sanitized text became empty");
      return;
    }

    // 5. Skip tiny and numeric/date-only noise
    if (sanitized.length < INSIGHTS_MIN_LEN) {
      console.log(
        `🔬 Insights: Sanitized text too short (<${INSIGHTS_MIN_LEN} chars)`
      );
      return;
    }

    if (isNumericOrDateOnly(sanitized)) {
      console.log("🔬 Insights: Text appears to be numeric/date-only noise");
      return;
    }

    console.log("🔬 Insights: Extracting anonymous signals");

    // 6. Extract anonymous signals locally
    const [embedding, sentiment, keywords] = await Promise.all([
      getEmbedding(sanitized),
      Promise.resolve(classifySentiment(sanitized)),
      Promise.resolve(extractKeywords(sanitized)),
    ]);

    if (!embedding) {
      console.log("🔬 Insights: Embedding unavailable, skipping ingest");
      return;
    }

    console.log(
      `🔬 Insights: Signals ready — sentiment=${sentiment}, keywords=${JSON.stringify(
        keywords
      )}`
    );

    // 7. Send ONLY anonymous signals to Supabase
    const response = await fetch(`${SUPABASE_URL}/functions/v1/insights-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_LOOKUP_SECRET,
      },
      body: JSON.stringify({
        tenant_id: tenantId,
        content_hash: hashMessage(sanitized),
        embedding,
        sentiment,
        keywords,
        source: "slack",
      }),
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
