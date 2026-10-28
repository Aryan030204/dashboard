// Pure view-models for the Intent Funnel (no imports), so the logic that decides what a chart or card shows can
// be tested with `node --test` without a browser.

// What the Intent Distribution donut shows for a distribution and the selected metric ("users" = visitors,
// "sessions"). The metric is the user's choice in BOTH bases (Score and Behaviour): the payload carries
// users and sessions for each level, and this picks the matching value, share and total, and labels them.
export function resolveDonutView({ distribution, metric = "users", basis = "score" } = {}) {
  const bySessions = metric === "sessions";
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const items = (distribution?.items || []).map((item) => ({
    level: item.level,
    value: num(bySessions ? item.sessions : item.users),
    pct: num(bySessions ? item.sessionsPct : item.pct),
  }));
  const total = num(bySessions ? distribution?.totalSessions : distribution?.total);
  // Score visitors are one level each, so the segments add up to the scored visitors. Older data (the visitor
  // query unavailable) counts a visitor in every level they had a session in; say so rather than call it unique.
  const perBucket = !bySessions && basis === "score" && distribution?.visitorBasis === "per_bucket";
  return {
    bySessions,
    items,
    total,
    metric: bySessions ? "sessions" : "users",
    centerLabel: bySessions ? "Sessions" : "Visitors",
    note: perBucket ? "A visitor can appear in more than one level." : null,
    botsExcluded: bySessions ? num(distribution?.botsExcluded) : 0,
  };
}

// The pieces of Total Sessions as { label, value } lines, in the order they add up:
// analysed + bots + live + waiting (+ other) = the total. `rollupBehind` is reported separately.
export function sessionsBreakdown(card) {
  if (!card) return { lines: [], rollupBehind: 0 };
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
  const lines = [
    { key: "analysed", label: "Analysed", value: num(card.analysed ?? card.closed) },
    { key: "bots", label: "Bots", value: num(card.bots) },
    { key: "live", label: "Live (current level)", value: num(card.live) },
    { key: "waiting", label: "Waiting to be analysed", value: num(card.waiting) },
    { key: "other", label: "Other", value: num(card.other) },
  ].filter((line) => line.value > 0 || line.key === "analysed");
  const behind = Number(card.rollupBehind);
  return { lines, rollupBehind: Number.isFinite(behind) && behind > 0 ? behind : 0 };
}
