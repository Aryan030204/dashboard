import {
  Card,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
  useTheme,
} from "@mui/material";
import dayjs from "dayjs";
import { formatSignedPercent } from "../pnlFormat.js";

const GOOD_COLOR = "#10b981";
const BAD_COLOR = "#ef4444";

function formatRangeLabel(start, end) {
  const s = dayjs(start);
  const e = dayjs(end);
  if (!s.isValid() || !e.isValid()) return "—";
  if (s.isSame(e, "day")) return s.format("MMM DD, YYYY");
  return `${s.format("MMM DD")} – ${e.format("MMM DD, YYYY")}`;
}

export default function PnlTable({ rows, loading, start, end, previousStart, previousEnd, formatAmount }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  return (
    <Card variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ xs: "flex-start", sm: "center" }}
        justifyContent="space-between"
        spacing={1}
        sx={{ mb: 2 }}
      >
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          P&amp;L Statement
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatRangeLabel(start, end)} vs {formatRangeLabel(previousStart, previousEnd)}
        </Typography>
      </Stack>

      {loading ? (
        <Skeleton variant="rounded" width="100%" height={520} />
      ) : (
        <TableContainer sx={{ overflowX: "auto" }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Line Item</TableCell>
                <TableCell align="right">Amount</TableCell>
                <TableCell align="right">% of Net Sales</TableCell>
                <TableCell align="right">Previous Period</TableCell>
                <TableCell align="right">% Change</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                      No P&amp;L data for this range.
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const changeColor =
                    !row.changePct || row.changePct === 0
                      ? "text.secondary"
                      : row.isDeduction
                        ? row.changePct < 0
                          ? GOOD_COLOR
                          : BAD_COLOR
                        : row.changePct > 0
                          ? GOOD_COLOR
                          : BAD_COLOR;

                  return (
                    <TableRow
                      key={row.key}
                      hover
                      sx={{
                        bgcolor: row.isSubtotal
                          ? isDark
                            ? "rgba(255,255,255,0.04)"
                            : "rgba(0,0,0,0.03)"
                          : undefined,
                      }}
                    >
                      <TableCell
                        sx={{
                          fontWeight: row.isSubtotal ? 700 : 400,
                          pl: row.isSubItem ? 4 : 2,
                        }}
                      >
                        {row.label}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: row.isSubtotal ? 700 : 400 }}>
                        {formatAmount(row.amount)}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: row.isSubtotal ? 700 : 400 }}>
                        {row.pctOfNetSales.toFixed(1)}%
                      </TableCell>
                      <TableCell align="right" color="text.secondary">
                        {formatAmount(row.previousAmount)}
                      </TableCell>
                      <TableCell align="right" sx={{ color: changeColor, fontWeight: 600 }}>
                        {formatSignedPercent(row.changePct)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Card>
  );
}
