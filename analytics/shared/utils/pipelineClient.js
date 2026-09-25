// Server-to-server calls into the aws-pipeline-ec2 repo's Flask app
// (pipeline/worker_triggers.py: POST /workers/<name>/trigger, x-pipeline-key
// required). Used to kick the P&L worker for one brand right after that
// brand connects a Meta or Google ad account, instead of waiting for the
// worker's own nightly schedule to pick up the new credentials.
//
// PIPELINE_API_URL is this service's own addition (base URL of that Flask
// app, e.g. http://aws-pipeline-host:5000). The auth header reuses whichever
// of PIPELINE_AUTH_HEADER / X_PIPELINE_KEY is already set for the reverse
// direction (see shared/middleware/requireAuthorOrPipeline.js) - it's the
// same shared secret both repos already agree on.

const axios = require("axios");
const logger = require("./logger");
const { formatUtcDate } = require("./date");

const REQUEST_TIMEOUT_MS = 10000;

function pipelineAuthKey() {
  return process.env.PIPELINE_AUTH_HEADER || process.env.X_PIPELINE_KEY || "";
}

function pipelineBaseUrl() {
  return (process.env.PIPELINE_API_URL || "").trim().replace(/\/+$/, "");
}

// [start, end] inclusive, both YYYY-MM-DD, ending yesterday (today's figures
// are still incomplete in the brand DB, same convention the worker itself
// uses for its rolling window).
function lastNDaysRange(days) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: formatUtcDate(start), end: formatUtcDate(end) };
}

// Fires POST /workers/pnl/trigger for one brand_id, covering the last `days`
// days (default 30). Never throws - a brand's token save must succeed even
// when the pipeline is unreachable or already mid-run (409, since only one
// run per worker+brand slot is allowed); logs and swallows every failure.
//
// `syncing` is what callers show the brand: true whenever a run is actually
// in flight for it, which includes the 409 case (someone else's trigger is
// already rebuilding the same dates) but never a trigger that didn't land.
async function triggerPnlBackfill(brandKey, { days = 30 } = {}) {
  const baseUrl = pipelineBaseUrl();
  const key = pipelineAuthKey();
  if (!baseUrl || !key) {
    logger.warn("[pipelineClient] PIPELINE_API_URL / PIPELINE_AUTH_HEADER not configured; skipping pnl trigger", {
      brandKey,
    });
    return { triggered: false, syncing: false, reason: "not_configured" };
  }

  const { start, end } = lastNDaysRange(days);
  try {
    const response = await axios.post(
      `${baseUrl}/workers/pnl/trigger`,
      { brand_id: brandKey, start, end },
      { headers: { "x-pipeline-key": key }, timeout: REQUEST_TIMEOUT_MS },
    );
    logger.info("[pipelineClient] triggered pnl worker", { brandKey, start, end, status: response.data?.state });
    return { triggered: true, syncing: true, start, end, status: response.data };
  } catch (error) {
    // A 409 just means a run for this brand is already in flight - not an
    // error worth surfacing, the in-flight run already covers this request.
    if (error.response?.status === 409) {
      logger.info("[pipelineClient] pnl worker already running for brand", { brandKey });
      return { triggered: false, syncing: true, reason: "already_running" };
    }
    const message = error.response?.data?.message || error.message;
    logger.error("[pipelineClient] failed to trigger pnl worker", { brandKey, error: message });
    return { triggered: false, syncing: false, reason: "error", error: message };
  }
}

module.exports = {
  triggerPnlBackfill,
};
