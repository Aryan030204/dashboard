const os = require("os");
const { validateMessage } = require("./messageContract");

const SQS_BODY_LIMIT_BYTES = 256 * 1024;

// Lease-based relay for intent_outbox. Rows are claimed one at a time (atomic
// findOneAndUpdate) before their send, so concurrent relays never hold the same
// live claim. A row becomes "sent" only after SendMessage succeeds. Any failure
// returns it to pending with a backoff, so delivery is at-least-once and
// duplicates are harmless: the consumer dedupes on event_id / session_id.
function createOutboxRelay({
  IntentOutbox,
  sendMessage,
  workerId,
  batchSize = 10,
  pollIntervalMs = 1000,
  claimTimeoutMs = 60000,
  retryBaseMs = 1000,
  retryMaxMs = 300000,
  maxBodyBytes = SQS_BODY_LIMIT_BYTES,
  now = () => new Date(),
  logger,
}) {
  if (!IntentOutbox || typeof sendMessage !== "function" || !workerId) {
    throw new Error("relay requires IntentOutbox, sendMessage and workerId");
  }

  function claimable(at) {
    return {
      $and: [
        {
          $or: [
            { status: "pending" },
            { status: "claimed", claimed_until: { $lt: at } }, // expired lease: a crashed relay's row
          ],
        },
        { next_attempt_at: { $not: { $gt: at } } }, // no backoff, or backoff elapsed
      ],
    };
  }

  async function claimOne() {
    const at = now();
    const row = await IntentOutbox.findOneAndUpdate(
      claimable(at),
      {
        $set: {
          status: "claimed",
          claimed_by: workerId,
          claimed_until: new Date(at.getTime() + claimTimeoutMs),
          updated_at: at,
        },
        $inc: { attempts: 1 },
      },
      { sort: { created_at: 1 }, new: true },
    ).lean();
    return row || null;
  }

  function backoffMs(attempts) {
    return Math.min(retryBaseMs * 2 ** Math.max(0, attempts - 1), retryMaxMs);
  }

  async function release(row, reason) {
    const at = now();
    const retryIn = backoffMs(row.attempts || 1);
    await IntentOutbox.updateOne(
      { _id: row._id, claimed_by: workerId },
      {
        $set: {
          status: "pending",
          claimed_by: null,
          claimed_until: null,
          last_error: reason,
          next_attempt_at: new Date(at.getTime() + retryIn),
          updated_at: at,
        },
      },
    );
    logger?.error?.(
      `[outbox-relay] send failed message_id=${row.message_id} attempts=${row.attempts} retry_in_ms=${retryIn}: ${reason}`,
    );
    return "failed";
  }

  async function deliver(row) {
    const problems = validateMessage(row.payload);
    if (problems.length) {
      return release(row, `invalid payload: ${problems.join("; ")}`);
    }

    // The stored payload is published as-is. No re-normalization, no added fields.
    const body = JSON.stringify(row.payload);
    if (Buffer.byteLength(body, "utf8") > maxBodyBytes) {
      return release(row, `payload exceeds ${maxBodyBytes} byte SQS limit`);
    }

    let sqsMessageId;
    try {
      sqsMessageId = await sendMessage(body);
    } catch (err) {
      return release(row, `${err?.name || "Error"}: ${err?.message || "send failed"}`);
    }

    const at = now();
    const result = await IntentOutbox.updateOne(
      { _id: row._id, claimed_by: workerId },
      {
        $set: {
          status: "sent",
          sent_at: at,
          claimed_by: null,
          claimed_until: null,
          last_error: null,
          sqs_message_id: sqsMessageId,
          updated_at: at,
        },
      },
    );
    if (!result || result.matchedCount === 0) {
      // Our lease expired and another relay reclaimed the row. It will be sent
      // again; the consumer dedupes, so this is logged and not treated as an error.
      logger?.warn?.(`[outbox-relay] lease lost before marking sent message_id=${row.message_id}; duplicate delivery is possible`);
    }
    return "sent";
  }

  async function processOnce() {
    const summary = { claimed: 0, sent: 0, failed: 0 };
    for (let i = 0; i < batchSize; i++) {
      const row = await claimOne();
      if (!row) break;
      summary.claimed += 1;
      try {
        const outcome = await deliver(row);
        if (outcome === "sent") summary.sent += 1;
        else summary.failed += 1;
      } catch (err) {
        // Infrastructure error after a send attempt. The row keeps its lease and
        // is retried when it expires, so nothing is marked sent without a send.
        summary.failed += 1;
        logger?.error?.(`[outbox-relay] error handling message_id=${row.message_id}: ${err?.message}`);
      }
    }
    return summary;
  }

  async function runForever(stop) {
    while (!stop.stopped) {
      try {
        await processOnce();
      } catch (err) {
        logger?.error?.(`[outbox-relay] poll failed, retrying: ${err?.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  return { processOnce, runForever, claimOne, deliver };
}

function readRelayConfig(env = process.env) {
  const int = (name, fallback, min, max) => {
    const raw = (env[name] || "").trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} must be an integer between ${min} and ${max}, got "${raw}"`);
    }
    return value;
  };

  const queueUrl = (env.SQS_INTENT_QUEUE_URL || "").trim();
  if (!queueUrl) throw new Error("SQS_INTENT_QUEUE_URL is required");

  return {
    queueUrl,
    region: (env.AWS_REGION || "ap-south-1").trim(),
    batchSize: int("INTENT_OUTBOX_RELAY_BATCH_SIZE", 10, 1, 100),
    pollIntervalMs: int("INTENT_OUTBOX_RELAY_POLL_MS", 1000, 100, 60000),
    claimTimeoutMs: int("INTENT_OUTBOX_CLAIM_TIMEOUT_MS", 60000, 5000, 3600000),
    retryBaseMs: int("INTENT_OUTBOX_RETRY_BASE_MS", 1000, 100, 3600000),
    retryMaxMs: int("INTENT_OUTBOX_RETRY_MAX_MS", 300000, 1000, 86400000),
    workerId: (env.INTENT_OUTBOX_RELAY_WORKER_ID || "").trim() || `${os.hostname()}:${process.pid}`,
  };
}

module.exports = { createOutboxRelay, readRelayConfig, SQS_BODY_LIMIT_BYTES };
