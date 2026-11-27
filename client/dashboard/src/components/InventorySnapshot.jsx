import { memo, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import {
  Box,
  Button,
  Card,
  CircularProgress,
  InputAdornment,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import SearchIcon from "@mui/icons-material/Search";
import { getInventorySnapshot } from "../lib/api.js";
import { monthLabel, monthOptions } from "../lib/monthRange.js";
import {
  buildSnapshotCsv,
  dayParts,
  defaultSnapshotMonths,
  drrHeaders,
  filterAndSort,
  formatDrr,
  formatUnits,
  pickMonth,
} from "../lib/inventorySnapshot.js";

const NUMBER_WIDTH = 56;
const DRR_WIDTH = 92;
const DAY_WIDTH = 72;

function MonthSelect({ label, value, other, options, onChange }) {
  return (
    <Select
      size="small"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      inputProps={{ "aria-label": label }}
      MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
      sx={{ height: 32, fontSize: 13, fontWeight: 500, flex: { xs: "1 1 0", sm: "0 0 auto" } }}
    >
      {options.map((month) => (
        <MenuItem key={month} value={month} disabled={month === other} sx={{ fontSize: 13 }}>
          {monthLabel(month)}
        </MenuItem>
      ))}
    </Select>
  );
}

function InventorySnapshot({ brandKey }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const today = dayjs().format("YYYY-MM-DD");
  const [months, setMonths] = useState(() => defaultSnapshotMonths(today));
  const [state, setState] = useState({ status: "loading", data: null });
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ by: "drr1", dir: "desc" });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const scrollRef = useRef(null);
  const monthsKey = months.join(",");

  useEffect(() => {
    if (!brandKey) return undefined;
    const controller = new AbortController();
    setState((previous) => ({ status: "loading", data: previous.data }));
    getInventorySnapshot({ brand_key: brandKey, months: monthsKey.split(",") }, { signal: controller.signal }).then(
      (resp) => {
        if (resp.aborted) return;
        if (resp.error) setState({ status: "failed", data: null });
        else setState({ status: "succeeded", data: resp });
        setPage(0);
      },
    );
    return () => controller.abort();
  }, [brandKey, monthsKey, attempt]);

  const data = state.data?.available ? state.data : null;
  const loading = state.status === "loading";

  // Newly loaded data opens at the latest day.
  useEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollLeft = container.scrollWidth;
  }, [data]);

  const rows = useMemo(() => (data ? filterAndSort(data.rows, search, sort) : []), [data, search, sort]);
  const pageRows = rows.slice(page * pageSize, page * pageSize + pageSize);
  const headers = useMemo(() => (data ? drrHeaders(data.months) : []), [data]);

  // A brand whose database has no daily inventory summary has nothing to show: no empty card.
  if (state.data?.available === false) return null;

  const skuWidth = isMobile ? 156 : 260;
  const tableMinWidth = data ? NUMBER_WIDTH + skuWidth + DRR_WIDTH * 2 + DAY_WIDTH * data.days.length : 0;
  const tint = alpha(theme.palette.primary.main, 0.08);

  // Fixed columns need a solid background, so the accent tint is layered on top of it. On phones only the SKU stays.
  const fixed = (left, width, { head = false, tinted = false, pinned = true } = {}) => ({
    width,
    minWidth: width,
    maxWidth: width,
    ...(pinned ? { position: "sticky", left, zIndex: head ? 4 : 2 } : {}),
    ...(head ? {} : { bgcolor: "background.paper" }),
    ...(tinted ? { backgroundImage: `linear-gradient(${tint}, ${tint})` } : {}),
  });
  const numberCell = (head) => fixed(0, NUMBER_WIDTH, { head, pinned: !isMobile });
  const skuCell = (head) => ({
    ...fixed(isMobile ? 0 : NUMBER_WIDTH, skuWidth, { head }),
    borderRight: isMobile ? `1px solid ${theme.palette.divider}` : undefined,
  });
  const drrCell = (index, head) => ({
    ...fixed(NUMBER_WIDTH + skuWidth + DRR_WIDTH * index, DRR_WIDTH, { head, tinted: true, pinned: !isMobile }),
    ...(index === 1 ? { borderRight: `1px solid ${theme.palette.divider}` } : {}),
  });

  const sortHeader = (by, label, firstDir) => (
    <TableSortLabel
      active={sort.by === by}
      direction={sort.by === by ? sort.dir : firstDir}
      onClick={() => {
        setSort({ by, dir: sort.by === by ? (sort.dir === "asc" ? "desc" : "asc") : firstDir });
        setPage(0);
      }}
    >
      {label}
    </TableSortLabel>
  );

  const handleExport = () => {
    const url = URL.createObjectURL(new Blob([buildSnapshotCsv(data, rows)], { type: "text/csv;charset=utf-8;" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `inventory-snapshot-${brandKey}-${data.months.map((m) => m.month).join("_")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const caption = data
    ? `Units sold per day in ${monthLabel(data.detail_month)} · DRR = average units a day · up to yesterday`
    : "Units sold per day and daily run rate by SKU";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1.5, alignItems: "center", justifyContent: "space-between" }}>
        <Box sx={{ flex: "1 1 240px", minWidth: 0 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, fontSize: "14.5px", letterSpacing: "-0.01em" }}>
            Inventory Snapshot
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            {caption}
          </Typography>
        </Box>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, alignItems: "center", width: { xs: "100%", md: "auto" } }}>
          <Box sx={{ display: "flex", gap: 1, width: { xs: "100%", sm: "auto" } }}>
            {[0, 1].map((index) => (
              <MonthSelect
                key={index}
                label={index === 0 ? "First month" : "Second month"}
                value={months[index]}
                other={months[1 - index]}
                options={monthOptions(today)}
                onChange={(value) => setMonths(pickMonth(months, index, value))}
              />
            ))}
          </Box>
          <TextField
            size="small"
            placeholder="Search SKU or product..."
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
            sx={{ flex: { xs: "1 1 0", sm: "0 0 220px" }, minWidth: 0 }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
            }}
          />
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadOutlinedIcon />}
            onClick={handleExport}
            disabled={loading || rows.length === 0}
            sx={{ height: 32, whiteSpace: "nowrap" }}
          >
            Export CSV
          </Button>
        </Box>
      </Box>

      <Card variant="outlined" sx={{ overflow: "hidden", position: "relative" }}>
        {state.status === "failed" ? (
          <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 1.5, py: 4 }}>
            <Typography variant="body2" color="error">
              Failed to load the inventory snapshot.
            </Typography>
            <Button size="small" variant="outlined" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </Button>
          </Box>
        ) : !data ? (
          <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            <TableContainer ref={scrollRef} sx={{ maxHeight: { xs: 440, md: 560 }, opacity: loading ? 0.5 : 1 }}>
              <Table
                size="small"
                stickyHeader
                aria-label="Inventory snapshot"
                sx={{ tableLayout: "fixed", borderCollapse: "separate", minWidth: tableMinWidth, width: "100%" }}
              >
                <TableHead>
                  <TableRow>
                    <TableCell sx={numberCell(true)}>Sr No</TableCell>
                    <TableCell sx={skuCell(true)}>{sortHeader("sku", "SKU", "asc")}</TableCell>
                    {headers.map((label, index) => (
                      <TableCell key={label} align="right" sx={drrCell(index, true)}>
                        {sortHeader(`drr${index}`, label, "desc")}
                      </TableCell>
                    ))}
                    {data.days.map((date) => {
                      const { weekday, label } = dayParts(date);
                      return (
                        <TableCell key={date} align="right" sx={{ width: DAY_WIDTH, px: 1.25 }}>
                          <Box component="span" sx={{ display: "block", fontWeight: 400 }}>
                            {weekday}
                          </Box>
                          <Box component="span" sx={{ display: "block", color: "text.primary" }}>
                            {label}
                          </Box>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pageRows.map((row, index) => (
                    <TableRow key={row.key}>
                      <TableCell sx={{ ...numberCell(false), color: "text.secondary" }}>
                        {page * pageSize + index + 1}
                      </TableCell>
                      <TableCell sx={skuCell(false)}>
                        <Tooltip title={row.title ? `${row.sku} · ${row.title}` : row.sku} arrow placement="top-start">
                          <Box
                            component="span"
                            sx={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                          >
                            {row.sku}
                          </Box>
                        </Tooltip>
                      </TableCell>
                      {row.drr.map((value, i) => (
                        <TableCell key={data.months[i].month} align="right" sx={{ ...drrCell(i, false), fontWeight: 600 }}>
                          {formatDrr(value)}
                        </TableCell>
                      ))}
                      {row.units.map((value, i) => (
                        <TableCell key={data.days[i]} align="right" sx={{ px: 1.25 }}>
                          {formatUnits(value)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {rows.length === 0 ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ position: "sticky", left: 0, textAlign: "center", py: 3, px: 2 }}
                >
                  {search ? "No SKU matches the search." : "No inventory data for these months."}
                </Typography>
              ) : null}
            </TableContainer>
            <TablePagination
              component="div"
              count={rows.length}
              page={page}
              onPageChange={(_event, next) => setPage(next)}
              rowsPerPage={pageSize}
              onRowsPerPageChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(0);
              }}
              rowsPerPageOptions={[10, 25, 50]}
              labelRowsPerPage={isMobile ? "Rows" : "Rows per page:"}
            />
          </>
        )}
        {loading && data ? (
          <Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <CircularProgress size={24} />
          </Box>
        ) : null}
      </Card>
    </Box>
  );
}

export default memo(InventorySnapshot);
