import { Box, Card, Skeleton, Stack, Typography, useTheme } from "@mui/material";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import dayjs from "dayjs";
import {
  CHANNEL_COLORS,
  MISSING,
  formatCount,
  formatPct,
  formatRoas,
  formatSignedPct,
  isMissing,
} from "../adsFormat.js";

const GOOD_COLOR = "#10b981";
const BAD_COLOR = "#ef4444";

function Delta({ value, higherIsBetter = true }) {
  const label = formatSignedPct(value);
  if (!label) {
    return (
      <Typography variant="caption" color="text.secondary">
        No comparison available
      </Typography>
    );
  }
  const good = higherIsBetter ? value >= 0 : value <= 0;
  return (
    <Typography variant="caption" sx={{ color: value === 0 ? "text.secondary" : good ? GOOD_COLOR : BAD_COLOR, fontWeight: 600 }}>
      {label} vs previous period
    </Typography>
  );
}

function Kpi({ label, value, hint, delta, higherIsBetter, loading }) {
  return (
    <Card variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
      {loading ? (
        <Skeleton variant="text" width={100} height={40} />
      ) : (
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {value}
        </Typography>
      )}
      {delta !== undefined ? <Delta value={delta} higherIsBetter={higherIsBetter} /> : null}
      {hint ? (
        <Typography variant="caption" color="text.secondary">
          {hint}
        </Typography>
      ) : null}
    </Card>
  );
}

function ChannelCard({ channel, label, data, color, formatAmount }) {
  return (
    <Card variant="outlined" sx={{ p: 2, flex: 1, minWidth: 260 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: "2px", bgcolor: color }} />
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {label}
        </Typography>
        {!data?.hasData ? (
          <Typography variant="caption" color="text.secondary">
            · nothing synced in this range
          </Typography>
        ) : null}
      </Stack>
      <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", rowGap: 1.5, columnGap: 2 }}>
        {[
          ["Spend", data ? formatAmount(data.spend) : MISSING],
          ["ROAS (platform)", formatRoas(data?.roas)],
          ["ROAS (Shopify)", formatRoas(data?.shopifyRoas)],
          ["Clicks", formatCount(data?.clicks)],
          ["CTR", formatPct(data?.ctr, 2)],
          ["CPC", isMissing(data?.cpc) ? MISSING : formatAmount(data.cpc)],
          ...(channel === "meta"
            ? [
                ["Link clicks", formatCount(data?.linkClicks)],
                ["Landing page views", formatCount(data?.landingPageViews)],
                ["LC → LPV", formatPct(data?.lpvRate)],
              ]
            : [
                ["Conversions", formatCount(data?.platformPurchases)],
                ["Conv. value", data ? formatAmount(data.platformPurchaseValue) : MISSING],
                ["CPA", isMissing(data?.cpa) ? MISSING : formatAmount(data.cpa)],
              ]),
        ].map(([name, value]) => (
          <Box key={name}>
            <Typography variant="caption" color="text.secondary">
              {name}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {value}
            </Typography>
          </Box>
        ))}
      </Box>
    </Card>
  );
}

function SpendTooltip({ active, payload, label, formatAmount }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const spend = (row.metaSpend || 0) + (row.googleSpend || 0);
  return (
    <Card variant="outlined" sx={{ p: 1.25, minWidth: 180 }}>
      <Typography variant="caption" color="text.secondary">
        {dayjs(label).format("ddd, D MMM YYYY")}
      </Typography>
      {payload.map((entry) => (
        <Stack key={entry.dataKey} direction="row" justifyContent="space-between" spacing={2} alignItems="center">
          <Stack direction="row" spacing={0.75} alignItems="center">
            <Box sx={{ width: 8, height: 8, borderRadius: "2px", bgcolor: entry.color }} />
            <Typography variant="body2">{entry.name}</Typography>
          </Stack>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {formatAmount(entry.value)}
          </Typography>
        </Stack>
      ))}
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
        ROAS {formatRoas(spend > 0 ? row.platformValue / spend : null)} platform ·{" "}
        {formatRoas(spend > 0 ? row.utmSales / spend : null)} Shopify
      </Typography>
    </Card>
  );
}

export default function AdsOverview({ overview, loading, formatAmount }) {
  const theme = useTheme();
  const colors = CHANNEL_COLORS[theme.palette.mode === "dark" ? "dark" : "light"];
  const total = overview?.total;
  const trend = overview?.trend || [];

  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: { xs: "repeat(2, 1fr)", sm: "repeat(3, 1fr)", md: "repeat(6, 1fr)" },
          gap: 1.5,
        }}
      >
        <Kpi label="Ad spend" value={total ? formatAmount(total.spend) : MISSING} delta={total?.change?.spend} higherIsBetter={false} loading={loading} />
        <Kpi label="ROAS (platform)" value={formatRoas(total?.roas)} delta={total?.change?.roas} loading={loading} />
        <Kpi label="ROAS (Shopify UTM)" value={formatRoas(total?.shopifyRoas)} delta={total?.change?.shopifyRoas} loading={loading} />
        <Kpi label="UTM-attributed sales" value={total ? formatAmount(total.utmSales) : MISSING} hint={total ? `${formatCount(total.utmOrders)} orders` : null} loading={loading} />
        <Kpi label="LC → LPV (Meta)" value={formatPct(total?.lpvRate)} delta={total?.change?.lpvRate} loading={loading} />
        <Kpi label="CPC" value={isMissing(total?.cpc) ? MISSING : formatAmount(total.cpc)} hint={total ? `CTR ${formatPct(total.ctr, 2)}` : null} loading={loading} />
      </Box>

      <Stack direction={{ xs: "column", md: "row" }} spacing={1.5}>
        <ChannelCard channel="meta" label="Meta" data={overview?.channels?.meta} color={colors.meta} formatAmount={formatAmount} />
        <ChannelCard channel="google" label="Google" data={overview?.channels?.google} color={colors.google} formatAmount={formatAmount} />
      </Stack>

      <Card variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Daily ad spend
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Hover a day for its blended ROAS.
        </Typography>
        <Box sx={{ height: 260, mt: 1 }}>
          {trend.length === 0 ? (
            <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
              <Typography variant="body2" color="text.secondary">
                {loading ? "Loading…" : "No synced spend in this range."}
              </Typography>
            </Stack>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trend} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
                <CartesianGrid vertical={false} stroke={theme.palette.divider} strokeOpacity={0.6} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d) => dayjs(d).format("D MMM")}
                  tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={16}
                />
                <YAxis
                  tickFormatter={(v) => formatAmount(v)}
                  tick={{ fontSize: 11, fill: theme.palette.text.secondary }}
                  axisLine={false}
                  tickLine={false}
                  width={80}
                />
                <Tooltip content={<SpendTooltip formatAmount={formatAmount} />} cursor={{ fill: theme.palette.action.hover }} />
                <Legend iconType="square" wrapperStyle={{ fontSize: 12, color: theme.palette.text.secondary }} />
                <Bar dataKey="metaSpend" name="Meta" stackId="spend" fill={colors.meta} stroke={theme.palette.background.paper} strokeWidth={2} />
                <Bar dataKey="googleSpend" name="Google" stackId="spend" fill={colors.google} stroke={theme.palette.background.paper} strokeWidth={2} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Box>
      </Card>
    </Stack>
  );
}
