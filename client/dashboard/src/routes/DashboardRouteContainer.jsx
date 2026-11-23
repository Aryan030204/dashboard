import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  Suspense,
  lazy,
} from "react";
import { Box, Button, Skeleton, Stack, Typography } from "@mui/material";
import { Download } from "lucide-react";
import LayoutPanelsIcon from "../components/ui/LayoutPanelsIcon.jsx";
import Grid from "@mui/material/Grid2";
import InlineDashboardLayoutEditor from "../components/InlineDashboardLayoutEditor.jsx";
import DashboardUnavailableCard from "../components/DashboardUnavailableCard.jsx";
import {
  DASHBOARD_LAYOUT_DEFAULTS,
  getVisibleDashboardWidgetIds,
  normalizeDashboardLayout,
} from "../lib/dashboardLayout.js";
import {
  DEFAULT_DESKTOP_KPI_LAYOUT,
  normalizeDesktopKpiLayout,
} from "../lib/kpiLayout.js";
import {
  getDashboardLayout,
  getDashboardSummary,
  getHourlyTrend,
  getOrderSplit,
  getPaymentSalesSplit,
  getTrafficSourceSplit,
  saveDashboardLayout,
} from "../lib/api.js";
import { DashboardDataProvider } from "../features/dashboard/DashboardDataProvider.jsx";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";
import { PageHeader } from "../components/datum/index.js";

const KPIs = lazy(() => import("../components/KPIs.jsx"));
const OverallSnapshotWidget = lazy(
  () => import("../components/OverallSnapshotWidget.jsx"),
);
const FunnelChart = lazy(() => import("../components/charts/FunnelChart.jsx"));
const ModeOfPayment = lazy(() => import("../components/ModeOfPayment.jsx"));
const PaymentSplitTrend = lazy(
  () => import("../components/PaymentSplitTrend.jsx"),
);
const TrafficSourceSplit = lazy(
  () => import("../components/TrafficSourceSplit.jsx"),
);
const HourlySalesCompare = lazy(
  () => import("../components/HourlySalesCompare.jsx"),
);
const WebVitals = lazy(() => import("../components/WebVitals.jsx"));
const WebPerformancePanel = lazy(
  () => import("../components/WebPerformancePanel.jsx"),
);
const ProductConversionTable = lazy(
  () => import("../components/ProductConversionTable.jsx"),
);

const WEB_VITAL_METRIC_KEYS = {
  FCP: "fcp",
  LCP: "lcp",
  TTFB: "ttfb",
  SESSIONS: "sessions",
  PERFORMANCE: "performance",
};

function buildBaseRow({
  section,
  subsection = "",
  item_type = "",
  item_key = "",
  item_name = "",
  hour = "",
  rank = "",
  category = "",
  source_name = "",
  page_name = "",
  payment_mode = "",
  metric = "",
  value = "",
  previous_value = "",
  change_percent = "",
  unit = "",
  start_date = "",
  end_date = "",
  brand_key = "",
  selected_web_vitals_metric = "",
  generated_at = "",
}) {
  return {
    section,
    subsection,
    item_type,
    item_key,
    item_name,
    hour,
    rank,
    category,
    source_name,
    page_name,
    payment_mode,
    metric,
    value,
    previous_value,
    change_percent,
    unit,
    start_date,
    end_date,
    brand_key,
    selected_web_vitals_metric,
    generated_at,
  };
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toBrandNameForPagespeed(brandKey) {
  return (brandKey || "").toString().trim().toLowerCase();
}

function getPreviousDateWindow(currentStart, currentEnd) {
  if (!currentStart || !currentEnd) return { prevStart: "", prevEnd: "" };
  const start = new Date(`${currentStart}T00:00:00`);
  const end = new Date(`${currentEnd}T00:00:00`);
  const diffDays = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / 86400000) + 1,
  );
  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (diffDays - 1));
  const fmt = (date) => date.toISOString().slice(0, 10);
  return {
    prevStart: fmt(prevStart),
    prevEnd: fmt(prevEnd),
  };
}

export default function DashboardRouteContainer({
  initialized,
  user,
  hasBrand,
  isMobile,
  isAuthor,
  hasPermission,
  canCustomizeDashboardLayout,
  canMultiSelectableKpiCards,
  dashboardScopeLabel,
  trendMetricsQuery,
  generalMetricsQuery,
  overallSnapshotQuery,
  selectedMetrics,
  activeMetric,
  onSelectMetric,
  onToggleMetric,
  onFunnelData,
  selectedProductIds,
  selectedProductLabel,
  utmOptions,
  compareMode,
  snapshotBrands,
  authorBrandsLoading,
  onOverallSnapshotBrandSelect,
  dataRestrictionDescription,
  isLongRangeDashboard,
  activeBrandKey,
  viewerPermissions,
  funnelData,
  trafficSplitRules,
  onRegisterActions,
}) {
  const [webVitalsMetric, setWebVitalsMetric] = useState("FCP");
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [dashboardLayout, setDashboardLayout] = useState(() =>
    normalizeDashboardLayout(),
  );
  const [previewDashboardLayout, setPreviewDashboardLayout] = useState(null);
  const [isSavingDashboardLayout, setIsSavingDashboardLayout] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!initialized || !user || !canCustomizeDashboardLayout) {
      setDashboardLayout(normalizeDashboardLayout());
      return () => {
        cancelled = true;
      };
    }

    getDashboardLayout().then((res) => {
      if (cancelled) return;
      if (res.error) {
        setDashboardLayout(normalizeDashboardLayout());
        return;
      }
      setDashboardLayout(normalizeDashboardLayout(res.data));
    });

    return () => {
      cancelled = true;
    };
  }, [initialized, user, canCustomizeDashboardLayout]);

  const effectiveDashboardLayout = useMemo(
    () => normalizeDashboardLayout(previewDashboardLayout || dashboardLayout),
    [dashboardLayout, previewDashboardLayout],
  );

  const isDashboardLayoutDirty = useMemo(() => {
    const preview = normalizeDashboardLayout(
      previewDashboardLayout || dashboardLayout,
    );
    const saved = normalizeDashboardLayout(dashboardLayout);
    return (
      preview.desktop.join("|") !== saved.desktop.join("|") ||
      preview.mobile.join("|") !== saved.mobile.join("|")
    );
  }, [dashboardLayout, previewDashboardLayout]);

  const visibleDesktopWidgetIds = useMemo(
    () =>
      getVisibleDashboardWidgetIds({
        viewport: "desktop",
        layout: effectiveDashboardLayout,
        hasPermission,
      }),
    [effectiveDashboardLayout, hasPermission],
  );

  const visibleMobileWidgetIds = useMemo(
    () =>
      getVisibleDashboardWidgetIds({
        viewport: "mobile",
        layout: effectiveDashboardLayout,
        hasPermission,
      }),
    [effectiveDashboardLayout, hasPermission],
  );

  const renderDashboardExtras = useCallback(() => {
    if (isLongRangeDashboard) {
      return (
        <Stack spacing={3} sx={{ mt: 2 }}>
          {!isAuthor && hasPermission("sessions_drop_off_funnel") && (
            <DashboardUnavailableCard
              title="Sessions Drop-off Funnel"
              description={dataRestrictionDescription}
              minHeight={250}
            />
          )}
          {!isAuthor && hasPermission("product_conversion") && (
            <Box>
              <Typography
                variant="subtitle2"
                color="text.secondary"
                sx={{ mb: 1.5, fontWeight: 500, ml: 1 }}
              >
                Product Performance
              </Typography>
              <DashboardUnavailableCard
                title="Product Performance"
                description={dataRestrictionDescription}
                minHeight={300}
              />
            </Box>
          )}
        </Stack>
      );
    }

    return (
      <>
        {!isAuthor &&
          hasPermission("sessions_drop_off_funnel") &&
          (funnelData?.stats ? (
            <Suspense
              fallback={<Skeleton variant="rounded" width="100%" height={250} />}
            >
              <Box sx={{ mt: 2 }}>
                <Typography
                  variant="subtitle2"
                  color="text.secondary"
                  sx={{ mb: 1.5, fontWeight: 500, ml: 1 }}
                >
                  Sessions Drop-off Funnel
                </Typography>
                <FunnelChart
                  data={[
                    {
                      label: "Sessions",
                      value: funnelData.stats.total_sessions || 0,
                      change: funnelData.deltas?.sessions?.diff_pct
                        ? Number(funnelData.deltas.sessions.diff_pct).toFixed(1)
                        : undefined,
                    },
                    {
                      label: "Add to Cart",
                      value: funnelData.stats.total_atc_sessions || 0,
                      change: funnelData.deltas?.atc?.diff_pct
                        ? Number(funnelData.deltas.atc.diff_pct).toFixed(1)
                        : undefined,
                    },
                    ...(hasPermission("ci_events")
                      ? [
                          {
                            label: "Checkout Initiated",
                            value: funnelData.stats.total_ci_events || 0,
                            change: funnelData.deltas?.ci?.diff_pct
                              ? Number(funnelData.deltas.ci.diff_pct).toFixed(1)
                              : undefined,
                          },
                        ]
                      : []),
                    {
                      label: "Orders",
                      value: funnelData.stats.total_orders || 0,
                      change:
                        funnelData.deltas?.orders?.diff_pct ||
                        funnelData.deltas?.orders?.diff_pp
                          ? Number(
                              funnelData.deltas?.orders?.diff_pct ||
                                funnelData.deltas?.orders?.diff_pp,
                            ).toFixed(1)
                          : undefined,
                    },
                  ]}
                  height={250}
                />
              </Box>
            </Suspense>
          ) : (
            <Skeleton variant="rounded" width="100%" height={290} />
          ))}

        {!isAuthor && hasPermission("product_conversion") && (
          <Box sx={{ mt: 3 }}>
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1.5, fontWeight: 500, ml: 1 }}
            >
              Product Performance
            </Typography>
            <Suspense
              fallback={<Skeleton variant="rounded" width="100%" height={300} />}
            >
              <ProductConversionTable
                brandKey={activeBrandKey}
                showCompareMode={hasPermission("compare_mode")}
                isAuthor={isAuthor}
                permissions={viewerPermissions}
              />
            </Suspense>
          </Box>
        )}
      </>
    );
  }, [
    activeBrandKey,
    dataRestrictionDescription,
    funnelData,
    hasPermission,
    isAuthor,
    isLongRangeDashboard,
    viewerPermissions,
  ]);

  const handleSaveDashboardLayout = useCallback(async (draftLayout) => {
    const payload = normalizeDashboardLayout(draftLayout);
    setIsSavingDashboardLayout(true);
    try {
      const res = await saveDashboardLayout(payload);
      if (res.error) return;
      setDashboardLayout(normalizeDashboardLayout(res.data));
      setPreviewDashboardLayout(null);
      setLayoutEditMode(false);
    } finally {
      setIsSavingDashboardLayout(false);
    }
  }, []);

  const handleDesktopKpiLayoutChange = useCallback(
    (nextKpiLayout, options = {}) => {
      const normalizedKpiLayout = normalizeDesktopKpiLayout(nextKpiLayout);

      if (options.persist && !layoutEditMode) {
        const nextLayout = normalizeDashboardLayout({
          ...dashboardLayout,
          kpiCardsDesktop: normalizedKpiLayout,
        });
        handleSaveDashboardLayout(nextLayout);
        return;
      }

      setPreviewDashboardLayout((prev) => {
        const base = normalizeDashboardLayout(prev || dashboardLayout);
        return normalizeDashboardLayout({
          ...base,
          kpiCardsDesktop: normalizedKpiLayout,
        });
      });
    },
    [dashboardLayout, handleSaveDashboardLayout, layoutEditMode],
  );

  const handleOpenLayoutEditor = useCallback(() => {
    if (layoutEditMode) return;
    setPreviewDashboardLayout(normalizeDashboardLayout(dashboardLayout));
    setLayoutEditMode(true);
  }, [dashboardLayout, layoutEditMode]);

  const handleCloseLayoutEditor = useCallback(() => {
    setPreviewDashboardLayout(null);
    setLayoutEditMode(false);
  }, []);

  const handleInlineDashboardReorder = useCallback(
    (nextVisibleIds) => {
      const viewport = isMobile ? "mobile" : "desktop";
      setPreviewDashboardLayout((prev) => {
        const base = normalizeDashboardLayout(prev || dashboardLayout);
        return normalizeDashboardLayout({
          ...base,
          [viewport]: nextVisibleIds,
        });
      });
    },
    [dashboardLayout, isMobile],
  );

  const handleResetDashboardLayout = useCallback(() => {
    const viewport = isMobile ? "mobile" : "desktop";
    setPreviewDashboardLayout((prev) => {
      const base = normalizeDashboardLayout(prev || dashboardLayout);
      return normalizeDashboardLayout({
        ...base,
        [viewport]: [...DASHBOARD_LAYOUT_DEFAULTS[viewport]],
        kpiCardsDesktop:
          viewport === "desktop" ? DEFAULT_DESKTOP_KPI_LAYOUT : base.kpiCardsDesktop,
      });
    });
  }, [dashboardLayout, isMobile]);

  // Each widget slot is memoized independently so that a change scoped to a
  // single widget (e.g. the WebVitals metric dropdown or opening the layout
  // editor) does not force every other widget's JSX to be rebuilt.
  const overallSnapshotElement = useMemo(
    () =>
      isLongRangeDashboard ? (
        <DashboardUnavailableCard
          title="Overall Snapshot"
          description={dataRestrictionDescription}
          minHeight={320}
        />
      ) : (
        <OverallSnapshotWidget
          query={overallSnapshotQuery}
          brands={snapshotBrands}
          brandsLoading={isAuthor && authorBrandsLoading}
          onBrandSelect={onOverallSnapshotBrandSelect}
        />
      ),
    [
      authorBrandsLoading,
      dataRestrictionDescription,
      isAuthor,
      isLongRangeDashboard,
      onOverallSnapshotBrandSelect,
      overallSnapshotQuery,
      snapshotBrands,
    ],
  );

  const paymentTrendElement = useMemo(
    () =>
      isLongRangeDashboard ? (
        <DashboardUnavailableCard
          title="Payment Trend"
          description={dataRestrictionDescription}
          minHeight={310}
        />
      ) : (
        <PaymentSplitTrend query={generalMetricsQuery} />
      ),
    [dataRestrictionDescription, generalMetricsQuery, isLongRangeDashboard],
  );

  const trafficSplitElement = useMemo(
    () =>
      isLongRangeDashboard ? (
        <DashboardUnavailableCard
          title="Traffic Split"
          description={dataRestrictionDescription}
          minHeight={310}
        />
      ) : (
        <TrafficSourceSplit
          query={trendMetricsQuery}
          compareMode={compareMode}
          mappingRules={trafficSplitRules}
        />
      ),
    [
      compareMode,
      dataRestrictionDescription,
      isLongRangeDashboard,
      trafficSplitRules,
      trendMetricsQuery,
    ],
  );

  const kpiCardsDesktopElement = useMemo(
    () => (
      <KPIs
        variant="desktop_paged"
        query={trendMetricsQuery}
        selectedMetrics={selectedMetrics}
        activeMetric={activeMetric}
        onSelectMetric={onSelectMetric}
        onToggleMetric={canMultiSelectableKpiCards ? onToggleMetric : undefined}
        onFunnelData={onFunnelData}
        productId={selectedProductIds}
        productLabel={selectedProductLabel}
        utmOptions={utmOptions}
        showWebVitals={false}
        showCiEvents={hasPermission("ci_events")}
        showRtoKpi={hasPermission("rto_kpi")}
        showIntentMetrics={hasPermission("intent_metrics")}
        compareMode={compareMode}
        desktopKpiLayout={effectiveDashboardLayout.kpiCardsDesktop}
        onDesktopKpiLayoutChange={handleDesktopKpiLayoutChange}
        canEditDesktopKpis={canCustomizeDashboardLayout}
        dashboardLayoutEditing={layoutEditMode}
      />
    ),
    [
      activeMetric,
      canCustomizeDashboardLayout,
      canMultiSelectableKpiCards,
      compareMode,
      effectiveDashboardLayout,
      handleDesktopKpiLayoutChange,
      hasPermission,
      layoutEditMode,
      onFunnelData,
      onSelectMetric,
      onToggleMetric,
      selectedMetrics,
      selectedProductIds,
      selectedProductLabel,
      trendMetricsQuery,
      utmOptions,
    ],
  );

  const kpiTrendDesktopElement = useMemo(
    () => (
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: hasPermission("web_vitals") ? 9 : 12 }}>
          <HourlySalesCompare
            query={trendMetricsQuery}
            selectedMetrics={selectedMetrics}
            activeMetric={activeMetric}
            compareMode={compareMode}
            isLongRange={isLongRangeDashboard}
          />
        </Grid>
        {hasPermission("web_vitals") && (
          <Grid size={{ xs: 12, md: 3 }}>
            {isLongRangeDashboard ? (
              <DashboardUnavailableCard
                title="Web Performance(Avg)"
                description={dataRestrictionDescription}
                minHeight={310}
              />
            ) : (
              <WebPerformancePanel
                query={generalMetricsQuery}
                selectedMetrics={selectedMetrics}
                activeMetric={activeMetric}
                onSelectMetric={onSelectMetric}
                onToggleMetric={canMultiSelectableKpiCards ? onToggleMetric : undefined}
              />
            )}
          </Grid>
        )}
      </Grid>
    ),
    [
      activeMetric,
      canMultiSelectableKpiCards,
      compareMode,
      dataRestrictionDescription,
      generalMetricsQuery,
      hasPermission,
      isLongRangeDashboard,
      onSelectMetric,
      onToggleMetric,
      selectedMetrics,
      trendMetricsQuery,
    ],
  );

  const paymentSplitDesktopElement = useMemo(
    () =>
      hasPermission("web_vitals") ? (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 8 }}>
            {isLongRangeDashboard ? (
              <DashboardUnavailableCard
                title="Mode of Payment"
                description={dataRestrictionDescription}
                minHeight={310}
              />
            ) : (
              <ModeOfPayment
                query={generalMetricsQuery}
                selectedMetrics={selectedMetrics}
                onToggleMetric={canMultiSelectableKpiCards ? onToggleMetric : undefined}
              />
            )}
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            {isLongRangeDashboard ? (
              <DashboardUnavailableCard
                title="Top 5 Pages"
                description={dataRestrictionDescription}
                minHeight={380}
              />
            ) : (
              <WebVitals
                query={generalMetricsQuery}
                metric={webVitalsMetric}
                onMetricChange={setWebVitalsMetric}
              />
            )}
          </Grid>
        </Grid>
      ) : isLongRangeDashboard ? (
        <DashboardUnavailableCard
          title="Mode of Payment"
          description={dataRestrictionDescription}
          minHeight={310}
        />
      ) : (
        <ModeOfPayment
          query={generalMetricsQuery}
          selectedMetrics={selectedMetrics}
          onToggleMetric={canMultiSelectableKpiCards ? onToggleMetric : undefined}
        />
      ),
    [
      canMultiSelectableKpiCards,
      dataRestrictionDescription,
      generalMetricsQuery,
      hasPermission,
      isLongRangeDashboard,
      onToggleMetric,
      selectedMetrics,
      webVitalsMetric,
    ],
  );

  const desktopWidgetRegistry = useMemo(
    () => ({
      kpi_cards: kpiCardsDesktopElement,
      overall_snapshot: overallSnapshotElement,
      kpi_trend: kpiTrendDesktopElement,
      payment_split: paymentSplitDesktopElement,
      payment_trend: paymentTrendElement,
      traffic_split: trafficSplitElement,
    }),
    [
      kpiCardsDesktopElement,
      overallSnapshotElement,
      kpiTrendDesktopElement,
      paymentSplitDesktopElement,
      paymentTrendElement,
      trafficSplitElement,
    ],
  );

  const kpiCardsMobileElement = useMemo(
    () => (
      <KPIs
        variant="desktop_paged"
        key={`mobile-kpis-${layoutEditMode ? "edit" : "view"}-${effectiveDashboardLayout.kpiCardsDesktop.order.join("|")}-${effectiveDashboardLayout.kpiCardsDesktop.pinned.join("|")}`}
        query={trendMetricsQuery}
        selectedMetrics={selectedMetrics}
        activeMetric={activeMetric}
        onSelectMetric={onSelectMetric}
        onToggleMetric={canMultiSelectableKpiCards ? onToggleMetric : undefined}
        onFunnelData={onFunnelData}
        productId={selectedProductIds}
        productLabel={selectedProductLabel}
        utmOptions={utmOptions}
        showRow="mobile_top"
        showWebVitals={!isLongRangeDashboard && hasPermission("web_vitals")}
        showCiEvents={hasPermission("ci_events")}
        showRtoKpi={hasPermission("rto_kpi")}
        showIntentMetrics={hasPermission("intent_metrics")}
        compareMode={compareMode}
        desktopKpiLayout={effectiveDashboardLayout.kpiCardsDesktop}
        onDesktopKpiLayoutChange={handleDesktopKpiLayoutChange}
        canEditDesktopKpis={canCustomizeDashboardLayout}
        dashboardLayoutEditing={layoutEditMode}
      />
    ),
    [
      activeMetric,
      canCustomizeDashboardLayout,
      canMultiSelectableKpiCards,
      compareMode,
      effectiveDashboardLayout,
      handleDesktopKpiLayoutChange,
      hasPermission,
      isLongRangeDashboard,
      layoutEditMode,
      onFunnelData,
      onSelectMetric,
      onToggleMetric,
      selectedMetrics,
      selectedProductIds,
      selectedProductLabel,
      trendMetricsQuery,
      utmOptions,
    ],
  );

  const kpiTrendMobileElement = useMemo(
    () => (
      <HourlySalesCompare
        query={trendMetricsQuery}
        selectedMetrics={selectedMetrics}
        activeMetric={activeMetric}
        compareMode={compareMode}
        isLongRange={isLongRangeDashboard}
      />
    ),
    [activeMetric, compareMode, isLongRangeDashboard, selectedMetrics, trendMetricsQuery],
  );

  const topPagesMobileElement = useMemo(
    () =>
      isLongRangeDashboard ? (
        <DashboardUnavailableCard
          title="Top 5 Pages"
          description={dataRestrictionDescription}
          minHeight={380}
        />
      ) : (
        <WebVitals
          query={generalMetricsQuery}
          metric={webVitalsMetric}
          onMetricChange={setWebVitalsMetric}
        />
      ),
    [dataRestrictionDescription, generalMetricsQuery, isLongRangeDashboard, webVitalsMetric],
  );

  const paymentSplitMobileElement = useMemo(
    () =>
      isLongRangeDashboard ? (
        <DashboardUnavailableCard
          title="Mode of Payment"
          description={dataRestrictionDescription}
          minHeight={310}
        />
      ) : (
        <ModeOfPayment
          query={generalMetricsQuery}
          selectedMetrics={selectedMetrics}
          onToggleMetric={canMultiSelectableKpiCards ? onToggleMetric : undefined}
        />
      ),
    [
      canMultiSelectableKpiCards,
      dataRestrictionDescription,
      generalMetricsQuery,
      isLongRangeDashboard,
      onToggleMetric,
      selectedMetrics,
    ],
  );

  const mobileWidgetRegistry = useMemo(
    () => ({
      kpi_cards: kpiCardsMobileElement,
      overall_snapshot: overallSnapshotElement,
      kpi_trend: kpiTrendMobileElement,
      top_pages: topPagesMobileElement,
      payment_split: paymentSplitMobileElement,
      payment_trend: paymentTrendElement,
      traffic_split: trafficSplitElement,
    }),
    [
      kpiCardsMobileElement,
      overallSnapshotElement,
      kpiTrendMobileElement,
      topPagesMobileElement,
      paymentSplitMobileElement,
      paymentTrendElement,
      trafficSplitElement,
    ],
  );

  const activeWidgetIds = isMobile ? visibleMobileWidgetIds : visibleDesktopWidgetIds;
  const activeWidgetRegistry = isMobile ? mobileWidgetRegistry : desktopWidgetRegistry;
  const extraAfterId = isMobile
    ? visibleMobileWidgetIds.includes("top_pages")
      ? "top_pages"
      : "kpi_trend"
    : "kpi_trend";
  const dashboardExtrasNode = renderDashboardExtras();

  const fetchPagespeedResults = useCallback(async (brandName, startDate, endDate) => {
    if (!brandName || !startDate || !endDate) return [];
    const params = new URLSearchParams({
      brand_key: brandName,
      start_date: startDate,
      end_date: endDate,
    });
    const response = await fetch(`/api/external-pagespeed/pagespeed?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`pagespeed request failed: ${response.status}`);
    }
    const json = await response.json();
    return Array.isArray(json?.results) ? json.results : [];
  }, []);

  const buildWebVitalsSnapshot = useCallback(
    async (query, selectedMetric) => {
      const metricKey = WEB_VITAL_METRIC_KEYS[selectedMetric] || "fcp";
      const brandName = toBrandNameForPagespeed(query?.brand_key || activeBrandKey);
      const currentStart = query?.start;
      const currentEnd = query?.end;
      if (!brandName || !currentStart || !currentEnd) {
        return {
          selected_metric: selectedMetric,
          performance: {
            current_avg: null,
            previous_avg: null,
            change_percent: null,
          },
          top_pages: [],
        };
      }

      const { prevStart, prevEnd } = getPreviousDateWindow(currentStart, currentEnd);
      const [currentResults, previousResults] = await Promise.all([
        fetchPagespeedResults(brandName, currentStart, currentEnd),
        prevStart && prevEnd
          ? fetchPagespeedResults(brandName, prevStart, prevEnd)
          : Promise.resolve([]),
      ]);

      const performanceCurrent =
        currentResults.reduce((sum, row) => sum + Number(row?.performance || 0), 0) /
        (currentResults.length || 1);
      const performancePrevious =
        previousResults.reduce((sum, row) => sum + Number(row?.performance || 0), 0) /
        (previousResults.length || 1);
      const performanceChange =
        performancePrevious > 0
          ? ((performanceCurrent - performancePrevious) / performancePrevious) * 100
          : null;

      const reduceByUrl = (results) => {
        const grouped = {};
        for (const row of results) {
          const url = String(row?.url || "");
          if (!url) continue;
          if (!grouped[url]) grouped[url] = [];
          grouped[url].push(Number(row?.[metricKey] || 0));
        }
        return Object.entries(grouped).map(([url, values]) => {
          const sum = values.reduce((a, b) => a + b, 0);
          const isSumMetric = metricKey === "sessions";
          return {
            url,
            value: isSumMetric ? sum : sum / values.length,
          };
        });
      };

      const currentPages = reduceByUrl(currentResults);
      const previousPages = reduceByUrl(previousResults);
      const topPages = currentPages
        .map((page) => {
          const previous = previousPages.find((p) => p.url === page.url);
          const previousValue = previous?.value ?? null;
          const changePercent =
            previousValue && previousValue > 0
              ? ((page.value - previousValue) / previousValue) * 100
              : null;
          return {
            page_name: page.url,
            value: Number(page.value || 0),
            previous_value: previousValue,
            change_percent: changePercent,
          };
        })
        .sort((a, b) => {
          const descending =
            selectedMetric === "SESSIONS" || selectedMetric === "PERFORMANCE";
          return descending ? b.value - a.value : a.value - b.value;
        })
        .slice(0, 5);

      return {
        selected_metric: selectedMetric,
        performance: {
          current_avg: Number.isFinite(performanceCurrent) ? performanceCurrent : null,
          previous_avg: Number.isFinite(performancePrevious)
            ? performancePrevious
            : null,
          change_percent: Number.isFinite(performanceChange)
            ? performanceChange
            : null,
        },
        top_pages: topPages,
      };
    },
    [activeBrandKey, fetchPagespeedResults],
  );

  const handleDownloadSnapshot = useCallback(async () => {
    try {
      const summaryBase = {
        ...trendMetricsQuery,
        align: "hour",
      };

      const [summary, hourlyTrend, orderSplit, salesSplit, trafficSplit, webVitals] =
        await Promise.all([
          getDashboardSummary(summaryBase),
          getHourlyTrend({ ...trendMetricsQuery, aggregate: "avg-by-hour" }),
          getOrderSplit(generalMetricsQuery),
          getPaymentSalesSplit(generalMetricsQuery),
          getTrafficSourceSplit({
            ...trendMetricsQuery,
            mappingRules: trafficSplitRules,
          }),
          buildWebVitalsSnapshot(generalMetricsQuery, webVitalsMetric),
        ]);

      const metrics = summary?.metrics || {};
      const totalOrders = Number(metrics?.total_orders?.value || 0);
      const cancelledOrders = Number(metrics?.cancelled_orders?.value || 0);
      const refundedOrders = Number(metrics?.refunded_orders?.value || 0);

      const kpis = [
        { name: "Total Orders", key: "orders", value: totalOrders },
        { name: "Gross Revenue", key: "sales", value: Number(metrics?.total_sales?.value || 0) },
        {
          name: "Average Order Value",
          key: "aov",
          value: Number(metrics?.average_order_value?.value || 0),
        },
        {
          name: "Conversion Rate",
          key: "cvr",
          value: Number(metrics?.conversion_rate?.value || 0),
        },
        {
          name: "Total Sessions",
          key: "sessions",
          value: Number(metrics?.total_sessions?.value || 0),
        },
        {
          name: "ATC Sessions",
          key: "atc",
          value: Number(metrics?.total_atc_sessions?.value || 0),
        },
        {
          name: "Cancellation Rate",
          key: "cancellation_rate",
          value: totalOrders > 0 ? (cancelledOrders / totalOrders) * 100 : 0,
        },
        {
          name: "Refund Rate",
          key: "refund_rate",
          value: totalOrders > 0 ? (refundedOrders / totalOrders) * 100 : 0,
        },
        {
          name: "Checkout Initiated Events",
          key: "checkout_initiated_events",
          value: Number(metrics?.total_ci_events?.value || 0),
        },
      ];

      const hourlyPoints = Array.isArray(hourlyTrend?.points) ? hourlyTrend.points : [];
      const mapHourlySeries = (key, name, getter) => ({
        key,
        name,
        points: hourlyPoints.map((point) => ({
          hour: point?.hour,
          value: getter(point?.metrics || {}),
        })),
      });

      const hourlyTrends = [
        mapHourlySeries("orders", "Total Orders", (m) => Number(m?.orders || 0)),
        mapHourlySeries("sales", "Gross Revenue", (m) => Number(m?.sales || 0)),
        mapHourlySeries("aov", "Average Order Value", (m) => {
          const sales = Number(m?.sales || 0);
          const orders = Number(m?.orders || 0);
          return orders > 0 ? sales / orders : 0;
        }),
        mapHourlySeries("cvr", "Conversion Rate", (m) => Number(m?.cvr_ratio || 0) * 100),
        mapHourlySeries("sessions", "Total Sessions", (m) => Number(m?.sessions || 0)),
        mapHourlySeries("atc", "ATC Sessions", (m) => Number(m?.atc || 0)),
      ];

      const trafficCategories = [
        {
          category: "meta",
          label: "Meta",
          sessions: Number(trafficSplit?.meta?.sessions || 0),
          atc_sessions: Number(trafficSplit?.meta?.atc_sessions || 0),
          delta_percent: trafficSplit?.meta?.delta ?? null,
          atc_delta_percent: trafficSplit?.meta?.atc_delta ?? null,
          sources: Array.isArray(trafficSplit?.meta_breakdown)
            ? trafficSplit.meta_breakdown.map((src) => ({
                source_name: src?.name || "",
                sessions: Number(src?.sessions || 0),
                atc_sessions: Number(src?.atc_sessions || 0),
              }))
            : [],
        },
        {
          category: "google",
          label: "Google",
          sessions: Number(trafficSplit?.google?.sessions || 0),
          atc_sessions: Number(trafficSplit?.google?.atc_sessions || 0),
          delta_percent: trafficSplit?.google?.delta ?? null,
          atc_delta_percent: trafficSplit?.google?.atc_delta ?? null,
          sources: [],
        },
        {
          category: "direct",
          label: "Direct",
          sessions: Number(trafficSplit?.direct?.sessions || 0),
          atc_sessions: Number(trafficSplit?.direct?.atc_sessions || 0),
          delta_percent: trafficSplit?.direct?.delta ?? null,
          atc_delta_percent: trafficSplit?.direct?.atc_delta ?? null,
          sources: [],
        },
        {
          category: "others",
          label: "Others",
          sessions: Number(trafficSplit?.others?.sessions || 0),
          atc_sessions: Number(trafficSplit?.others?.atc_sessions || 0),
          delta_percent: trafficSplit?.others?.delta ?? null,
          atc_delta_percent: trafficSplit?.others?.atc_delta ?? null,
          sources: Array.isArray(trafficSplit?.others_breakdown)
            ? trafficSplit.others_breakdown.map((src) => ({
                source_name: src?.name || "",
                sessions: Number(src?.sessions || 0),
                atc_sessions: Number(src?.atc_sessions || 0),
              }))
            : [],
        },
      ];

      const generatedAt = new Date().toISOString();
      const rows = [];

      rows.push(
        buildBaseRow({
          section: "meta",
          subsection: "snapshot",
          item_type: "generated",
          item_name: "generated_at",
          metric: "generated_at",
          value: generatedAt,
          generated_at: generatedAt,
        }),
      );

      rows.push(
        buildBaseRow({
          section: "filters",
          subsection: "applied",
          item_type: "flag",
          item_name: "compare_mode",
          metric: "compare_mode",
          value: compareMode ? "true" : "false",
          generated_at: generatedAt,
        }),
      );

      const filterRows = [
        ["compare_start", generalMetricsQuery?.compare_start || ""],
        ["compare_end", generalMetricsQuery?.compare_end || ""],
        [
          "product_id",
          Array.isArray(generalMetricsQuery?.product_id)
            ? generalMetricsQuery.product_id.join("|")
            : generalMetricsQuery?.product_id || "",
        ],
        [
          "utm_source",
          Array.isArray(generalMetricsQuery?.utm_source)
            ? generalMetricsQuery.utm_source.join("|")
            : generalMetricsQuery?.utm_source || "",
        ],
        [
          "utm_medium",
          Array.isArray(generalMetricsQuery?.utm_medium)
            ? generalMetricsQuery.utm_medium.join("|")
            : generalMetricsQuery?.utm_medium || "",
        ],
        [
          "utm_campaign",
          Array.isArray(generalMetricsQuery?.utm_campaign)
            ? generalMetricsQuery.utm_campaign.join("|")
            : generalMetricsQuery?.utm_campaign || "",
        ],
        [
          "sales_channel",
          Array.isArray(generalMetricsQuery?.sales_channel)
            ? generalMetricsQuery.sales_channel.join("|")
            : generalMetricsQuery?.sales_channel || "",
        ],
        [
          "device_type",
          Array.isArray(generalMetricsQuery?.device_type)
            ? generalMetricsQuery.device_type.join("|")
            : generalMetricsQuery?.device_type || "",
        ],
      ];

      for (const [name, value] of filterRows) {
        rows.push(
          buildBaseRow({
            section: "filters",
            subsection: "applied",
            item_type: "filter",
            item_name: name,
            metric: name,
            value,
            generated_at: generatedAt,
          }),
        );
      }

      for (const kpi of kpis) {
        rows.push(
          buildBaseRow({
            section: "kpis",
            subsection: "summary",
            item_type: "kpi",
            item_key: kpi.key,
            item_name: kpi.name,
            metric: kpi.key,
            value: kpi.value,
            unit: kpi.key.includes("rate") || kpi.key === "cvr" ? "percent" : "value",
            generated_at: generatedAt,
          }),
        );
      }

      for (const trend of hourlyTrends) {
        for (const point of trend.points) {
          rows.push(
            buildBaseRow({
              section: "hourly_trends",
              subsection: trend.key,
              item_type: "hourly_point",
              item_key: trend.key,
              item_name: trend.name,
              hour: point.hour,
              metric: trend.key,
              value: point.value,
              unit: trend.key.includes("rate") || trend.key === "cvr" ? "percent" : "value",
              generated_at: generatedAt,
            }),
          );
        }
      }

      rows.push(
        buildBaseRow({
          section: "web_vitals",
          subsection: "performance",
          item_type: "summary",
          item_key: "web_performance_avg",
          item_name: "Web Performance(Avg)",
          metric: "performance_avg",
          value: webVitals?.performance?.current_avg ?? "",
          previous_value: webVitals?.performance?.previous_avg ?? "",
          change_percent: webVitals?.performance?.change_percent ?? "",
          generated_at: generatedAt,
        }),
      );

      (webVitals?.top_pages || []).forEach((page, index) => {
        rows.push(
          buildBaseRow({
            section: "web_vitals",
            subsection: "top_pages",
            item_type: "top_page",
            item_name: `Top Page ${index + 1}`,
            rank: index + 1,
            page_name: page.page_name || "",
            metric: webVitals?.selected_metric || webVitalsMetric,
            value: page.value ?? "",
            previous_value: page.previous_value ?? "",
            change_percent: page.change_percent ?? "",
            selected_web_vitals_metric:
              webVitals?.selected_metric || webVitalsMetric || "",
            generated_at: generatedAt,
          }),
        );
      });

      [
        {
          subsection: "by_order_count",
          items: [
            { payment_mode: "Prepaid", value: Number(orderSplit?.prepaid_orders || 0) },
            { payment_mode: "COD", value: Number(orderSplit?.cod_orders || 0) },
            {
              payment_mode: "Partially paid",
              value: Number(orderSplit?.partially_paid_orders || 0),
            },
          ],
        },
        {
          subsection: "by_sales",
          items: [
            { payment_mode: "Prepaid", value: Number(salesSplit?.prepaid_sales || 0) },
            { payment_mode: "COD", value: Number(salesSplit?.cod_sales || 0) },
            { payment_mode: "Partial", value: Number(salesSplit?.partial_sales || 0) },
          ],
        },
      ].forEach((split) => {
        split.items.forEach((item) => {
          rows.push(
            buildBaseRow({
              section: "payment_splits",
              subsection: split.subsection,
              item_type: "payment_mode",
              payment_mode: item.payment_mode,
              metric: split.subsection,
              value: item.value,
              generated_at: generatedAt,
            }),
          );
        });
      });

      for (const category of trafficCategories) {
        rows.push(
          buildBaseRow({
            section: "traffic_split",
            subsection: "category_summary",
            item_type: "traffic_category",
            category: category.label,
            metric: "sessions",
            value: category.sessions,
            change_percent: category.delta_percent ?? "",
            generated_at: generatedAt,
          }),
        );
        rows.push(
          buildBaseRow({
            section: "traffic_split",
            subsection: "category_summary",
            item_type: "traffic_category",
            category: category.label,
            metric: "atc_sessions",
            value: category.atc_sessions,
            change_percent: category.atc_delta_percent ?? "",
            generated_at: generatedAt,
          }),
        );

        for (const src of category.sources || []) {
          rows.push(
            buildBaseRow({
              section: "traffic_split",
              subsection: "source_breakdown",
              item_type: "traffic_source",
              category: category.label,
              source_name: src.source_name,
              metric: "sessions",
              value: src.sessions,
              generated_at: generatedAt,
            }),
          );
          rows.push(
            buildBaseRow({
              section: "traffic_split",
              subsection: "source_breakdown",
              item_type: "traffic_source",
              category: category.label,
              source_name: src.source_name,
              metric: "atc_sessions",
              value: src.atc_sessions,
              generated_at: generatedAt,
            }),
          );
        }
      }

      const csvHeader = [
        "section",
        "subsection",
        "item_type",
        "item_key",
        "item_name",
        "hour",
        "rank",
        "category",
        "source_name",
        "page_name",
        "payment_mode",
        "metric",
        "value",
        "previous_value",
        "change_percent",
        "unit",
        "start_date",
        "end_date",
        "brand_key",
        "selected_web_vitals_metric",
        "generated_at",
      ];
      const csvLines = [
        csvHeader.join(","),
        ...rows.map((row) => csvHeader.map((col) => escapeCsvCell(row[col])).join(",")),
      ];
      const csvText = `${csvLines.join("\n")}\n`;

      const filename = `datum_snapshot_${generalMetricsQuery?.start || "start"}_${generalMetricsQuery?.end || "end"}.csv`;
      const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to build dashboard snapshot:", error);
      window.alert("Failed to download dashboard snapshot. Please try again.");
    }
  }, [
    buildWebVitalsSnapshot,
    compareMode,
    generalMetricsQuery,
    trafficSplitRules,
    trendMetricsQuery,
    webVitalsMetric,
  ]);

  useEffect(() => {
    if (!onRegisterActions) return;
    onRegisterActions({
      openLayoutEditor: handleOpenLayoutEditor,
      downloadSnapshot: handleDownloadSnapshot,
    });
    return () => onRegisterActions(null);
  }, [handleDownloadSnapshot, handleOpenLayoutEditor, onRegisterActions]);

  if (!hasBrand) {
    return <EmptyStateCard message="Select a brand to load dashboard metrics." />;
  }

  return (
    <DashboardDataProvider>
      <Suspense fallback={<SectionFallback count={5} />}>
        <Stack spacing={{ xs: 1, md: 1.25 }}>
          {!isMobile ? (
            <PageHeader
              title="Dashboard"
              description="Your store at a glance"
              meta={[`Scope: ${dashboardScopeLabel}`]}
              actions={
                <>
                  {canCustomizeDashboardLayout ? (
                    <Button size="small" variant="outlined" startIcon={<LayoutPanelsIcon size={16} />} onClick={handleOpenLayoutEditor}>
                      Customize
                    </Button>
                  ) : null}
                  {isAuthor ? (
                    <Button size="small" variant="outlined" startIcon={<Download size={16} />} onClick={handleDownloadSnapshot}>
                      Download
                    </Button>
                  ) : null}
                </>
              }
            />
          ) : (
            <div className="dz-meta" style={{ margin: "0 2px 2px" }}>
              <span>Scope: {dashboardScopeLabel}</span>
            </div>
          )}
          <InlineDashboardLayoutEditor
            isEditing={layoutEditMode}
            itemIds={activeWidgetIds}
            renderWidget={(widgetId) => activeWidgetRegistry[widgetId]}
            extraAfterId={extraAfterId}
            extras={dashboardExtrasNode}
            onOrderChange={handleInlineDashboardReorder}
            onSave={() => handleSaveDashboardLayout(effectiveDashboardLayout)}
            onCancel={handleCloseLayoutEditor}
            onReset={handleResetDashboardLayout}
            isDirty={isDashboardLayoutDirty}
            isSaving={isSavingDashboardLayout}
          />
        </Stack>
      </Suspense>
    </DashboardDataProvider>
  );
}
