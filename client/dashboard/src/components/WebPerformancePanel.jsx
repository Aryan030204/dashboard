import { memo } from "react";
import { Box, Button, Card, Skeleton } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { useTheme, alpha } from "@mui/material/styles";
import { useDashboardWebVitalsData } from "../features/dashboard/widgetDataHooks.js";

const nfFloat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

// Presentation: score gauge. Bands: 35 or below red, 36-49 yellow, 50 and above green.
// The marker position is derived from the same averaged score the widget already shows.
function ScoreGauge({ score }) {
  const pct = Math.max(0, Math.min(100, Number(score) || 0));
  const ticks = [
    { value: 0, shift: "0%" },
    { value: 36, shift: "-50%" },
    { value: 50, shift: "-50%" },
    { value: 100, shift: "-100%" },
  ];
  return (
    <Box aria-hidden="true" sx={{ width: "100%", mt: 1.5 }}>
      <Box sx={{ position: "relative" }}>
        <Box sx={{ display: "flex", height: 8 }}>
          <i style={{ width: "36%", background: "#ff4d4f", borderRadius: "4px 0 0 4px" }} />
          <i style={{ width: "14%", background: "#ffd21f" }} />
          <i style={{ width: "50%", background: "#22d364", borderRadius: "0 4px 4px 0" }} />
        </Box>
        <Box
          sx={{
            position: "absolute",
            top: -4,
            left: `${pct}%`,
            width: 3,
            height: 16,
            borderRadius: "2px",
            bgcolor: "text.primary",
            transform: "translateX(-50%)",
          }}
        />
      </Box>
      <Box sx={{ position: "relative", height: 16, mt: 0.75, fontSize: 11, color: "text.secondary" }}>
        {ticks.map((tick) => (
          <span key={tick.value} style={{ position: "absolute", left: `${tick.value}%`, transform: `translateX(${tick.shift})` }}>
            {tick.value}
          </span>
        ))}
      </Box>
    </Box>
  );
}

// Presentation only: the same card on desktop and phones. Callers pass the data they already have.
export function WebPerformanceCard({
  average,
  previous = null,
  change,
  showCompare = false,
  loading,
  selected = false,
  radioSelected = false,
  onSelect,
  onToggle,
}) {
  const theme = useTheme();
  const navigate = useNavigate();
  const clickable = typeof onSelect === "function";
  const selectionClickable = typeof onToggle === "function";

  const handleKeyDown = (event) => {
    if (!clickable) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect();
    }
  };

  const handleSelectionToggle = (event) => {
    if (!selectionClickable) return;
    event.preventDefault();
    event.stopPropagation();
    onToggle();
  };

  return (
    <Card
      elevation={0}
      className="dz-panel"
      onClick={clickable ? onSelect : undefined}
      onKeyDown={handleKeyDown}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable ? selected : undefined}
      sx={{
        height: "100%",
        minHeight: { xs: 150, md: 310 },
        display: "flex",
        flexDirection: "column",
        position: "relative",
        cursor: clickable ? "pointer" : "default",
        borderColor: selected ? "var(--dz-accent)" : undefined,
        boxShadow: selected ? "0 0 0 1px var(--dz-accent)" : undefined,
        "&:focus-visible": { outline: "2px solid var(--dz-accent)", outlineOffset: 2 },
      }}
    >
      <div className="dz-ph">
        <div style={{ minWidth: 0 }}>
          <h2 className="dz-pt">Web performance</h2>
          <p className="dz-ps">Average score across tracked pages</p>
        </div>
      </div>
      <Box
        sx={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          p: { xs: 1.5, md: 2.25 },
        }}
      >
        {loading ? (
          <Box>
            <Skeleton variant="text" width={160} />
            <Skeleton variant="text" width={120} height={42} />
          </Box>
        ) : (
          <>
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 1.25 }}>
              <Box component="span" className="dz-num" sx={{ fontSize: 44, fontWeight: 620, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
                {nfFloat.format(average ?? 0)}
              </Box>
              <Box component="span" sx={{ color: "text.secondary" }}>/ 100</Box>
              {typeof change === "number" ? (
                <Box
                  component="span"
                  className="dz-num"
                  sx={{
                    ml: "auto",
                    fontWeight: 600,
                    color:
                      change > 0
                        ? "var(--dz-good)"
                        : change < 0
                          ? "var(--dz-bad)"
                          : "text.secondary",
                  }}
                >
                  {change > 0 ? "↑" : change < 0 ? "↓" : ""}{" "}
                  {nfFloat.format(Math.abs(change))}%
                </Box>
              ) : null}
            </Box>
            {showCompare && previous != null ? (
              <Box sx={{ mt: 0.5, fontSize: 12.5, color: "text.secondary" }}>
                vs {nfFloat.format(previous)}
              </Box>
            ) : null}
            <ScoreGauge score={average} />
            <Box sx={{ mt: 2 }}>
              <Button
                size="small"
                variant="outlined"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate("/web-vitals");
                }}
              >
                Open Web Vitals ›
              </Button>
            </Box>
          </>
        )}
      </Box>
      {selectionClickable && (
        <Box
          component="button"
          type="button"
          aria-pressed={radioSelected}
          aria-label={`${radioSelected ? "Deselect" : "Select"} Web Performance(Avg)`}
          onClick={handleSelectionToggle}
          sx={{
            position: "absolute",
            right: 12,
            bottom: 12,
            width: 18,
            height: 18,
            borderRadius: "50%",
            border: "1.5px solid",
            borderColor: radioSelected
              ? "var(--dz-accent)"
              : alpha(theme.palette.text.secondary, 0.35),
            bgcolor: radioSelected ? "var(--dz-accent)" : "transparent",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "all 0.18s ease",
            cursor: selectionClickable ? "pointer" : "default",
            p: 0,
            outline: "none",
            appearance: "none",
            WebkitAppearance: "none",
            "&:focus-visible": {
              boxShadow: "0 0 0 2px var(--dz-accent-line)",
            },
          }}
        >
          {radioSelected && (
            <Box
              component="span"
              sx={{
                width: 7,
                height: 4,
                borderLeft: "2px solid #fff",
                borderBottom: "2px solid #fff",
                transform: "rotate(-45deg) translateY(-1px)",
              }}
            />
          )}
        </Box>
      )}
    </Card>
  );
}

function WebPerformancePanel({
  query,
  selectedMetrics = [],
  activeMetric = null,
  onSelectMetric,
  onToggleMetric,
}) {
  const { performanceAvg, performancePrev, performanceChange, loading } =
    useDashboardWebVitalsData(query, "PERFORMANCE", {
      usePerformanceSummary: true,
    });

  return (
    <WebPerformanceCard
      average={performanceAvg}
      previous={performancePrev}
      change={performanceChange}
      showCompare={Boolean(query?.compare_start && query?.compare_end)}
      loading={loading}
      selected={activeMetric === "performance"}
      radioSelected={selectedMetrics.includes("performance")}
      onSelect={typeof onSelectMetric === "function" ? () => onSelectMetric("performance") : undefined}
      onToggle={typeof onToggleMetric === "function" ? () => onToggleMetric("performance") : undefined}
    />
  );
}

export default memo(WebPerformancePanel);
