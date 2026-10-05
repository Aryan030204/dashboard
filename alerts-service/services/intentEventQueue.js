const https = require("https");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { NodeHttpHandler } = require("@smithy/node-http-handler");
const { intFromEnv, DEFAULTS } = require("./intent/sqsPublisher");

// SQS hard limit for a single message body.
const SQS_MESSAGE_LIMIT_BYTES = 256 * 1024;

// Hard upper bound for one SendMessage attempt. In the SDK handler, requestTimeout
// only logs a warning unless throwOnRequestTimeout is set, so the handler rejects
// on timeout, bounds idle sockets, and every send also carries an AbortSignal.
// The publisher adds its own deadline on top, so a slot is always released.
const SEND_TIMEOUT_MS = DEFAULTS.sendTimeoutMs;

// One long-lived keep-alive agent. maxSockets is kept above the producer's
// concurrency limit (INTENT_SQS_MAX_CONCURRENCY, default 32), so requests never
// queue for a socket. The app-level limit is the only queue, and the connect
// timer never runs while a request waits for a socket.
let agent = null;
function buildHttpsAgent() {
  if (!agent) {
    agent = new https.Agent({
      keepAlive: true,
      maxSockets: intFromEnv("INTENT_SQS_MAX_SOCKETS", 64),
      maxFreeSockets: intFromEnv("INTENT_SQS_MAX_FREE_SOCKETS", 32),
    });
  }
  return agent;
}

// Client is created without an explicit identity, so the SDK's default
// provider chain resolves the EC2 instance role (datum-ec2-sqs-role) via IMDSv2.
// maxAttempts is 1: retries of transient errors are handled by sqsPublisher, so
// the SDK does not multiply them.
function buildRequestHandler(timeoutMs = SEND_TIMEOUT_MS) {
  return new NodeHttpHandler({
    connectionTimeout: Math.min(5000, timeoutMs),
    requestTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    throwOnRequestTimeout: true,
    httpsAgent: buildHttpsAgent(),
  });
}

let client = null;
function getClient() {
  if (!client) {
    client = new SQSClient({
      region: process.env.AWS_REGION || "ap-south-1",
      maxAttempts: 1,
      requestHandler: buildRequestHandler(),
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
    { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
  );
  return result.MessageId;
}

module.exports = {
  SQS_MESSAGE_LIMIT_BYTES,
  SEND_TIMEOUT_MS,
  getClient,
  buildHttpsAgent,
  buildRequestHandler,
  serializeIntentEvent,
  sendIntentEvent,
  sendRawMessage,
};
