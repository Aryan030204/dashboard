import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Card,
  Checkbox,
  FormControlLabel,
  IconButton,
  Popover,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import DownloadIcon from "@mui/icons-material/Download";
import ViewColumnIcon from "@mui/icons-material/ViewColumn";
import { METRIC_DEFS, getStatusMeta, normalizeWebVitalsUrl } from "../webVitalsFormat.js";

const ALL_COLUMNS = [
  { id: "page_name", label: "Page Name" },
  { id: "url", label: "URL" },
  { id: "performance", label: "Performance" },
  { id: "fcp", label: "FCP (s)" },
  { id: "lcp", label: "LCP (s)" },
  { id: "ttfb", label: "TTFB (s)" },
  { id: "inp", label: "INP (ms)" },
  { id: "cls", label: "CLS" },
];

const MOBILE_DEFAULT_COLUMNS = ["page_name", "performance", "lcp", "ttfb"];
const DESKTOP_DEFAULT_COLUMNS = ALL_COLUMNS.map((column) => column.id);

function escapeCsvValue(value) {
  const normalized = value == null ? "" : String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function formatCellValue(columnId, row) {
  if (columnId === "page_name") return row.page_name || "—";
  if (columnId === "url") return normalizeWebVitalsUrl(row.url) || "—";
  const def = METRIC_DEFS[columnId];
  return def ? def.format(row[columnId]) : row[columnId] ?? "—";
}

export default function WebVitalsPageTable({ rows, loading, brandKey, date, selectedPageUrl = null, onSelectPage = null }) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));

  const [visibleColumnIds, setVisibleColumnIds] = useState(
    isMobile ? MOBILE_DEFAULT_COLUMNS : DESKTOP_DEFAULT_COLUMNS,
  );
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [columnsAnchorEl, setColumnsAnchorEl] = useState(null);

  const visibleColumns = useMemo(
    () => ALL_COLUMNS.filter((column) => visibleColumnIds.includes(column.id)),
    [visibleColumnIds],
  );

  const pagedRows = useMemo(
    () => rows.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [rows, page, rowsPerPage],
  );

  const toggleColumn = (columnId) => {
    setVisibleColumnIds((current) =>
      current.includes(columnId)
        ? current.filter((id) => id !== columnId)
        : [...current, columnId],
    );
  };

  const handleExport = () => {
    if (!rows.length) return;
    const headers = visibleColumns.map((column) => column.label);
    const lines = [
      headers.join(","),
      ...rows.map((row) =>
        visibleColumns
          .map((column) => formatCellValue(column.id, row))
          .map(escapeCsvValue)
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `web-vitals-pages-${(brandKey || "brand").toLowerCase()}-${date || ""}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "center" }}
        justifyContent="space-between"
        spacing={1.5}
        sx={{ mb: 2 }}
      >
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Page Level Breakdown
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<DownloadIcon />}
            onClick={handleExport}
            disabled={!rows.length}
          >
            Export Excel
          </Button>
          <Tooltip title="Columns">
            <IconButton
              size="small"
              onClick={(event) => setColumnsAnchorEl(event.currentTarget)}
              sx={{ border: "1px solid", borderColor: "divider" }}
            >
              <ViewColumnIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Popover
            open={Boolean(columnsAnchorEl)}
            anchorEl={columnsAnchorEl}
            onClose={() => setColumnsAnchorEl(null)}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
          >
            <Box sx={{ p: 1.5, minWidth: 200 }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                Visible columns
              </Typography>
              <Stack sx={{ mt: 0.5 }}>
                {ALL_COLUMNS.map((column) => (
                  <FormControlLabel
                    key={column.id}
                    control={
                      <Checkbox
                        size="small"
                        checked={visibleColumnIds.includes(column.id)}
                        onChange={() => toggleColumn(column.id)}
                      />
                    }
                    label={<Typography variant="body2">{column.label}</Typography>}
                  />
                ))}
              </Stack>
            </Box>
          </Popover>
        </Stack>
      </Stack>

      {loading ? (
        <Skeleton variant="rounded" width="100%" height={280} />
      ) : (
        <>
          <TableContainer sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>#</TableCell>
                  {visibleColumns.map((column) => (
                    <TableCell key={column.id}>{column.label}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {pagedRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={visibleColumns.length + 1}>
                      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                        No page data for this date.
                      </Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedRows.map((row, index) => (
                    <TableRow
                      key={`${row.page_name}-${row.url}-${index}`}
                      hover
                      selected={Boolean(onSelectPage) && row.url === selectedPageUrl}
                      onClick={onSelectPage ? () => onSelectPage(row.url === selectedPageUrl ? null : row.url) : undefined}
                      sx={onSelectPage ? { cursor: "pointer" } : undefined}
                    >
                      <TableCell>{page * rowsPerPage + index + 1}</TableCell>
                      {visibleColumns.map((column) => {
                        const isPerformance = column.id === "performance";
                        const statusMeta = isPerformance
                          ? getStatusMeta(row.performance_status, "performance")
                          : null;
                        const cellValue = formatCellValue(column.id, row);
                        return (
                          <TableCell
                            key={column.id}
                            sx={{
                              whiteSpace: column.id === "url" ? "nowrap" : undefined,
                              maxWidth: column.id === "url" ? 220 : undefined,
                              overflow: column.id === "url" ? "hidden" : undefined,
                              textOverflow: column.id === "url" ? "ellipsis" : undefined,
                              color: statusMeta ? statusMeta.color : undefined,
                              fontWeight: statusMeta ? 700 : undefined,
                            }}
                          >
                            <Tooltip title={cellValue} arrow>
                              <span
                                style={{
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  display: "block",
                                  width: "100%",
                                }}
                              >
                                {cellValue}
                              </span>
                            </Tooltip>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={rows.length}
            page={page}
            onPageChange={(_event, nextPage) => setPage(nextPage)}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={(event) => {
              setRowsPerPage(parseInt(event.target.value, 10));
              setPage(0);
            }}
            rowsPerPageOptions={[10, 25, 50]}
          />
        </>
      )}
    </Card>
  );
}
