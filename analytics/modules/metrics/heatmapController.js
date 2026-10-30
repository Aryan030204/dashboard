const { handleControllerError } = require('../../shared/middleware/handleControllerError');
const { daysInclusive } = require('../../shared/utils/date');
const { normalizeMetricRequest } = require('./requestNormalizer');
const { MAX_RANGE_DAYS, isQueryTimeout } = require('../../services/intentFunnelService');
const { MAX_PAGE_LIMIT, MAX_ELEMENT_LIMIT } = require('../../services/heatmapService');
const { DEVICES, normalizePagePath } = require('../../shared/utils/heatmap');

const MAX_SEARCH_LENGTH = 100;

function badRequest(res, error) {
  return res.status(400).json({ error });
}

// Shared by both endpoints: both dates, a brand connection and the range cap.
function readRange(req, res) {
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

function readLimit(raw, max) {
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false };
  return { ok: true, value: n };
}

function buildHeatmapController({ heatmapService }) {
  return {
    // Popular pages: page views per page path. `device` is all | desktop | mobile | tablet.
    getHeatmapPages: async (req, res) => {
      try {
        const spec = readRange(req, res);
        if (!spec) return undefined;

        const device = String(req.query.device || 'all').toLowerCase();
        if (device !== 'all' && !DEVICES.includes(device)) {
          return badRequest(res, 'Invalid device');
        }

        const search = String(req.query.search || '').trim();
        if (search.length > MAX_SEARCH_LENGTH) {
          return badRequest(res, `search must be at most ${MAX_SEARCH_LENGTH} characters`);
        }

        const limit = readLimit(req.query.limit, MAX_PAGE_LIMIT);
        if (!limit.ok) {
          return badRequest(res, `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
        }

        return res.json(
          await heatmapService.getHeatmapPages({
            conn: spec.conn,
            brandKey: spec.brandKey,
            start: spec.start,
            end: spec.end,
            device,
            search,
            limit: limit.value,
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Pages took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'heatmap pages failed');
      }
    },

    // Ranked clicked elements of one page. `path` may be a path or a full URL; it is normalised the same
    // way the rollups normalise page paths.
    getHeatmapElements: async (req, res) => {
      try {
        const spec = readRange(req, res);
        if (!spec) return undefined;

        const path = normalizePagePath(req.query.path);
        if (!path) {
          return badRequest(res, 'A valid page path is required');
        }

        const limit = readLimit(req.query.limit, MAX_ELEMENT_LIMIT);
        if (!limit.ok) {
          return badRequest(res, `limit must be an integer between 1 and ${MAX_ELEMENT_LIMIT}`);
        }

        return res.json(
          await heatmapService.getHeatmapElements({
            conn: spec.conn,
            brandKey: spec.brandKey,
            start: spec.start,
            end: spec.end,
            path,
            limit: limit.value,
          }),
        );
      } catch (e) {
        if (isQueryTimeout(e)) {
          return res.status(504).json({ error: 'Clicks took too long. Try a shorter date range.' });
        }
        return handleControllerError(res, e, 'heatmap elements failed');
      }
    },
  };
}

module.exports = { buildHeatmapController };
