const crypto = require("crypto");
const { toStoreLocalOccurredAt } = require("./timezone");

// Per-actor session state machine, ported from the Sessions Pipeline with the
// same semantics. Storage is injected via `models`, so it can be unit-tested.
//
// models: { ActorCursor, Event, ClickEvent, SessionHistory }
function createSessionState({
  models,
  getBrandTimezone,
  sessionTimeoutMs,
  negativeGapToleranceMs,
  logger,
}) {
  const { ActorCursor, Event, ClickEvent, SessionHistory } = models;

  // session_time_spent is always null for the event being processed. It is only
  // filled in on the previous session's last document when a later event
  // reveals the session has closed.
  async function resolveSessionTiming(brand, actorId, when) {
    if (!actorId) {
      return {
        session_id: crypto.randomUUID(),
        session_start: when,
        session_end: null,
        session_time_spent: null,
        cursor: null,
        isNewSession: true,
      };
    }

    const cursor = await ActorCursor.findOne({ brand_id: brand, actor_id: actorId }).lean();
    const gap = cursor ? when - new Date(cursor.last_event_at) : Infinity;
    // Small negative gaps (out-of-order arrival) stay in the same session.
    // Only a gap beyond the timeout, in either direction, starts a new one.
    const isNewSession =
      !cursor || gap > sessionTimeoutMs || gap < -negativeGapToleranceMs;

    if (isNewSession) {
      return {
        session_id: crypto.randomUUID(),
        session_start: when,
        session_end: null,
        session_time_spent: null,
        cursor,
        isNewSession: true,
      };
    }

    return {
      session_id: cursor.session_id,
      session_start: new Date(cursor.session_start),
      session_end: when,
      session_time_spent: null,
      cursor,
      isNewSession: false,
    };
  }

  // Call only after the event was newly inserted (upsertedCount > 0). A failure
  // here is logged and not rethrown, matching the Sessions Pipeline. The event
  // is already stored at this point.
  async function commitSessionCursor(brand, actorId, timing, when, docRef, eventDoc) {
    if (!actorId) return;

    if (timing.isNewSession && timing.cursor) {
      const prevSessionStart = new Date(timing.cursor.session_start);
      const prevLastEventAt = new Date(timing.cursor.last_event_at);
      const prevSessionTimeSpent = prevLastEventAt - prevSessionStart;
      const PrevModel =
        timing.cursor.last_ref.collection === "click_events" ? ClickEvent : Event;

      try {
        await PrevModel.updateOne(
          { event_id: timing.cursor.last_ref.event_id },
          {
            $set: {
              session_end: prevLastEventAt,
              session_time_spent: prevSessionTimeSpent,
            },
          },
        );
      } catch (err) {
        logger?.error?.(`[session] failed to close previous session: ${err.message}`);
      }

      try {
        const displayOccurredAt = toStoreLocalOccurredAt(
          prevLastEventAt,
          getBrandTimezone(brand),
        );
        await SessionHistory.create({
          brand_id: brand,
          actor_id: actorId,
          session_id: timing.cursor.session_id,
          session_start: prevSessionStart,
          session_end: prevLastEventAt,
          session_time_spent: prevSessionTimeSpent,
          occurred_at: displayOccurredAt,
          events_seq: timing.cursor.events_seq || {},
          last_ref: timing.cursor.last_ref,
        });
      } catch (err) {
        logger?.error?.(`[session] failed to write session history: ${err.message}`);
      }
    }

    // events_seq holds the CURRENT open session's journey: reset on a new
    // session, otherwise append the next step (full event document).
    let eventsSeq;
    if (timing.isNewSession) {
      eventsSeq = { 1: eventDoc };
    } else {
      const prevSeq = timing.cursor?.events_seq || {};
      const nextKey = String(Object.keys(prevSeq).length + 1);
      eventsSeq = { ...prevSeq, [nextKey]: eventDoc };
    }

    // A tolerated out-of-order event must not move the "latest known event"
    // pointer backwards.
    let newLastEventAt = when;
    let newLastRef = docRef;
    if (!timing.isNewSession && timing.cursor) {
      const prevLastEventAt = new Date(timing.cursor.last_event_at);
      if (prevLastEventAt > when) {
        newLastEventAt = prevLastEventAt;
        newLastRef = timing.cursor.last_ref;
      }
    }

    try {
      await ActorCursor.updateOne(
        { brand_id: brand, actor_id: actorId },
        {
          $set: {
            session_id: timing.session_id,
            session_start: timing.session_start,
            last_event_at: newLastEventAt,
            last_ref: newLastRef,
            events_seq: eventsSeq,
          },
        },
        { upsert: true },
      );
    } catch (err) {
      logger?.error?.(`[session] failed to update actor cursor: ${err.message}`);
    }
  }

  return { resolveSessionTiming, commitSessionCursor };
}

module.exports = { createSessionState };
