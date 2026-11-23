import { memo, useState } from "react";
import { Box, Link, Skeleton } from "@mui/material";
import { Segmented } from "./datum/index.js";
import { useDashboardWebVitalsData } from "../features/dashboard/widgetDataHooks.js";

const METRIC_TITLES = {
  FCP: "First Contentful Paint",
  LCP: "Largest Contentful Paint",
  TTFB: "Time to First Byte",
  PERFORMANCE: "performance score",
  SESSIONS: "sessions",
};

const WebVitals = ({
  query,
  metric: metricProp = "FCP",
  onMetricChange,
  sx = {},
}) => {
  const [localMetric, setLocalMetric] = useState(metricProp);
  const metric = typeof onMetricChange === "function" ? metricProp : localMetric;
  const handleMetricChange = (event) => {
    const nextMetric = event.target.value;
    if (typeof onMetricChange === "function") {
      onMetricChange(nextMetric);
      return;
    }
    setLocalMetric(nextMetric);
  };
  const { topPages, loading, isSingleDateSelection } = useDashboardWebVitalsData(
    query,
    metric,
  );

  const empty = (text) => (
    <Box sx={{ minHeight: 180, display: "flex", alignItems: "center", justifyContent: "center", p: 2 }}>
      <Box sx={{ color: "text.secondary", fontSize: 13, textAlign: "center" }}>{text}</Box>
    </Box>
  );

  return (
    <Box
      component="section"
      className="dz-panel"
      sx={{
        display: "flex",
        flexDirection: "column",
        height: { xs: "auto", md: 380 },
        minHeight: { xs: 320, md: 380 },
        maxHeight: { xs: "none", md: 380 },
        ...sx,
      }}
    >
      <div className="dz-ph">
        <div style={{ minWidth: 0 }}>
          <h2 className="dz-pt">Top 5 pages by {METRIC_TITLES[metric] || metric}</h2>
          <p className="dz-ps">
            Change vs previous period · {metric === "PERFORMANCE" || metric === "SESSIONS" ? "higher is better" : "lower is faster"}
          </p>
        </div>
        <Segmented
          ariaLabel="Metric"
          value={metric}
          onChange={(next) => handleMetricChange({ target: { value: next } })}
          options={[
            { value: "FCP", label: "FCP" },
            { value: "LCP", label: "LCP" },
            { value: "TTFB", label: "TTFB" },
            { value: "PERFORMANCE", label: "Performance" },
            { value: "SESSIONS", label: "Sessions" },
          ]}
        />
      </div>

      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", scrollbarWidth: "thin" }}>
        {loading
          ? Array.from(new Array(5)).map((_, i) => (
              <Box key={i} sx={{ px: 2, py: 1.5 }}>
                <Skeleton variant="text" width="80%" />
                <Skeleton variant="text" width="40%" />
              </Box>
            ))
          : !isSingleDateSelection
            ? empty("Top 5 pages are shown only for a single selected date.")
            : topPages.length === 0
              ? empty("No top pages exist for this selection.")
              : topPages.map((page, idx) => {
                  const improved = page.change > 0;
                  let cleanUrl = page.url.replace(
                    /\/[a-z0-9-]+\.myshopify\.com(\/|$)/i,
                    "/",
                  );
                  cleanUrl = cleanUrl.replace(/([^:]\/)\/+/g, "$1");
                  let displayUrl = cleanUrl;
                  try {
                    displayUrl = new URL(cleanUrl).pathname;
                  } catch {
                    // keep the cleaned URL as-is
                  }
                  const unit =
                    metric !== "TTFB" && metric !== "SESSIONS" && metric !== "PERFORMANCE" ? "s" : "";
                  // Same direction logic as before: for sessions/performance up is good; for timings down is good.
                  const higherIsBetter = metric === "SESSIONS" || metric === "PERFORMANCE";
                  const arrow = higherIsBetter ? (improved ? "↑" : "↓") : improved ? "↓" : "↑";

                  return (
                    <div key={idx} className="dz-mrow" style={{ alignItems: "center" }}>
                      <span className="dz-num dz-muted" style={{ width: 16, fontSize: 12 }}>{idx + 1}</span>
                      <div className="dz-mrow-l">
                        <Link
                          href={cleanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          underline="hover"
                          className="dz-mono"
                          sx={{ color: "text.primary", wordBreak: "break-all", lineHeight: 1.45 }}
                        >
                          {displayUrl}
                        </Link>
                      </div>
                      <div className="dz-mrow-r">
                        <div className="dz-mrow-v">
                          {Math.round(page.avg * 100) / 100}
                          {unit}
                        </div>
                        {page.change !== null ? (
                          <div
                            className="dz-num"
                            style={{ fontSize: 12, fontWeight: 600, color: improved ? "var(--dz-good)" : "var(--dz-bad)" }}
                          >
                            {arrow} {Math.abs(page.change).toFixed(2)}%
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
      </Box>
    </Box>
  );
};

export default memo(WebVitals);
