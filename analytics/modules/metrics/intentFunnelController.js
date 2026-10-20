const { handleControllerError } = require('../../shared/middleware/handleControllerError');
const { daysInclusive } = require('../../shared/utils/date');
const { normalizeMetricRequest } = require('./requestNormalizer');
const {
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
  };
}

module.exports = { buildIntentFunnelController };
