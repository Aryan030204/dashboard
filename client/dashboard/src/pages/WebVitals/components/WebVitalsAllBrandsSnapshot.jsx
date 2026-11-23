import { useEffect, useMemo, useState } from "react";
import { Box, Card, IconButton, Skeleton, Stack, Typography, useMediaQuery, useTheme } from "@mui/material";
import { alpha } from "@mui/material/styles";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { METRIC_DEFS, getStatusMeta } from "../webVitalsFormat.js";

const PERFORMANCE_DEF = METRIC_DEFS.performance;
const PAGE_SLOT_COUNT = 8;
const SELECTED_CARD_COLOR = "#10b981";

function BrandCard({ brand, selected, onSelect }) {
  const value = brand.metrics?.performance?.value ?? null;
  const statusMeta = getStatusMeta(brand.metrics?.performance?.status, "performance");
  const clickable = typeof onSelect === "function";

  return (
    <Card
      variant="outlined"
      onClick={clickable ? onSelect : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable ? Boolean(selected) : undefined}
      sx={{
        p: 2,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 0.75,
        cursor: clickable ? "pointer" : "default",
        transition: "all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
        borderColor: selected ? SELECTED_CARD_COLOR : "divider",
        boxShadow: selected
          ? `0 0 0 1px ${SELECTED_CARD_COLOR}, 0 10px 20px ${alpha(SELECTED_CARD_COLOR, 0.2)}, 0 6px 6px ${alpha(SELECTED_CARD_COLOR, 0.1)}`
          : "none",
        "&:hover": clickable
          ? {
              borderColor: selected ? SELECTED_CARD_COLOR : "divider",
              boxShadow: selected
                ? `0 0 0 1.5px ${SELECTED_CARD_COLOR}, 0 14px 28px ${alpha(SELECTED_CARD_COLOR, 0.25)}, 0 10px 10px ${alpha(SELECTED_CARD_COLOR, 0.15)}`
                : "0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23)",
              transform: "translateY(-4px)",
            }
          : {},
      }}
    >
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {brand.brand_name || brand.brand_key}
      </Typography>

      <Typography variant="h5" sx={{ fontWeight: 700 }}>
        {PERFORMANCE_DEF.format(value)}
        {value !== null ? (
          <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 0.5 }}>
            /100
          </Typography>
        ) : null}
      </Typography>

      {statusMeta ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "999px",
              bgcolor: statusMeta.color,
              flexShrink: 0,
            }}
          />
          <Typography variant="caption" sx={{ color: statusMeta.color, fontWeight: 600 }}>
            {statusMeta.label}
          </Typography>
        </Box>
      ) : (
        <Typography variant="caption" color="text.secondary">
          No data
        </Typography>
      )}
    </Card>
  );
}

export default function WebVitalsAllBrandsSnapshot({
  brands,
  loading,
  selectedBrandKey,
  onSelectBrand,
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const muiTheme = useTheme();
  const isPhone = useMediaQuery(muiTheme.breakpoints.down("md"));

  const pages = useMemo(() => {
    const chunks = [];
    for (let i = 0; i < brands.length; i += PAGE_SLOT_COUNT) {
      chunks.push(brands.slice(i, i + PAGE_SLOT_COUNT));
    }
    return chunks.length > 0 ? chunks : [[]];
  }, [brands]);

  useEffect(() => {
    if (pageIndex > pages.length - 1) setPageIndex(0);
  }, [pageIndex, pages.length]);

  const currentPage = pages[pageIndex] || [];

  if (isPhone) {
    return (
      <section className="dz-panel">
        <div className="dz-ph">
          <div style={{ minWidth: 0 }}>
            <h2 className="dz-pt">All brands</h2>
            <p className="dz-ps">Performance score today</p>
          </div>
          {pages.length > 1 ? (
            <Stack direction="row" spacing={0.25} alignItems="center">
              <IconButton
                size="small"
                aria-label="Previous brands"
                onClick={() => setPageIndex((current) => current - 1)}
                disabled={pageIndex === 0}
                sx={{ color: "text.secondary", border: "1px solid", borderColor: "divider" }}
              >
                <ChevronLeftRoundedIcon fontSize="small" />
              </IconButton>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32, textAlign: "center" }}>
                {pageIndex + 1}/{pages.length}
              </Typography>
              <IconButton
                size="small"
                aria-label="Next brands"
                onClick={() => setPageIndex((current) => current + 1)}
                disabled={pageIndex === pages.length - 1}
                sx={{ color: "text.secondary", border: "1px solid", borderColor: "divider" }}
              >
                <ChevronRightRoundedIcon fontSize="small" />
              </IconButton>
            </Stack>
          ) : null}
        </div>
        {loading ? (
          <Box sx={{ p: 2 }}>
            <Skeleton variant="text" width="60%" />
            <Skeleton variant="text" width="80%" />
            <Skeleton variant="text" width="70%" />
          </Box>
        ) : brands.length === 0 ? (
          <div className="dz-tbl-empty">No web vitals data for this date across any brand.</div>
        ) : (
          currentPage.map((brand) => {
            const value = brand.metrics?.performance?.value ?? null;
            const statusMeta = getStatusMeta(brand.metrics?.performance?.status, "performance");
            const selected = typeof onSelectBrand === "function" && brand.brand_key === selectedBrandKey;
            const clickable = typeof onSelectBrand === "function";
            const pct = Math.max(0, Math.min(100, Number(value) || 0));
            return (
              <div
                key={brand.brand_key}
                className="dz-mrow"
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                aria-pressed={clickable ? selected : undefined}
                onClick={clickable ? () => onSelectBrand(brand.brand_key) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectBrand(brand.brand_key);
                        }
                      }
                    : undefined
                }
                style={{ cursor: clickable ? "pointer" : "default", background: selected ? "var(--dz-accent-soft)" : undefined, alignItems: "center" }}
              >
                <div className="dz-mrow-l">
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                    <b style={{ fontWeight: 600, fontSize: 13 }}>{brand.brand_name || brand.brand_key}</b>
                    {statusMeta ? (
                      <span
                        className="dz-tag has-dot"
                        style={{ color: statusMeta.color, background: `color-mix(in srgb, ${statusMeta.color} 14%, transparent)` }}
                      >
                        {statusMeta.label}
                      </span>
                    ) : (
                      <span className="dz-muted" style={{ fontSize: 12 }}>No data</span>
                    )}
                  </div>
                  <span className="dz-track" aria-hidden="true" style={{ height: 5 }}>
                    <i style={{ width: `${pct}%`, background: statusMeta ? statusMeta.color : "var(--dz-line-2)" }} />
                  </span>
                </div>
                <div className="dz-mrow-r">
                  <div className="dz-mrow-v" style={{ fontSize: 16 }}>{PERFORMANCE_DEF.format(value)}</div>
                </div>
              </div>
            );
          })
        )}
      </section>
    );
  }

  return (
    <Box>
      {pages.length > 1 ? (
        <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={0.25} sx={{ mb: 1 }}>
          <IconButton
            size="small"
            onClick={() => setPageIndex((current) => current - 1)}
            disabled={pageIndex === 0}
            sx={{ color: "text.secondary", bgcolor: "rgba(255,255,255,0.03)" }}
          >
            <ChevronLeftRoundedIcon fontSize="small" />
          </IconButton>
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32, textAlign: "center" }}>
            {pageIndex + 1}/{pages.length}
          </Typography>
          <IconButton
            size="small"
            onClick={() => setPageIndex((current) => current + 1)}
            disabled={pageIndex === pages.length - 1}
            sx={{ color: "text.secondary", bgcolor: "rgba(255,255,255,0.03)" }}
          >
            <ChevronRightRoundedIcon fontSize="small" />
          </IconButton>
        </Stack>
      ) : null}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "repeat(2, 1fr)",
            sm: "repeat(4, 1fr)",
          },
          gap: 1.5,
        }}
      >
        {loading ? (
          Array.from({ length: PAGE_SLOT_COUNT }).map((_, index) => (
            <Card key={`skeleton-${index}`} variant="outlined" sx={{ p: 2, height: "100%" }}>
              <Skeleton variant="text" width="70%" />
              <Skeleton variant="text" width={60} height={40} />
              <Skeleton variant="text" width="50%" />
            </Card>
          ))
        ) : brands.length === 0 ? (
          <Box sx={{ gridColumn: "1 / -1" }}>
            <Typography variant="body2" color="text.secondary">
              No web vitals data for this date across any brand.
            </Typography>
          </Box>
        ) : (
          currentPage.map((brand) => (
            <BrandCard
              key={brand.brand_key}
              brand={brand}
              selected={
                typeof onSelectBrand === "function" &&
                brand.brand_key === selectedBrandKey
              }
              onSelect={
                typeof onSelectBrand === "function"
                  ? () => onSelectBrand(brand.brand_key)
                  : undefined
              }
            />
          ))
        )}
      </Box>
    </Box>
  );
}
