import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { Box, Button, Typography } from "@mui/material";
import { EmptyStateCard, SectionFallback } from "../routes/shared/RouteUi.jsx";
import { getIntentFunnel } from "../lib/api.js";
import IntentKpiGrid from "./intentFunnel/IntentKpiGrid.jsx";
import IntentFunnelBars from "./intentFunnel/IntentFunnelBars.jsx";
import IntentTrendChart from "./intentFunnel/IntentTrendChart.jsx";
import IntentDistributionDonut from "./intentFunnel/IntentDistributionDonut.jsx";
import IntentConversionRates from "./intentFunnel/IntentConversionRates.jsx";
import TopProductsByIntent from "./intentFunnel/TopProductsByIntent.jsx";
import PathExplorationSankey from "./intentFunnel/PathExplorationSankey.jsx";
import { prepareTrend } from "./intentFunnel/intentFunnelUtils.js";

// The UI tab value -> the sort value the API whitelists.
const API_SORT = { views: "views", addToCart: "add_to_cart", checkouts: "checkouts" };

// Two-column row on desktop, stacked below the lg breakpoint.
const rowSx = (columns) => ({
  display: "grid",
  gap: { xs: 1.5, md: 2 },
  gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: columns },
});

export default function IntentFunnelPanel({ brandKey, start, end }) {
  const [granularity, setGranularity] = useState("daily");
  const [topProductsSort, setTopProductsSort] = useState("views");
  const [pathStart, setPathStart] = useState("page_viewed");
  const [topN, setTopN] = useState(5);
  const [intentFilter, setIntentFilter] = useState("all");

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const startKey = start ? dayjs(start).format("YYYY-MM-DD") : "";
  const endKey = end ? dayjs(end).format("YYYY-MM-DD") : "";

  // A different brand or date range must never show the previous result.
  useEffect(() => {
    setData(null);
  }, [brandKey, startKey, endKey]);

  useEffect(() => {
    if (!brandKey || !startKey || !endKey) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    getIntentFunnel(
      {
        brand_key: brandKey,
        start: startKey,
        end: endKey,
        sort: API_SORT[topProductsSort],
        intent: intentFilter,
        pathStart,
        pathTop: topN,
      },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setFailed(true);
      } else {
        setData(res.data);
      }
      setLoading(false);
    });
    return () => controller.abort();
  }, [
    brandKey,
    startKey,
    endKey,
    topProductsSort,
    pathStart,
    topN,
    intentFilter,
    reloadKey,
  ]);

  const trend = useMemo(
    () => prepareTrend(data?.trend || [], granularity),
    [data?.trend, granularity],
  );

  const unavailable = data?.meta?.available === false;
  const hasSessions = (data?.kpis || []).some((kpi) => kpi.id === "visitors" && kpi.sessions > 0);

  let body;
  if (failed && !data) {
    body = (
      <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
        <EmptyStateCard message="Couldn't load intent funnel data. Please try again." />
        <Button size="small" variant="outlined" onClick={() => setReloadKey((n) => n + 1)}>
          Retry
        </Button>
      </Box>
    );
  } else if (!data) {
    body = <SectionFallback count={3} height={200} />;
  } else if (unavailable) {
    body = <EmptyStateCard message="Intent data is not available for this brand yet." />;
  } else if (!hasSessions) {
    body = <EmptyStateCard message="No intent data for the selected date range." />;
  } else {
    body = (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          gap: { xs: 2, md: 2.5 },
          opacity: loading ? 0.6 : 1,
          transition: "opacity 0.2s ease",
        }}
      >
        <Box sx={{ mb: { xs: 0.5, md: 1 } }}>
          <IntentKpiGrid kpis={data.kpis} />
        </Box>

        <Box sx={rowSx("minmax(0, 1.7fr) minmax(0, 1fr)")}>
          <IntentTrendChart
            trend={trend}
            granularity={granularity}
            onGranularityChange={setGranularity}
          />
          <IntentDistributionDonut distribution={data.distribution} />
        </Box>

        <IntentFunnelBars funnel={data.funnel} />

        <Box sx={rowSx("minmax(0, 1fr) minmax(0, 1.4fr)")}>
          <IntentConversionRates conversionRates={data.conversionRates} />
          <TopProductsByIntent
            products={data.topProducts}
            sortBy={topProductsSort}
            onSortByChange={setTopProductsSort}
          />
        </Box>

        <PathExplorationSankey
          paths={data.paths}
          pathStart={pathStart}
          onPathStartChange={setPathStart}
          topN={topN}
          onTopNChange={setTopN}
          intentFilter={intentFilter}
          onIntentFilterChange={setIntentFilter}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: { xs: 2, md: 2.5 } }}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 600 }} color="text.primary">
          Intent Funnel
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Understand user intent and conversion behavior across the customer
          journey.
        </Typography>
      </Box>
      {body}
    </Box>
  );
}
