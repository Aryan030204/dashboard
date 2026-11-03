import { useEffect, useState } from "react";
import dayjs from "dayjs";
import {
  Box,
  Button,
  InputAdornment,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import SearchIcon from "@mui/icons-material/Search";
import { INTENT_COLORS } from "../intentFunnelUtils.js";
import { describePage, formatCount, formatShare, intentSplit, pageShare } from "./heatmapUtils.js";

const INTENT_LEVELS = ["high", "medium", "low"];
const INTENT_NAMES = { high: "High", medium: "Medium", low: "Low" };

// One pill split into three equal parts, High | Medium | Low, each showing that level's percentage of the page's
// sessions (the three always add up to 100). Drawn like the circles of the User Overlap diagram: a see-through
// fill with a border in the level's colour (the intent card colours), with white text so it reads on any of them.
function IntentBar({ split }) {
  if (!split) {
    return (
      <Typography variant="caption" color="text.secondary">
        -
      </Typography>
    );
  }
  const summary = INTENT_LEVELS.map(
    (level) => `${INTENT_NAMES[level]}: ${formatShare(split[level].pct)} (${formatCount(split[level].sessions)} sessions)`,
  ).join("\n");
  const radius = 11;
  return (
    <Tooltip title={<span style={{ whiteSpace: "pre-line" }}>{summary}</span>} arrow placement="top">
      <Box
        role="img"
        aria-label={summary.replace(/\n/g, ", ")}
        sx={{ display: "flex", width: 150, height: 22, ml: "auto" }}
      >
        {INTENT_LEVELS.map((level, index) => {
          const color = INTENT_COLORS[level];
          const first = index === 0;
          const last = index === INTENT_LEVELS.length - 1;
          return (
            <Box
              key={level}
              sx={{
                flex: "1 1 0",
                minWidth: 0,
                boxSizing: "border-box",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: alpha(color, 0.2),
                border: `1.5px solid ${color}`,
                // neighbouring parts share one border line instead of doubling it
                ml: first ? 0 : "-1.5px",
                borderRadius: `${first ? radius : 0}px ${last ? radius : 0}px ${last ? radius : 0}px ${first ? radius : 0}px`,
                color: "#fff",
                fontSize: "0.68rem",
                fontWeight: 700,
                lineHeight: 1,
              }}
            >
              {split[level].shown}%
            </Box>
          );
        })}
      </Box>
    </Tooltip>
  );
}

// The popular pages list: page views per page path, most viewed first. Clicking a row (or its button)
// opens that page's clicks.
export default function PopularPagesTable({
  pages,
  totalViews,
  totalPages,
  latestDate,
  search,
  onSearchChange,
  onSelect,
}) {
  const hasSearch = Boolean(search.trim());
  // the Intent column needs the rollup's intent counts; without them (rollup not refilled) it is hidden
  const showIntent = pages.some((page) => page.intent);
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
                        <IntentBar split={intentSplit(page.intent)} />
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
