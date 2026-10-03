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
  Session,
  OtpVerified,
  AjrsPurchase,
  logger,
  intentEventQueue,
  sqsMessageLimitBytes,
  ingestionMode,
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

  async function handleSqsIntentEvent(sessionData, res) {
    const idempotencyKey = sessionData.idempotency_key;
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

  async function handleMongoIntentEvent(sessionData, res) {
    const existingSession = await Session.findOne({ idempotency_key: sessionData.idempotency_key });
    if (existingSession) {
      return res.status(200).json({ message: "Event already processed", session: existingSession });
    }

    const session = new Session(sessionData);
    await session.save();
    return res.status(201).json({ message: "Session tracked successfully" });
  }

  return {
    track: async (req, res) => {
      try {
        const sessionData = req.body || {};
        const isRSEvent = sessionData.tags === "RS_Cinema_KP" || sessionData.orderId;

        if (!sessionData.idempotency_key && !isRSEvent) {
          return res.status(400).json({ error: "idempotency_key is required" });
        }

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
