// Client clocks must not drive sessionization.
//
// occurred_at is the visitor's own device time (Shopify's event.timestamp). A device whose clock is hours ahead (BBB sees
// 100-180 such events a day, and one in the year 2040) writes an actor cursor in the future, which used to make the
// consumer's idle-session sweep close every live session. The consumer now caps its sweep clock too; this is the source-side
// rule: an event more than FUTURE_TOLERANCE_MS ahead of the time /track received it is sessionized at the receipt time.
// The client's own value is never thrown away: it travels as client_occurred_at.
//
// 5 minutes comes from BBB 2026-11-12..14: honest events never run ahead of the server (the P99.9 of "client ahead of the
// write time" is +110..150 s), 62% of the events that do run ahead are within +5 min, and a device a few minutes fast is
// harmless because all of an actor's events share its offset. Override with INTENT_FUTURE_TOLERANCE_S.

const DEFAULT_FUTURE_TOLERANCE_S = 300;

function futureToleranceMs(env = process.env) {
  const raw = env.INTENT_FUTURE_TOLERANCE_S;
  if (raw === undefined || raw === "") return DEFAULT_FUTURE_TOLERANCE_S * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`INTENT_FUTURE_TOLERANCE_S must be a number of seconds >= 0, got ${raw}`);
  }
  return seconds * 1000;
}

// Returns the instant to sessionize with. Pure: both arguments are real instants (Dates).
function normalizeOccurredAt(clientTime, receivedAt, toleranceMs = futureToleranceMs()) {
  const skewMs = clientTime.getTime() - receivedAt.getTime();
  if (skewMs > toleranceMs) return { effective: receivedAt, normalized: true, skewMs };
  return { effective: clientTime, normalized: false, skewMs };
}

module.exports = { DEFAULT_FUTURE_TOLERANCE_S, futureToleranceMs, normalizeOccurredAt };
