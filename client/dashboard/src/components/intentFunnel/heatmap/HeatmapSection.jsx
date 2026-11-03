import { useEffect, useMemo, useState } from "react";
import { Box, Button, MenuItem, Select, Skeleton, Typography } from "@mui/material";
import { getHeatmapPages } from "../../../lib/api.js";
import { FunnelDateRangePicker } from "../../DailyFunnelPanel.jsx";
import { SectionCard } from "../shared.jsx";
import { validateRange } from "../intentReportUtils.js";
import PopularPagesTable from "./PopularPagesTable.jsx";
import PageClicksView from "./PageClicksView.jsx";
import { HEATMAP_DEVICE_OPTIONS } from "./heatmapUtils.js";

const INFO =
  "Where visitors go and click on your store. Pick a page to see which elements get the most clicks. Page views are counted once a day, so the newest day is not included yet. Click counts cover all devices. Elements are named from what the tracker records (an id, name, link or tag), and click positions are not shown because they are not stored relative to the page.";

const SEARCH_DEBOUNCE_MS = 350;

// The Heatmaps section of the Intent page: first the popular pages, then the clicks on one page. It has its
// own date range (it starts at the page's range) and fetches on its own, so nothing here reloads the rest
// of the page. `pageStart` / `pageEnd` are YYYY-MM-DD strings.
export default function HeatmapSection({ brandKey, pageStart, pageEnd }) {
  const pageRange = useMemo(() => ({ start: pageStart, end: pageEnd }), [pageStart, pageEnd]);
  const [range, setRange] = useState(pageRange);
  const [device, setDevice] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedPath, setSelectedPath] = useState(null);

  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error | unavailable
  const [reloadKey, setReloadKey] = useState(0);

  // A different brand or page range starts over from the page's dates.
  useEffect(() => {
    setRange(pageRange);
    setSelectedPath(null);
    setSearch("");
    setDebouncedSearch("");
    setData(null);
  }, [brandKey, pageRange]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const rangeError = validateRange(range.start, range.end);

  useEffect(() => {
    if (!brandKey || rangeError) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    getHeatmapPages(
      { brand_key: brandKey, start: range.start, end: range.end, device, search: debouncedSearch },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        // 404: a backend without this endpoint yet
        setStatus(res.status === 404 ? "unavailable" : "error");
        return;
      }
      setData(res.data);
      setStatus(res.data?.meta?.available === false ? "unavailable" : "ready");
    });
    return () => controller.abort();
  }, [brandKey, range.start, range.end, device, debouncedSearch, rangeError, reloadKey]);

  const actions = (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
      <FunnelDateRangePicker
        startDate={range.start}
        endDate={range.end}
        onApply={(nextStart, nextEnd) =>
          setRange({ start: nextStart.format("YYYY-MM-DD"), end: nextEnd.format("YYYY-MM-DD") })
        }
      />
      <Select
        size="small"
        value={device}
        onChange={(event) => setDevice(event.target.value)}
        inputProps={{ "aria-label": "Device" }}
        sx={{ minWidth: 140, fontSize: 13, "& .MuiSelect-select": { py: 0.5 } }}
      >
        {HEATMAP_DEVICE_OPTIONS.map((option) => (
          <MenuItem key={option.value} value={option.value} dense>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </Box>
  );

  let body;
  if (rangeError) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        {rangeError}
      </Typography>
    );
  } else if (selectedPath) {
    body = (
      <PageClicksView
        brandKey={brandKey}
        path={selectedPath}
        start={range.start}
        end={range.end}
        device={device}
        onBack={() => setSelectedPath(null)}
      />
    );
  } else if (!data && status === "loading") {
    body = <Skeleton variant="rounded" height={280} />;
  } else if (status === "error" && !data) {
    body = (
      <Box sx={{ py: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t load the pages. Please try again.
        </Typography>
        <Button size="small" variant="outlined" onClick={() => setReloadKey((n) => n + 1)}>
          Retry
        </Button>
      </Box>
    );
  } else if (status === "unavailable") {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        The popular pages list isn&apos;t available for this brand yet. Its daily page-views rollup hasn&apos;t been
        set up.
      </Typography>
    );
  } else if (data) {
    body = (
      <Box sx={{ opacity: status === "loading" ? 0.6 : 1, transition: "opacity 0.2s ease" }}>
        <PopularPagesTable
          pages={data.pages || []}
          totalViews={data.totalViews}
          totalPages={data.totalPages}
          latestDate={data.meta?.latestDate}
          search={search}
          onSearchChange={setSearch}
          onSelect={setSelectedPath}
        />
      </Box>
    );
  }

  return (
    <SectionCard
      title="Heatmaps"
      subtitle="Popular pages and where visitors click"
      info={INFO}
      action={actions}
    >
      {body}
    </SectionCard>
  );
}
