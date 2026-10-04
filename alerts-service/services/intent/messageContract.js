// Intent message contract (schema_version 1): the interface between alerts-service
// (producer) and the Intent Worker (consumer). Pure functions only; nothing here
// is wired into /track yet.
//
// Field names match the Mongo documents the production pipeline reads
// (intent_sessions.events, click_events, session_history), so the worker can
// feed the same extractors in aws-pipeline / intent-pipeline.

const SCHEMA_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
  EVENT: "event",
  CLICK: "click",
  SESSION_SNAPSHOT: "session_snapshot",
});

const VALID_CLICK_BUCKETS = new Set(["useful_click", "dead_click"]);

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return String(value);
}

function buildEventMessage(eventDoc) {
  if (!eventDoc || !eventDoc.event_id || !eventDoc.event_name || !eventDoc.brand_id) {
    throw new Error("event message requires brand_id, event_id and event_name");
  }
  return {
    schema_version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.EVENT,
    message_key: String(eventDoc.event_id),
    brand_id: eventDoc.brand_id,
    event_id: eventDoc.event_id,
    event_name: eventDoc.event_name,
    actor_id: eventDoc.actor_id ?? null,
    client_id: eventDoc.client_id ?? null,
    visitor_id: eventDoc.visitor_id ?? null,
    session_id: eventDoc.session_id ?? null,
    occurred_at: toIso(eventDoc.occurred_at),
    url: eventDoc.url ?? null,
    referrer: eventDoc.referrer ?? null,
    user_agent: eventDoc.user_agent ?? null,
    session_start: toIso(eventDoc.session_start),
    session_end: toIso(eventDoc.session_end),
    session_time_spent: eventDoc.session_time_spent ?? null,
    raw: eventDoc.raw ?? null,
  };
}

function buildClickMessage(clickDoc) {
  if (!clickDoc || !clickDoc.event_id || !clickDoc.event_name || !clickDoc.brand_id) {
    throw new Error("click message requires brand_id, event_id and event_name");
  }
  return {
    schema_version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.CLICK,
    message_key: String(clickDoc.event_id),
    brand_id: clickDoc.brand_id,
    event_id: clickDoc.event_id,
    event_name: clickDoc.event_name,
    actor_id: clickDoc.actor_id ?? null,
    client_id: clickDoc.client_id ?? null,
    visitor_id: clickDoc.visitor_id ?? null,
    session_id: clickDoc.session_id ?? null,
    occurred_at: toIso(clickDoc.occurred_at),
    url: clickDoc.url ?? null,
    referrer: clickDoc.referrer ?? null,
    user_agent: clickDoc.user_agent ?? null,
    session_start: toIso(clickDoc.session_start),
    session_end: toIso(clickDoc.session_end),
    session_time_spent: clickDoc.session_time_spent ?? null,
    click: clickDoc.click ?? {},
    signals: clickDoc.signals ?? {},
    click_bucket: clickDoc.click_bucket ?? null,
    raw: clickDoc.raw ?? null,
  };
}

// events_seq entries are reduced to the fields the session rollup reads
// (event_name, event_id, click_bucket, client_id, visitor_id). Full sub-event
// payloads are already delivered as event/click messages.
function compactEventsSeq(eventsSeq) {
  const compact = {};
  for (const [step, sub] of Object.entries(eventsSeq || {})) {
    if (!sub || typeof sub !== "object") continue;
    compact[String(step)] = {
      event_name: sub.event_name ?? null,
      event_id: sub.event_id ?? null,
      click_bucket: sub.click_bucket ?? null,
      client_id: sub.client_id ?? null,
      visitor_id: sub.visitor_id ?? null,
    };
  }
  return compact;
}

function buildSessionSnapshotMessage(sessionHistoryDoc, { sourceUpdatedAt } = {}) {
  if (!sessionHistoryDoc || !sessionHistoryDoc.session_id || !sessionHistoryDoc.actor_id || !sessionHistoryDoc.brand_id) {
    throw new Error("session snapshot requires brand_id, session_id and actor_id");
  }
  const sourceTs = sourceUpdatedAt ?? sessionHistoryDoc.updatedAt ?? null;
  if (!sourceTs) {
    throw new Error("session snapshot requires sourceUpdatedAt (version for stale-snapshot guard)");
  }
  return {
    schema_version: SCHEMA_VERSION,
    type: MESSAGE_TYPES.SESSION_SNAPSHOT,
    message_key: `session:${sessionHistoryDoc.session_id}`,
    brand_id: sessionHistoryDoc.brand_id,
    session_id: sessionHistoryDoc.session_id,
    actor_id: sessionHistoryDoc.actor_id,
    session_start: toIso(sessionHistoryDoc.session_start),
    session_end: toIso(sessionHistoryDoc.session_end),
    session_time_spent: sessionHistoryDoc.session_time_spent ?? null,
    occurred_at: toIso(sessionHistoryDoc.occurred_at),
    events_seq: compactEventsSeq(sessionHistoryDoc.events_seq),
    source_updated_at: toIso(sourceTs),
  };
}

function isIsoString(value) {
  if (typeof value !== "string") return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function validateMessage(message) {
  const errors = [];
  if (!message || typeof message !== "object") return ["message must be an object"];
  if (message.schema_version !== SCHEMA_VERSION) errors.push(`unsupported schema_version ${message.schema_version}`);
  if (!Object.values(MESSAGE_TYPES).includes(message.type)) errors.push(`unknown type ${message.type}`);
  if (!message.brand_id || typeof message.brand_id !== "string") errors.push("brand_id required");
  if (!message.message_key || typeof message.message_key !== "string") errors.push("message_key required");

  if (message.type === MESSAGE_TYPES.EVENT || message.type === MESSAGE_TYPES.CLICK) {
    if (!message.event_id) errors.push("event_id required");
    if (!message.event_name) errors.push("event_name required");
    if (!isIsoString(message.occurred_at)) errors.push("occurred_at must be ISO timestamp");
  }

  if (message.type === MESSAGE_TYPES.CLICK) {
    if (message.click_bucket != null && !VALID_CLICK_BUCKETS.has(message.click_bucket)) {
      errors.push(`invalid click_bucket ${message.click_bucket}`);
    }
  }

  if (message.type === MESSAGE_TYPES.SESSION_SNAPSHOT) {
    if (!message.session_id) errors.push("session_id required");
    if (!message.actor_id) errors.push("actor_id required");
    if (!isIsoString(message.session_start)) errors.push("session_start must be ISO timestamp");
    if (!isIsoString(message.source_updated_at)) errors.push("source_updated_at must be ISO timestamp");
    if (!message.events_seq || typeof message.events_seq !== "object") errors.push("events_seq required");
  }

  return errors;
}

function serializeMessage(message) {
  const errors = validateMessage(message);
  if (errors.length) throw new Error(`invalid intent message: ${errors.join("; ")}`);
  return JSON.stringify(message);
}

function messageBytes(message) {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

module.exports = {
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  buildEventMessage,
  buildClickMessage,
  buildSessionSnapshotMessage,
  compactEventsSeq,
  validateMessage,
  serializeMessage,
  messageBytes,
};
