import React, { useMemo, useState } from "react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  LabelList,
  YAxis,
  XAxis,
  Tooltip,
} from "recharts";
import { Card, CardContent, useTheme } from "@mui/material";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "../../lib/utils";

const FunnelChart = React.memo(function FunnelChart({
  data = [],
  height = 300,
  className,
  showHeader = true,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const [viewMode, setViewMode] = useState("funnel"); // 'funnel' | 'bar'

  // Process data to calculate scaling and centering
  const funnelPoints = useMemo(() => {
    if (!data || data.length === 0) return [];

    const count = data.length;
    const maxValue = Math.max(...data.map((d) => d.value)) || 1;
    const minHeightPx = 16; // Increased from 8 to give a better minimum thickness
    const minPct = (minHeightPx / height) * 100;

    const points = [];

    const getPct = (val) => {
      const rawPct = Math.pow(val / maxValue, 0.8) * 100;
      return Math.max(rawPct, minPct);
    };

    const firstPct = getPct(data[0]?.value || 1);
    const lastPct = getPct(data[count - 1]?.value || 1);
    const flowLength = Math.max(1, count - 1);

    const getInterpolatedPct = (x) => {
      // The triangle flows flawlessly until the last stage
      if (x >= flowLength) return lastPct;
      return firstPct - (x / flowLength) * (firstPct - lastPct);
    };

    for (let i = 0; i < count; i++) {
      // Use the geometric triangle height for visual flow
      const currentPct = getInterpolatedPct(i);
      const nextPct = getInterpolatedPct(i + 0.5);

      const firstValue = data[0]?.value || 1;
      const pctValue = (data[i].value / firstValue) * 100;
      const pctLabel =
        i === 0
          ? "100%"
          : `${pctValue % 1 === 0 ? pctValue : pctValue.toFixed(1)}%`;

      // Left edge point
      points.push({
        xOffset: i,
        conversionPct: currentPct,
        spacer: (100 - currentPct) / 2,
        isCenter: false,
        rawValue: data[i].value,
      });

      // Center point (for label)
      points.push({
        ...data[i],
        xOffset: i + 0.5,
        conversionPct: nextPct,
        spacer: (100 - nextPct) / 2,
        isCenter: true,
        displayValue: pctLabel,
        rawValue: data[i].value,
      });
    }

    // Final right edge point, kept identical to last step (flat rectangle)
    points.push({
      xOffset: count,
      conversionPct: lastPct,
      spacer: (100 - lastPct) / 2,
      isCenter: false,
      rawValue: data[count - 1].value,
    });

    return points;
  }, [data, height]);

  // Generate gradient stops for segmented look
  const gradientStops = useMemo(() => {
    const colors = [
      "var(--dz-series)", // emerald-500 (Primary sync)
      "#34d399", // emerald-400
      "#6ee7b7", // emerald-300
      "#a7f3d0", // emerald-200
      "#d1fae5", // emerald-100
    ];

    return data.map((_, index) => {
      const color = colors[index % colors.length];
      const startPct = (index / data.length) * 100;
      const endPct = ((index + 1) / data.length) * 100;

      return (
        <React.Fragment key={index}>
          <stop offset={`${startPct}%`} stopColor={color} stopOpacity={0.9} />
          <stop offset={`${endPct}%`} stopColor={color} stopOpacity={0.9} />
        </React.Fragment>
      );
    });
  }, [data]);

  return (
    <Card
      elevation={0}
      sx={{
        height: "100%",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: { xs: 2, md: 3 },
      }}
      className={className}
    >
      <CardContent
        sx={{ p: 3, "&:last-child": { pb: 3 }, position: "relative" }}
      >
        {/* View Mode Toggle */}
        <div className="absolute top-3 right-3 z-30 hidden md:flex bg-gray-100 dark:bg-gray-800 p-1 rounded-lg border border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setViewMode("funnel")}
            className={cn(
              "px-4 py-1.5 text-[10px] md:text-[11px] uppercase tracking-wide font-semibold rounded-md transition-all duration-200",
              viewMode === "funnel"
                ? "bg-white dark:bg-gray-700 text-emerald-600 dark:text-emerald-400 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200",
            )}
          >
            Funnel
          </button>
          <button
            onClick={() => setViewMode("bar")}
            className={cn(
              "px-4 py-1.5 text-[10px] md:text-[11px] uppercase tracking-wide font-semibold rounded-md transition-all duration-200",
              viewMode === "bar"
                ? "bg-white dark:bg-gray-700 text-emerald-600 dark:text-emerald-400 shadow-sm"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200",
            )}
          >
            Bar
          </button>
        </div>

        {/* Background Hover Layer */}
        <div className="absolute inset-0 flex z-0 m-6">
          {data.map((_, i) => (
            <div
              key={i}
              className={cn(
                "flex-1 h-full transition-all duration-300 ease-in-out border-r border-dashed border-gray-200 dark:border-gray-800 last:border-r-0",
                hoveredIndex === i
                  ? "bg-gradient-to-t from-emerald-500/20 to-transparent"
                  : "bg-transparent",
              )}
              onMouseEnter={() => setHoveredIndex(i)}
              onMouseLeave={() => setHoveredIndex(null)}
            />
          ))}
        </div>

        <div className="relative z-10 pointer-events-none">
          {showHeader && (
            <div className="flex justify-between mb-8">
              {data.map((step, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex flex-col flex-1 min-w-0 pl-2 md:pl-4 first:pl-0 transition-transform duration-300 ease-in-out",
                    hoveredIndex === i ? "translate-y-1" : "",
                  )}
                >
                  <span className="text-xs md:text-sm text-gray-500 dark:text-gray-400 font-medium truncate">
                    {step.label}
                  </span>
                  <div className="flex flex-wrap items-end gap-x-2 gap-y-0 mt-1">
                    <span
                      style={{ color: isDark ? "#fff" : "#111827" }}
                      className="text-lg md:text-2xl font-bold tracking-tight truncate"
                    >
                      {step.value.toLocaleString()}
                    </span>
                    {step.change !== undefined && (
                      <div
                        className={cn(
                          "flex items-center text-[10px] md:text-xs font-medium mb-1 md:mb-1.5",
                          step.change > 0
                            ? "text-emerald-500"
                            : step.change < 0
                              ? "text-rose-500"
                              : "text-gray-500",
                        )}
                      >
                        {step.change > 0 ? (
                          <TrendingUp className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5" />
                        ) : step.change < 0 ? (
                          <TrendingDown className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5" />
                        ) : (
                          <Minus className="w-2.5 h-2.5 md:w-3 md:h-3 mr-0.5" />
                        )}
                        <span className="ml-[1px]">
                          {Math.abs(step.change)}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div
            style={{ height }}
            className="relative w-full pointer-events-auto"
          >
            {viewMode === "funnel" ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={funnelPoints}
                  layout="horizontal"
                  margin={{ top: 20, right: 0, left: 0, bottom: 20 }}
                  stackOffset="none"
                  overflow="visible"
                  onMouseMove={(state) => {
                    if (state && state.activeTooltipIndex !== undefined) {
                      const dataIndex = Math.min(
                        Math.floor(state.activeTooltipIndex / 2),
                        data.length - 1,
                      );
                      if (dataIndex >= 0) {
                        setHoveredIndex(dataIndex);
                      }
                    } else {
                      setHoveredIndex(null);
                    }
                  }}
                  onMouseLeave={() => setHoveredIndex(null)}
                >
                  <defs>
                    <filter
                      id="funnelCombinedShadow"
                      x="-50%"
                      y="-50%"
                      width="200%"
                      height="200%"
                    >
                      <feDropShadow
                        dx="0"
                        dy="4"
                        stdDeviation="4"
                        floodColor="rgba(0, 0, 0, 0.3)"
                        result="shadowDown"
                      />
                      <feDropShadow
                        dx="0"
                        dy="-8"
                        stdDeviation="12"
                        floodColor="var(--dz-series)"
                        floodOpacity="0.3"
                        result="shadowUp"
                      />
                      <feMerge>
                        <feMergeNode in="shadowDown" />
                        <feMergeNode in="shadowUp" />
                        <feMergeNode in="SourceGraphic" />
                      </feMerge>
                    </filter>
                    <linearGradient
                      id="funnelGradient"
                      x1="0"
                      y1="0"
                      x2="1"
                      y2="0"
                    >
                      {gradientStops}
                    </linearGradient>
                  </defs>

                  <XAxis
                    type="number"
                    dataKey="xOffset"
                    domain={[0, data.length]}
                    hide
                  />
                  <YAxis type="number" domain={[0, 100]} hide />

                  {/* Required for hover state calculation in Recharts */}
                  <Tooltip
                    content={() => null}
                    cursor={{ stroke: "rgba(255,255,255,0.1)", strokeWidth: 1 }}
                  />

                  <Area
                    type="linear"
                    dataKey="spacer"
                    stackId="1"
                    stroke="none"
                    fill="transparent"
                    isAnimationActive={false}
                    activeDot={false}
                    tooltipType="none"
                  />

                  <Area
                    type="linear"
                    dataKey="conversionPct"
                    stackId="1"
                    stroke="none"
                    fill="url(#funnelGradient)"
                    filter="url(#funnelCombinedShadow)"
                    isAnimationActive={false}
                    activeDot={false}
                  >
                    <LabelList
                      dataKey="displayValue"
                      position="center"
                      content={({ x, width, value, index }) => {
                        const pt = funnelPoints[index];
                        if (!value || !pt?.isCenter) return null;
                        const centerY = height / 2;

                        const textAnchor = "middle";
                        const xPos = x + width / 2;

                        return (
                          <text
                            x={xPos}
                            y={centerY}
                            fill="white"
                            textAnchor={textAnchor}
                            dominantBaseline="middle"
                            className="text-sm font-bold drop-shadow-md pointer-events-none"
                            style={{
                              textShadow: "0 2px 4px rgba(0,0,0,0.3)",
                              opacity: 1,
                            }}
                          >
                            {value}
                          </text>
                        );
                      }}
                    />
                  </Area>
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-end pb-5 px-2">
                {data.map((d, i) => {
                  const maxValue =
                    Math.max(...data.map((item) => item.value)) || 1;
                  const heightPct = Math.max((d.value / maxValue) * 100, 5); // Min 5% height

                  const firstValue = data[0]?.value || 1;
                  const pctLabel =
                    d.label === data[0].label
                      ? "100%"
                      : `${Number(((d.value / firstValue) * 100).toFixed(2))}%`;

                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col justify-end items-center h-full"
                      onMouseEnter={() => setHoveredIndex(i)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    >
                      <div
                        className="w-[80%] bg-emerald-500 rounded-t-md relative flex items-center justify-center transition-all duration-500 ease-out"
                        style={{
                          height: `${heightPct}%`,
                          opacity:
                            hoveredIndex === null || hoveredIndex === i ? 1 : 0.92,
                        }}
                      >
                        {/* Percentage Label inside bar */}
                        <span className="text-white font-bold text-sm drop-shadow-md">
                          {pctLabel}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});

export default FunnelChart;
