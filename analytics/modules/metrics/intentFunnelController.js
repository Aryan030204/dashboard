const { handleControllerError } = require('../../shared/middleware/handleControllerError');
const { daysInclusive } = require('../../shared/utils/date');
const { normalizeMetricRequest } = require('./requestNormalizer');
const {
  INTENT_LEVELS,
  OVERLAP_BASES,
  INTENT_FILTERS,
  PRODUCT_SORTS,
  PATH_STARTS,
  PATH_TOP_MIN,
  PATH_TOP_MAX,
  MAX_RANGE_DAYS,
  isQueryTimeout,
} = require('../../services/intentFunnelService');

function badRequest(res, error) {
  return res.status(400).json({ error });
}

function buildIntentFunnelController({ intentFunnelService }) {
  return {
    getIntentFunnel: async (req, res) => {
      try {
        // The range normalizer defaults a missing end to start, so "both" is checked here.
        if (!req.query.start || !req.query.end) {
          return badRequest(res, 'Both start and end dates are required');
        }
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        const { spec } = normalized;
        if (!spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        if (daysInclusive(spec.start, spec.end) > MAX_RANGE_DAYS) {
          return badRequest(res, `Date range cannot exceed ${MAX_RANGE_DAYS} days`);
        }

        const intent = String(req.query.intent || 'all').toLowerCase();
        if (!INTENT_FILTERS.includes(intent)) {
          return badRequest(res, 'Invalid intent');
        }

        const sort = String(req.query.sort || 'views').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(PRODUCT_SORTS, sort)) {
          return badRequest(res, 'Invalid sort');
        }

        const pathStart = String(req.query.path_start || PATH_STARTS[0]).toLowerCase();
        if (!PATH_STARTS.includes(pathStart)) {
          return badRequest(res, 'Invalid path_start');
        }

        const rawTop = req.query.path_top === undefined ? 5 : Number(req.query.path_top);
        if (!Number.isInteger(rawTop) || rawTop < PATH_TOP_MIN || rawTop > PATH_TOP_MAX) {
          return badRequest(
            res,
            `path_top must be an integer between ${PATH_TOP_MIN} and ${PATH_TOP_MAX}`,
          );
        }

        return res.json(
          await intentFunnelService.getIntentFunnel({
            conn: spec.conn,
            brandKey: spec.brandKey,
            start: spec.start,
            end: spec.end,
            timezone: spec.timezone,
            intent,
            sort,
            pathStart,
            pathTop: rawTop,
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Intent data took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'intent-funnel failed');
      }
    },

    // User overlap by UTM source. `intent` is a comma list of levels (default: all three).
    getSourceOverlap: async (req, res) => {
      try {
        if (!req.query.start || !req.query.end) {
          return badRequest(res, 'Both start and end dates are required');
        }
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        const { spec } = normalized;
        if (!spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        if (daysInclusive(spec.start, spec.end) > MAX_RANGE_DAYS) {
          return badRequest(res, `Date range cannot exceed ${MAX_RANGE_DAYS} days`);
        }

        const intents = String(req.query.intent || '')
          .toLowerCase()
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        if (intents.some((value) => !INTENT_LEVELS.includes(value))) {
          return badRequest(res, 'Invalid intent');
        }

        const basis = String(req.query.basis || 'behavior').toLowerCase();
        if (!OVERLAP_BASES.includes(basis)) {
          return badRequest(res, 'Invalid basis');
        }

        return res.json(
          await intentFunnelService.getSourceOverlap({
            conn: spec.conn,
            brandKey: spec.brandKey,
            start: spec.start,
            end: spec.end,
            intents,
            basis,
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Source overlap took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'intent-funnel source-overlap failed');
      }
    },

    // Intent report: the KPI figures per day and for the range. `basis` follows the page's Behaviour / Score switch.
    getIntentReport: async (req, res) => {
      try {
        if (!req.query.start || !req.query.end) {
          return badRequest(res, 'Both start and end dates are required');
        }
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        const { spec } = normalized;
        if (!spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        if (daysInclusive(spec.start, spec.end) > MAX_RANGE_DAYS) {
          return badRequest(res, `Date range cannot exceed ${MAX_RANGE_DAYS} days`);
        }

        const basis = String(req.query.basis || 'behavior').toLowerCase();
        if (!OVERLAP_BASES.includes(basis)) {
          return badRequest(res, 'Invalid basis');
        }

        return res.json(
          await intentFunnelService.getIntentReport({
            conn: spec.conn,
            brandKey: spec.brandKey,
            start: spec.start,
            end: spec.end,
            basis,
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'The report took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'intent-funnel report failed');
      }
    },
  };
}

module.exports = { buildIntentFunnelController };
