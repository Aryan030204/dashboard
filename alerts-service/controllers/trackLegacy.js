// Legacy /track handler (Mongo). Handles everything the Kafka path does not take: the CI
// pixel (event_type + idempotency_key) and any event name outside the Kafka list.
// Requires an idempotency_key, skips duplicates, and saves the payload as a Session.
function createLegacyTrack({ Session, logger }) {
  return async function legacyTrack(req, res) {
    try {
      const sessionData = req.body;

      if (!sessionData?.idempotency_key) {
        return res.status(400).json({ error: "idempotency_key is required" });
      }

      const existingSession = await Session.findOne({
        idempotency_key: sessionData.idempotency_key,
      });
      if (existingSession) {
        return res
          .status(200)
          .json({ message: "Event already processed", session: existingSession });
      }

      const session = new Session(sessionData);
      await session.save();

      return res.status(201).json({ message: "Session tracked successfully" });
    } catch (err) {
      logger.error("Error tracking session:", err);
      return res.status(500).json({ error: "Failed to track alert" });
    }
  };
}

module.exports = { createLegacyTrack };
