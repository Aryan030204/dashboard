import { Card, CardContent, Typography, Skeleton, Box } from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";

import { getTokens } from "../design/tokens.js";

export default function KPIStat({
  label,
  value,
  hint,
  loading,
  deltaLoading,
  formatter,
  delta,
  onSelect,
  onSelectionToggle,
  selected,
  selectionIndicatorSelected,
  centerOnMobile = false,
  action,
  bottomRightAccessory,
  sx = {},
  activeColor = "#10b981",
  compareValue,
  compareFormatter,
  invertDeltaColor = false,
  unavailable = false,
  showSelectionIndicator,
  variant = "card", // "cell" = flat metric cell for the connected KPI grid (visual only)
}) {
  const theme = useTheme();
  // Today's green stays in light mode; dark mode follows the accent (real hex, because alpha() needs one).
  const seriesColor = getTokens(theme.palette.mode).series;
  const accentColor = activeColor === "#10b981" ? seriesColor : activeColor;
  const selectedColor = seriesColor;
  const clickable = typeof onSelect === "function" && !unavailable;
  const selectionClickable =
    typeof onSelectionToggle === "function" && !unavailable;
  const shouldShowSelectionIndicator =
    typeof showSelectionIndicator === "boolean"
      ? showSelectionIndicator
      : selectionClickable;

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
    onSelectionToggle();
  };

  const isCell = variant === "cell";
  const goodColor = isCell ? "var(--dz-good)" : "#10b981"; // Green
  const badColor = isCell ? "var(--dz-bad)" : "#ef4444"; // Red

  return (
    <Card
      className="kpi-stat-card"
      elevation={0}
      onClick={clickable ? onSelect : undefined}
      onKeyDown={handleKeyDown}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable ? Boolean(selected) : undefined}
      sx={{
        height: "100%",
        transition: "all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
        cursor: clickable ? "pointer" : "default",
        position: "relative",
        border: "1px solid",
        borderColor: selected ? selectedColor : "divider",
        bgcolor: "background.paper",
        boxShadow: selected
          ? `0 0 0 1px ${selectedColor}, 0 10px 20px ${alpha(selectedColor, 0.2)}, 0 6px 6px ${alpha(selectedColor, 0.1)}`
          : "0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)",
        "&:hover": clickable
          ? {
              borderColor: selected ? selectedColor : "divider",
              boxShadow: selected
                ? `0 0 0 1.5px ${selectedColor}, 0 14px 28px ${alpha(selectedColor, 0.25)}, 0 10px 10px ${alpha(selectedColor, 0.15)}`
                : "0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23)",
              transform: "translateY(-4px)",
            }
          : {},
        "&:focus-visible": clickable
          ? { borderColor: "primary.main" }
          : undefined,
        ...(isCell
          ? {
              border: 0,
              borderRadius: 0,
              boxShadow: "none",
              bgcolor: selected ? "var(--dz-accent-soft)" : "var(--dz-panel)",
              transition: "background-color 0.15s ease",
              "&:hover": clickable
                ? { bgcolor: selected ? "var(--dz-accent-soft)" : "var(--dz-hover)" }
                : {},
              "&::after": selected
                ? {
                    content: '""',
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    height: 2,
                    bgcolor: "var(--dz-accent)",
                  }
                : undefined,
              "&:focus-visible": clickable
                ? { outline: "2px solid var(--dz-accent)", outlineOffset: -2 }
                : undefined,
            }
          : {}),
        ...sx,
      }}
    >
      <CardContent
        sx={{
          p: { xs: 1.25, md: 1.5 },
          "&:last-child": { pb: { xs: 1.25, md: 1.5 } },
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          minHeight: 110,
          alignItems: "stretch",
          textAlign: centerOnMobile ? { xs: "center", md: "left" } : "left",
          position: "relative",
        }}
      >
        <Box
          sx={{
            display: "flex",
            justifyContent: centerOnMobile
              ? { xs: "center", md: "flex-start" }
              : "flex-start",
            width: "100%",
            mb: 0.5,
            px: action && centerOnMobile ? { xs: "46px", md: 0 } : 0,
          }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{
              lineHeight: 1.2,
              pr: action && !centerOnMobile ? { xs: "46px", md: "46px" } : 0,
              ...(isCell ? { fontSize: 12.5, fontWeight: 500 } : {}),
            }}
          >
            {label}
          </Typography>
        </Box>
        {action && (
          <Box
            sx={{
              position: "absolute",
              top: 12,
              right: 12,
              zIndex: 10,
            }}
          >
            {action}
          </Box>
        )}
        {bottomRightAccessory && (
          <Box
            sx={{
              position: "absolute",
              right: shouldShowSelectionIndicator ? 36 : 12,
              bottom: 8,
              zIndex: 10,
              display: "flex",
              alignItems: "center",
            }}
          >
            {bottomRightAccessory}
          </Box>
        )}
        {shouldShowSelectionIndicator && (
          <Box
            component="button"
            type="button"
            aria-pressed={Boolean(selectionIndicatorSelected)}
            aria-label={`${selectionIndicatorSelected ? "Deselect" : "Select"} ${label}`}
            onClick={handleSelectionToggle}
            sx={{
              position: "absolute",
              right: 12,
              bottom: 12,
              width: 18,
              height: 18,
              borderRadius: "50%",
              border: "1.5px solid",
              borderColor: selectionIndicatorSelected
                ? accentColor
                : alpha(theme.palette.text.secondary, 0.35),
              bgcolor: selectionIndicatorSelected ? accentColor : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "all 0.18s ease",
              boxShadow: selectionIndicatorSelected
                ? `0 2px 6px ${alpha(accentColor, 0.35)}`
                : "none",
              cursor: selectionClickable ? "pointer" : "default",
              p: 0,
              outline: "none",
              appearance: "none",
              WebkitAppearance: "none",
              "&:focus-visible": {
                boxShadow: `0 0 0 2px ${alpha(accentColor, 0.28)}`,
              },
            }}
          >
            {selectionIndicatorSelected && (
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
        {loading ? (
          <Skeleton variant="text" width={120} height={32} />
        ) : (
          <>
            <Box
              sx={{
                display: "flex",
                alignItems: "baseline",
                gap: 1,
                justifyContent: centerOnMobile
                  ? { xs: "center", md: "flex-start" }
                  : "flex-start",
              }}
            >
              <Typography
                variant="h5"
                sx={
                  isCell
                    ? { fontSize: 24, fontWeight: 620, letterSpacing: "-0.025em", fontVariantNumeric: "tabular-nums" }
                    : { fontWeight: 700 }
                }
              >
                {unavailable ? "-" : formatter ? formatter(value) : value}
              </Typography>
              {!unavailable && compareValue != null && (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ fontWeight: 400, fontSize: "0.85em" }}
                >
                  vs{" "}
                  {compareFormatter
                    ? compareFormatter(compareValue)
                    : formatter
                      ? formatter(compareValue)
                      : compareValue}
                </Typography>
              )}
              {hint && !compareValue && !unavailable && (
                <Typography variant="caption" color="text.secondary">
                  {hint}
                </Typography>
              )}
            </Box>
            <Box
              sx={{
                mt: 0.5,
                height: 20,
                display: "flex",
                alignItems: "center",
                gap: 0.25,
                justifyContent: centerOnMobile
                  ? { xs: "center", md: "flex-start" }
                  : "flex-start",
              }}
            >
              {deltaLoading ? (
                <Skeleton variant="text" width={60} height={20} />
              ) : !unavailable && delta && typeof delta.value === "number" ? (
                <>
                  {delta.direction === "up" ? (
                    <TrendingUpIcon
                      sx={{
                        fontSize: 16,
                        color: invertDeltaColor ? badColor : goodColor,
                      }}
                    />
                  ) : delta.direction === "down" ? (
                    <TrendingDownIcon
                      sx={{
                        fontSize: 16,
                        color: invertDeltaColor ? goodColor : badColor,
                      }}
                    />
                  ) : (
                    <Box sx={{ width: 0, height: 0 }} />
                  )}
                  <Typography
                    variant="caption"
                    sx={{
                      color:
                        delta.direction === "up"
                          ? invertDeltaColor
                            ? badColor
                            : goodColor
                          : delta.direction === "down"
                            ? invertDeltaColor
                              ? goodColor
                              : badColor
                            : "text.secondary",
                      fontWeight: 600,
                      ml: 0.5,
                    }}
                  >
                    {Math.abs(delta.value).toFixed(1)}%
                  </Typography>
                </>
              ) : (
                // Reserve space to keep all cards equal height
                <Box sx={{ visibility: "hidden" }}>
                  <TrendingUpIcon sx={{ fontSize: 16 }} />
                  <Typography variant="body2">0.0%</Typography>
                </Box>
              )}
            </Box>
          </>
        )}
      </CardContent>
    </Card>
  );
}
