import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { Box, Button, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { EmptyStateCard, SectionFallback } from "../routes/shared/RouteUi.jsx";
import { getIntentFunnel, getIntentFunnelPathProducts, getIntentFunnelPaths } from "../lib/api.js";
import { PATH_STEPS_DEFAULT } from "./intentFunnel/intentFunnelUtils.js";
import IntentKpiGrid from "./intentFunnel/IntentKpiGrid.jsx";
import IntentDistributionDonut from "./intentFunnel/IntentDistributionDonut.jsx";
import IntentSourceOverlap from "./intentFunnel/IntentSourceOverlap.jsx";
import TopProductsByIntent from "./intentFunnel/TopProductsByIntent.jsx";
import PathExplorationSankey from "./intentFunnel/PathExplorationSankey.jsx";
import IntentReport from "./intentFunnel/IntentReport.jsx";
import HeatmapSection from "./intentFunnel/heatmap/HeatmapSection.jsx";

// The UI tab value -> the sort value the API whitelists.
const API_SORT = { views: "views", addToCart: "add_to_cart", checkouts: "checkouts" };

// Two-column row on desktop, stacked below the lg breakpoint.
const rowSx = (columns) => ({
  display: "grid",
  gap: { xs: 1.5, md: 2 },
  gridTemplateColumns: { xs: "minmax(0, 1fr)", lg: columns },
});

export default function IntentFunnelPanel({ brandKey, start, end }) {
  const [topProductsSort, setTopProductsSort] = useState("views");
  // Funnel Exploration: the starting event, the path length (steps), an intent level and a product. With a
  // product or an intent level chosen the paths are read live (own request); otherwise they come with the page.
  const [pathStart, setPathStart] = useState("page_viewed");
  const [pathSteps, setPathSteps] = useState(PATH_STEPS_DEFAULT);
  const [pathIntent, setPathIntent] = useState("all");
  const [pathProduct, setPathProduct] = useState("");
  const [pathProducts, setPathProducts] = useState([]);
  const [livePaths, setLivePaths] = useState({ status: "idle", paths: null });
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
        // the Funnel Exploration loads its own data, so changing its controls does not re-run this request
        skipPaths: true,
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

  const pathBasis = useBehavior ? "behavior" : "score";
  // the intent basis only matters when an intent level is chosen, so it must not re-trigger the plain view
  const pathBasisKey = pathIntent === "all" ? "" : pathBasis;
  const hasData = data != null;

  // The store's top products (Redis cache) for the Funnel Exploration product filter.
  useEffect(() => {
    setPathProduct("");
  }, [brandKey]);
  useEffect(() => {
    if (!brandKey || !startKey || !endKey) return undefined;
    const controller = new AbortController();
    getIntentFunnelPathProducts(
      { brand_key: brandKey, start: startKey, end: endKey },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      setPathProducts(res.error ? [] : res.data?.products || []);
    });
    return () => controller.abort();
  }, [brandKey, startKey, endKey]);

  // The Funnel Exploration's own data (the daily rollup, or a live read for a product / intent level). The
  // previous paths stay on screen (dimmed) while the next ones load, so changing a control does not blank the card.
  useEffect(() => {
    if (!brandKey || !startKey || !endKey) return undefined;
    if (pathIntent !== "all" && !hasData) return undefined; // the intent basis is known once the page has loaded
    const controller = new AbortController();
    setLivePaths((previous) => ({ ...previous, status: "loading" }));
    getIntentFunnelPaths(
      {
        brand_key: brandKey,
        start: startKey,
        end: endKey,
        intent: pathIntent,
        basis: pathBasisKey || "behavior",
        pathStart,
        steps: pathSteps,
        productId: pathProduct,
      },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setLivePaths({ status: "error", paths: null });
      } else if (res.data?.meta?.available === false) {
        setLivePaths({ status: "unavailable", paths: null });
      } else {
        setLivePaths({ status: "ready", paths: res.data?.paths || null });
      }
    });
    return () => controller.abort();
  }, [brandKey, startKey, endKey, pathIntent, pathBasisKey, pathStart, pathSteps, pathProduct, hasData]);

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
            Counts every session. A session still in progress is counted at its current level and moves up if the
            visitor does more within 30 minutes. Each visitor is counted once, at their best level.
          </Typography>
        ) : null}

        <Box sx={{ mb: { xs: 0.5, md: 1 } }}>
          <IntentKpiGrid kpis={kpis} sessionsStarted={data.sessionsStarted} />
        </Box>

        {/* 1. User Overlap and Intent Distribution, side by side */}
        <Box sx={rowSx("minmax(0, 1fr) minmax(0, 1fr)")}>
          <IntentSourceOverlap
            brandKey={brandKey}
            start={startKey}
            end={endKey}
            basis={useBehavior ? "behavior" : "score"}
          />
          <IntentDistributionDonut
            distribution={useBehavior ? behavior.distribution : data.distribution}
            metric={donutMetric}
            onMetricChange={setDonutMetric}
            basis={useBehavior ? "behavior" : "score"}
          />
        </Box>

        {/* 2. Top Products by Intent, full width */}
        <TopProductsByIntent
          products={data.topProducts}
          sortBy={topProductsSort}
          onSortByChange={setTopProductsSort}
        />

        {/* 3. Funnel Exploration, full width */}
        <PathExplorationSankey
          paths={livePaths.paths}
          status={livePaths.status === "idle" ? "loading" : livePaths.status}
          pathStart={pathStart}
          onPathStartChange={setPathStart}
          steps={pathSteps}
          onStepsChange={setPathSteps}
          intent={pathIntent}
          onIntentChange={setPathIntent}
          productId={pathProduct}
          onProductChange={setPathProduct}
          products={pathProducts}
        />

        {/* 4. Intent Report, full width */}
        <IntentReport
          brandKey={brandKey}
          pageStart={startKey}
          pageEnd={endKey}
          basis={useBehavior ? "behavior" : "score"}
        />

        {/* 5. Heatmaps: popular pages, then the clicks on one page. Full width, last. */}
        <HeatmapSection brandKey={brandKey} pageStart={startKey} pageEnd={endKey} />
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
