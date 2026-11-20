// Deterministic selection of the GoKwik report email. Pure: no I/O, no clock. The sender, subject pattern and
// attachment filename pattern are CONFIGURATION (never guessed in code); this module only applies them.
const { PipelineError } = require("../errors");

function extractAddress(from) {
  const text = String(from || "").trim();
  const angle = /<([^>]+)>/.exec(text);
  return (angle ? angle[1] : text).trim().toLowerCase();
}

function compileRules(rules) {
  const missing = [];
  if (!rules.sender) missing.push("NDD_SLA_GMAIL_SENDER");
  if (!rules.subjectPattern) missing.push("NDD_SLA_GMAIL_SUBJECT_PATTERN");
  if (!rules.filenamePattern) missing.push("NDD_SLA_GMAIL_FILENAME_PATTERN");
  if (missing.length) throw new PipelineError("GMAIL_CONFIG_MISSING", `Missing Gmail matching config: ${missing.join(", ")}`);
  try {
    return {
      senders: String(rules.sender).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      subject: new RegExp(rules.subjectPattern, "i"),
      filename: new RegExp(rules.filenamePattern, "i"),
      pick: rules.pick === "latest" ? "latest" : "first",
    };
  } catch (err) {
    throw new PipelineError("GMAIL_CONFIG_INVALID", `Gmail subject/filename pattern is not a valid regular expression: ${err.message}`);
  }
}

// candidates: [{ id, from, subject, receivedWall, receivedMs, attachments: [{ id, filename, size }] }]
// range: { fromWall, toWall }, half-open on the message receive time in the report timezone.
// Returns { message, attachment, duplicates } or null. `duplicates` = other matching messages that were ignored.
// The order is total (receivedMs, then id) so the same inbox always yields the same choice.
function selectGokwikMessage(candidates, rules, range) {
  const r = compileRules(rules);
  const matches = [];
  for (const message of candidates) {
    if (!r.senders.includes(extractAddress(message.from))) continue;
    if (!r.subject.test(String(message.subject || ""))) continue;
    if (message.receivedWall < range.fromWall || message.receivedWall >= range.toWall) continue;
    const attachment = (message.attachments || []).find((a) => a.filename && r.filename.test(a.filename));
    if (!attachment) continue;
    matches.push({ message, attachment });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.message.receivedMs - b.message.receivedMs || String(a.message.id).localeCompare(String(b.message.id)));
  const chosen = r.pick === "latest" ? matches[matches.length - 1] : matches[0];
  return { ...chosen, duplicates: matches.length - 1 };
}

module.exports = { compileRules, extractAddress, selectGokwikMessage };
