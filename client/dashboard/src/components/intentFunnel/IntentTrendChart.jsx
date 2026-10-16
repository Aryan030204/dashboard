import { MenuItem, Select, useTheme } from "@mui/material";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SectionCard } from "./shared.jsx";
import { STEP_COLORS, formatCount } from "./intentFunnelUtils.js";

const compactFormat = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export default function IntentTrendChart({
  trend = [],
  granularity,
  onGranularityChange,
}) {
  const theme = useTheme();
  const axisColor = theme.palette.text.secondary;

  return (
    <SectionCard
      title="Intent Trend"
      info="Product views, add to cart and checkouts over the selected period."
      action={
        <Select
          size="small"
          value={granularity}
          onChange={(event) => onGranularityChange(event.target.value)}
          sx={{ minWidth: 96, fontSize: 13 }}
        >
          <MenuItem value="daily">Daily</MenuItem>
          <MenuItem value="weekly">Weekly</MenuItem>
        </Select>
      }
    >
      <div style={{ width: "100%", height: 250 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={trend}
            margin={{ top: 8, right: 12, left: -8, bottom: 0 }}
          >
            <CartesianGrid
              stroke={theme.palette.divider}
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: axisColor }}
              tickLine={false}
              axisLine={{ stroke: theme.palette.divider }}
              minTickGap={16}
            />
            <YAxis
              tick={{ fontSize: 11, fill: axisColor }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => compactFormat.format(v)}
              width={44}
            />
            <Tooltip
              formatter={(value, name) => [formatCount(value), name]}
              contentStyle={{
                background: theme.palette.background.paper,
                border: `1px solid ${theme.palette.divider}`,
                borderRadius: 8,
                fontSize: 12,
              }}
            />
            <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
            <Line
              type="monotone"
              dataKey="productViews"
              name="Product Views"
              stroke={STEP_COLORS.productViews}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="addToCart"
              name="Add to Cart"
              stroke={STEP_COLORS.addToCart}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
            <Line
              type="monotone"
              dataKey="checkouts"
              name="Checkouts Started"
              stroke={STEP_COLORS.checkouts}
              strokeWidth={2}
              dot={{ r: 3 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </SectionCard>
  );
}
