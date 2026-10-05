// Standalone intent outbox relay. Not started by app.js: run it explicitly, in
// a separate process, once the relay is approved for that environment.
//
//   SQS_INTENT_QUEUE_URL=...  AWS_REGION=ap-south-1  INTENT_MONGO_URI=...
//   node scripts/intent-outbox-relay.js
//
// AWS credentials come from the default provider chain (EC2 instance role).
// No access keys are read from the environment.
require("dotenv").config();

const { getIntentModels } = require("../models/intent/connection");
const { sendRawMessage } = require("../services/intentEventQueue");
const { createOutboxRelay, readRelayConfig } = require("../services/intent/outboxRelay");

async function main() {
  const config = readRelayConfig(process.env);
  const { IntentOutbox } = getIntentModels();
  const logger = {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };

  const relay = createOutboxRelay({
    IntentOutbox,
    sendMessage: (body) => sendRawMessage(body, { queueUrl: config.queueUrl }),
    workerId: config.workerId,
    batchSize: config.batchSize,
    pollIntervalMs: config.pollIntervalMs,
    claimTimeoutMs: config.claimTimeoutMs,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
    logger,
  });

  const stop = { stopped: false };
  const shutdown = (signal) => {
    logger.info(`[outbox-relay] ${signal} received; stopping after the current poll`);
    stop.stopped = true;
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info(
    `[outbox-relay] started worker=${config.workerId} queue=${config.queueUrl} batch=${config.batchSize} ` +
      `poll_ms=${config.pollIntervalMs} claim_timeout_ms=${config.claimTimeoutMs}`,
  );
  await relay.runForever(stop);
  logger.info("[outbox-relay] stopped");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[outbox-relay] fatal: ${err?.message}`);
    process.exit(1);
  });
}

module.exports = { main };
