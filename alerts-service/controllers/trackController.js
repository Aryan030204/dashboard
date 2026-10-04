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
  intentEventQueue,
  sqsMessageLimitBytes,
  ingestionMode,
  intentIngest,
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

  // Unchanged. Still sends the raw body; normalization for SQS is the planned
  // SQS cutover step, not part of this migration.
  async function handleSqsIntentEvent(sessionData, res) {
    const idempotencyKey = sessionData.idempotency_key;
    if (!idempotencyKey) {
      return res.status(400).json({ error: "idempotency_key is required" });
    }

    const message = { ...sessionData, ingested_at: new Date().toISOString() };
    const bodyBytes = Buffer.byteLength(JSON.stringify(message), "utf8");

    if (bodyBytes > sqsMessageLimitBytes) {
      logger.warn(
        `[track] Intent event ${idempotencyKey} rejected: ${bodyBytes} bytes exceeds SQS limit ${sqsMessageLimitBytes}`,
      );
      return res.status(413).json({ error: "Event payload too large" });
    }

    try {
      const messageId = await intentEventQueue.sendIntentEvent(sessionData);
      logger.info(`[track] Intent event ${idempotencyKey} queued to SQS (MessageId=${messageId})`);
      return res.status(202).json({ message: "Event accepted", event_id: idempotencyKey });
    } catch (err) {
      logger.error(`[track] SQS send failed for intent event ${idempotencyKey}: ${err?.name || "Error"} ${err?.message || ""}`);
      return res.status(503).json({ error: "Failed to queue event" });
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
