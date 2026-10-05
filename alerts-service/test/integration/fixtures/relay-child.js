// Child process used by the relay concurrency test. Runs one independent relay
// against the test replica set, with a mocked SQS sender, and reports every send
// back to the parent over IPC.
const mongoose = require('mongoose');
const schemas = require('../../../models/intent/schemas');
const { createOutboxRelay } = require('../../../services/intent/outboxRelay');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.on('message', async (cfg) => {
  const conn = mongoose.createConnection(cfg.uri, { serverSelectionTimeoutMS: 15000 });
  await conn.asPromise();
  const IntentOutbox = conn.model('IntentOutbox', schemas.intentOutboxSchema);

  const sends = [];
  const logs = [];
  const sendMessage = async (body) => {
    const parsed = JSON.parse(body);
    const started = Date.now();
    // What the database says about this row at the moment of the send.
    const row = await IntentOutbox.findOne({ message_id: `event:${parsed.event_id}` }).lean();
    const dbState = {
      status: row.status,
      claimed_by: row.claimed_by,
      claimed_until_ms_from_now: row.claimed_until ? row.claimed_until.getTime() - Date.now() : null,
    };
    if (cfg.delayMessageIds.includes(parsed.event_id)) {
      await sleep(cfg.delayMs);
    } else {
      await sleep(Math.random() * cfg.jitterMs);
    }
    const messageId = `${cfg.workerId}-${sends.length + 1}`;
    sends.push({
      relay: cfg.workerId,
      message_id: `event:${parsed.event_id}`,
      body,
      started,
      ended: Date.now(),
      dbState,
      sqsMessageId: messageId,
    });
    return messageId;
  };

  const logger = {
    info: () => {},
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
  };
  const relay = createOutboxRelay({
    IntentOutbox,
    sendMessage,
    workerId: cfg.workerId,
    batchSize: cfg.batchSize,
    claimTimeoutMs: cfg.claimTimeoutMs,
    retryBaseMs: 1000,
    retryMaxMs: 300000,
    logger,
  });

  let idleRounds = 0;
  while (idleRounds < cfg.idleRounds) {
    const summary = await relay.processOnce();
    if (summary.claimed === 0) {
      idleRounds += 1;
      await sleep(cfg.idleSleepMs);
    } else {
      idleRounds = 0;
    }
  }

  process.send({ workerId: cfg.workerId, sends, logs });
  await conn.close();
  process.exit(0);
});
