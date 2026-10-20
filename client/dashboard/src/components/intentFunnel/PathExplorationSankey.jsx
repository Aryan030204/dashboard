import { useMemo } from "react";
import {
  Box,
  FormControl,
  MenuItem,
  Select,
  Tooltip as MuiTooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { ResponsiveContainer, Sankey, Tooltip as ChartTooltip } from "recharts";
import { SectionCard } from "./shared.jsx";
import {
  INTENT_COLORS,
  INTENT_FILTER_OPTIONS,
  PATH_START_OPTIONS,
  PATH_TOP_OPTIONS,
  formatCount,
  formatPct,
} from "./intentFunnelUtils.js";

// Bold, clearly different colours per action, reused from the other panels
// (blue / green / purple intent colours, amber warning, red error).
// Keys are the recorded event names.
const STATE_COLORS = {
  page_viewed: "#f59e0b",
  product_viewed: "#2563eb",
  click: "#06b6d4",
  product_added_to_cart: INTENT_COLORS.high,
  checkout_started: "#7c3aed",
  exit: "#ef4444",
};

// On phones every control takes a full row (label left, select filling the rest).
function ControlSelect({ label, value, onChange, options, hint }) {
  const select = (
    <FormControl size="small" sx={{ flex: { xs: 1, sm: "none" }, minWidth: 0 }}>
      <Select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        sx={{ fontSize: 13, minWidth: { xs: 0, sm: 120 } }}
      >
        {options.map((option) => (
          <MenuItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.75,
        width: { xs: "100%", sm: "auto" },
      }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        noWrap
        sx={{ width: { xs: 84, sm: "auto" }, flexShrink: 0 }}
      >
        {label}
      </Typography>
      {hint ? (
        <MuiTooltip title={hint} arrow>
          <Box component="span" sx={{ display: "flex", flex: { xs: 1, sm: "none" }, minWidth: 0 }}>
            {select}
          </Box>
        </MuiTooltip>
      ) : (
        select
      )}
    </Box>
  );
}

// Phone view of the path data: one block per step, every action as a labelled bar. The flow
// diagram needs more width than a phone has, and scrolling it sideways hides most of it.
function PathStepList({ paths, textColor }) {
  const steps = useMemo(() => {
    const byStep = new Map();
    (paths?.nodes || []).forEach((node) => {
      if (!byStep.has(node.step)) byStep.set(node.step, []);
      byStep.get(node.step).push(node);
    });
    return [...byStep.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([step, nodes]) => ({
        step,
        info: paths.steps?.[step],
        nodes: [...nodes].sort((a, b) => b.value - a.value),
      }));
  }, [paths]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {steps.map(({ step, info, nodes }) => (
        <Box key={step}>
          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1, mb: 0.75 }}>
            <Typography variant="body2" sx={{ fontWeight: 700 }}>
              {`Step ${step + 1}${info?.title ? ` · ${info.title}` : ""}`}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              {`${formatCount(info?.sessions ?? 0)} sessions`}
            </Typography>
          </Box>
          <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
            {nodes.map((node) => (
              <Box key={node.key} sx={{ minWidth: 0 }}>
                <Box sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
                  <Typography variant="caption" sx={{ color: textColor, fontWeight: 600, minWidth: 0 }}>
                    {node.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                    {`${formatCount(node.value)} (${formatPct(node.pct)})`}
                  </Typography>
                </Box>
                <Box sx={{ height: 8, borderRadius: 1, bgcolor: "action.hover", overflow: "hidden" }}>
                  <Box
                    sx={{
                      height: "100%",
                      width: `${Math.max(2, Math.min(100, node.pct))}%`,
                      bgcolor: STATE_COLORS[node.state] || "#94a3b8",
                      borderRadius: 1,
                    }}
                  />
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

const MARGIN = { top: 64, right: 170, bottom: 8, left: 8 };

export default function PathExplorationSankey({
  paths,
  pathStart,
  onPathStartChange,
  topN,
  onTopNChange,
  intentFilter,
  onIntentFilterChange,
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("md"));
  const isDark = theme.palette.mode === "dark";
  const textColor = theme.palette.text.primary;
  const mutedColor = theme.palette.text.secondary;

  const data = useMemo(() => {
    if (!paths?.nodes?.length) return null;
    const seenSteps = new Set();
    const nodes = paths.nodes.map((node) => {
      const firstInStep = !seenSteps.has(node.step);
      seenSteps.add(node.step);
      const stepInfo = paths.steps[node.step];
      return {
        ...node,
        color: STATE_COLORS[node.state] || "#94a3b8",
        firstInStep,
        stepTitle: stepInfo?.title,
        stepSessions: stepInfo?.sessions,
      };
    });
    return { nodes, links: paths.links.map((link) => ({ ...link })) };
  }, [paths]);

  const renderNode = (props) => {
    const { x, y, width, height, payload } = props;
    if (!payload) return null;
    return (
      <g>
        {payload.firstInStep && (
          <g>
            <text x={x} y={14} fontSize={11} fill={mutedColor}>
              {`Step ${payload.step + 1}`}
            </text>
            <text x={x} y={30} fontSize={12} fontWeight={700} fill={textColor}>
              {payload.stepTitle}
            </text>
            <text x={x} y={46} fontSize={11} fill={mutedColor}>
              {`${formatCount(payload.stepSessions)} sessions`}
            </text>
          </g>
        )}
        <rect
          x={x}
          y={y}
          width={width}
          height={Math.max(height, 2)}
          fill={payload.color}
          rx={2}
        />
        <text
          x={x + width + 8}
          y={y + Math.max(height, 2) / 2 - 2}
          fontSize={12}
          fontWeight={600}
          fill={textColor}
        >
          {payload.name}
        </text>
        <text
          x={x + width + 8}
          y={y + Math.max(height, 2) / 2 + 13}
          fontSize={11}
          fill={mutedColor}
        >
          {`${formatCount(payload.value)} (${formatPct(payload.pct)})`}
        </text>
      </g>
    );
  };

  const renderLink = (props) => {
    const {
      sourceX,
      targetX,
      sourceY,
      targetY,
      sourceControlX,
      targetControlX,
      linkWidth,
      payload,
    } = props;
    // Coloured by destination so each action reads the same everywhere.
    const color = payload?.target?.color || "#94a3b8";
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={color}
        strokeWidth={Math.max(linkWidth, 1)}
        strokeOpacity={isDark ? 0.6 : 0.5}
      />
    );
  };

  return (
    <SectionCard
      title="Path Exploration (Left to Right Funnel)"
      info="Where sessions go next after each step, from recorded event sequences. Choose the starting event and how many paths to show per step. Splitting paths by intent is not available yet."
      action={
        <Box
          sx={{
            display: "flex",
            flexDirection: { xs: "column", sm: "row" },
            flexWrap: "wrap",
            alignItems: { xs: "stretch", sm: "center" },
            gap: { xs: 1, md: 2 },
            width: { xs: "100%", sm: "auto" },
          }}
        >
          <ControlSelect
            label="Start with"
            value={pathStart}
            onChange={onPathStartChange}
            options={PATH_START_OPTIONS}
          />
          <ControlSelect
            label="Show top"
            value={topN}
            onChange={onTopNChange}
            options={PATH_TOP_OPTIONS.map((n) => ({
              value: n,
              label: `${n} paths`,
            }))}
          />
          <ControlSelect
            label="Intent Filter"
            value={intentFilter}
            onChange={onIntentFilterChange}
            options={INTENT_FILTER_OPTIONS}
            hint="Splitting paths by intent is not available yet"
          />
        </Box>
      }
    >
      {data && paths?.coverage && paths.coverage.pct < 99.5 ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          Showing the most common paths, covering {formatPct(paths.coverage.pct, 0)} of{" "}
          {formatCount(paths.coverage.totalSessions)} sessions that started here.
        </Typography>
      ) : null}
      {data && phone ? (
        <PathStepList paths={paths} textColor={textColor} />
      ) : data ? (
        <Box sx={{ overflowX: "auto" }}>
          <Box sx={{ minWidth: 820, height: 420 }}>
            <ResponsiveContainer width="100%" height="100%">
              <Sankey
                data={data}
                node={renderNode}
                link={renderLink}
                nodePadding={22}
                nodeWidth={18}
                iterations={32}
                margin={MARGIN}
              >
                <ChartTooltip
                  formatter={(value) => formatCount(value)}
                  contentStyle={{
                    background: theme.palette.background.paper,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
              </Sankey>
            </ResponsiveContainer>
          </Box>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No path data for this selection.
        </Typography>
      )}
    </SectionCard>
  );
}
