// A small per-brand limit on how many heavy intent queries run at the same time.
//
// One Intent page load starts several scans of the same brand database at once (the page, the overlap
// card, the report, the heatmap list). The tenant pool has a fixed number of connections (BRAND_POOL_MAX),
// so without a limit one page load can take most of them and make every other dashboard of that brand wait.
// Extra queries wait here, in order, instead of waiting for a pool connection. Cached results never come
// here: only the query that actually runs does.
//
// INTENT_QUERY_CONCURRENCY (default 4, minimum 1) is the limit per brand.

const DEFAULT_LIMIT = 4;
const brands = new Map(); // brandKey -> { active, waiting: [] }

function limitFromEnv(env = process.env) {
  const value = Number.parseInt(env.INTENT_QUERY_CONCURRENCY, 10);
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_LIMIT;
}

function stateFor(brandKey) {
  let state = brands.get(brandKey);
  if (!state) {
    state = { active: 0, waiting: [] };
    brands.set(brandKey, state);
  }
  return state;
}

function release(brandKey, state) {
  state.active -= 1;
  const next = state.waiting.shift();
  if (next) next();
  else if (state.active === 0 && state.waiting.length === 0) brands.delete(brandKey);
}

// Runs `task` when the brand has a free slot. Without a brand key it runs straight away.
function runLimited(brandKey, task, limit = limitFromEnv()) {
  if (!brandKey) return task();
  const state = stateFor(brandKey);
  const start = () => {
    state.active += 1;
    return Promise.resolve()
      .then(task)
      .finally(() => release(brandKey, state));
  };
  if (state.active < limit) return start();
  return new Promise((resolve, reject) => {
    state.waiting.push(() => start().then(resolve, reject));
  });
}

function snapshot() {
  return [...brands.entries()].map(([brandKey, { active, waiting }]) => ({
    brandKey,
    active,
    waiting: waiting.length,
  }));
}

module.exports = { runLimited, limitFromEnv, snapshot, DEFAULT_LIMIT };
