const INTENT_MODES = Object.freeze({ MONGO: "mongo", SQS: "sqs" });

function resolveIntentIngestionMode(rawValue, logger) {
  const normalized = (rawValue || "").toString().trim().toLowerCase();
  if (normalized === INTENT_MODES.SQS) return INTENT_MODES.SQS;
  if (normalized && normalized !== INTENT_MODES.MONGO) {
    logger?.warn?.(`[track] Unknown INTENT_EVENT_INGESTION="${rawValue}", falling back to mongo`);
  }
  return INTENT_MODES.MONGO;
}

function buildTrackController({
  OtpVerified,
  AjrsPurchase,
  logger,
  ingestionMode,
  intentIngest,
  intentSqsPublish,
  isKnownBrand,
}) {
  async function handleRsEvent(sessionData, res) {
    if (sessionData.tags === "RS_Cinema_KP" && sessionData.customer_id) {
      const exists = await OtpVerified.findOne({ customer_id: sessionData.customer_id });
      if (!exists) {
        const otpVerify = new OtpVerified({ customer_id: sessionData.customer_id });
        await otpVerify.save();
        logger.info(`[track] OTP Verified saved for customer: ${sessionData.customer_id}`);
      }
    }

    if (sessionData.orderId) {
      const exists = await AjrsPurchase.findOne({ order_id: sessionData.orderId });
      if (!exists) {
        const purchase = new AjrsPurchase({ order_id: sessionData.orderId });
        await purchase.save();
        logger.info(`[track] AJRS Purchase saved for order: ${sessionData.orderId}`);
      }
    }

    return res.status(201).json({ message: "Session tracked successfully" });
  }

  // SQS mode: normalize, build the contract message and send it to SQS. 202 only
  // after SendMessage succeeds. No Mongo, no session state, no outbox, no dedupe.
  async function handleSqsIntentEvent(sessionData, res) {
    const brandId = sessionData.brand_id;
    if (!brandId || !isKnownBrand(brandId)) {
      return res.status(400).json({ error: "unknown or inactive brand_id" });
    }

    try {
      const result = await intentSqsPublish(sessionData, brandId);
      return res.status(202).json({ message: "Event accepted", event_id: result.event_id });
    } catch (err) {
      if (err?.status === 400) {
        logger.warn(`[track] rejected intent event brand=${brandId} event_id=${sessionData.event_id ?? "missing"}: ${err.message}`);
        return res.status(400).json({ error: "invalid event payload" });
      }
      if (err?.status === 413) return res.status(413).json({ error: "Event payload too large" });
      if (err?.status === 503) return res.status(503).json({ error: "Failed to queue event" });
      throw err;
    }
  }

  // Sessions Pipeline behaviour: brand check → normalize → session state →
  // intent_sessions. Returns 204 for new and duplicate events, as the Sessions
  // Pipeline did.
  async function handleMongoIntentEvent(sessionData, res) {
    const brandId = sessionData.brand_id;
    if (!brandId || !isKnownBrand(brandId)) {
      return res.status(400).json({ error: "unknown or inactive brand_id" });
    }

    try {
      await intentIngest(sessionData, brandId);
    } catch (err) {
      if (err?.status === 400) {
        return res.status(400).json({ error: "invalid event payload" });
      }
      throw err;
    }
    return res.sendStatus(204);
  }

  return {
    track: async (req, res) => {
      try {
        const sessionData = req.body || {};
        // Intent events always carry event_name, and legitimate RS payloads never do.
        // So a payload with event_name is never routed to the RS Mongo branch, even
        // if it also carries a top-level orderId.
        const isIntentEvent = typeof sessionData.event_name === "string" && sessionData.event_name !== "";
        const isRSEvent = !isIntentEvent && (sessionData.tags === "RS_Cinema_KP" || Boolean(sessionData.orderId));

        if (isRSEvent) {
          return await handleRsEvent(sessionData, res);
        }

        if (ingestionMode === INTENT_MODES.SQS) {
          return await handleSqsIntentEvent(sessionData, res);
        }
        return await handleMongoIntentEvent(sessionData, res);
      } catch (err) {
        logger.error("Error tracking session:", err);
        return res.status(500).json({ error: "Failed to track alert" });
      }
    },
  };
}

module.exports = { buildTrackController, resolveIntentIngestionMode, INTENT_MODES };
