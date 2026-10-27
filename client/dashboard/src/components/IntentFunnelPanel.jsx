import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { Box, Button, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { EmptyStateCard, SectionFallback } from "../routes/shared/RouteUi.jsx";
import { getIntentFunnel } from "../lib/api.js";
import IntentKpiGrid from "./intentFunnel/IntentKpiGrid.jsx";
import IntentFunnelBars from "./intentFunnel/IntentFunnelBars.jsx";
import IntentTrendChart from "./intentFunnel/IntentTrendChart.jsx";
import IntentDistributionDonut from "./intentFunnel/IntentDistributionDonut.jsx";
import IntentSourceOverlap from "./intentFunnel/IntentSourceOverlap.jsx";
import IntentConversionRates from "./intentFunnel/IntentConversionRates.jsx";
import TopProductsByIntent from "./intentFunnel/TopProductsByIntent.jsx";
import FunnelExploration from "./intentFunnel/FunnelExploration.jsx";
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
  // "behavior": rule-based over every session, each visitor at their best level (the same idea as Microsoft
  // Clarity's user intent). "score": percentile buckets of the intent score. Both come in the same response;
  // until the user picks one, behaviour is shown whenever the server sent it.
  const [intentBasis, setIntentBasis] = useState(null);
  // What the behaviour donut counts: visitors, or sessions (Clarity counts sessions).
  const [donutMetric, setDonutMetric] = useState("users");

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
  }, [brandKey, startKey, endKey, topProductsSort, reloadKey]);

  const trend = useMemo(
    () => prepareTrend(data?.trend || [], granularity),
    [data?.trend, granularity],
  );

  const behavior = data?.behavior || null;
  const basis = intentBasis || (behavior ? "behavior" : "score");
  const useBehavior = basis === "behavior" && behavior != null;
  // The high / medium / low cards switch with the basis; the other cards are the same either way.
  const kpis = useMemo(() => {
    const base = data?.kpis || [];
    if (!useBehavior) return base;
    const replacements = new Map((behavior.kpis || []).map((kpi) => [kpi.id, kpi]));
    return base.map((kpi) => replacements.get(kpi.id) || kpi);
  }, [data?.kpis, behavior, useBehavior]);

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
        {behavior ? (
          <Box
            sx={{
              display: "flex",
              flexDirection: { xs: "column", sm: "row" },
              alignItems: { xs: "stretch", sm: "center" },
              gap: { xs: 0.75, sm: 1 },
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Intent based on
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={basis}
              onChange={(_, next) => next && setIntentBasis(next)}
              aria-label="Intent basis"
              sx={{
                width: { xs: "100%", sm: "auto" },
                "& .MuiToggleButton-root": {
                  flex: { xs: 1, sm: "none" },
                  textTransform: "none",
                  fontSize: { xs: 12, sm: 13 },
                  lineHeight: 1.25,
                  px: { xs: 1, sm: 1.5 },
                },
              }}
            >
              <ToggleButton value="behavior">Behaviour (like Clarity)</ToggleButton>
              <ToggleButton value="score">Score (percentile)</ToggleButton>
            </ToggleButtonGroup>
          </Box>
        ) : null}
        {useBehavior ? (
          <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
            Counts every session once the visitor has been quiet for 30 minutes, so the newest hour is not
            included yet. Each visitor is counted once, at their best level.
          </Typography>
        ) : null}

        <Box sx={{ mb: { xs: 0.5, md: 1 } }}>
          <IntentKpiGrid kpis={kpis} sessionsStarted={data.sessionsStarted} />
        </Box>

        <Box sx={rowSx("minmax(0, 1.7fr) minmax(0, 1fr)")}>
          <IntentTrendChart
            trend={trend}
            granularity={granularity}
            onGranularityChange={setGranularity}
          />
          <IntentDistributionDonut
            distribution={useBehavior ? behavior.distribution : data.distribution}
            metric={useBehavior ? donutMetric : "users"}
            onMetricChange={useBehavior ? setDonutMetric : undefined}
            basis={useBehavior ? "behavior" : "score"}
          />
        </Box>

        <IntentSourceOverlap
          brandKey={brandKey}
          start={startKey}
          end={endKey}
          basis={useBehavior ? "behavior" : "score"}
        />

        <IntentFunnelBars funnel={data.funnel} />

        <Box sx={rowSx("minmax(0, 1fr) minmax(0, 1.4fr)")}>
          <IntentConversionRates conversionRates={data.conversionRates} />
          <TopProductsByIntent
            products={data.topProducts}
            sortBy={topProductsSort}
            onSortByChange={setTopProductsSort}
          />
        </Box>

        <FunnelExploration
          products={data.topProducts}
          rankedByViews={topProductsSort === "views"}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: { xs: 2, md: 2.5 }, minWidth: 0, maxWidth: "100%" }}>
      <Box>
        <Typography
          variant="h4"
          sx={{ fontWeight: 600, fontSize: { xs: "1.5rem", sm: "2rem", md: "2.125rem" } }}
          color="text.primary"
        >
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
