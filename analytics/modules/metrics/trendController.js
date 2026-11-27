const { handleControllerError } = require('../../shared/middleware/handleControllerError');
const {
  normalizeMetricRequest,
} = require('./requestNormalizer');
const {
  isRangeOverDataRestrictionPeriod,
  buildLongRangeUnavailablePayload,
} = require('./longRangeGate');
const { daysInclusive } = require('../../shared/utils/date');

// The UTM source funnel compares two periods; each one is a single day or up to this many days.
const UTM_FUNNEL_MAX_DAYS = 7;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// The monthly funnel is limited so one request cannot read an unbounded span of the summary tables.
const FUNNEL_MAX_MONTHS = 6;

const monthsInclusive = (start, end) =>
  (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 +
  Number(end.slice(5, 7)) - Number(start.slice(5, 7)) + 1;

// Returns an error message for an invalid UTM funnel period, or null.
function validateUtmPeriod(label, start, end) {
  if (!start) return null;
  if (!ISO_DAY.test(start) || (end && !ISO_DAY.test(end))) {
    return `${label} must use the YYYY-MM-DD format`;
  }
  const last = end || start;
  if (last < start) return `${label} end cannot be before its start`;
  if (daysInclusive(start, last) > UTM_FUNNEL_MAX_DAYS) {
    return `${label} cannot exceed ${UTM_FUNNEL_MAX_DAYS} days`;
  }
  return null;
}

function buildTrendController({ metricsService }) {
  const parseBooleanQuery = (value, defaultValue) => {
    if (value === undefined || value === null || value === "") return defaultValue;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return defaultValue;
  };

  return {
    hourlyTrend: async (req, res) => {
      try {
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        if (!normalized.spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        if (isRangeOverDataRestrictionPeriod(normalized.spec.start, normalized.spec.end)) {
          return res.json(
            buildLongRangeUnavailablePayload({
              range: { start: normalized.spec.start, end: normalized.spec.end },
            }),
          );
        }
        return res.json(await metricsService.getTrend(normalized.spec, 'hourly'));
      } catch (e) {
        return handleControllerError(res, e, 'hourly-trend failed');
      }
    },

    dailyTrend: async (req, res) => {
      try {
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        if (!normalized.spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        return res.json(await metricsService.getTrend(normalized.spec, 'daily'));
      } catch (e) {
        return handleControllerError(res, e, 'daily-trend failed');
      }
    },

    dailyFunnel: async (req, res) => {
      try {
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        if (!normalized.spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        const granularity = req.query.granularity ? String(req.query.granularity) : 'daily';
        if (granularity !== 'daily' && granularity !== 'monthly') {
          return res.status(400).json({ error: "granularity must be 'daily' or 'monthly'" });
        }
        const monthly = granularity === 'monthly';
        if (monthly && monthsInclusive(normalized.spec.start, normalized.spec.end) > FUNNEL_MAX_MONTHS) {
          return res.status(400).json({ error: `Monthly funnel cannot exceed ${FUNNEL_MAX_MONTHS} months` });
        }
        const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
        const canAccessUtmFunnel =
          !!req.user?.isAuthor ||
          permissions.includes('all') ||
          permissions.includes('utm_funnel_table');
        const canAccessUtmCampaignGrain =
          !!req.user?.isAuthor ||
          permissions.includes('all') ||
          permissions.includes('utm_funnel_table:utm_campaign_grain');
        // Admins only (author, admin, super admin); no permission grants it to anyone else.
        const canSeePerformance = !!req.user?.isAuthor;
        const utmDate = req.query.utm_date ? String(req.query.utm_date) : normalized.spec.end;
        const utmEndDate = req.query.utm_end_date ? String(req.query.utm_end_date) : utmDate;
        const compareUtmDate = req.query.compare_utm_date ? String(req.query.compare_utm_date) : null;
        const compareUtmEndDate = req.query.compare_utm_end_date
          ? String(req.query.compare_utm_end_date)
          : compareUtmDate;
        const utmPeriodError =
          validateUtmPeriod('UTM funnel date range', utmDate, utmEndDate) ||
          validateUtmPeriod('UTM funnel comparison range', compareUtmDate, compareUtmEndDate);
        if (utmPeriodError) {
          return res.status(400).json({ error: utmPeriodError });
        }
        const includeDaily = monthly || parseBooleanQuery(req.query.include_daily, true);
        // The monthly view never reads the UTM tables (they are the expensive part of this endpoint).
        const includeUtm = !monthly && canAccessUtmFunnel
          ? parseBooleanQuery(req.query.include_utm, true)
          : false;

        return res.json(
          await metricsService.getDailyFunnel({
            ...normalized.spec,
            granularity,
            includePerformance: canSeePerformance,
            utmDate,
            utmEndDate,
            compareUtmDate,
            compareUtmEndDate,
            utmSource:
              canAccessUtmCampaignGrain && req.query.utm_source
                ? String(req.query.utm_source)
                : null,
            includeDaily,
            includeUtm,
          }),
        );
      } catch (e) {
        return handleControllerError(res, e, 'daily-funnel failed');
      }
    },

    monthlyTrend: async (req, res) => {
      try {
        const normalized = normalizeMetricRequest(req, { requireBoth: true });
        if (!normalized.ok) {
          return res.status(normalized.status).json(normalized.body);
        }
        if (!normalized.spec.conn) {
          return res.status(500).json({ error: 'Brand DB connection unavailable' });
        }
        return res.json(await metricsService.getTrend(normalized.spec, 'monthly'));
      } catch (e) {
        return handleControllerError(res, e, 'monthly-trend failed');
      }
    },
  };
}

module.exports = { buildTrendController };
