import { useEffect, useMemo, useState } from "react";
import { Box, Button, MenuItem, Select, Skeleton, Typography } from "@mui/material";
import { getIntentSourceOverlap } from "../../lib/api.js";
import { SectionCard } from "./shared.jsx";
import SourceVennDiagram from "./SourceVennDiagram.jsx";
import {
  OVERLAP_INTENT_OPTIONS,
  getRegionCaption,
  hasOverlapData,
  orderRegions,
} from "./intentSourceOverlapUtils.js";

const INFO =
  "Sessions from visitors who arrived through more than one traffic source. The circles are Google (including YouTube), Meta (Facebook and Instagram) and Others (every other source, including sessions without a UTM source). Each region counts the sessions of visitors seen in exactly those sources; the centre, where all three meet, counts only the sessions that reached checkout.";

function Message({ children, action }) {
  return (
    <Box
      sx={{
        minHeight: 220,
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
  const [intent, setIntent] = useState("all");
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
      { brand_key: brandKey, start, end, intent, basis },
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
  }, [brandKey, start, end, basis, intent, reloadKey]);

  const sources = useMemo(() => data?.sources || [], [data]);
  const regions = useMemo(() => orderRegions(data?.regions || [], sources), [data, sources]);
  const activeRegion = regions.find((region) => region.id === activeId) || null;

  const unavailable =
    status === "unavailable" || (status === "ready" && data?.meta?.available === false);
  const empty = status === "ready" && !unavailable && !hasOverlapData(data);

  const intentSelect = (
    <Select
      size="small"
      value={intent}
      onChange={(event) => setIntent(event.target.value)}
      inputProps={{ "aria-label": "Intent" }}
      startAdornment={
        <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
          Intent
        </Typography>
      }
      sx={{ minWidth: 170, fontSize: 13, "& .MuiSelect-select": { py: 0.5 } }}
    >
      {OVERLAP_INTENT_OPTIONS.map((option) => (
        <MenuItem key={option.value} value={option.value} dense>
          {option.label}
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
        Couldn&apos;t load user overlap. Please try again.
      </Message>
    );
  } else if (unavailable) {
    body = <Message>User overlap isn&apos;t available for this brand yet.</Message>;
  } else if (empty) {
    body = <Message>No sessions for the selected date range and intent.</Message>;
  } else if (data) {
    body = (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          opacity: status === "loading" ? 0.6 : 1,
          transition: "opacity 0.2s ease",
        }}
      >
        <Box sx={{ width: "100%", maxWidth: 340 }}>
          <SourceVennDiagram
            sources={sources}
            regions={regions}
            activeId={activeId}
            onActiveChange={setActiveId}
          />
        </Box>
        <Typography
          variant="caption"
          color="text.secondary"
          aria-live="polite"
          sx={{ minHeight: "1.5em", textAlign: "center" }}
        >
          {activeRegion ? getRegionCaption(activeRegion, sources) : ""}
        </Typography>
      </Box>
    );
  }

  return (
    <SectionCard title="User Overlap" subtitle="By UTM Source" info={INFO} action={intentSelect}>
      {body}
    </SectionCard>
  );
}
