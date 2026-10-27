import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  ListItemText,
  MenuItem,
  Select,
  Skeleton,
  Typography,
} from "@mui/material";
import { getIntentSourceOverlap } from "../../lib/api.js";
import { SectionCard } from "./shared.jsx";
import SourceVennDiagram from "./SourceVennDiagram.jsx";
import {
  OVERLAP_LEVELS,
  OVERLAP_LEVEL_LABELS,
  SOURCE_COLORS,
  describeLevels,
  formatValue,
  getRegionCaption,
  getRegionLabel,
  hasOverlapData,
  orderRegions,
  regionIndices,
  sanitizeLevels,
} from "./intentSourceOverlapUtils.js";

const INFO =
  "Sessions from visitors who arrived through more than one traffic source. The circles are the brand's three biggest UTM sources in this range. Each region counts the sessions of visitors seen in exactly those sources; the centre, where all three meet, counts only the sessions that reached checkout. Facebook, Instagram and Meta are grouped as Meta, Google and YouTube as Google, and sessions without a UTM source as Direct.";

// Legend dot: the source colour for a single circle, split colours for an overlap.
function regionSwatch(indices) {
  const colors = indices.map((index) => SOURCE_COLORS[index]).filter(Boolean);
  if (colors.length <= 1) return colors[0] || "transparent";
  const step = 100 / colors.length;
  const stops = colors.map((color, i) => `${color} ${i * step}% ${(i + 1) * step}%`);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function Message({ children, action }) {
  return (
    <Box
      sx={{
        minHeight: 200,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
        textAlign: "center",
        px: 2,
      }}
    >
      <Typography variant="body2" color="text.secondary">
        {children}
      </Typography>
      {action}
    </Box>
  );
}

// Fetches its own data (separate from the page payload), so changing the intent dropdown refetches only
// this card. `start` / `end` are YYYY-MM-DD strings; `basis` follows the page's Behaviour / Score switch.
export default function IntentSourceOverlap({ brandKey, start, end, basis = "behavior" }) {
  const [levels, setLevels] = useState(OVERLAP_LEVELS);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error | unavailable
  const [reloadKey, setReloadKey] = useState(0);
  const [activeId, setActiveId] = useState(null);

  // A different brand, range or basis must never show the previous result.
  useEffect(() => {
    setData(null);
  }, [brandKey, start, end, basis]);

  useEffect(() => {
    if (!brandKey || !start || !end) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    setActiveId(null);
    getIntentSourceOverlap(
      { brand_key: brandKey, start, end, intent: levels, basis },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        // 404: a backend without this endpoint yet
        setStatus(res.status === 404 ? "unavailable" : "error");
        return;
      }
      setData(res.data);
      setStatus("ready");
    });
    return () => controller.abort();
  }, [brandKey, start, end, basis, levels, reloadKey]);

  const sources = useMemo(() => data?.sources || [], [data]);
  const regions = useMemo(() => orderRegions(data?.regions || [], sources), [data, sources]);
  const activeRegion = regions.find((region) => region.id === activeId) || null;
  const otherSessions = Number(data?.otherSessions) || 0;

  const unavailable =
    status === "unavailable" || (status === "ready" && data?.meta?.available === false);
  const empty = status === "ready" && !unavailable && !hasOverlapData(data);

  const intentSelect = (
    <Select
      multiple
      size="small"
      value={levels}
      onChange={(event) => {
        const next = event.target.value;
        const picked = typeof next === "string" ? next.split(",") : next;
        // keep at least one level selected
        if (picked.length) setLevels(sanitizeLevels(picked));
      }}
      renderValue={() => describeLevels(levels)}
      inputProps={{ "aria-label": "Intent filter" }}
      sx={{ minWidth: 150, fontSize: 13, "& .MuiSelect-select": { py: 0.5 } }}
    >
      {OVERLAP_LEVELS.map((level) => (
        <MenuItem key={level} value={level} dense>
          <Checkbox size="small" checked={levels.includes(level)} sx={{ p: 0.5, mr: 0.5 }} />
          <ListItemText primary={OVERLAP_LEVEL_LABELS[level]} />
        </MenuItem>
      ))}
    </Select>
  );

  let body;
  if (!data && status === "loading") {
    body = <Skeleton variant="rounded" height={260} />;
  } else if (status === "error" && !data) {
    body = (
      <Message
        action={
          <Button size="small" variant="outlined" onClick={() => setReloadKey((n) => n + 1)}>
            Retry
          </Button>
        }
      >
        Couldn&apos;t load source overlap. Please try again.
      </Message>
    );
  } else if (unavailable) {
    body = <Message>Source overlap isn&apos;t available for this brand yet.</Message>;
  } else if (empty) {
    body = <Message>No UTM data for the selected date range and intent.</Message>;
  } else if (data) {
    body = (
      <Box
        sx={{
          display: "flex",
          // full-width card: diagram and legend side by side from the md breakpoint
          flexDirection: { xs: "column", md: "row" },
          alignItems: { xs: "center", md: "flex-start" },
          gap: 2,
          opacity: status === "loading" ? 0.6 : 1,
          transition: "opacity 0.2s ease",
        }}
      >
        <Box sx={{ width: "100%", maxWidth: 340, flexShrink: 0 }}>
          <SourceVennDiagram
            sources={sources}
            regions={regions}
            activeId={activeId}
            onActiveChange={setActiveId}
          />
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, width: "100%" }}>
          <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
            {regions.map((region) => {
              const indices = regionIndices(region, sources);
              const active = region.id === activeId;
              return (
                <Box
                  component="li"
                  key={region.id}
                  tabIndex={0}
                  aria-label={getRegionCaption(region, sources)}
                  onMouseEnter={() => setActiveId(region.id)}
                  onMouseLeave={() => setActiveId(null)}
                  onFocus={() => setActiveId(region.id)}
                  onBlur={() => setActiveId(null)}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 1,
                    py: 0.6,
                    borderRadius: 1,
                    bgcolor: active ? "action.hover" : "transparent",
                    outline: "none",
                    "&:focus-visible": { boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}` },
                  }}
                >
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      flexShrink: 0,
                      background: regionSwatch(indices),
                    }}
                  />
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                    {getRegionLabel(region, sources)}
                  </Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {formatValue(region.value)}
                  </Typography>
                </Box>
              );
            })}
          </Box>

          <Typography
            variant="caption"
            color="text.secondary"
            aria-live="polite"
            sx={{ display: "block", mt: 1, minHeight: "2.6em" }}
          >
            {activeRegion
              ? getRegionCaption(activeRegion, sources)
              : "Hover a region or a row for details. The centre counts sessions that reached checkout."}
          </Typography>
          {otherSessions > 0 ? (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {formatValue(otherSessions)} sessions from other sources are not shown.
            </Typography>
          ) : null}
        </Box>
      </Box>
    );
  }

  return (
    <SectionCard title="User Overlap by UTM Source" info={INFO} action={intentSelect}>
      {body}
    </SectionCard>
  );
}
