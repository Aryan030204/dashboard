const { DEFAULTS } = require("./sqsPublisher");
const { parseBrandAllowlist } = require("./brandAllowlist");

// Startup validation for intent ingestion. Runs before the server listens, so a
// misconfiguration stops the process with a clear message instead of failing every
// /track request later.

const QUEUE_URL_PATTERN = /^https:\/\/sqs\.([a-z]{2}(?:-[a-z]+)+-\d)\.amazonaws\.com\/(\d{12})\/([A-Za-z0-9_-]{1,80})$/;
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

const POSITIVE_INT_VARS = [
  "INTENT_SQS_MAX_CONCURRENCY",
  "INTENT_SQS_MAX_PENDING",
  "INTENT_SQS_MAX_WAIT_MS",
  "INTENT_SQS_MAX_ATTEMPTS",
  "INTENT_SQS_MAX_SOCKETS",
  "INTENT_SQS_MAX_FREE_SOCKETS",
  "INTENT_SQS_SEND_TIMEOUT_MS",
];

// The gateway proxy timeout is 60 s, so one publisher attempt must stay well under it.
const MAX_SEND_TIMEOUT_MS = 20000;
const MAX_SEND_ATTEMPTS = 5;

function readInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  return Number(String(raw).trim());
}

function validateIntentConfig(env = process.env, mode) {
  const errors = [];

  for (const name of POSITIVE_INT_VARS) {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === "") continue;
    if (!/^\d+$/.test(String(raw).trim()) || Number(raw) <= 0) {
      errors.push(`${name} must be a positive integer`);
    }
  }

  // Brand allow-list applies to both ingestion modes.
  errors.push(...parseBrandAllowlist(env).errors);

  if (mode !== "sqs") return { errors };

  const queueUrl = (env.SQS_INTENT_QUEUE_URL || "").trim();
  const match = queueUrl.match(QUEUE_URL_PATTERN);
  if (!queueUrl) {
    errors.push("SQS_INTENT_QUEUE_URL is required when INTENT_EVENT_INGESTION=sqs");
  } else if (!match) {
    errors.push("SQS_INTENT_QUEUE_URL must look like https://sqs.<region>.amazonaws.com/<account-id>/<queue-name>");
  }

  // The client falls back to ap-south-1 when AWS_REGION is unset, so the check uses
  // the same default.
  const region = (env.AWS_REGION || "").trim() || "ap-south-1";
  if (!REGION_PATTERN.test(region)) {
    errors.push(`AWS_REGION (${region}) is not a valid AWS region name`);
  }
  if (match && match[1] !== region) {
    errors.push(`AWS_REGION (${region}) does not match the queue URL region (${match[1]})`);
  }

  const concurrency = readInt(env, "INTENT_SQS_MAX_CONCURRENCY", DEFAULTS.maxConcurrency);
  const sockets = readInt(env, "INTENT_SQS_MAX_SOCKETS", 64);
  if (concurrency > sockets) {
    errors.push(
      `INTENT_SQS_MAX_CONCURRENCY (${concurrency}) must not exceed INTENT_SQS_MAX_SOCKETS (${sockets}), or requests queue for a socket`,
    );
  }

  const attempts = readInt(env, "INTENT_SQS_MAX_ATTEMPTS", DEFAULTS.maxAttempts);
  if (attempts > MAX_SEND_ATTEMPTS) {
    errors.push(`INTENT_SQS_MAX_ATTEMPTS (${attempts}) must be at most ${MAX_SEND_ATTEMPTS}`);
  }

  const sendTimeout = readInt(env, "INTENT_SQS_SEND_TIMEOUT_MS", DEFAULTS.sendTimeoutMs);
  if (sendTimeout > MAX_SEND_TIMEOUT_MS) {
    errors.push(`INTENT_SQS_SEND_TIMEOUT_MS (${sendTimeout}) must be at most ${MAX_SEND_TIMEOUT_MS}`);
  }

  return { errors };
}

function assertIntentConfig(env = process.env, mode) {
  const { errors } = validateIntentConfig(env, mode);
  if (errors.length) {
    throw new Error(`invalid intent ingestion configuration: ${errors.join("; ")}`);
  }
}

module.exports = { validateIntentConfig, assertIntentConfig };
