const { handleControllerError } = require('../../shared/middleware/handleControllerError');
const { daysInclusive } = require('../../shared/utils/date');
const { normalizeMetricRequest } = require('./requestNormalizer');
const {
  OVERLAP_BASES,
  INTENT_FILTERS,
  PRODUCT_SORTS,
  PATH_STARTS,
  PATH_TOP_MIN,
  PATH_TOP_MAX,
  PATH_STEPS_MIN,
  PATH_STEPS_MAX,
  PATH_STEPS_DEFAULT,
  MAX_RANGE_DAYS,
  isQueryTimeout,
  normalizePathProductId,
} = require('../../services/intentFunnelService');

function badRequest(res, error) {
  return res.status(400).json({ error });
}

// Reads the path length query value; undefined means "use the default".
function readPathSteps(raw) {
  if (raw === undefined || raw === '') return { ok: true, value: PATH_STEPS_DEFAULT };
  const value = Number(raw);
  if (!Number.isInteger(value) || value < PATH_STEPS_MIN || value > PATH_STEPS_MAX) {
    return { ok: false };
  }
  return { ok: true, value };
}

// The checks every intent-funnel request shares: both dates, a brand connection and the range cap.
// Sends the error response itself and returns null when the request is not valid.
function resolveSpec(req, res) {
  if (!req.query.start || !req.query.end) {
    badRequest(res, 'Both start and end dates are required');
    return null;
  }
  const normalized = normalizeMetricRequest(req, { requireBoth: true });
  if (!normalized.ok) {
    res.status(normalized.status).json(normalized.body);
    return null;
  }
  const { spec } = normalized;
  if (!spec.conn) {
    res.status(500).json({ error: 'Brand DB connection unavailable' });
    return null;
  }
  if (daysInclusive(spec.start, spec.end) > MAX_RANGE_DAYS) {
    badRequest(res, `Date range cannot exceed ${MAX_RANGE_DAYS} days`);
    return null;
  }
  return spec;
}

// `readTopProductsCache(brandKey)` returns the cached top-products JSON of the brand's store (or null).
function buildIntentFunnelController({ intentFunnelService, readTopProductsCache }) {
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

        const pathSteps = readPathSteps(req.query.path_steps);
        if (!pathSteps.ok) {
          return badRequest(
            res,
            `path_steps must be an integer between ${PATH_STEPS_MIN} and ${PATH_STEPS_MAX}`,
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
            pathSteps: pathSteps.value,
            // the Funnel Exploration loads its own data (/intent-funnel/paths) and asks the page to leave it out
            skipPaths: ['1', 'true'].includes(String(req.query.skip_paths || '').toLowerCase()),
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Intent data took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'intent-funnel failed');
      }
    },

    // User overlap by UTM source. `intent` is "all" (default) or one of high / medium / low.
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

        const intent = String(req.query.intent || 'all').toLowerCase();
        if (!INTENT_FILTERS.includes(intent)) {
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
            intent,
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

    // Funnel Exploration for a product and/or an intent level (live, bounded). `product_id` is a numeric Shopify
    // product id; `intent` is all / high / medium / low on the `basis` the page is showing.
    getPaths: async (req, res) => {
      try {
        const spec = resolveSpec(req, res);
        if (!spec) return undefined;

        const intent = String(req.query.intent || 'all').toLowerCase();
        if (!INTENT_FILTERS.includes(intent)) {
          return badRequest(res, 'Invalid intent');
        }
        const basis = String(req.query.basis || 'behavior').toLowerCase();
        if (!OVERLAP_BASES.includes(basis)) {
          return badRequest(res, 'Invalid basis');
        }
        const pathStart = String(req.query.path_start || PATH_STARTS[0]).toLowerCase();
        if (!PATH_STARTS.includes(pathStart)) {
          return badRequest(res, 'Invalid path_start');
        }
        const steps = readPathSteps(req.query.steps);
        if (!steps.ok) {
          return badRequest(res, `steps must be an integer between ${PATH_STEPS_MIN} and ${PATH_STEPS_MAX}`);
        }
        let productId = null;
        if (req.query.product_id !== undefined && req.query.product_id !== '') {
          productId = normalizePathProductId(req.query.product_id);
          if (!productId) return badRequest(res, 'Invalid product_id');
        }

        return res.json(
          await intentFunnelService.getPaths({
            conn: spec.conn,
            brandKey: spec.brandKey,
            start: spec.start,
            end: spec.end,
            intent,
            basis,
            pathStart,
            steps: steps.value,
            productId,
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Path exploration took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'intent-funnel paths failed');
      }
    },

    // The product dropdown of the Funnel Exploration: the store's top products from the Redis cache.
    getPathProducts: async (req, res) => {
      try {
        const spec = resolveSpec(req, res);
        if (!spec) return undefined;
        return res.json(
          await intentFunnelService.getPathProducts(
            { conn: spec.conn, brandKey: spec.brandKey, start: spec.start, end: spec.end },
            { readTopProductsCache },
          ),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Products took too long to load.' });
        }
        return handleControllerError(res, e, 'intent-funnel path-products failed');
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
