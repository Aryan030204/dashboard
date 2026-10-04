const { classifyClick } = require("./normalize");

// Builds the document written to intent_sessions.events. Field set matches the
// Sessions Pipeline exactly.
function buildEventDoc({ brand, e, sessionId, actorId, when, productIdOverride, timing, displayOccurredAt }) {
  const baseRaw = e.data ?? null;
  const raw = productIdOverride
    ? { ...(baseRaw || {}), product_id: productIdOverride }
    : baseRaw;

  return {
    brand_id: brand,
    event_id: e.event_id,
    session_id: sessionId,
    actor_id: actorId,
    event_name: e.event_name,
    occurred_at: displayOccurredAt ?? when,
    url: e.url || null,
    referrer: e.referrer || null,
    user_agent: e.user_agent || null,
    client_id: e.client_id || null,
    visitor_id: e.visitor_id || null,
    session_start: timing?.session_start ?? null,
    session_end: timing?.session_end ?? null,
    session_time_spent: timing?.session_time_spent ?? null,
    raw,
  };
}

// Builds the document written to intent_sessions.click_events.
function buildClickDoc({ brand, e, actorId, when, timing, displayOccurredAt }) {
  return {
    brand_id: brand,
    event_id: e.event_id,
    event_name: e.event_name,
    occurred_at: displayOccurredAt,
    ingested_at: new Date(),
    client_id: e.client_id || null,
    visitor_id: e.visitor_id || null,
    session_id: timing.session_id,
    actor_id: actorId,
    session_start: timing.session_start,
    session_end: timing.session_end,
    session_time_spent: timing.session_time_spent,
    url: e.url || null,
    referrer: e.referrer || null,
    user_agent: e.user_agent || null,
    click: e.data.click,
    signals: e.data.signals,
    click_bucket: classifyClick(e.data.signals),
    raw: e,
  };
}

module.exports = { buildEventDoc, buildClickDoc };
