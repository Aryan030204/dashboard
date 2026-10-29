import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Typography,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import { getIntentReport } from "../../lib/api.js";
import { FunnelDateRangePicker } from "../DailyFunnelPanel.jsx";
import { SectionCard } from "./shared.jsx";
import {
  REPORT_COLUMNS,
  buildReportCsv,
  buildReportFilename,
  cellDisplay,
  sortDaysDescending,
  validateRange,
} from "./intentReportUtils.js";

const INFO =
  "Daily figures from the cards at the top of this page, as sessions. Total Sessions are sessions started (from the daily rollup). Unique Visitors, High, Medium and Low Intent Users are the sessions counted by those cards, with intent following the Behaviour / Score switch above.";

const ROWS_PER_PAGE_OPTIONS = [5, 10, 25, 50];

// A leading byte-order mark makes Excel read the file as UTF-8.
const CSV_BOM = String.fromCharCode(0xfeff);

function downloadCsv(filename, text) {
  const url = URL.createObjectURL(new Blob([CSV_BOM + text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// Has its own date range (it starts at the page's range) and fetches on its own, so changing the dates
// refetches only this table. `pageStart` / `pageEnd` are YYYY-MM-DD strings; `basis` follows the page's
// Behaviour / Score switch.
export default function IntentReport({ brandKey, pageStart, pageEnd, basis = "behavior" }) {
  const pageRange = useMemo(() => ({ start: pageStart, end: pageEnd }), [pageStart, pageEnd]);
  const [range, setRange] = useState(pageRange);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error | unavailable
  const [reloadKey, setReloadKey] = useState(0);

  // A different brand or page range starts the report over from the page's dates.
  useEffect(() => {
    setRange(pageRange);
    setData(null);
    setPage(0);
  }, [brandKey, pageRange]);

  const rangeError = validateRange(range.start, range.end);

  useEffect(() => {
    if (!brandKey || rangeError) return undefined;
    const controller = new AbortController();
    setStatus("loading");
    getIntentReport(
      { brand_key: brandKey, start: range.start, end: range.end, basis },
      { signal: controller.signal },
    ).then((res) => {
      if (res.aborted) return;
      if (res.error) {
        // 404: a backend without this endpoint yet
        setStatus(res.status === 404 ? "unavailable" : "error");
        return;
      }
      setData(res.data);
      setPage(0);
      setStatus("ready");
    });
    return () => controller.abort();
  }, [brandKey, range.start, range.end, basis, rangeError, reloadKey]);

  const days = useMemo(() => sortDaysDescending(data?.days), [data]);
  const pagedDays = days.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  const unavailable =
    status === "unavailable" || (status === "ready" && data?.meta?.available === false);
  const hasRows = days.length > 0;
  const hasData = days.some(
    (day) => day.kpis?.visitors?.sessions > 0 || day.sessionsStarted > 0,
  );

  const exportCsv = () => {
    downloadCsv(buildReportFilename(brandKey, range.start, range.end), buildReportCsv(days));
  };

  const actions = (
    <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5 }}>
      <FunnelDateRangePicker
        startDate={range.start}
        endDate={range.end}
        onApply={(nextStart, nextEnd) =>
          setRange({ start: nextStart.format("YYYY-MM-DD"), end: nextEnd.format("YYYY-MM-DD") })
        }
      />
      <Button
        size="small"
        variant="outlined"
        startIcon={<DownloadIcon />}
        onClick={exportCsv}
        disabled={!hasRows || !hasData || unavailable || Boolean(rangeError)}
        sx={{ minWidth: "fit-content" }}
      >
        Export CSV
      </Button>
    </Box>
  );

  let body;
  if (rangeError) {
    body = <Alert severity="warning">{rangeError}</Alert>;
  } else if (!data && status === "loading") {
    body = <Skeleton variant="rounded" height={260} />;
  } else if (status === "error" && !data) {
    body = (
      <Box sx={{ py: 4, display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          Couldn&apos;t load the report. Please try again.
        </Typography>
        <Button size="small" variant="outlined" onClick={() => setReloadKey((n) => n + 1)}>
          Retry
        </Button>
      </Box>
    );
  } else if (unavailable) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        The intent report isn&apos;t available for this brand yet.
      </Typography>
    );
  } else if (data && !hasData) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No intent data for the selected dates.
      </Typography>
    );
  } else if (data) {
    body = (
      <Box sx={{ opacity: status === "loading" ? 0.6 : 1, transition: "opacity 0.2s ease" }}>
        <TableContainer>
          <Table
            size="small"
            aria-label="Intent report"
            sx={{
              minWidth: 640,
              "& th, & td": { px: 1.25, py: 1 },
              "& th": { fontSize: "0.75rem" },
              "& td": { fontSize: "0.8125rem" },
            }}
          >
            <TableHead>
              <TableRow>
                {REPORT_COLUMNS.map((column) => (
                  <TableCell key={column.id} align={column.align} sx={{ whiteSpace: "nowrap" }}>
                    {column.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {pagedDays.map((day) => (
                <TableRow key={day.date} hover>
                  {REPORT_COLUMNS.map((column) =>
                    column.id === "date" ? (
                      <TableCell
                        key={column.id}
                        sx={{ fontWeight: 700, color: "primary.main", whiteSpace: "nowrap" }}
                      >
                        {cellDisplay(day, column.id).text}
                      </TableCell>
                    ) : (
                      <TableCell key={column.id} align={column.align}>
                        {cellDisplay(day, column.id).text}
                      </TableCell>
                    ),
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={days.length}
          page={page}
          onPageChange={(_event, next) => setPage(next)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value));
            setPage(0);
          }}
          rowsPerPageOptions={ROWS_PER_PAGE_OPTIONS}
        />
      </Box>
    );
  }

  return (
    <SectionCard
      title="Intent Report"
      subtitle="Daily intent metrics for the selected brand."
      info={INFO}
      action={actions}
    >
      {body}
    </SectionCard>
  );
}
