import { useEffect, useState } from "react";
import dayjs from "dayjs";
import {
  Box,
  Button,
  Chip,
  InputAdornment,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import { INTENT_COLORS } from "../intentFunnelUtils.js";
import { describePage, formatCount, formatShare, pageIntentLevel, pageShare } from "./heatmapUtils.js";

const INTENT_CHIP_LABELS = { high: "High", medium: "Medium", low: "Low" };

// How the page's visitors compare with the site as a whole, in the colours of the intent cards above.
function IntentChip({ level }) {
  if (!level) {
    return (
      <Typography variant="caption" color="text.secondary">
        -
      </Typography>
    );
  }
  const color = INTENT_COLORS[level];
  return (
    <Chip
      size="small"
      label={INTENT_CHIP_LABELS[level]}
      sx={{
        height: 22,
        fontWeight: 600,
        fontSize: "0.7rem",
        color,
        bgcolor: alpha(color, 0.14),
        border: "1px solid",
        borderColor: alpha(color, 0.4),
      }}
    />
  );
}

// The popular pages list: page views per page path, most viewed first. Clicking a row (or its button)
// opens that page's clicks.
export default function PopularPagesTable({
  pages,
  totalViews,
  totalPages,
  latestDate,
  intentTotals,
  search,
  onSearchChange,
  onSelect,
}) {
  const hasSearch = Boolean(search.trim());
  // the Intent column needs the site totals to compare against; without them (rollup not refilled) it is hidden
  const showIntent = Boolean(intentTotals);
  const [pageIndex, setPageIndex] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // A new list (search, dates, device or brand) starts again from the first page.
  useEffect(() => setPageIndex(0), [pages]);

  const firstRow = pageIndex * rowsPerPage;
  const visiblePages = pages.slice(firstRow, firstRow + rowsPerPage);

  return (
    <Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1.5, mb: 1.5 }}>
        <TextField
          size="small"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search pages"
          inputProps={{ "aria-label": "Search pages", maxLength: 100 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
          sx={{ minWidth: { xs: "100%", sm: 260 } }}
        />
        <Typography variant="caption" color="text.secondary">
          {hasSearch
            ? `${formatCount(pages.length)} matching pages`
            : `${formatCount(totalPages)} pages · ${formatCount(totalViews)} page views`}
          {latestDate ? ` · page views through ${dayjs(latestDate).format("D MMM YYYY")}` : ""}
        </Typography>
      </Box>

      {pages.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
          {hasSearch ? "No pages match your search." : "No page views for the selected dates and device."}
        </Typography>
      ) : (
        <TableContainer>
          <Table
            size="small"
            aria-label="Popular pages"
            sx={{
              minWidth: 520,
              "& th, & td": { px: 1.25, py: 1 },
              "& th": { fontSize: "0.75rem" },
              "& td": { fontSize: "0.8125rem" },
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 36 }}>#</TableCell>
                <TableCell>Page</TableCell>
                {showIntent ? <TableCell align="right">Intent</TableCell> : null}
                <TableCell align="right">Page views</TableCell>
                <TableCell align="right">Share</TableCell>
                <TableCell align="right" sx={{ width: 120 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {visiblePages.map((page, index) => {
                const info = describePage(page.path);
                return (
                  <TableRow
                    key={page.path}
                    hover
                    onClick={() => onSelect(page.path)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell>{firstRow + index + 1}</TableCell>
                    <TableCell sx={{ maxWidth: 420 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap title={info.label}>
                        {info.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap component="div" title={page.path}>
                        {info.kind} · {page.path}
                      </Typography>
                    </TableCell>
                    {showIntent ? (
                      <TableCell align="right">
                        <IntentChip level={pageIntentLevel(page.intent, intentTotals)} />
                      </TableCell>
                    ) : null}
                    <TableCell align="right">{formatCount(page.views)}</TableCell>
                    <TableCell align="right">{formatShare(pageShare(page.views, totalViews))}</TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelect(page.path);
                        }}
                        aria-label={`View clicks on ${info.label}`}
                        sx={{ textTransform: "none", whiteSpace: "nowrap" }}
                      >
                        View clicks
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {pages.length > 0 ? (
        <TablePagination
          component="div"
          count={pages.length}
          page={pageIndex}
          onPageChange={(_, next) => setPageIndex(next)}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={(event) => {
            setRowsPerPage(Number(event.target.value));
            setPageIndex(0);
          }}
          rowsPerPageOptions={[5, 10, 25, 50]}
        />
      ) : null}
    </Box>
  );
}
