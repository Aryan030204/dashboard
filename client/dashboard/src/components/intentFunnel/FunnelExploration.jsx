import { useMemo, useState } from "react";
import {
  Box,
  Checkbox,
  MenuItem,
  Select,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { SectionCard } from "./shared.jsx";
import { INTENT_FILTER_OPTIONS, formatCount, formatPct } from "./intentFunnelUtils.js";
import {
  FUNNEL_STEPS,
  TOP_PRODUCT_OPTIONS,
  computeFunnelLayout,
  selectTopProducts,
  stepRate,
} from "./funnelExplorationUtils.js";

const INFO =
  "How the most viewed products move from product view to add to cart to checkout. Each coloured band is one product; use the checkboxes to show or hide a band. Product numbers cannot be split by intent yet, so the intent filter is fixed to all users.";

const INTENT_NOTE = "Product data can't be split by intent yet";

function rateText(product, step) {
  const rate = stepRate(product.views, product[step.key]);
  return rate == null ? "" : ` (${formatPct(rate)} of product views)`;
}

function Legend({ selected, hidden, onToggle }) {
  return (
    <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0 }}>
      {selected.map((product, index) => {
        const checked = !hidden.has(product.id);
        return (
          <Box
            component="li"
            key={product.id}
            sx={{ display: "flex", alignItems: "center", gap: 0.5, py: 0.25, minWidth: 0 }}
          >
            <Checkbox
              size="small"
              checked={checked}
              onChange={() => onToggle(product.id)}
              inputProps={{ "aria-label": `Show ${product.name}` }}
              sx={{ p: 0.5, color: product.color, "&.Mui-checked": { color: product.color } }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
              Path {index + 1}
            </Typography>
            <Typography
              variant="body2"
              noWrap
              title={product.name}
              sx={{ flex: 1, minWidth: 0, opacity: checked ? 1 : 0.5 }}
            >
              {product.name}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600, opacity: checked ? 1 : 0.5 }}>
              {formatCount(product.views)}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

function FunnelChart({ products }) {
  const theme = useTheme();
  const layout = useMemo(() => computeFunnelLayout(products), [products]);
  const byId = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const lastStep = FUNNEL_STEPS.length - 1;

  return (
    <Box sx={{ width: "100%", overflowX: "auto" }}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="Funnel Exploration: each product's journey from product view to add to cart to checkout"
        style={{ width: "100%", minWidth: 520, height: "auto", display: "block" }}
      >
        {FUNNEL_STEPS.map((step, index) => {
          const x = layout.columnX[index];
          const anchor = index === 0 ? "start" : index === lastStep ? "end" : "middle";
          const textX = index === 0 ? x : index === lastStep ? x + layout.nodeWidth : x + layout.nodeWidth / 2;
          return (
            <text key={step.key} x={textX} textAnchor={anchor} fill={theme.palette.text.primary}>
              <tspan x={textX} y={14} fontSize={11} fill={theme.palette.text.secondary}>
                Step {index + 1}
              </tspan>
              <tspan x={textX} y={30} fontSize={12} fontWeight={700}>
                {step.title}
              </tspan>
            </text>
          );
        })}

        {layout.links.map((link) => {
          const product = byId.get(link.productId);
          const from = FUNNEL_STEPS[link.fromStep];
          const to = FUNNEL_STEPS[link.toStep];
          return (
            <path
              key={`${link.productId}-${link.fromStep}`}
              d={link.d}
              fill={link.color}
              fillOpacity={0.35}
            >
              <title>
                {`${product.name}: ${formatCount(product[from.key])} ${from.title} → ${formatCount(
                  product[to.key],
                )} ${to.title}`}
              </title>
            </path>
          );
        })}

        {layout.nodes.map((node) => {
          const product = byId.get(node.productId);
          const step = FUNNEL_STEPS[node.stepIndex];
          const onRight = node.stepIndex === lastStep;
          return (
            <g key={`${node.productId}-${node.stepIndex}`}>
              <rect
                x={node.x}
                y={node.y}
                width={node.width}
                height={node.height}
                rx={2}
                fill={node.color}
              >
                <title>
                  {`${product.name} · ${step.title}: ${formatCount(node.value)}${
                    node.stepIndex > 0 ? rateText(product, step) : ""
                  }`}
                </title>
              </rect>
              <text
                x={onRight ? node.x - 6 : node.x + node.width + 6}
                y={node.y + node.height / 2 + 4}
                textAnchor={onRight ? "end" : "start"}
                fontSize={12}
                fontWeight={700}
                fill={theme.palette.text.primary}
                stroke={theme.palette.background.paper}
                strokeWidth={3}
                paintOrder="stroke"
                pointerEvents="none"
              >
                {formatCount(node.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </Box>
  );
}

// Phones: the wide drawing does not fit, so each product is a small card with its three steps.
function PhoneList({ products }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
      {products.map((product) => (
        <Box
          key={product.id}
          sx={{
            borderLeft: `4px solid ${product.color}`,
            pl: 1.25,
            py: 0.5,
          }}
        >
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {product.name}
          </Typography>
          {FUNNEL_STEPS.map((step, index) => (
            <Box key={step.key} sx={{ display: "flex", justifyContent: "space-between", gap: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {step.title}
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                {formatCount(product[step.key])}
                {index > 0 ? rateText(product, step) : ""}
              </Typography>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// `products` are the rows of the page's top-products list ({ id, name, views, addToCart, checkouts }).
// `rankedByViews` is false when that list was sorted another way, so the top N is among those rows only.
export default function FunnelExploration({ products, rankedByViews = true }) {
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("md"));
  const [topN, setTopN] = useState(5);
  const [hidden, setHidden] = useState(() => new Set());

  const selected = useMemo(() => selectTopProducts(products, topN), [products, topN]);
  const visible = useMemo(
    () => selected.filter((product) => !hidden.has(product.id)),
    [selected, hidden],
  );

  const toggle = (id) =>
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const controls = (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
      <Tooltip title={INTENT_NOTE} arrow>
        <Box component="span">
          <Select
            size="small"
            value="all"
            onChange={() => {}}
            inputProps={{ "aria-label": "Intent filter" }}
            sx={{ minWidth: 130, fontSize: 13, "& .MuiSelect-select": { py: 0.5 } }}
          >
            {INTENT_FILTER_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value} disabled={option.disabled} dense>
                {option.label}
              </MenuItem>
            ))}
          </Select>
        </Box>
      </Tooltip>
      <Select
        size="small"
        value={topN}
        onChange={(event) => setTopN(Number(event.target.value))}
        inputProps={{ "aria-label": "Number of products" }}
        sx={{ minWidth: 130, fontSize: 13, "& .MuiSelect-select": { py: 0.5 } }}
      >
        {TOP_PRODUCT_OPTIONS.map((option) => (
          <MenuItem key={option} value={option} dense>
            Top {option} Products
          </MenuItem>
        ))}
      </Select>
    </Box>
  );

  let body;
  if (selected.length === 0) {
    body = (
      <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
        No product views for the selected date range.
      </Typography>
    );
  } else {
    body = (
      <Box
        sx={{
          display: "grid",
          gap: 2,
          gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "260px minmax(0, 1fr)" },
          alignItems: "start",
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Legend selected={selected} hidden={hidden} onToggle={toggle} />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
            {rankedByViews
              ? `Top ${topN} products by product views.`
              : `Top ${topN} by product views among the products in the table above.`}
          </Typography>
        </Box>
        {visible.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
            Select at least one product to see its journey.
          </Typography>
        ) : isPhone ? (
          <PhoneList products={visible} />
        ) : (
          <FunnelChart products={visible} />
        )}
      </Box>
    );
  }

  return (
    <SectionCard title="Funnel Exploration" info={INFO} action={controls}>
      {body}
    </SectionCard>
  );
}
