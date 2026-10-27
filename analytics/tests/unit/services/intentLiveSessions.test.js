/* eslint-env jest */

const {
  EVENT_COUNTERS,
  parseSequence,
  countEvents,
  classifyLevel,
  classifyOpenSession,
  applyLive,
} = require("../../../services/intentLiveSessions");

const START = new Date("2026-10-27T10:00:00.000Z");
const at = (seconds) => new Date(START.getTime() + seconds * 1000);
const steps = (...names) =>
  Object.fromEntries(names.map((name, i) => [String(i + 1), { event_name: name, event_id: `e${i}` }]));

function open(seconds, ...names) {
  return { actor_id: "a1", session_start: START, last_event_at: at(seconds), events_seq: steps(...names) };
}

describe("intentLiveSessions", () => {
  test("the event-name mapping is the pipeline's (pipeline/intent_events.py _SESSION_EVENT_NAME_COUNTERS)", () => {
    expect(EVENT_COUNTERS).toEqual({
      page_viewed: "pageViews",
      product_viewed: "productViews",
      click: "clicks",
      product_added_to_cart: "addToCarts",
      checkout_started: "checkouts",
      scroll_depth: "scrolls",
    });
  });

  test("a 2-second, one-page-view session is low straight away", () => {
    expect(classifyOpenSession(open(2, "page_viewed")).level).toBe("low");
    expect(classifyOpenSession(open(0, "page_viewed")).level).toBe("low");   // a single event, 0 ms
  });

  test("the same session moves up as the visitor does more, and never down", () => {
    const events = ["page_viewed"];
    const levels = [classifyOpenSession(open(2, ...events)).level];
    events.push("scroll_depth");
    levels.push(classifyOpenSession(open(40, ...events)).level);                       // over 5 s, a scroll: medium
    events.push("product_viewed", "click", "product_added_to_cart", "checkout_started");
    levels.push(classifyOpenSession(open(600, ...events)).level);                      // clicks plus key actions: high
    expect(levels).toEqual(["low", "medium", "high"]);
  });

  test("the rules match the SQL: under 5 s or no clicks/scrolls is low; clicks plus a key action is high", () => {
    const base = { durationMs: 60000, clicks: 0, scrolls: 0, productViews: 0, addToCarts: 0, checkouts: 0 };
    expect(classifyLevel({ ...base, durationMs: 4999, clicks: 3, productViews: 2 })).toBe("low");
    expect(classifyLevel({ ...base })).toBe("low");                                      // long, but nothing done
    expect(classifyLevel({ ...base, scrolls: 2 })).toBe("medium");
    expect(classifyLevel({ ...base, clicks: 1 })).toBe("medium");                        // a click but no key action
    expect(classifyLevel({ ...base, clicks: 1, productViews: 1 })).toBe("high");
    expect(classifyLevel({ ...base, clicks: 1, addToCarts: 1 })).toBe("high");
    expect(classifyLevel({ ...base, clicks: 1, checkouts: 1 })).toBe("high");
    expect(classifyLevel({ ...base, productViews: 3 })).toBe("low");                     // viewing products, but no click or scroll
  });

  test("events_seq parses whether the driver returns an object, a string or a buffer, and tolerates junk", () => {
    const seq = steps("page_viewed", "click");
    expect(countEvents(parseSequence(seq)).clicks).toBe(1);
    expect(countEvents(parseSequence(JSON.stringify(seq))).clicks).toBe(1);
    expect(countEvents(parseSequence(Buffer.from(JSON.stringify(seq)))).pageViews).toBe(1);
    expect(parseSequence("not json")).toEqual({});
    expect(parseSequence(null)).toEqual({});
    expect(classifyOpenSession({ actor_id: "a", session_start: "bad", last_event_at: "bad", events_seq: "{}" })).toBeNull();
    expect(classifyOpenSession({ session_start: START, last_event_at: at(1), events_seq: "{}" })).toBeNull();
  });

  test("unknown event names are ignored and a last event before the start does not give a negative duration", () => {
    expect(countEvents(steps("something_else"))).toEqual({
      pageViews: 0, productViews: 0, clicks: 0, addToCarts: 0, checkouts: 0, scrolls: 0,
    });
    expect(classifyOpenSession({ actor_id: "a", session_start: at(10), last_event_at: START, events_seq: steps("page_viewed") }).level)
      .toBe("low");
  });

  describe("applyLive", () => {
    const counts = () => ({
      high: { cur_users: 5, cur_sessions: 6 },
      medium: { cur_users: 10, cur_sessions: 12 },
      low: { cur_users: 20, cur_sessions: 25 },
    });

    test("a new visitor adds one user and one session at the live level", () => {
      const out = applyLive(counts(), [{ actorId: "new", level: "low" }]);
      expect(out.low).toMatchObject({ cur_users: 21, cur_sessions: 26 });
      expect(out.high).toMatchObject({ cur_users: 5, cur_sessions: 6 });
    });

    test("a visitor with a closed low session and a live high one is counted once, as high", () => {
      const out = applyLive(counts(), [{ actorId: "a1", level: "high" }], new Map([["a1", 1]]));
      expect(out.low).toMatchObject({ cur_users: 19, cur_sessions: 25 });   // moved out of low
      expect(out.high).toMatchObject({ cur_users: 6, cur_sessions: 7 });
    });

    test("a live session at or below the visitor's closed level only adds a session", () => {
      const out = applyLive(counts(), [{ actorId: "a1", level: "low" }], new Map([["a1", 3]]));
      expect(out.high.cur_users).toBe(5);
      expect(out.low).toMatchObject({ cur_users: 20, cur_sessions: 26 });
    });

    test("only one live session per visitor counts as a user, at their best live level", () => {
      const live = [{ actorId: "a1", level: "low" }, { actorId: "a1", level: "medium" }];
      const out = applyLive(counts(), live);
      expect(out.medium).toMatchObject({ cur_users: 11, cur_sessions: 13 });
      expect(out.low).toMatchObject({ cur_users: 20, cur_sessions: 26 });
    });

    test("does not change its input, and totals of visitors only ever grow by new visitors", () => {
      const input = counts();
      const out = applyLive(input, [{ actorId: "x", level: "medium" }, { actorId: "y", level: "high" }], new Map([["y", 2]]));
      expect(input).toEqual(counts());
      const users = (c) => c.high.cur_users + c.medium.cur_users + c.low.cur_users;
      expect(users(out) - users(counts())).toBe(1);                         // x is new, y was already counted
    });
  });
});
