import { Panel, DataTable, Tag } from "../../../components/datum/index.js";
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

const GOOD_COLOR = "var(--dz-good)";
const BAD_COLOR = "var(--dz-bad)";

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
    <Card variant="outlined" sx={{ p: 2, display: "flex", flexDirection: "column", gap: 0.5, border: 0, borderRadius: 0, boxShadow: "none" }}>
      <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
      {loading ? (
        <Skeleton variant="text" width={100} height={40} />
      ) : (
        <Typography variant="h5" sx={{ fontSize: 24, fontWeight: 620, letterSpacing: "-0.025em" }}>
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

// "By platform" table: same figures and formatters the channel cards used, shown as Metric | Meta | Google.
// Rows a platform does not report are shown as MISSING, as in the design.
function platformRows(meta, google, formatAmount) {
  const amount = (data, key) => (data && !isMissing(data[key]) ? formatAmount(data[key]) : MISSING);
  return [
    ["Spend", meta ? formatAmount(meta.spend) : MISSING, google ? formatAmount(google.spend) : MISSING],
    ["ROAS (platform)", formatRoas(meta?.roas), formatRoas(google?.roas)],
    ["ROAS (Shopify)", formatRoas(meta?.shopifyRoas), formatRoas(google?.shopifyRoas)],
    ["Clicks", formatCount(meta?.clicks), formatCount(google?.clicks)],
    ["CTR", formatPct(meta?.ctr, 2), formatPct(google?.ctr, 2)],
    ["CPC", amount(meta, "cpc"), amount(google, "cpc")],
    ["Link clicks", formatCount(meta?.linkClicks), MISSING],
    ["Landing page views", formatCount(meta?.landingPageViews), MISSING],
    ["LC → LPV", formatPct(meta?.lpvRate), MISSING],
    ["Conversions", MISSING, formatCount(google?.platformPurchases)],
    ["Conv. value", MISSING, google ? formatAmount(google.platformPurchaseValue) : MISSING],
    ["CPA", MISSING, amount(google, "cpa")],
  ];
}

function PlatformTable({ meta, google, colors, formatAmount }) {
  const rows = platformRows(meta, google, formatAmount);
  const status = (data) => (
    <Tag tone={data?.hasData ? "good" : "warn"} dot={Boolean(data?.hasData)}>
      {data?.hasData ? "Synced" : "Nothing synced"}
    </Tag>
  );
  const columns = [
    { key: "metric", header: "Metric", render: (r) => r.metric },
    {
      key: "meta",
      header: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <i className="dz-sw" style={{ background: colors.meta }} />
          Meta
        </span>
      ),
      align: "right",
      render: (r) => r.meta,
    },
    {
      key: "google",
      header: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <i className="dz-sw" style={{ background: colors.google }} />
          Google
        </span>
      ),
      align: "right",
      render: (r) => r.google,
    },
  ];
  const data = [
    { metric: "Status", meta: status(meta), google: status(google) },
    ...rows.map(([metric, m, g]) => ({ metric, meta: m, google: g })),
  ];
  return (
    <>
      <DataTable ariaLabel="By platform" columns={columns} rows={data} getRowKey={(r) => r.metric} dense />
      <div className="dz-pf" style={{ justifyContent: "flex-start" }}>{MISSING} = no value for this platform in this range</div>
    </>
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
          gap: "1px",
          bgcolor: "divider",
          border: "1px solid",
          borderColor: "divider",
          borderRadius: "12px",
          overflow: "hidden",
        }}
      >
        <Kpi label="Ad spend" value={total ? formatAmount(total.spend) : MISSING} delta={total?.change?.spend} higherIsBetter={false} loading={loading} />
        <Kpi label="ROAS (platform)" value={formatRoas(total?.roas)} delta={total?.change?.roas} loading={loading} />
        <Kpi label="ROAS (Shopify UTM)" value={formatRoas(total?.shopifyRoas)} delta={total?.change?.shopifyRoas} loading={loading} />
        <Kpi label="UTM-attributed sales" value={total ? formatAmount(total.utmSales) : MISSING} hint={total ? `${formatCount(total.utmOrders)} orders` : null} loading={loading} />
        <Kpi label="LC → LPV (Meta)" value={formatPct(total?.lpvRate)} delta={total?.change?.lpvRate} loading={loading} />
        <Kpi label="CPC" value={isMissing(total?.cpc) ? MISSING : formatAmount(total.cpc)} hint={total ? `CTR ${formatPct(total.ctr, 2)}` : null} loading={loading} />
      </Box>

      <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "minmax(0, 2fr) minmax(0, 1fr)" }, gap: 2.5 }}>
        <Panel title="Daily ad spend" subtitle="Hover a day for its blended ROAS" flush>
        <Box sx={{ height: 300, p: 2 }}>
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
        </Panel>
        <Panel title="By platform" subtitle="Meta and Google for the selected range" flush>
          <PlatformTable meta={overview?.channels?.meta} google={overview?.channels?.google} colors={colors} formatAmount={formatAmount} />
        </Panel>
      </Box>
    </Stack>
  );
}
