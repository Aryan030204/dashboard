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
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import { describePage, formatCount, formatShare, pageShare } from "./heatmapUtils.js";

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
                <TableCell align="right">Page views</TableCell>
                <TableCell align="right">Share</TableCell>
                <TableCell align="right" sx={{ width: 120 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {pages.map((page, index) => {
                const info = describePage(page.path);
                return (
                  <TableRow
                    key={page.path}
                    hover
                    onClick={() => onSelect(page.path)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell>{index + 1}</TableCell>
                    <TableCell sx={{ maxWidth: 420 }}>
                      <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap title={info.label}>
                        {info.label}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap component="div" title={page.path}>
                        {info.kind} · {page.path}
                      </Typography>
                    </TableCell>
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
    </Box>
  );
}
