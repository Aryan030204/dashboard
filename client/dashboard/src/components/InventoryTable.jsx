import { useEffect, useMemo, useState, useCallback, useRef, memo } from "react";
import dayjs from "dayjs";
import {
  Alert,
  Box,
  Chip,
  InputAdornment,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
  Button,
  Tooltip,
  useMediaQuery,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import SearchIcon from "@mui/icons-material/Search";
import { getProductConversion } from "../lib/api.js";

const INVENTORY_PERIOD = "7d";
const INVENTORY_INFO_TOOLTIP =
  "DRR & DOH are based on the last 7 days of net units sold and current available inventory. These are estimated values based on recent sales trends and may vary slightly from the exact inventory position.";

function PaginationActions({ count, page, rowsPerPage, onPageChange, disabled }) {
  const handleBack = (event) => onPageChange(event, page - 1);
  const handleNext = (event) => onPageChange(event, page + 1);
  const lastPage = Math.max(0, Math.ceil(count / rowsPerPage) - 1);

  return (
    <Box
      sx={{
        flexShrink: 0,
        ml: { xs: 0.5, sm: 1.5, md: 2.5 },
        display: "flex",
        alignItems: "center",
      }}
    >
      <Button onClick={handleBack} disabled={disabled || page <= 0} sx={{ minWidth: 0, px: 1 }}>
        <KeyboardArrowLeft />
      </Button>
      <Button onClick={handleNext} disabled={disabled || page >= lastPage} sx={{ minWidth: 0, px: 1 }}>
        <KeyboardArrowRight />
      </Button>
    </Box>
  );
}

function formatProductName(path) {
  const raw = String(path || "").trim();
  if (!raw) return "-";
  const segment = raw.split("/").filter(Boolean).pop() || raw;
  return segment.replace(/-/g, " ");
}

function formatRounded(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return Math.round(num).toLocaleString();
}

function formatDoh(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return num.toFixed(2);
}

function formatCurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return `₹${Math.round(num).toLocaleString("en-IN")}`;
}

function formatSku(value) {
  const raw = String(value || "").trim();
  return raw || "-";
}

function parseInventoryUpdatedAt(value) {
  if (!value) return null;
  const parsed = dayjs(String(value).replace(" ", "T"));
  return parsed.isValid() ? parsed : null;
}

function formatInventoryUpdatedAgo(value, nowValue = Date.now()) {
  const parsed = parseInventoryUpdatedAt(value);
  if (!parsed) return null;

  const now = dayjs(nowValue);
  const minutes = Math.max(0, now.diff(parsed, "minute"));

  if (minutes < 1) return "inventory updated just now";
  if (minutes < 60) return `inventory updated ${minutes} min${minutes === 1 ? "" : "s"} ago`;

  const hours = now.diff(parsed, "hour");
  if (hours < 24) return `inventory updated ${hours} hr${hours === 1 ? "" : "s"} ago`;

  const days = now.diff(parsed, "day");
  return `inventory updated ${days} day${days === 1 ? "" : "s"} ago`;
}

function InventoryTable({ brandKey, startDate, endDate, selectedProductId = null, onSelectProduct = null }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const [rows, setRows] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sortBy, setSortBy] = useState("sales");
  const [sortDir, setSortDir] = useState("desc");
  const [activeColumn, setActiveColumn] = useState("sales");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [updatedChipNow, setUpdatedChipNow] = useState(() => Date.now());
  const [columnWidths, setColumnWidths] = useState({
    product: 320,
    sku: 180,
    sales: 160,
    drr: 140,
    doh: 140,
  });

  const resizingColumn = useRef(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const start = useMemo(() => {
    if (startDate) return dayjs(startDate).format("YYYY-MM-DD");
    return dayjs().startOf("day").format("YYYY-MM-DD");
  }, [startDate]);

  const end = useMemo(() => {
    if (endDate) return dayjs(endDate).format("YYYY-MM-DD");
    return dayjs().startOf("day").format("YYYY-MM-DD");
  }, [endDate]);

  const loadData = useCallback(async () => {
    if (!brandKey) return;
    setStatus("loading");
    setError(null);

    const resp = await getProductConversion({
      brand_key: brandKey,
      start,
      end,
      page,
      pageSize,
      sortBy,
      sortDir,
      inventoryPeriod: INVENTORY_PERIOD,
      inventoryOnly: true,
      search,
    });

    if (resp.error) {
      setStatus("failed");
      setError("Failed to load inventory data");
      return;
    }

    setRows(Array.isArray(resp.rows) ? resp.rows : []);
    setTotalCount(Number(resp.total_count || 0));
    setStatus("succeeded");
  }, [brandKey, start, end, page, pageSize, sortBy, sortDir, search]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setUpdatedChipNow(Date.now());
    }, 60 * 1000);

    return () => window.clearInterval(intervalId);
  }, []);

  const columns = useMemo(
    () => [
      { id: "product", label: "Product", align: "left" },
      { id: "sku", label: "SKU", align: "left" },
      { id: "sales", label: "Total Sales", align: "right" },
      { id: "drr", label: `DRR (${INVENTORY_PERIOD})`, align: "right", sortable: false },
      { id: "doh", label: `DOH (${INVENTORY_PERIOD})`, align: "right", sortable: false },
    ],
    [],
  );

  const handleSort = useCallback(
    (columnId) => {
      const map = {
        product: "landing_page_path",
        sku: "sku",
        sales: "sales",
      };
      const nextSortBy = map[columnId] || "landing_page_path";
      const isAsc = activeColumn === columnId && sortDir === "asc";
      const nextDir = isAsc ? "desc" : "asc";
      setActiveColumn(columnId);
      setSortBy(nextSortBy);
      setSortDir(nextDir);
      setPage(1);
    },
    [activeColumn, sortDir],
  );

  const handleChangePage = (_e, newPage) => {
    setPage(newPage + 1);
  };

  const handleChangeRowsPerPage = (e) => {
    setPageSize(parseInt(e.target.value, 10));
    setPage(1);
  };

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setPage(1);
  };

  const handleMouseMove = useCallback((e) => {
    if (!resizingColumn.current) return;
    const diff = e.pageX - startX.current;
    const newWidth = Math.max(80, startWidth.current + diff);
    setColumnWidths((prev) => ({
      ...prev,
      [resizingColumn.current]: newWidth,
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    resizingColumn.current = null;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  const handleMouseDown = useCallback(
    (e, colId) => {
      e.preventDefault();
      e.stopPropagation();
      resizingColumn.current = colId;
      startX.current = e.pageX;
      startWidth.current = columnWidths[colId] || 120;
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [columnWidths, handleMouseMove, handleMouseUp],
  );

  useEffect(() => {
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  useEffect(() => {
    if (isMobile) {
      setColumnWidths({ product: 240, sku: 150, sales: 140, drr: 130, doh: 130 });
    } else {
      setColumnWidths({ product: 320, sku: 180, sales: 160, drr: 140, doh: 140 });
    }
  }, [isMobile]);

  const tableMinWidth = useMemo(() => {
    const product = Number(columnWidths.product || 0);
    const sku = Number(columnWidths.sku || 0);
    const sales = Number(columnWidths.sales || 0);
    const drr = Number(columnWidths.drr || 0);
    const doh = Number(columnWidths.doh || 0);
    return product + sku + sales + drr + doh;
  }, [columnWidths]);

  const inventoryUpdatedText = useMemo(() => {
    // Prefer calculation_date (the whole cache snapshot's timestamp) over the
    // per-product updated_at, which reflects when that individual product was
    // last recalculated within the cache and can lag behind the cache refresh.
    const latestUpdatedAt = rows
      .map((row) => row?.calculation_date || row?.updated_at)
      .filter(Boolean)
      .sort((left, right) => String(right).localeCompare(String(left)))[0];

    return formatInventoryUpdatedAgo(latestUpdatedAt, updatedChipNow);
  }, [rows, updatedChipNow]);

  return (
    <Stack spacing={2}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
              color: theme.palette.mode === "dark" ? "text.primary" : "text.secondary",
            }}
          >
            Inventory Info
          </Typography>
          <Tooltip title={INVENTORY_INFO_TOOLTIP} arrow>
            <Box
              component="span"
              sx={{
                display: "inline-flex",
                alignItems: "center",
                color: "rgba(255,255,255,0.58)",
                cursor: "default",
                mt: "1px",
              }}
            >
              <InfoOutlinedIcon sx={{ fontSize: 16 }} />
            </Box>
          </Tooltip>
          {inventoryUpdatedText ? (
            <Chip
              label={inventoryUpdatedText}
              size="small"
              sx={{
                height: 26,
                color: "rgba(255,255,255,0.82)",
                bgcolor: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                "& .MuiChip-label": {
                  px: 1.1,
                  fontSize: 12,
                  fontWeight: 500,
                },
              }}
            />
          ) : null}
        </Stack>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            flexWrap: { xs: "nowrap", sm: "wrap" },
            width: { xs: "100%", sm: "auto" },
          }}
        >
          <TextField
            size="small"
            placeholder="Search products or SKU..."
            value={search}
            onChange={handleSearchChange}
            sx={{
              minWidth: { xs: 0, sm: 260 },
              width: { xs: "100%", sm: "auto" },
              flex: { xs: "1 1 auto", sm: "0 0 auto" },
            }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
            }}
          />
        </Box>
      </Box>

      <Card variant="outlined" sx={{ height: "100%", overflow: "hidden" }}>
        <CardContent sx={{ p: 0, height: "100%", display: "flex", flexDirection: "column" }}>
          <TableContainer sx={{ flex: 1, overflow: "auto", position: "relative" }}>
            <Table
              size="small"
              sx={{
                tableLayout: "fixed",
                minWidth: `${tableMinWidth}px`,
                width: "100%",
              }}
            >
              <TableHead>
                <TableRow sx={{ bgcolor: "rgba(255,255,255,0.08)" }}>
                  {columns.map((col) => (
                    <TableCell
                      key={col.id}
                      align={col.align}
                      sx={{
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        position: "relative",
                        width: columnWidths[col.id] || "auto",
                        minWidth: columnWidths[col.id] || "auto",
                        maxWidth: columnWidths[col.id] || "auto",
                        "&:hover .resize-handle": {
                          opacity: 1,
                        },
                      }}
                    >
                      {col.sortable === false ? (
                        col.label
                      ) : (
                        <TableSortLabel
                          active={activeColumn === col.id}
                          direction={activeColumn === col.id ? sortDir : "asc"}
                          onClick={() => handleSort(col.id)}
                        >
                          {col.label}
                        </TableSortLabel>
                      )}
                      <Box
                        className="resize-handle"
                        onMouseDown={(e) => handleMouseDown(e, col.id)}
                        sx={{
                          position: "absolute",
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: "1px",
                          cursor: "col-resize",
                          bgcolor: "#10b981",
                          opacity: 0,
                          transition: "opacity 0.2s",
                          zIndex: 1,
                        }}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>

              <TableBody>
                {status !== "loading" && rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} align="center" sx={{ py: 3, color: "text.secondary" }}>
                      No data for the selected range.
                    </TableCell>
                  </TableRow>
                )}

                {rows.map((row, idx) => {
                  const selectable = typeof onSelectProduct === "function" && !!row.product_id;
                  const selected = selectable && String(row.product_id) === String(selectedProductId);
                  return (
                  <TableRow
                    key={`${row.landing_page_path || "path"}-${idx}`}
                    hover={selectable}
                    selected={selected}
                    onClick={selectable ? () => onSelectProduct(selected ? null : row) : undefined}
                    sx={selectable ? { cursor: "pointer" } : undefined}
                  >
                    <TableCell
                      align="left"
                      sx={{
                        verticalAlign: "middle",
                        width: columnWidths.product || "auto",
                        minWidth: columnWidths.product || "auto",
                        maxWidth: columnWidths.product || "auto",
                        overflow: "hidden",
                      }}
                    >
                      <Tooltip title={row.landing_page_path || ""} arrow>
                        <span
                          style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            display: "block",
                            width: "100%",
                          }}
                        >
                          {formatProductName(row.landing_page_path)}
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell
                      align="left"
                      sx={{
                        verticalAlign: "middle",
                        width: columnWidths.sku || "auto",
                        minWidth: columnWidths.sku || "auto",
                        maxWidth: columnWidths.sku || "auto",
                        overflow: "hidden",
                      }}
                    >
                      <Tooltip title={row.sku || ""} arrow>
                        <span
                          style={{
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            display: "block",
                            width: "100%",
                          }}
                        >
                          {formatSku(row.sku)}
                        </span>
                      </Tooltip>
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        width: columnWidths.sales || "auto",
                        minWidth: columnWidths.sales || "auto",
                        maxWidth: columnWidths.sales || "auto",
                        overflow: "hidden",
                      }}
                    >
                      {formatCurrency(row.sales)}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        width: columnWidths.drr || "auto",
                        minWidth: columnWidths.drr || "auto",
                        maxWidth: columnWidths.drr || "auto",
                        overflow: "hidden",
                      }}
                    >
                      {formatRounded(row.drr)}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{
                        width: columnWidths.doh || "auto",
                        minWidth: columnWidths.doh || "auto",
                        maxWidth: columnWidths.doh || "auto",
                        overflow: "hidden",
                      }}
                    >
                      {formatDoh(row.doh)}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>

            {error && (
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: "rgba(0,0,0,0.16)",
                  px: 2,
                }}
              >
                <Alert severity="error">{error}</Alert>
              </Box>
            )}

            {status === "loading" && (
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: "rgba(0,0,0,0.12)",
                  pointerEvents: "none",
                }}
              >
                <CircularProgress size={24} />
              </Box>
            )}
          </TableContainer>

          <Divider />
          <Box sx={{ display: "flex", justifyContent: "center", width: "100%", overflowX: "auto" }}>
            <TablePagination
              component="div"
              count={totalCount}
              page={Math.max(0, page - 1)}
              onPageChange={handleChangePage}
              rowsPerPage={pageSize}
              onRowsPerPageChange={handleChangeRowsPerPage}
              rowsPerPageOptions={[10, 25, 50]}
              ActionsComponent={(props) => (
                <PaginationActions {...props} disabled={status === "loading"} />
              )}
              SelectProps={{ disabled: status === "loading" }}
              sx={{
                width: "100%",
                minWidth: 0,
                ".MuiTablePagination-toolbar": {
                  px: { xs: 1, sm: 2 },
                  minHeight: { xs: 48, sm: 52 },
                  flexWrap: { xs: "wrap", sm: "nowrap" },
                  justifyContent: "center",
                  gap: { xs: 0.5, sm: 1 },
                },
                ".MuiTablePagination-spacer": {
                  display: { xs: "none", sm: "block" },
                },
                ".MuiTablePagination-selectLabel, .MuiTablePagination-displayedRows": {
                  m: 0,
                  fontSize: { xs: "0.9rem", sm: "0.95rem" },
                },
              }}
            />
          </Box>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default memo(InventoryTable);
