import { useMemo, useState } from "react";
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
  PATH_START_OPTIONS,
  PATH_TOP_OPTIONS,
  formatCount,
  formatPct,
} from "./intentFunnelUtils.js";
import { highlightJourney, linkShare } from "./pathJourneyUtils.js";

// Bold, clearly different colours per action, reused from the other panels
// (blue / green / purple intent colours, amber warning, red error).
// Keys are the recorded event names. Exit is always red.
const STATE_COLORS = {
  page_viewed: "#f59e0b",
  product_viewed: "#2563eb",
  click: "#06b6d4",
  product_added_to_cart: INTENT_COLORS.high,
  checkout_started: "#7c3aed",
  exit: "#ef4444",
};

// How many of the most common paths the chart shows per step.
const PATH_COUNT_OPTIONS = PATH_TOP_OPTIONS.filter((n) => n >= 3 && n <= 5);

// Single-select, one level at a time (no "all").
const INTENT_LEVEL_OPTIONS = [
  { value: "high", label: "High Intent" },
  { value: "medium", label: "Medium Intent" },
  { value: "low", label: "Low Intent" },
];
const PRODUCT_OPTIONS = [{ value: "top10", label: "Top 10 Products" }];

const DIMMED_OPACITY = 0.18;

// On phones every control takes a full row (label left, select filling the rest).
function ControlSelect({ label, value, onChange, options, hint, disabled = false, placeholder }) {
  const select = (
    <FormControl size="small" sx={{ flex: { xs: 1, sm: "none" }, minWidth: 0 }} disabled={disabled}>
      <Select
        value={value}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        displayEmpty={Boolean(placeholder)}
        renderValue={
          placeholder
            ? (current) =>
                options.find((option) => option.value === current)?.label ?? (
                  <Box component="span" sx={{ color: "text.secondary" }}>
                    {placeholder}
                  </Box>
                )
            : undefined
        }
        inputProps={{ "aria-label": label }}
        sx={{ fontSize: 13, minWidth: { xs: 0, sm: 130 } }}
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

// Details live in the tooltip so the chart itself stays readable. Percentages always say what they are a
// share of.
function PathTooltip({ active, payload }) {
  const theme = useTheme();
  const item = payload?.[0]?.payload;
  if (!active || !item) return null;

  const isLink = Boolean(item.source && item.target);
  const share = isLink ? linkShare(item) : null;
  const box = {
    background: theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: 8,
    padding: "8px 12px",
    fontSize: 12,
    maxWidth: 260,
  };

  if (isLink) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 700 }}>{`${item.source.name} → ${item.target.name}`}</div>
        <div>{`${formatCount(item.value)} sessions`}</div>
        {share != null ? (
          <div style={{ color: theme.palette.text.secondary }}>
            {`${formatPct(share)} of the ${formatCount(item.source.value)} sessions at ${item.source.name} (step ${
              item.source.step + 1
            })`}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div style={box}>
      <div style={{ fontWeight: 700 }}>{item.name}</div>
      <div>{`${formatCount(item.value)} sessions`}</div>
      <div style={{ color: theme.palette.text.secondary }}>
        {`${formatPct(item.pct)} of the ${formatCount(item.stepSessions)} sessions at step ${item.step + 1}`}
      </div>
    </div>
  );
}

const MARGIN = { top: 64, right: 200, bottom: 8, left: 8 };

export default function PathExplorationSankey({
  paths,
  pathStart,
  onPathStartChange,
  topN,
  onTopNChange,
}) {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("md"));
  const isDark = theme.palette.mode === "dark";
  const textColor = theme.palette.text.primary;
  const mutedColor = theme.palette.text.secondary;
  const [hover, setHover] = useState(null);

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

  // The whole journey under the pointer stays bright; everything else fades back.
  const journey = useMemo(() => highlightJourney(data?.links, hover), [data, hover]);

  const renderNode = (props) => {
    const { x, y, width, height, index, payload } = props;
    if (!payload) return null;
    const dimmed = journey && !journey.nodes.has(index);
    return (
      <g opacity={dimmed ? DIMMED_OPACITY : 1} style={{ transition: "opacity 0.15s ease" }}>
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
          style={{ cursor: "pointer" }}
          onMouseEnter={() => setHover({ type: "node", index })}
          onMouseLeave={() => setHover(null)}
        />
        <text
          x={x + width + 8}
          y={y + Math.max(height, 2) / 2 - 2}
          fontSize={12}
          fontWeight={600}
          fill={textColor}
          pointerEvents="none"
        >
          {payload.name}
        </text>
        <text
          x={x + width + 8}
          y={y + Math.max(height, 2) / 2 + 13}
          fontSize={11}
          fill={mutedColor}
          pointerEvents="none"
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
      index,
      payload,
    } = props;
    // Coloured by destination so each action reads the same everywhere.
    const color = payload?.target?.color || "#94a3b8";
    const base = isDark ? 0.6 : 0.5;
    const opacity = journey ? (journey.links.has(index) ? 0.85 : 0.06) : base;
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={color}
        strokeWidth={Math.max(linkWidth, 1)}
        strokeOpacity={opacity}
        style={{ transition: "stroke-opacity 0.15s ease", cursor: "pointer" }}
        onMouseEnter={() => setHover({ type: "link", index })}
        onMouseLeave={() => setHover(null)}
      />
    );
  };

  return (
    <SectionCard
      title="Funnel Exploration"
      info="Where sessions go next after each step, from recorded event sequences. Choose the starting event and how many of the most common paths to show per step. Hover a step or a flow to follow its whole journey. Percentages are the share of the sessions at that step. Splitting journeys by intent or product is not available yet."
      action={
        <Box
          sx={{
            display: "flex",
            flexDirection: { xs: "column", sm: "row" },
            flexWrap: "wrap",
            alignItems: { xs: "stretch", sm: "center" },
            gap: { xs: 1, md: 1.5 },
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
            label="Paths"
            value={topN}
            onChange={onTopNChange}
            options={PATH_COUNT_OPTIONS.map((n) => ({ value: n, label: `${n} paths` }))}
          />
          <ControlSelect
            label="Intent"
            value=""
            placeholder="Select intent"
            disabled
            options={INTENT_LEVEL_OPTIONS}
            hint="Splitting journeys by intent is not available yet"
          />
          <ControlSelect
            label="Products"
            value="top10"
            disabled
            options={PRODUCT_OPTIONS}
            hint="Splitting journeys by product is not available yet"
          />
        </Box>
      }
    >
      {data && paths?.coverage && paths.coverage.pct < 99.5 ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          Showing the most common paths, covering {formatPct(paths.coverage.pct, 0)} of{" "}
          {formatCount(paths.coverage.totalSessions)} sessions that started here. Percentages are the share
          of the sessions at each step.
        </Typography>
      ) : data ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          Percentages are the share of the sessions at each step.
        </Typography>
      ) : null}
      {data && phone ? (
        <PathStepList paths={paths} textColor={textColor} />
      ) : data ? (
        <Box sx={{ overflowX: "auto" }}>
          <Box sx={{ minWidth: 980, height: 460 }}>
            <ResponsiveContainer width="100%" height="100%">
              <Sankey
                data={data}
                node={renderNode}
                link={renderLink}
                nodePadding={32}
                nodeWidth={18}
                iterations={32}
                margin={MARGIN}
              >
                <ChartTooltip content={<PathTooltip />} />
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
