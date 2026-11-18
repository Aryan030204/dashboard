import { useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Skeleton, Typography } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { getHeatmapElements } from "../../../lib/api.js";
import {
  clickSplit,
  describeElement,
  describePage,
  formatCount,
  formatShare,
} from "./heatmapUtils.js";

const ELEMENT_LIMIT = 20;

function ElementRow({ element, rank }) {
  const { title, subtitle } = describeElement(element);
  const split = clickSplit(element);
  return (
    <Box
      component="li"
      sx={{
        display: "flex",
        gap: 1.5,
        alignItems: "flex-start",
        py: 1.25,
        borderBottom: "1px solid",
        borderColor: "divider",
        minWidth: 0,
      }}
    >
      <Box
        aria-hidden
        sx={{
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: "50%",
          bgcolor: "primary.main",
          color: "primary.contrastText",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 700,
        }}
      >
        {rank}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1.5, alignItems: "baseline" }}>
          <Typography variant="body2" sx={{ fontWeight: 600, minWidth: 0 }} noWrap title={title}>
            {title}
          </Typography>
          <Typography variant="body2" sx={{ flexShrink: 0, fontWeight: 600 }}>
            {formatCount(element.clicks)}{" "}
            <Typography component="span" variant="caption" color="text.secondary">
              ({formatShare(element.share)})
            </Typography>
          </Typography>
        </Box>
        {subtitle ? (
          <Typography variant="caption" color="text.secondary" noWrap component="div" title={subtitle}>
            {subtitle}
          </Typography>
        ) : null}
        <Box
          role="img"
          aria-label={`${formatCount(element.usefulClicks)} useful clicks, ${formatCount(element.deadClicks)} dead clicks`}
          sx={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", mt: 0.75, bgcolor: "action.hover" }}
        >
          <Box sx={{ width: `${split.usefulPct}%`, bgcolor: "success.main" }} />
          <Box sx={{ width: `${split.deadPct}%`, bgcolor: "text.disabled", opacity: 0.55 }} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          {formatCount(element.usefulClicks)} useful · {formatCount(element.deadClicks)} dead
        </Typography>
      </Box>
    </Box>
  );
}

// Where visitors click on one page: totals, then the clicked elements ranked by clicks. Click counts come
// from the daily click rollup, which has no device split, so they are always for all devices.
export default function PageClicksView({ brandKey, path, start, end, device, onBack }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error | unavailable
  const [reloadKey, setReloadKey] = useState(0);
  const page = describePage(path);

  useEffect(() => {
    if (!brandKey || !path || !start || !end) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    setData(null);
    getHeatmapElements(
      { brand_key: brandKey, start, end, path, limit: ELEMENT_LIMIT },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        setStatus(res.status === 404 ? "unavailable" : "error");
        return;
      }
      setData(res.data);
      setStatus(res.data?.meta?.available === false ? "unavailable" : "ready");
    });
    return () => controller.abort();
  }, [brandKey, path, start, end, reloadKey]);

  const totals = data?.totals;
  const elements = data?.elements || [];
  const deadShare = totals?.clicks > 0 ? (totals.deadClicks / totals.clicks) * 100 : null;

  let body;
  if (status === "loading") {
    body = <Skeleton variant="rounded" height={260} />;
  } else if (status === "error") {
    body = (
      <Box sx={{ py: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t load the clicks for this page. Please try again.
        </Typography>
        <Button size="small" variant="outlined" onClick={() => setReloadKey((n) => n + 1)}>
          Retry
        </Button>
      </Box>
    );
  } else if (status === "unavailable") {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        Click data isn&apos;t available for this brand yet.
      </Typography>
    );
  } else if (!elements.length) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No clicks recorded on this page for the selected dates.
      </Typography>
    );
  } else {
    body = (
      <>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Ranked by most clicks
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatCount(elements.length)} of {formatCount(totals.elements)} elements
        </Typography>
        <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, mt: 0.5 }}>
          {elements.map((element, index) => (
            <ElementRow key={element.id} element={element} rank={index + 1} />
          ))}
        </Box>
      </>
    );
  }

  return (
    <Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5, mb: 1.5 }}>
        <Button size="small" startIcon={<ArrowBackIcon />} onClick={onBack} sx={{ textTransform: "none" }}>
          All pages
        </Button>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }} noWrap title={page.label}>
            {page.label}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap component="div" title={page.path}>
            {page.path}
          </Typography>
        </Box>
      </Box>

      {status === "ready" ? (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mb: 1.5 }}>
          {totals.pageViews != null ? (
            <Chip size="small" variant="outlined" label={`${formatCount(totals.pageViews)} page views`} />
          ) : null}
          <Chip size="small" variant="outlined" label={`${formatCount(totals.clicks)} clicks`} />
          {deadShare != null ? (
            <Chip size="small" variant="outlined" label={`${formatShare(deadShare)} dead clicks`} />
          ) : null}
        </Box>
      ) : null}

      {device !== "all" && status === "ready" ? (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          Clicks and page views here cover all devices. The device filter only applies to the pages list.
        </Alert>
      ) : null}

      {body}
    </Box>
  );
}
