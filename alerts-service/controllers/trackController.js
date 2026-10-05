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
  outboxIngest,
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

  // SQS mode: same normalization and state as the Mongo path, recorded in
  // intent_outbox inside one transaction. The relay sends to SQS later.
  // Keyed on event_id; idempotency_key is not required from the pixel.
  async function handleOutboxIntentEvent(sessionData, res) {
    const brandId = sessionData.brand_id;
    if (!brandId || !isKnownBrand(brandId)) {
      return res.status(400).json({ error: "unknown or inactive brand_id" });
    }

    try {
      const result = await outboxIngest(sessionData, brandId);
      if (result.status === "duplicate") {
        return res.status(202).json({ message: "Event already accepted", event_id: result.event_id, duplicate: true });
      }
      return res.status(202).json({ message: "Event accepted", event_id: result.event_id });
    } catch (err) {
      if (err?.status === 400) return res.status(400).json({ error: "invalid event payload" });
      if (err?.status === 413) return res.status(413).json({ error: "Event payload too large" });
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
        const isRSEvent = sessionData.tags === "RS_Cinema_KP" || sessionData.orderId;

        if (isRSEvent) {
          return await handleRsEvent(sessionData, res);
        }

        if (ingestionMode === INTENT_MODES.SQS) {
          return await handleOutboxIntentEvent(sessionData, res);
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
