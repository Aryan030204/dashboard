import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Stack, Typography } from "@mui/material";
import dayjs from "dayjs";
import {
  getWebVitalsAllBrandsSnapshot,
  getWebVitalsSnapshot,
  getWebVitalsTrend,
} from "../../lib/api.js";
import { fetchPagespeedResults, pagespeedBrandName } from "../../lib/pagespeed.js";
import { FunnelSingleDatePicker } from "../../components/DailyFunnelPanel.jsx";
import { buildPageRowsFromPagespeed } from "./webVitalsFormat.js";
import WebVitalsKpiRow from "./components/WebVitalsKpiRow.jsx";
import WebVitalsAllBrandsSnapshot from "./components/WebVitalsAllBrandsSnapshot.jsx";
import WebVitalsTrendChart from "./components/WebVitalsTrendChart.jsx";
import WebVitalsPageTable from "./components/WebVitalsPageTable.jsx";

function formatDate(value) {
  return dayjs(value).format("YYYY-MM-DD");
}

export default function WebVitalsPage({ brandKey, canViewAllBrandsSnapshot = false }) {
  const today = useMemo(() => formatDate(dayjs()), []);

  const [snapshotDate, setSnapshotDate] = useState(today);
  const [trendStart, setTrendStart] = useState(() => formatDate(dayjs().subtract(6, "day")));
  const [trendEnd, setTrendEnd] = useState(today);

  // Admins pick which brand's Summary/Trend/Page table show by clicking a
  // card in the Overall Snapshot grid — decoupled from the global brand
  // selector, mirroring the dashboard's KPI-card <-> trend-chart pattern.
  // Non-admins never see that grid, so this just tracks the global brandKey.
  const [selectedBrandKey, setSelectedBrandKey] = useState(brandKey);
  useEffect(() => {
    setSelectedBrandKey(brandKey);
  }, [brandKey]);

  const [snapshot, setSnapshot] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [snapshotError, setSnapshotError] = useState("");

  const [allBrandsSnapshot, setAllBrandsSnapshot] = useState([]);
  const [allBrandsLoading, setAllBrandsLoading] = useState(false);

  const [trendPoints, setTrendPoints] = useState([]);
  const [trendLoading, setTrendLoading] = useState(false);

  const [pageRows, setPageRows] = useState([]);
  const [pagesLoading, setPagesLoading] = useState(false);

  useEffect(() => {
    if (!selectedBrandKey) return;
    let cancelled = false;
    setSnapshotLoading(true);
    setSnapshotError("");
    getWebVitalsSnapshot({ brand_key: selectedBrandKey, date: snapshotDate })
      .then((result) => {
        if (cancelled) return;
        if (result?.error) {
          setSnapshot(null);
          setSnapshotError("Failed to load web vitals snapshot.");
          return;
        }
        setSnapshot(result);
      })
      .catch(() => {
        if (cancelled) return;
        setSnapshot(null);
        setSnapshotError("Failed to load web vitals snapshot.");
      })
      .finally(() => {
        if (!cancelled) setSnapshotLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBrandKey, snapshotDate]);

  useEffect(() => {
    if (!canViewAllBrandsSnapshot) {
      setAllBrandsSnapshot([]);
      return;
    }
    let cancelled = false;
    setAllBrandsLoading(true);
    getWebVitalsAllBrandsSnapshot({ date: snapshotDate })
      .then((result) => {
        if (cancelled) return;
        setAllBrandsSnapshot(result?.error ? [] : result.brands);
      })
      .catch(() => {
        if (cancelled) return;
        setAllBrandsSnapshot([]);
      })
      .finally(() => {
        if (!cancelled) setAllBrandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [snapshotDate, canViewAllBrandsSnapshot]);

  useEffect(() => {
    if (!selectedBrandKey) return;
    let cancelled = false;
    setTrendLoading(true);
    getWebVitalsTrend({
      brand_key: selectedBrandKey,
      start: trendStart,
      end: trendEnd,
    })
      .then((result) => {
        if (cancelled) return;
        setTrendPoints(result?.error ? [] : result.points);
      })
      .catch(() => {
        if (cancelled) return;
        setTrendPoints([]);
      })
      .finally(() => {
        if (!cancelled) setTrendLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBrandKey, trendStart, trendEnd]);

  useEffect(() => {
    if (!selectedBrandKey) return;
    let cancelled = false;
    setPagesLoading(true);
    // The same PageSpeed results, brand name and date the dashboard's Top 5 Pages card uses, so the table
    // lists the same pages with the same numbers.
    fetchPagespeedResults(pagespeedBrandName(selectedBrandKey), snapshotDate, snapshotDate)
      .then((results) => {
        if (cancelled) return;
        setPageRows(buildPageRowsFromPagespeed(results));
      })
      .catch(() => {
        if (cancelled) return;
        setPageRows([]);
      })
      .finally(() => {
        if (!cancelled) setPagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedBrandKey, snapshotDate]);

  const handleTrendRangeChange = useCallback((nextStart, nextEnd) => {
    setTrendStart(nextStart);
    setTrendEnd(nextEnd);
  }, []);

  return (
    <Stack spacing={2.5} sx={{ p: { xs: 1.5, md: 2 } }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "center" }}
        justifyContent="space-between"
        spacing={1.5}
      >
        <Stack spacing={0.25}>
          <Typography variant="h4" sx={{ fontWeight: 600 }} color="text.primary">
            Web Vitals
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Track real-user performance metrics for your brand
          </Typography>
        </Stack>
        <FunnelSingleDatePicker
          date={snapshotDate}
          onApply={(next) => setSnapshotDate(formatDate(next))}
        />
      </Stack>

      {snapshotError ? <Alert severity="error">{snapshotError}</Alert> : null}

      {canViewAllBrandsSnapshot ? (
        <Stack spacing={1}>
          <Typography variant="subtitle2" color="text.secondary">
            Overall Snapshot
          </Typography>
          <WebVitalsAllBrandsSnapshot
            brands={allBrandsSnapshot}
            loading={allBrandsLoading}
            selectedBrandKey={selectedBrandKey}
            onSelectBrand={setSelectedBrandKey}
          />
        </Stack>
      ) : null}

      <Stack spacing={1}>
        <Typography variant="subtitle2" color="text.secondary">
          Summary
        </Typography>
        <WebVitalsKpiRow snapshot={snapshot} loading={snapshotLoading} />
      </Stack>

      <WebVitalsTrendChart
        points={trendPoints}
        loading={trendLoading}
        rangeStart={trendStart}
        rangeEnd={trendEnd}
        onRangeChange={handleTrendRangeChange}
      />

      <WebVitalsPageTable
        rows={pageRows}
        loading={pagesLoading}
        brandKey={selectedBrandKey}
        date={snapshotDate}
      />
    </Stack>
  );
}
