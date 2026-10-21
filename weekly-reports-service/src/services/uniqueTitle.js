const { httpError } = require("../errors");

// A title that is already used by another presentation of the brand gets " (1)", then " (2)", ...
// appended. Only the title changes: the reporting week is never touched. `isTaken(candidate)` is
// supplied by the caller so the comparison uses the database's own collation (case-insensitive),
// and so this stays testable without a database.
async function uniqueTitle(isTaken, requested, maxLength = 200) {
  if (!(await isTaken(requested))) return requested;
  for (let n = 1; n <= 999; n += 1) {
    const suffix = ` (${n})`;
    // Keep the whole title within the column limit even when the original was already long.
    const candidate = requested.slice(0, maxLength - suffix.length).trimEnd() + suffix;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw httpError(409, "TITLE_CONFLICT", "Too many presentations share this title. Choose a different title.");
}

module.exports = { uniqueTitle };
