/* eslint-disable react-refresh/only-export-components */
import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { useAppSelector } from "../../state/hooks.js";
import { useDashboardDataApi } from "./DashboardDataProvider.jsx";
import { fetchPagespeedResults, pagespeedBrandName } from "../../lib/pagespeed.js";

const WEB_VITAL_METRIC_KEYS = {
  FCP: "fcp",
  LCP: "lcp",
  TTFB: "ttfb",
  SESSIONS: "sessions",
  PERFORMANCE: "performance",
};

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKLY_LABEL_THRESHOLD = 60;
const WEEK_SIZE_DAYS = 7;

function buildIntentMetricState(metrics = {}) {
  const buildIntentEntry = (level) => {
    const sessionsMetric = metrics?.[`${level}_intent_sessions`];
    const percentMetric = metrics?.[`${level}_intent_percent`];

    return {
      sessions: sessionsMetric?.value ?? 0,
      percent:
        percentMetric?.value != null ? Number(percentMetric.value) / 100 : 0,
      sessionsDelta: sessionsMetric
        ? {
            diff_pct: sessionsMetric.diff_pct ?? 0,
            direction: sessionsMetric.direction ?? "flat",
          }
        : undefined,
      percentDelta: percentMetric
        ? {
            diff_pct: percentMetric.diff_pct ?? 0,
            diff_pp: percentMetric.diff_pp,
            direction: percentMetric.direction ?? "flat",
          }
        : undefined,
      prevSessions: sessionsMetric?.previous ?? null,
      prevPercent:
        percentMetric?.previous != null
          ? Number(percentMetric.previous) / 100
          : null,
      unavailable: !!sessionsMetric?.unavailable || !!percentMetric?.unavailable,
    };
  };

  return {
    high: buildIntentEntry("high"),
    medium: buildIntentEntry("medium"),
    low: buildIntentEntry("low"),
  };
}

function getPreviousDateWindow(startStr, endStr) {
  if (!startStr || !endStr) return { prev_start: null, prev_end: null };
  const startDate = new Date(startStr);
  const endDate = new Date(endStr);
  const daysDiff =
    Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
  const prevEnd = new Date(startDate);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - daysDiff + 1);
  return {
    prev_start: prevStart.toISOString().split("T")[0],
    prev_end: prevEnd.toISOString().split("T")[0],
  };
}

function calculatePageMetric(results, metricKey) {
  const grouped = {};
  results.forEach((item) => {
    if (!grouped[item.url]) grouped[item.url] = [];
    grouped[item.url].push(item[metricKey]);
  });
  return Object.entries(grouped).map(([url, arr]) => {
    const isSum = metricKey === "sessions";
    const sum = arr.reduce((a, b) => a + (b || 0), 0);
    return {
      url,
      avg: isSum ? sum : sum / arr.length,
    };
  });
}

export function useDashboardWebVitalsData(query, metric = "FCP", options = {}) {
  const { getWebPerformanceSummary } = useDashboardDataApi();
  const [data, setData] = useState({
    performanceAvg: null,
    performancePrev: null,
    performanceChange: null,
    topPages: [],
    isSingleDateSelection: true,
    loading: true,
  });
  const usePerformanceSummary = options?.usePerformanceSummary === true;
  const disabled = options?.disabled === true;
  const { user } = useAppSelector((state) => state.auth);
  const globalBrandKey = useAppSelector((state) => state.brand.brand);
  const activeBrandKey = (
    query?.brand_key ||
    globalBrandKey ||
    user?.brandKey ||
    ""
  )
    .toString()
    .trim()
    .toUpperCase();

  const brandName = useMemo(() => pagespeedBrandName(activeBrandKey), [activeBrandKey]);

  const startDate = query?.start || null;
  const endDate = query?.end || null;

  useEffect(() => {
    let cancelled = false;

    if (disabled) {
      setData({
        performanceAvg: null,
        performancePrev: null,
        performanceChange: null,
        topPages: [],
        isSingleDateSelection: startDate === endDate,
        loading: false,
      });
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      if (!brandName || !startDate || !endDate) {
        if (!cancelled) {
          setData((prev) => ({
            ...prev,
            loading: false,
            isSingleDateSelection: true,
          }));
        }
        return;
      }

      if (!cancelled) setData((prev) => ({ ...prev, loading: true }));

      const { prev_start, prev_end } = getPreviousDateWindow(startDate, endDate);
      const metricKey = WEB_VITAL_METRIC_KEYS[metric] || "fcp";
      const isSingleDateSelection = startDate === endDate;

      const [performanceSummary, currentData, prevData] = await Promise.all([
        usePerformanceSummary
          ? getWebPerformanceSummary({
              brand_key: activeBrandKey,
              start: startDate,
              end: endDate,
              timezone: query?.timezone,
            }).then((json) =>
              json?.__error
                ? {
                    current_avg: null,
                    previous_avg: null,
                    change_percent: null,
                  }
                : {
                    current_avg: json?.current_avg ?? null,
                    previous_avg: json?.previous_avg ?? null,
                    change_percent: json?.change_percent ?? null,
                  },
            )
          : Promise.resolve({
              current_avg: null,
              previous_avg: null,
              change_percent: null,
            }),
        fetchPagespeedResults(brandName, startDate, endDate),
        fetchPagespeedResults(brandName, prev_start, prev_end),
      ]);

      if (cancelled) return;

      if (
        !currentData.length &&
        !prevData.length &&
        (!usePerformanceSummary ||
          (performanceSummary.current_avg == null &&
            performanceSummary.previous_avg == null))
      ) {
        setData({
          performanceAvg: null,
          performancePrev: null,
          performanceChange: null,
          topPages: [],
          isSingleDateSelection,
          loading: false,
        });
        return;
      }

      const currentPerformance = usePerformanceSummary
        ? performanceSummary.current_avg
        : currentData.reduce((a, b) => a + b.performance, 0) /
          (currentData.length || 1);
      const previousPerformance = usePerformanceSummary
        ? performanceSummary.previous_avg
        : prevData.reduce((a, b) => a + b.performance, 0) /
          (prevData.length || 1);
      const performanceChange = usePerformanceSummary
        ? performanceSummary.change_percent
        : previousPerformance > 0
          ? ((currentPerformance - previousPerformance) / previousPerformance) *
            100
          : null;

      const currentPages = calculatePageMetric(currentData, metricKey);
      const previousPages = calculatePageMetric(prevData, metricKey);
      const combined = currentPages.map((page) => {
        const match = previousPages.find((prev) => prev.url === page.url);
        let change = null;
        if (match && match.avg > 0) {
          if (metric === "SESSIONS" || metric === "PERFORMANCE") {
            change = ((page.avg - match.avg) / match.avg) * 100;
          } else {
            change = ((match.avg - page.avg) / match.avg) * 100;
          }
        }
        return { url: page.url, avg: page.avg, change };
      });
      const isDescending = metric === "SESSIONS" || metric === "PERFORMANCE";
      const topPages = isSingleDateSelection
        ? combined
            .sort((a, b) => (isDescending ? b.avg - a.avg : a.avg - b.avg))
            .slice(0, 5)
        : [];

      setData({
        performanceAvg: currentPerformance,
        performancePrev: previousPerformance,
        performanceChange,
        topPages,
        isSingleDateSelection,
        loading: false,
      });
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    activeBrandKey,
    brandName,
    disabled,
    endDate,
    getWebPerformanceSummary,
    metric,
    query?.timezone,
    startDate,
    usePerformanceSummary,
  ]);

  return data;
}

export function useDashboardKpiData({
  query,
  onLoaded,
  productId,
  showWebVitals = true,
}) {
  const { getDashboardSummary, getProductKpis } = useDashboardDataApi();
  const [loading, setLoading] = useState(true);
  const [deltaLoading, setDeltaLoading] = useState(true);
  const [data, setData] = useState({});
  const start = query?.start;
  const end = query?.end;
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const scopedProductId = (productId || "").toString().trim();
  const isProductScoped = scopedProductId.length > 0;
  const utmSource = query?.utm_source;
  const utmMedium = query?.utm_medium;
  const utmCampaign = query?.utm_campaign;
  const salesChannel = query?.sales_channel;
  const deviceType = query?.device_type;
  const discountCode = query?.discount_code;
  const city = query?.city;
  const productType = query?.product_type;
  const compareStart = query?.compare_start;
  const compareEnd = query?.compare_end;
  const hasScopedUtmSource = Array.isArray(utmSource)
    ? utmSource.length > 0
    : !!utmSource;
  const webVitalsData = useDashboardWebVitalsData(query, "PERFORMANCE", {
    usePerformanceSummary: true,
    disabled: !showWebVitals,
  });

  useEffect(() => {
    let cancelled = false;
    if (!start || !end) {
      setData({});
      setLoading(false);
      setDeltaLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    setDeltaLoading(true);

    const load = async () => {
      try {
        if (isProductScoped) {
          const base = brandKey
            ? {
                start,
                end,
                brand_key: brandKey,
                product_id: scopedProductId,
                utm_source: utmSource,
              }
            : { start, end, product_id: scopedProductId, utm_source: utmSource };

          const summaryBase = { ...base, align: "hour" };
          if (compareStart && compareEnd) {
            summaryBase.compare_start = compareStart;
            summaryBase.compare_end = compareEnd;
          }

          const [resp, summaryResp] = await Promise.all([
            getProductKpis(base),
            getDashboardSummary(summaryBase),
          ]);
          if (cancelled) return;
          if (resp.error) {
            setData({});
            setLoading(false);
            setDeltaLoading(false);
            return;
          }

          const m = summaryResp?.metrics || {};
          const orders = {
            value: hasScopedUtmSource
              ? (m.total_orders?.value ?? 0)
              : (resp.total_orders ?? 0),
          };
          const sales = {
            value: hasScopedUtmSource
              ? (m.total_sales?.value ?? 0)
              : (resp.total_sales ?? 0),
          };
          const aovValue = hasScopedUtmSource
            ? (m.average_order_value?.value ?? 0)
            : orders.value > 0
              ? resp.total_sales / orders.value
              : 0;
          const funnel = {
            total_sessions: hasScopedUtmSource
              ? (m.total_sessions?.value ?? 0)
              : (resp.sessions ?? 0),
            total_atc_sessions: hasScopedUtmSource
              ? (m.total_atc_sessions?.value ?? 0)
              : (resp.sessions_with_cart_additions ?? 0),
            total_orders: orders.value,
          };
          const cvr = {
            cvr: hasScopedUtmSource
              ? (m.conversion_rate?.value ?? 0) / 100
              : (resp.conversion_rate ?? 0),
            cvr_percent: hasScopedUtmSource
              ? (m.conversion_rate?.value ?? 0)
              : (resp.conversion_rate_pct ?? 0),
          };
          const returnsData = {
            cancelled_rate:
              orders.value > 0
                ? hasScopedUtmSource
                  ? (m.cancelled_orders?.value ?? 0) / orders.value
                  : (resp.cancelled_orders ?? 0) / orders.value
                : 0,
            refunded_rate:
              orders.value > 0
                ? hasScopedUtmSource
                  ? (m.refunded_orders?.value ?? 0) / orders.value
                  : (resp.refunded_orders ?? 0) / orders.value
                : 0,
          };
          const rtoData = {
            orders:
              hasScopedUtmSource && m.rto_orders?.unavailable
                ? 0
                : hasScopedUtmSource
                  ? (m.rto_orders?.value ?? 0)
                  : (resp.rto_orders ?? 0),
            rate:
              hasScopedUtmSource && m.rto_rate?.unavailable
                ? 0
                : hasScopedUtmSource
                  ? (m.rto_rate?.value ?? 0) / 100
                  : typeof resp.rto_rate === "number"
                    ? resp.rto_rate
                    : orders.value > 0
                      ? (resp.rto_orders ?? 0) / orders.value
                      : 0,
          };
          const intentMetrics = buildIntentMetricState(m);

          setData({
            orders,
            sales,
            aov: { aov: aovValue },
            cvr,
            funnel,
            returnsData,
            rtoData,
            intentMetrics,
            totalSessions: funnel.total_sessions,
            totalAtcSessions: funnel.total_atc_sessions,
            totalCiEvents: { value: 0 },
            ordersDelta: {
              diff_pct: m.total_orders?.diff_pct ?? 0,
              direction: m.total_orders?.direction ?? "flat",
            },
            salesDelta: {
              diff_pct: m.total_sales?.diff_pct ?? 0,
              direction: m.total_sales?.direction ?? "flat",
            },
            aovDelta: {
              diff_pct: m.average_order_value?.diff_pct ?? 0,
              direction: m.average_order_value?.direction ?? "flat",
            },
            cvrDelta: {
              diff_pct: m.conversion_rate?.diff_pct ?? 0,
              diff_pp: m.conversion_rate?.diff_pp,
              direction: m.conversion_rate?.direction ?? "flat",
            },
            sessDelta: {
              diff_pct: m.total_sessions?.diff_pct ?? 0,
              direction: m.total_sessions?.direction ?? "flat",
            },
            atcDelta: {
              diff_pct: m.total_atc_sessions?.diff_pct ?? 0,
              direction: m.total_atc_sessions?.direction ?? "flat",
            },
            ciDelta: {
              diff_pct: m.total_ci_events?.diff_pct ?? 0,
              direction: m.total_ci_events?.direction ?? "flat",
            },
            checkoutRateDelta: {
              diff_pct: m.checkout_rate?.diff_pct ?? 0,
              direction: m.checkout_rate?.direction ?? "flat",
            },
            atcRateDelta: {
              diff_pct: m.atc_rate?.diff_pct ?? 0,
              direction: m.atc_rate?.direction ?? "flat",
            },
            cancelledRateDelta: {
              diff_pct: m.cancelled_orders?.diff_pct ?? 0,
              direction: m.cancelled_orders?.direction ?? "flat",
            },
            refundedRateDelta: {
              diff_pct: m.refunded_orders?.diff_pct ?? 0,
              direction: m.refunded_orders?.direction ?? "flat",
            },
            rtoOrdersDelta: {
              diff_pct: m.rto_orders?.diff_pct ?? 0,
              direction: m.rto_orders?.direction ?? "flat",
            },
            rtoRateDelta: {
              diff_pct: m.rto_rate?.diff_pct ?? 0,
              direction: m.rto_rate?.direction ?? "flat",
            },
            prevOrders: m.total_orders?.previous ?? null,
            prevSales: m.total_sales?.previous ?? null,
            prevAov: m.average_order_value?.previous ?? null,
            prevCvr: m.conversion_rate?.previous ?? null,
            prevSessions: m.total_sessions?.previous ?? null,
            prevAtcSessions: m.total_atc_sessions?.previous ?? null,
            prevCiEvents: m.total_ci_events?.previous ?? null,
            prevCheckoutRate: m.checkout_rate?.previous ?? null,
            prevAtcRate: m.atc_rate?.previous ?? null,
            prevCancelledOrders: m.cancelled_orders?.previous ?? null,
            prevRefundedOrders: m.refunded_orders?.previous ?? null,
            prevRtoOrders: m.rto_orders?.previous ?? null,
            prevRtoRate: m.rto_rate?.previous ?? null,
            unavailable: {
              sessions: !!m.total_sessions?.unavailable,
              atc:
                !!m.total_atc_sessions?.unavailable || !!m.atc_rate?.unavailable,
              ci: true,
              cvr: !!m.conversion_rate?.unavailable,
              returns:
                !!m.cancelled_orders?.unavailable ||
                !!m.refunded_orders?.unavailable,
              rto: !!m.rto_orders?.unavailable || !!m.rto_rate?.unavailable,
            },
          });
        } else {
          const base = brandKey
            ? {
                start,
                end,
                brand_key: brandKey,
                align: "hour",
                utm_source: utmSource,
                utm_medium: utmMedium,
                utm_campaign: utmCampaign,
                sales_channel: salesChannel,
                device_type: deviceType,
                discount_code: discountCode,
                city,
                product_type: productType,
              }
            : {
                start,
                end,
                align: "hour",
                utm_source: utmSource,
                utm_medium: utmMedium,
                utm_campaign: utmCampaign,
                sales_channel: salesChannel,
                device_type: deviceType,
                discount_code: discountCode,
                city,
                product_type: productType,
              };
          if (compareStart && compareEnd) {
            base.compare_start = compareStart;
            base.compare_end = compareEnd;
            base._t = Date.now();
          }

          const resp = await getDashboardSummary(base);
          if (cancelled) return;
          if (resp.error || !resp.metrics) {
            setData({});
            setLoading(false);
            setDeltaLoading(false);
            return;
          }
          const m = resp.metrics || {};
          const orders = { value: m.total_orders?.value ?? 0 };
          const sales = { value: m.total_sales?.value ?? 0 };
          const sessions = m.total_sessions?.value ?? 0;
          const atcSessions = m.total_atc_sessions?.value ?? 0;
          const intentMetrics = buildIntentMetricState(m);
          setData({
            orders,
            sales,
            aov: { aov: m.average_order_value?.value ?? 0 },
            totalCiEvents: { value: m.total_ci_events?.value ?? 0 },
            cvr: {
              cvr: (m.conversion_rate?.value ?? 0) / 100,
              cvr_percent: m.conversion_rate?.value ?? 0,
            },
            funnel: {
              total_sessions: sessions,
              total_atc_sessions: atcSessions,
              total_ci_events: m.total_ci_events?.value ?? 0,
              total_orders: orders.value,
            },
            returnsData: {
              cancelled_rate:
                orders.value > 0
                  ? (m.cancelled_orders?.value ?? 0) / orders.value
                  : 0,
              refunded_rate:
                orders.value > 0
                  ? (m.refunded_orders?.value ?? 0) / orders.value
                  : 0,
            },
            rtoData: {
              orders: m.rto_orders?.value ?? 0,
              rate:
                m.rto_rate?.value != null
                  ? (m.rto_rate.value ?? 0) / 100
                  : orders.value > 0
                    ? (m.rto_orders?.value ?? 0) / orders.value
                    : 0,
            },
            intentMetrics,
            totalSessions: sessions,
            totalAtcSessions: atcSessions,
            ordersDelta: {
              diff_pct: m.total_orders?.diff_pct ?? 0,
              direction: m.total_orders?.direction ?? "flat",
            },
            salesDelta: {
              diff_pct: m.total_sales?.diff_pct ?? 0,
              direction: m.total_sales?.direction ?? "flat",
            },
            aovDelta: {
              diff_pct: m.average_order_value?.diff_pct ?? 0,
              direction: m.average_order_value?.direction ?? "flat",
            },
            cvrDelta: {
              diff_pct: m.conversion_rate?.diff_pct ?? 0,
              diff_pp: m.conversion_rate?.diff_pp,
              direction: m.conversion_rate?.direction ?? "flat",
            },
            sessDelta: {
              diff_pct: m.total_sessions?.diff_pct ?? 0,
              direction: m.total_sessions?.direction ?? "flat",
            },
            atcDelta: {
              diff_pct: m.total_atc_sessions?.diff_pct ?? 0,
              direction: m.total_atc_sessions?.direction ?? "flat",
            },
            ciDelta: {
              diff_pct: m.total_ci_events?.diff_pct ?? 0,
              direction: m.total_ci_events?.direction ?? "flat",
            },
            checkoutRateDelta: {
              diff_pct: m.checkout_rate?.diff_pct ?? 0,
              direction: m.checkout_rate?.direction ?? "flat",
            },
            atcRateDelta: {
              diff_pct: m.atc_rate?.diff_pct ?? 0,
              direction: m.atc_rate?.direction ?? "flat",
            },
            cancelledRateDelta: {
              diff_pct: m.cancelled_orders?.diff_pct ?? 0,
              direction: m.cancelled_orders?.direction ?? "flat",
            },
            refundedRateDelta: {
              diff_pct: m.refunded_orders?.diff_pct ?? 0,
              direction: m.refunded_orders?.direction ?? "flat",
            },
            rtoOrdersDelta: {
              diff_pct: m.rto_orders?.diff_pct ?? 0,
              direction: m.rto_orders?.direction ?? "flat",
            },
            rtoRateDelta: {
              diff_pct: m.rto_rate?.diff_pct ?? 0,
              direction: m.rto_rate?.direction ?? "flat",
            },
            prevOrders: m.total_orders?.previous ?? null,
            prevSales: m.total_sales?.previous ?? null,
            prevAov: m.average_order_value?.previous ?? null,
            prevCvr: m.conversion_rate?.previous ?? null,
            prevSessions: m.total_sessions?.previous ?? null,
            prevAtcSessions: m.total_atc_sessions?.previous ?? null,
            prevCiEvents: m.total_ci_events?.previous ?? null,
            prevCheckoutRate:
              m.checkout_rate?.previous != null
                ? m.checkout_rate.previous / 100
                : null,
            prevAtcRate:
              m.atc_rate?.previous != null ? m.atc_rate.previous / 100 : null,
            prevCancelledRate:
              (m.total_orders?.previous ?? 0) > 0
                ? (m.cancelled_orders?.previous ?? 0) / m.total_orders.previous
                : null,
            prevRefundedRate:
              (m.total_orders?.previous ?? 0) > 0
                ? (m.refunded_orders?.previous ?? 0) / m.total_orders.previous
                : null,
            prevRtoOrders: m.rto_orders?.previous ?? null,
            prevRtoRate:
              m.rto_rate?.previous != null
                ? m.rto_rate.previous / 100
                : (m.total_orders?.previous ?? 0) > 0
                  ? (m.rto_orders?.previous ?? 0) / m.total_orders.previous
                  : null,
            unavailable: {
              sessions: !!m.total_sessions?.unavailable,
              atc:
                !!m.total_atc_sessions?.unavailable || !!m.atc_rate?.unavailable,
              ci:
                !!m.total_ci_events?.unavailable || !!m.checkout_rate?.unavailable,
              cvr: !!m.conversion_rate?.unavailable,
              returns:
                !!m.cancelled_orders?.unavailable ||
                !!m.refunded_orders?.unavailable,
              rto: !!m.rto_orders?.unavailable || !!m.rto_rate?.unavailable,
            },
          });
        }
        setLoading(false);
        setDeltaLoading(false);
        onLoaded?.(new Date());
      } catch {
        if (cancelled) return;
        setLoading(false);
        setDeltaLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    brandKey,
    city,
    compareEnd,
    compareStart,
    discountCode,
    deviceType,
    end,
    getDashboardSummary,
    getProductKpis,
    hasScopedUtmSource,
    isProductScoped,
    onLoaded,
    productType,
    refreshKey,
    salesChannel,
    scopedProductId,
    start,
    utmCampaign,
    utmMedium,
    utmSource,
  ]);

  return {
    loading,
    deltaLoading,
    data,
    webVitalsData,
  };
}

export function useDashboardTrafficSourceSplitData({ query, mappingRules = [] }) {
  const { getTrafficSourceSplit } = useDashboardDataApi();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const productType = query?.product_type;
  const hasActiveProductTypeFilter =
    Array.isArray(productType) && productType.length > 0;

  useEffect(() => {
    let cancelled = false;
    // Traffic source split is sourced from ad-attribution tables entirely
    // unrelated to mv_product_type_funnel_daily — it has no way to honor a
    // Product Type filter, so don't fetch/render it while one is active.
    if (!query?.start || !query?.end || hasActiveProductTypeFilter) {
      setData(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    getTrafficSourceSplit({ ...query, mappingRules })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getTrafficSourceSplit, hasActiveProductTypeFilter, mappingRules, query]);

  return { loading, data };
}

function getPreviousRange(start, end) {
  if (!start || !end) return { start: null, end: null };
  const s = dayjs(start);
  const e = dayjs(end);
  const diff = e.diff(s, "day") + 1;
  const prevEnd = s.subtract(1, "day");
  const prevStart = prevEnd.subtract(diff - 1, "day");
  return {
    start: prevStart.format("YYYY-MM-DD"),
    end: prevEnd.format("YYYY-MM-DD"),
  };
}

function getTimezoneParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = Number(parts.hour || 0);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: hour === 24 ? 0 : hour,
  };
}

function getHourlyCutoffForTodayRange(start, end, timezone) {
  if (!start || !end) return null;
  const nowLocal = getTimezoneParts(new Date(), timezone);
  const includesToday = start <= nowLocal.date && end >= nowLocal.date;
  if (!includesToday) return null;
  return Math.max(0, nowLocal.hour - 1);
}

export function useDashboardModeOfPaymentData({
  query,
  convertAmount,
  formatConvertedAmount,
}) {
  const { getOrderSplit, getPaymentSalesSplit, getPaymentSplitSummary } =
    useDashboardDataApi();
  const [loading, setLoading] = useState(true);
  const [prevRange, setPrevRange] = useState(null);
  const [data, setData] = useState({
    quantity: [],
    value: [],
    totalQuantity: 0,
    totalValue: 0,
  });

  const start = query?.start;
  const end = query?.end;
  const brandKey = query?.brand_key;
  const productId = query?.product_id;
  const utmSource = query?.utm_source;
  const utmMedium = query?.utm_medium;
  const utmCampaign = query?.utm_campaign;
  const salesChannel = query?.sales_channel;
  const deviceType = query?.device_type;
  const discountCode = query?.discount_code;
  const city = query?.city;
  const productType = query?.product_type;
  const timezone = query?.timezone;

  useEffect(() => {
    let cancelled = false;
    if (!start || !end) {
      setLoading(false);
      return;
    }

    setLoading(true);

    const load = async () => {
      try {
        const prevRangeData = getPreviousRange(start, end);
        setPrevRange(prevRangeData);
        const baseParams = {
          brand_key: brandKey,
          product_id: productId,
          utm_source: utmSource,
          utm_medium: utmMedium,
          utm_campaign: utmCampaign,
          sales_channel: salesChannel,
          device_type: deviceType,
          discount_code: discountCode,
          city,
          product_type: productType,
        };

        const summary = await getPaymentSplitSummary({
          ...baseParams,
          start,
          end,
          compare_start: prevRangeData.start || undefined,
          compare_end: prevRangeData.end || undefined,
        });
        const currOrders = summary.current.orders;
        const currSales = summary.current.sales;
        const prevFullOrders = summary.previous.orders || {};
        const prevFullSales = summary.previous.sales || {};

        const splitTimezone =
          currOrders?.timezone || currSales?.timezone || timezone || "Asia/Kolkata";
        const hourLte = getHourlyCutoffForTodayRange(start, end, splitTimezone);
        const compareArgs = Number.isInteger(hourLte)
          ? { ...baseParams, hour_lte: hourLte }
          : baseParams;

        const [
          currCompareOrders,
          currCompareSales,
          prevCompareOrders,
          prevCompareSales,
        ] = Number.isInteger(hourLte)
          ? await Promise.all([
              getOrderSplit({ start, end, ...compareArgs }),
              getPaymentSalesSplit({ start, end, ...compareArgs }),
              prevRangeData.start
                ? getOrderSplit({
                    start: prevRangeData.start,
                    end: prevRangeData.end,
                    ...compareArgs,
                  })
                : Promise.resolve({}),
              prevRangeData.start
                ? getPaymentSalesSplit({
                    start: prevRangeData.start,
                    end: prevRangeData.end,
                    ...compareArgs,
                  })
                : Promise.resolve({}),
            ])
          : [null, null, prevFullOrders, prevFullSales];

        if (cancelled) return;

        const processMetric = (curr, compareCurr, comparePrev, type) => {
          const isValue = type === "value";
          const total = Number(curr?.total || 0);
          // mv_product_type_funnel_daily-backed responses (Product Type
          // filter active) carry a real total but no payment-mode split —
          // show "-" for each segment instead of a misleading 0.
          const unavailable = !!curr?.unavailable;
          const comparisonCurrent = compareCurr || curr;
          const comparisonPrevious = comparePrev || {};
          const compareTotal = Number(comparisonCurrent?.total || 0);
          const prevTotal = Number(comparisonPrevious?.total || 0);
          const segments = ["Prepaid", "COD", "Partial"].map((key) => {
            const name =
              key === "Partial" ? "Partially paid" : key === "Prepaid" ? "Prepaid" : "COD";
            const color =
              key === "Prepaid" ? "#2cc995" : key === "COD" ? "#1f5748" : "#8da399";

            if (unavailable) {
              return {
                name,
                value: 0,
                percent: null,
                delta: 0,
                color,
                formattedValue: "-",
              };
            }

            const valKey = isValue
              ? key === "Partial"
                ? "partial_sales"
                : `${key.toLowerCase()}_sales`
              : key === "Partial"
                ? "partially_paid_orders"
                : `${key.toLowerCase()}_orders`;

            const currVal = Number(curr?.[valKey] || 0);
            const compareCurrVal = Number(comparisonCurrent?.[valKey] || 0);
            const prevVal = Number(comparisonPrevious?.[valKey] || 0);
            const currPct = total > 0 ? (currVal / total) * 100 : 0;
            const compareCurrPct =
              compareTotal > 0 ? (compareCurrVal / compareTotal) * 100 : 0;
            const prevPct = prevTotal > 0 ? (prevVal / prevTotal) * 100 : 0;
            const delta =
              prevPct > 0
                ? ((compareCurrPct - prevPct) / prevPct) * 100
                : compareCurrPct > 0
                  ? 100
                  : 0;
            const displayValue = isValue ? convertAmount(currVal) : currVal;
            return {
              name,
              value: displayValue,
              percent: currPct.toFixed(1),
              delta: Math.round(delta),
              color,
              formattedValue: isValue
                ? formatConvertedAmount(displayValue, {
                    notation: "compact",
                    maximumFractionDigits: 1,
                  })
                : currVal.toLocaleString(),
            };
          });

          const displayTotal = isValue ? convertAmount(total) : total;
          return {
            segments,
            total: displayTotal,
            formattedTotal: isValue
              ? formatConvertedAmount(displayTotal, {
                  notation: "compact",
                  maximumFractionDigits: 1,
                })
              : total.toLocaleString(),
          };
        };

        const qtyData = processMetric(
          currOrders,
          currCompareOrders,
          prevCompareOrders,
          "quantity",
        );
        const valData = processMetric(
          currSales,
          currCompareSales,
          prevCompareSales,
          "value",
        );

        setData({
          quantity: qtyData.segments,
          value: valData.segments,
          totalQuantity: qtyData.formattedTotal,
          totalValue: valData.formattedTotal,
          rawTotalQuantity: qtyData.total,
          rawTotalValue: valData.total,
        });
      } catch {
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    brandKey,
    city,
    convertAmount,
    deviceType,
    discountCode,
    end,
    formatConvertedAmount,
    getOrderSplit,
    getPaymentSalesSplit,
    productId,
    productType,
    salesChannel,
    start,
    timezone,
    utmCampaign,
    utmMedium,
    utmSource,
  ]);

  return { loading, prevRange, data };
}

function buildDateRange(start, end) {
  if (!start || !end) return [];
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(endDate.getTime())) {
    return dates;
  }
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function resolveComparisonRange(start, end, compareStart, compareEnd) {
  if (compareStart && compareEnd) {
    return { start: compareStart, end: compareEnd };
  }
  if (!start || !end) return null;
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return null;
  }
  const dayCount =
    Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const prevEnd = new Date(startDate);
  prevEnd.setUTCDate(prevEnd.getUTCDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setUTCDate(prevStart.getUTCDate() - (dayCount - 1));
  return {
    start: prevStart.toISOString().slice(0, 10),
    end: prevEnd.toISOString().slice(0, 10),
  };
}

function formatRangeLabel(range) {
  if (!range || !range.start || !range.end) return "";
  const startDate = new Date(`${range.start}T00:00:00Z`);
  const endDate = new Date(`${range.end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "";
  }
  const sMonth = MONTH_NAMES[startDate.getUTCMonth()] || "";
  const eMonth = MONTH_NAMES[endDate.getUTCMonth()] || "";
  const sDay = startDate.getUTCDate();
  const eDay = endDate.getUTCDate();
  const sYear = startDate.getUTCFullYear();
  const eYear = endDate.getUTCFullYear();
  if (range.start === range.end) return `${sMonth} ${sDay}, ${sYear}`;
  if (sYear === eYear) {
    if (startDate.getUTCMonth() === endDate.getUTCMonth()) {
      return `${sMonth} ${sDay}-${eDay}, ${sYear}`;
    }
    return `${sMonth} ${sDay} - ${eMonth} ${eDay}, ${sYear}`;
  }
  return `${sMonth} ${sDay}, ${sYear} - ${eMonth} ${eDay}, ${eYear}`;
}

function formatHourLabel(hour) {
  const normalized = hour % 12 === 0 ? 12 : hour % 12;
  return `${normalized}${hour >= 12 ? "pm" : "am"}`;
}

function formatDayLabel(date) {
  const dt = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return date;
  return `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function aggregateMetrics(points = []) {
  return points.reduce((acc, point) => {
    const metrics = point?.metrics || {};
    Object.entries(metrics).forEach(([key, value]) => {
      const numericValue = Number(value || 0);
      acc[key] = (acc[key] || 0) + numericValue;
    });
    return acc;
  }, {});
}

function buildWeeklyBuckets(points = [], comparisonPoints = []) {
  const bucketCount = Math.ceil(points.length / WEEK_SIZE_DAYS);
  return Array.from({ length: bucketCount }, (_, index) => {
    const startIdx = index * WEEK_SIZE_DAYS;
    const endIdx = startIdx + WEEK_SIZE_DAYS;
    return {
      label: `Week ${index + 1}`,
      metrics: aggregateMetrics(points.slice(startIdx, endIdx)),
      comparisonMetrics: aggregateMetrics(comparisonPoints.slice(startIdx, endIdx)),
      isInProgressHour: false,
      hour: null,
    };
  });
}

function buildWeeklyPaymentBuckets(points = []) {
  const bucketCount = Math.ceil(points.length / WEEK_SIZE_DAYS);
  return Array.from({ length: bucketCount }, (_, index) => {
    const slice = points.slice(index * WEEK_SIZE_DAYS, index * WEEK_SIZE_DAYS + WEEK_SIZE_DAYS);
    return slice.reduce(
      (acc, point) => ({
        label: `Week ${index + 1}`,
        currentPrepaid: acc.currentPrepaid + Number(point.currentPrepaid || 0),
        currentCod: acc.currentCod + Number(point.currentCod || 0),
        currentPartial: acc.currentPartial + Number(point.currentPartial || 0),
        currentTotal: acc.currentTotal + Number(point.currentTotal || 0),
        comparisonPrepaid:
          acc.comparisonPrepaid + Number(point.comparisonPrepaid || 0),
        comparisonCod: acc.comparisonCod + Number(point.comparisonCod || 0),
        comparisonPartial:
          acc.comparisonPartial + Number(point.comparisonPartial || 0),
        comparisonTotal:
          acc.comparisonTotal + Number(point.comparisonTotal || 0),
      }),
      {
        label: `Week ${index + 1}`,
        currentPrepaid: 0,
        currentCod: 0,
        currentPartial: 0,
        currentTotal: 0,
        comparisonPrepaid: 0,
        comparisonCod: 0,
        comparisonPartial: 0,
        comparisonTotal: 0,
      },
    );
  }).map((point) => ({
    ...point,
    currentPrepaidPct:
      point.currentTotal > 0 ? (point.currentPrepaid / point.currentTotal) * 100 : 0,
    currentCodPct:
      point.currentTotal > 0 ? (point.currentCod / point.currentTotal) * 100 : 0,
    currentPartialPct:
      point.currentTotal > 0 ? (point.currentPartial / point.currentTotal) * 100 : 0,
    comparisonPrepaidPct:
      point.comparisonTotal > 0
        ? (point.comparisonPrepaid / point.comparisonTotal) * 100
        : 0,
    comparisonCodPct:
      point.comparisonTotal > 0 ? (point.comparisonCod / point.comparisonTotal) * 100 : 0,
    comparisonPartialPct:
      point.comparisonTotal > 0
        ? (point.comparisonPartial / point.comparisonTotal) * 100
        : 0,
  }));
}

export function useDashboardPaymentSplitTrendData({
  query,
  metric,
  viewMode,
  canUseHourly,
  useWeeklyBuckets,
  convertAmount,
}) {
  const { getPaymentSplitTrend } = useDashboardDataApi();
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState([]);
  const [rangeLabels, setRangeLabels] = useState({ current: "", previous: "" });

  const start = query?.start;
  const end = query?.end;
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const utmSource = query?.utm_source;
  const utmMedium = query?.utm_medium;
  const utmCampaign = query?.utm_campaign;
  const salesChannel = query?.sales_channel;
  const deviceType = query?.device_type;
  const productId = query?.product_id;
  const discountCode = query?.discount_code;
  const productType = query?.product_type;
  const hasActiveProductTypeFilter =
    Array.isArray(productType) && productType.length > 0;
  const compareStart = query?.compare_start;
  const compareEnd = query?.compare_end;
  const queryTimezone = query?.timezone;

  useEffect(() => {
    let cancelled = false;
    // mv_product_type_funnel_daily has no payment-mode breakdown — don't
    // fetch/render this trend while a Product Type filter is active, rather
    // than silently showing a flat 0%/unfiltered line.
    if (!start || !end || hasActiveProductTypeFilter) {
      setChartData([]);
      setRangeLabels({ current: "", previous: "" });
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);

    const load = async () => {
      const comparisonRange = resolveComparisonRange(
        start,
        end,
        compareStart,
        compareEnd,
      );
      const currentDates = buildDateRange(start, end);
      const comparisonDates = comparisonRange
        ? buildDateRange(comparisonRange.start, comparisonRange.end)
        : [];
      const baseParams = {
        brand_key: brandKey,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        sales_channel: salesChannel,
        device_type: deviceType,
        product_id: productId,
        discount_code: discountCode,
        city: query?.city,
      };
      try {
        if (viewMode === "hourly" && canUseHourly) {
          const splitTimezone = queryTimezone || "Asia/Kolkata";
          const maxHour = getHourlyCutoffForTodayRange(start, end, splitTimezone);
          const hourLimit = Number.isInteger(maxHour) ? maxHour : 23;

          const [currentTrend, comparisonTrend] = await Promise.all([
            getPaymentSplitTrend({
              start,
              end,
              granularity: "hourly",
              hour_lte: hourLimit,
              ...baseParams,
            }),
            comparisonRange
              ? getPaymentSplitTrend({
                  start: comparisonRange.start,
                  end: comparisonRange.end,
                  granularity: "hourly",
                  hour_lte: hourLimit,
                  ...baseParams,
                })
              : Promise.resolve(null),
          ]);
          if (cancelled) return;

          const currentByHour = new Map(
            (currentTrend?.points || []).map((p) => [p.hour, p]),
          );
          const comparisonByHour = new Map(
            (comparisonTrend?.points || []).map((p) => [p.hour, p]),
          );
          const emptyBucket = {
            prepaid_orders: 0,
            cod_orders: 0,
            partially_paid_orders: 0,
            prepaid_sales: 0,
            cod_sales: 0,
            partial_sales: 0,
            total_orders: 0,
            total_sales: 0,
          };

          const pickMetric = (bucket, orderKey, salesKey) =>
            metric === "orders"
              ? Number(bucket?.[orderKey] ?? 0)
              : convertAmount(Number(bucket?.[salesKey] ?? 0));

          const hourlyChartData = Array.from({ length: hourLimit + 1 }, (_, hour) => {
            const curr = currentByHour.get(hour) || emptyBucket;
            const comp = comparisonByHour.get(hour) || emptyBucket;

            const currentPrepaid = pickMetric(curr, "prepaid_orders", "prepaid_sales");
            const currentCod = pickMetric(curr, "cod_orders", "cod_sales");
            const currentPartial = pickMetric(
              curr,
              "partially_paid_orders",
              "partial_sales",
            );
            const currentTotal =
              metric === "orders"
                ? Number(curr.total_orders || 0)
                : convertAmount(Number(curr.total_sales || 0));
            const comparisonPrepaid = pickMetric(comp, "prepaid_orders", "prepaid_sales");
            const comparisonCod = pickMetric(comp, "cod_orders", "cod_sales");
            const comparisonPartial = pickMetric(
              comp,
              "partially_paid_orders",
              "partial_sales",
            );
            const comparisonTotal =
              metric === "orders"
                ? Number(comp.total_orders || 0)
                : convertAmount(Number(comp.total_sales || 0));

            return {
              label: formatHourLabel(hour),
              currentPrepaid,
              currentCod,
              currentPartial,
              currentTotal,
              currentPrepaidPct:
                currentTotal > 0 ? (currentPrepaid / currentTotal) * 100 : 0,
              currentCodPct:
                currentTotal > 0 ? (currentCod / currentTotal) * 100 : 0,
              currentPartialPct:
                currentTotal > 0 ? (currentPartial / currentTotal) * 100 : 0,
              comparisonPrepaid,
              comparisonCod,
              comparisonPartial,
              comparisonTotal,
              comparisonPrepaidPct:
                comparisonTotal > 0
                  ? (comparisonPrepaid / comparisonTotal) * 100
                  : 0,
              comparisonCodPct:
                comparisonTotal > 0 ? (comparisonCod / comparisonTotal) * 100 : 0,
              comparisonPartialPct:
                comparisonTotal > 0
                  ? (comparisonPartial / comparisonTotal) * 100
                  : 0,
            };
          });

          if (cancelled) return;
          setChartData(hourlyChartData);
          setRangeLabels({
            current: formatRangeLabel({ start, end }),
            previous: formatRangeLabel(comparisonRange),
          });
          return;
        }

        const [currentTrend, comparisonTrend] = await Promise.all([
          getPaymentSplitTrend({ start, end, granularity: "daily", ...baseParams }),
          comparisonRange
            ? getPaymentSplitTrend({
                start: comparisonRange.start,
                end: comparisonRange.end,
                granularity: "daily",
                ...baseParams,
              })
            : Promise.resolve(null),
        ]);
        if (cancelled) return;

        const currentByDate = new Map(
          (currentTrend?.points || []).map((p) => [p.date, p]),
        );
        const comparisonByDate = new Map(
          (comparisonTrend?.points || []).map((p) => [p.date, p]),
        );
        const emptyDailyBucket = {
          prepaid_orders: 0,
          cod_orders: 0,
          partially_paid_orders: 0,
          prepaid_sales: 0,
          cod_sales: 0,
          partial_sales: 0,
          total_orders: 0,
          total_sales: 0,
        };
        const pickDailyMetric = (bucket, orderKey, salesKey) =>
          metric === "orders"
            ? Number(bucket?.[orderKey] ?? 0)
            : convertAmount(Number(bucket?.[salesKey] ?? 0));

        const pointCount = Math.min(
          currentDates.length,
          comparisonDates.length || currentDates.length,
        );
        const dailyChartData = currentDates.slice(0, pointCount).map((date, index) => {
          const point = currentByDate.get(date) || emptyDailyBucket;
          const previousDate = comparisonDates[index];
          const previousPoint = previousDate
            ? comparisonByDate.get(previousDate) || emptyDailyBucket
            : null;

          const currentPrepaid = pickDailyMetric(point, "prepaid_orders", "prepaid_sales");
          const currentCod = pickDailyMetric(point, "cod_orders", "cod_sales");
          const currentPartial = pickDailyMetric(
            point,
            "partially_paid_orders",
            "partial_sales",
          );
          const currentTotal =
            metric === "orders"
              ? Number(point.total_orders || 0)
              : convertAmount(Number(point.total_sales || 0));
          const comparisonPrepaid = previousPoint
            ? pickDailyMetric(previousPoint, "prepaid_orders", "prepaid_sales")
            : 0;
          const comparisonCod = previousPoint
            ? pickDailyMetric(previousPoint, "cod_orders", "cod_sales")
            : 0;
          const comparisonPartial = previousPoint
            ? pickDailyMetric(previousPoint, "partially_paid_orders", "partial_sales")
            : 0;
          const comparisonTotal = previousPoint
            ? metric === "orders"
              ? Number(previousPoint.total_orders || 0)
              : convertAmount(Number(previousPoint.total_sales || 0))
            : 0;
          return {
            label: formatDayLabel(date),
            currentPrepaid,
            currentCod,
            currentPartial,
            currentTotal,
            currentPrepaidPct:
              currentTotal > 0 ? (currentPrepaid / currentTotal) * 100 : 0,
            currentCodPct:
              currentTotal > 0 ? (currentCod / currentTotal) * 100 : 0,
            currentPartialPct:
              currentTotal > 0 ? (currentPartial / currentTotal) * 100 : 0,
            comparisonPrepaid,
            comparisonCod,
            comparisonPartial,
            comparisonTotal,
            comparisonPrepaidPct:
              comparisonTotal > 0
                ? (comparisonPrepaid / comparisonTotal) * 100
                : 0,
            comparisonCodPct:
              comparisonTotal > 0 ? (comparisonCod / comparisonTotal) * 100 : 0,
            comparisonPartialPct:
              comparisonTotal > 0
                ? (comparisonPartial / comparisonTotal) * 100
                : 0,
          };
        });

        setChartData(
          useWeeklyBuckets
            ? buildWeeklyPaymentBuckets(dailyChartData)
            : dailyChartData,
        );
        setRangeLabels({
          current: formatRangeLabel({ start, end }),
          previous: formatRangeLabel(comparisonRange),
        });
      } catch {
        if (!cancelled) {
          setChartData([]);
          setRangeLabels({ current: "", previous: "" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    brandKey,
    canUseHourly,
    compareEnd,
    compareStart,
    convertAmount,
    deviceType,
    discountCode,
    end,
    getPaymentSplitTrend,
    hasActiveProductTypeFilter,
    metric,
    productId,
    query?.city,
    queryTimezone,
    refreshKey,
    salesChannel,
    start,
    useWeeklyBuckets,
    utmCampaign,
    utmMedium,
    utmSource,
    viewMode,
  ]);

  return { loading, chartData, rangeLabels };
}

export function useDashboardHourlyTrendData({
  query,
  viewMode,
  daysInRange,
  useWeeklyBuckets,
  convertAmount,
  hasPerformanceSelected,
  hasPaymentCompositeSelected,
  canUseHourlyPaymentTrend,
}) {
  const {
    getHourlyTrend,
    getDailyTrend,
    getMonthlyTrend,
    getWebPerformanceSummary,
    getOrderSplit,
    getPaymentSalesSplit,
  } = useDashboardDataApi();
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState([]);
  const [rangeLabels, setRangeLabels] = useState({ current: "", previous: "" });

  const start = query?.start;
  const end = query?.end;
  const brandKey = query?.brand_key;
  const refreshKey = query?.refreshKey;
  const utmSource = query?.utm_source;
  const utmMedium = query?.utm_medium;
  const utmCampaign = query?.utm_campaign;
  const salesChannel = query?.sales_channel;
  const deviceType = query?.device_type;
  const productId = query?.product_id;
  const discountCode = query?.discount_code;
  const compare = query?.compare;
  const compareStart = query?.compare_start;
  const compareEnd = query?.compare_end;

  useEffect(() => {
    let cancelled = false;
    if (!start || !end) {
      setChartData([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);

    const load = async () => {
      const utmParams = {
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        sales_channel: salesChannel,
        device_type: deviceType,
        product_id: productId,
        discount_code: discountCode,
        city: query?.city,
      };
      const fetcher =
        viewMode === "monthly"
          ? getMonthlyTrend
          : viewMode === "daily"
            ? getDailyTrend
            : getHourlyTrend;
      const base =
        viewMode === "daily" || viewMode === "monthly"
          ? {
              start,
              end,
              compare,
              compare_start: compareStart,
              compare_end: compareEnd,
              ...utmParams,
            }
          : {
              start,
              end,
              compare,
              compare_start: compareStart,
              compare_end: compareEnd,
              aggregate: "avg-by-hour",
              ...utmParams,
            };
      const params = brandKey ? { ...base, brand_key: brandKey } : base;

      try {
        const [res, performanceSummary] = await Promise.all([
          fetcher(params),
          hasPerformanceSelected
            ? getWebPerformanceSummary(params)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (res?.error) throw new Error("Fetch failed");
        if (performanceSummary?.__error) throw new Error("Performance fetch failed");

        let points = [];
        let comparisonPoints = [];
        if (viewMode === "daily") {
          points = Array.isArray(res.days) ? res.days : [];
          comparisonPoints = Array.isArray(res?.comparison?.days)
            ? res.comparison.days
            : [];
        } else if (viewMode === "monthly") {
          points = Array.isArray(res.points) ? res.points : [];
          comparisonPoints = Array.isArray(res?.comparison?.points)
            ? res.comparison.points
            : [];
        } else {
          points = Array.isArray(res.points) ? res.points : [];
          const timezone = res.timezone || "Asia/Kolkata";
          const todayInStoreTimezone = new Date().toLocaleDateString("en-CA", {
            timeZone: timezone,
          });
          let currentHour = null;
          if (start === todayInStoreTimezone) {
            currentHour = Number.parseInt(
              new Date().toLocaleTimeString("en-US", {
                timeZone: timezone,
                hour12: false,
                hour: "numeric",
              }),
              10,
            );
            points = points.filter((point) => point.hour <= currentHour);
          }
          comparisonPoints = Array.isArray(res?.comparison?.points)
            ? res.comparison.points
            : [];
          points = points.map((point) => ({
            ...point,
            __isInProgressHour:
              start === todayInStoreTimezone &&
              Number.isInteger(currentHour) &&
              point?.hour === currentHour,
          }));
        }

        const buildPerformanceMap = (rows = []) => {
          if (!Array.isArray(rows) || rows.length === 0) return new Map();
          if (viewMode === "monthly") {
            const monthlyAverages = new Map();
            rows.forEach((row) => {
              if (!row?.date) return;
              const monthKey = String(row.date).slice(0, 7);
              const existing = monthlyAverages.get(monthKey) || { sum: 0, count: 0 };
              existing.sum += Number(row.avg_performance || 0);
              existing.count += 1;
              monthlyAverages.set(monthKey, existing);
            });
            return new Map(
              Array.from(monthlyAverages.entries()).map(([key, value]) => [
                key,
                value.count > 0 ? value.sum / value.count : null,
              ]),
            );
          }
          return new Map(rows.map((row) => [row.date, Number(row.avg_performance || 0)]));
        };

        const currentPerformanceMap = buildPerformanceMap(
          performanceSummary?.daily_averages,
        );
        const previousPerformanceMap = buildPerformanceMap(
          performanceSummary?.previous_daily_averages,
        );
        const paymentMetricsByDate = new Map();
        const paymentMetricsByMonth = new Map();
        const paymentMetricsByHour = new Map();
        const previousPaymentMetricsByHour = new Map();

        if (hasPaymentCompositeSelected) {
          const paymentBaseParams = {
            brand_key: brandKey,
            utm_source: utmSource,
            utm_medium: utmMedium,
            utm_campaign: utmCampaign,
            sales_channel: salesChannel,
            device_type: deviceType,
            product_id: productId,
            discount_code: discountCode,
            city: query?.city,
          };
          if (viewMode === "hourly" && canUseHourlyPaymentTrend) {
            const timezoneMeta = await getOrderSplit({
              ...paymentBaseParams,
              start,
              end,
            });
            const splitTimezone = timezoneMeta?.timezone || res.timezone || "Asia/Kolkata";
            const todayInStoreTimezone = new Date().toLocaleDateString("en-CA", {
              timeZone: splitTimezone,
            });
            const hourLimit =
              start === todayInStoreTimezone
                ? Number.parseInt(
                    new Date().toLocaleTimeString("en-US", {
                      timeZone: splitTimezone,
                      hour12: false,
                      hour: "numeric",
                    }),
                    10,
                  )
                : 23;
            const hours = Array.from({ length: hourLimit + 1 }, (_, index) => index);
            const currentHourlySeries = await Promise.all(
              hours.map(async (hour) => {
                const [orders, sales] = await Promise.all([
                  getOrderSplit({ ...paymentBaseParams, start, end, hour_lte: hour }),
                  getPaymentSalesSplit({
                    ...paymentBaseParams,
                    start,
                    end,
                    hour_lte: hour,
                  }),
                ]);
                return { hour, orders, sales };
              }),
            );
            const previousHourlySeries =
              compareStart && compareEnd
                ? await Promise.all(
                    hours.map(async (hour) => {
                      const [orders, sales] = await Promise.all([
                        getOrderSplit({
                          ...paymentBaseParams,
                          start: compareStart,
                          end: compareEnd,
                          hour_lte: hour,
                        }),
                        getPaymentSalesSplit({
                          ...paymentBaseParams,
                          start: compareStart,
                          end: compareEnd,
                          hour_lte: hour,
                        }),
                      ]);
                      return { hour, orders, sales };
                    }),
                  )
                : [];

            currentHourlySeries.forEach((point, index) => {
              const previousPoint = index > 0 ? currentHourlySeries[index - 1] : null;
              paymentMetricsByHour.set(point.hour, {
                payment_orders_prepaid: Math.max(
                  0,
                  Number(point.orders?.prepaid_orders || 0) -
                    Number(previousPoint?.orders?.prepaid_orders || 0),
                ),
                payment_orders_cod: Math.max(
                  0,
                  Number(point.orders?.cod_orders || 0) -
                    Number(previousPoint?.orders?.cod_orders || 0),
                ),
                payment_orders_partial: Math.max(
                  0,
                  Number(point.orders?.partially_paid_orders || 0) -
                    Number(previousPoint?.orders?.partially_paid_orders || 0),
                ),
                payment_sales_prepaid: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.prepaid_sales || 0) -
                      Number(previousPoint?.sales?.prepaid_sales || 0),
                  ),
                ),
                payment_sales_cod: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.cod_sales || 0) -
                      Number(previousPoint?.sales?.cod_sales || 0),
                  ),
                ),
                payment_sales_partial: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.partial_sales || 0) -
                      Number(previousPoint?.sales?.partial_sales || 0),
                  ),
                ),
              });
            });
            previousHourlySeries.forEach((point, index) => {
              const previousPoint = index > 0 ? previousHourlySeries[index - 1] : null;
              previousPaymentMetricsByHour.set(point.hour, {
                payment_orders_prepaid: Math.max(
                  0,
                  Number(point.orders?.prepaid_orders || 0) -
                    Number(previousPoint?.orders?.prepaid_orders || 0),
                ),
                payment_orders_cod: Math.max(
                  0,
                  Number(point.orders?.cod_orders || 0) -
                    Number(previousPoint?.orders?.cod_orders || 0),
                ),
                payment_orders_partial: Math.max(
                  0,
                  Number(point.orders?.partially_paid_orders || 0) -
                    Number(previousPoint?.orders?.partially_paid_orders || 0),
                ),
                payment_sales_prepaid: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.prepaid_sales || 0) -
                      Number(previousPoint?.sales?.prepaid_sales || 0),
                  ),
                ),
                payment_sales_cod: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.cod_sales || 0) -
                      Number(previousPoint?.sales?.cod_sales || 0),
                  ),
                ),
                payment_sales_partial: convertAmount(
                  Math.max(
                    0,
                    Number(point.sales?.partial_sales || 0) -
                      Number(previousPoint?.sales?.partial_sales || 0),
                  ),
                ),
              });
            });
          } else {
            const currentDates = buildDateRange(start, end);
            const paymentSeries = await Promise.all(
              currentDates.map(async (date) => {
                const [orders, sales] = await Promise.all([
                  getOrderSplit({ ...paymentBaseParams, start: date, end: date }),
                  getPaymentSalesSplit({
                    ...paymentBaseParams,
                    start: date,
                    end: date,
                  }),
                ]);
                return {
                  date,
                  values: {
                    payment_orders_prepaid: Number(orders?.prepaid_orders || 0),
                    payment_orders_cod: Number(orders?.cod_orders || 0),
                    payment_orders_partial: Number(orders?.partially_paid_orders || 0),
                    payment_sales_prepaid: convertAmount(sales?.prepaid_sales || 0),
                    payment_sales_cod: convertAmount(sales?.cod_sales || 0),
                    payment_sales_partial: convertAmount(sales?.partial_sales || 0),
                  },
                };
              }),
            );
            paymentSeries.forEach(({ date, values }) => {
              paymentMetricsByDate.set(date, values);
              const monthKey = String(date).slice(0, 7);
              const existing = paymentMetricsByMonth.get(monthKey) || {
                payment_orders_prepaid: 0,
                payment_orders_cod: 0,
                payment_orders_partial: 0,
                payment_sales_prepaid: 0,
                payment_sales_cod: 0,
                payment_sales_partial: 0,
              };
              Object.entries(values).forEach(([key, value]) => {
                existing[key] = Number(existing[key] || 0) + Number(value || 0);
              });
              paymentMetricsByMonth.set(monthKey, existing);
            });
          }
        }

        const normalizedPoints = points.map((point) => {
          let label = point.date;
          if (viewMode === "hourly") {
            label = formatHourLabel(point.hour);
          } else if (point.date) {
            const dt = new Date(`${point.date}T00:00:00Z`);
            if (!Number.isNaN(dt.getTime())) {
              label =
                viewMode === "monthly"
                  ? MONTH_NAMES[dt.getUTCMonth()]
                  : `${MONTH_NAMES[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
            }
          }
          let performanceValue = null;
          if (hasPerformanceSelected && point.date) {
            performanceValue =
              viewMode === "monthly"
                ? currentPerformanceMap.get(String(point.date).slice(0, 7))
                : currentPerformanceMap.get(point.date);
          }
          const paymentMetricValues = hasPaymentCompositeSelected
            ? viewMode === "hourly"
              ? paymentMetricsByHour.get(point.hour) || {}
              : point.date
                ? viewMode === "monthly"
                  ? paymentMetricsByMonth.get(String(point.date).slice(0, 7)) || {}
                  : paymentMetricsByDate.get(point.date) || {}
                : {}
            : {};
          return {
            label,
            date: point.date || null,
            hour: typeof point.hour === "number" ? point.hour : null,
            isInProgressHour: Boolean(point.__isInProgressHour),
            metrics:
              hasPerformanceSelected || hasPaymentCompositeSelected
                ? {
                    ...(point.metrics || {}),
                    performance: performanceValue,
                    ...paymentMetricValues,
                  }
                : point.metrics || {},
          };
        });

        const normalizedComparisonPoints = comparisonPoints.map((point) => {
          let performanceValue = null;
          if (hasPerformanceSelected && point.date) {
            performanceValue =
              viewMode === "monthly"
                ? previousPerformanceMap.get(String(point.date).slice(0, 7))
                : previousPerformanceMap.get(point.date);
          }
          return {
            date: point.date || null,
            metrics:
              hasPerformanceSelected || hasPaymentCompositeSelected
                ? {
                    ...(point.metrics || {}),
                    performance: performanceValue,
                    ...(viewMode === "hourly"
                      ? previousPaymentMetricsByHour.get(point.hour) || {}
                      : {}),
                  }
                : point.metrics || {},
          };
        });

        const normalizedData = useWeeklyBuckets
          ? buildWeeklyBuckets(normalizedPoints, normalizedComparisonPoints)
          : normalizedPoints.map((point, index) => ({
              ...point,
              comparisonMetrics:
                normalizedComparisonPoints[index]?.metrics || null,
            }));

        setRangeLabels({
          current: formatRangeLabel(res.range),
          previous: formatRangeLabel(res?.comparison?.range),
        });
        setChartData(normalizedData);
        setLoading(false);
      } catch {
        if (!cancelled) {
          setChartData([]);
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [
    brandKey,
    canUseHourlyPaymentTrend,
    compare,
    compareEnd,
    compareStart,
    convertAmount,
    daysInRange,
    deviceType,
    discountCode,
    end,
    getDailyTrend,
    getHourlyTrend,
    getMonthlyTrend,
    getOrderSplit,
    getPaymentSalesSplit,
    getWebPerformanceSummary,
    hasPaymentCompositeSelected,
    hasPerformanceSelected,
    productId,
    query?.city,
    refreshKey,
    salesChannel,
    start,
    useWeeklyBuckets,
    utmCampaign,
    utmMedium,
    utmSource,
    viewMode,
  ]);

  return { loading, chartData, rangeLabels };
}
