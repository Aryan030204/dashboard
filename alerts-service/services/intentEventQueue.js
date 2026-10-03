const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

// SQS hard limit for a single message body.
const SQS_MESSAGE_LIMIT_BYTES = 256 * 1024;

// Client is created without an explicit identity, so the SDK's default
// provider chain resolves the EC2 instance role (datum-ec2-sqs-role) via IMDSv2.
let client = null;
function getClient() {
  if (!client) {
    client = new SQSClient({ region: process.env.AWS_REGION || "ap-south-1" });
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

module.exports = {
  SQS_MESSAGE_LIMIT_BYTES,
  serializeIntentEvent,
  sendIntentEvent,
};
