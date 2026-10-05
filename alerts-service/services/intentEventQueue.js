const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { NodeHttpHandler } = require("@smithy/node-http-handler");

// SQS hard limit for a single message body.
const SQS_MESSAGE_LIMIT_BYTES = 256 * 1024;

// Client is created without an explicit identity, so the SDK's default
// provider chain resolves the EC2 instance role (datum-ec2-sqs-role) via IMDSv2.
let client = null;
function getClient() {
  if (!client) {
    // Bounded so a stalled socket fails fast (surfaced as 503) instead of hanging /track.
    client = new SQSClient({
      region: process.env.AWS_REGION || "ap-south-1",
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 3000, requestTimeout: 5000 }),
    });
  }
  return client;
}

function serializeIntentEvent(event) {
  return JSON.stringify({ ...event, ingested_at: new Date().toISOString() });
}

async function sendIntentEvent(event, { sqs = getClient(), queueUrl = process.env.SQS_INTENT_QUEUE_URL } = {}) {
  if (!queueUrl) throw new Error("SQS_INTENT_QUEUE_URL is not configured");
  const body = serializeIntentEvent(event);
  const result = await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }),
  );
  return result.MessageId;
}

// Sends an already-serialized body unchanged. The outbox relay uses this so the
// stored contract message is published exactly as written (no ingested_at added).
async function sendRawMessage(body, { sqs = getClient(), queueUrl = process.env.SQS_INTENT_QUEUE_URL } = {}) {
  if (!queueUrl) throw new Error("SQS_INTENT_QUEUE_URL is not configured");
  const result = await sqs.send(
    new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }),
  );
  return result.MessageId;
}

module.exports = {
  SQS_MESSAGE_LIMIT_BYTES,
  serializeIntentEvent,
  sendIntentEvent,
  sendRawMessage,
};
