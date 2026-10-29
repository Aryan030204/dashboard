// Pure helpers for the "Funnel Exploration" card (no React or MUI imports, so node can test them).
// Each band is one product flowing through Product View -> Add to Cart -> Checkout Started.

export const FUNNEL_STEPS = [
  { key: "views", title: "Product View" },
  { key: "addToCart", title: "Add to Cart" },
  { key: "checkouts", title: "Checkout Started" },
];

export const TOP_PRODUCT_OPTIONS = [3, 5, 8];

// One colour per rank, so a product keeps its colour when other bands are hidden.
export const PRODUCT_COLORS = [
  "#3b82f6",
  "#f59e0b",
  "#8b5cf6",
  "#10b981",
  "#ef4444",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The `topN` most viewed products (ties broken by name), each with its steps and colour.
export function selectTopProducts(products, topN) {
  return [...(products || [])]
    .map((product) => ({
      id: String(product.id),
      name: product.name || `Product ${product.id}`,
      views: count(product.views),
      addToCart: count(product.addToCart),
      checkouts: count(product.checkouts),
    }))
    .filter((product) => product.views > 0)
    .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, Number(topN) || 0))
    .map((product, index) => ({ ...product, color: PRODUCT_COLORS[index % PRODUCT_COLORS.length] }));
}

// Share of the previous step that reached this one, or null when there is nothing to compare with.
export function stepRate(from, to) {
  const base = count(from);
  if (base <= 0) return null;
  return (count(to) / base) * 100;
}

function ribbonPath(x0, top0, bottom0, x1, top1, bottom1) {
  const mid = (x0 + x1) / 2;
  return [
    `M ${x0} ${top0}`,
    `C ${mid} ${top0}, ${mid} ${top1}, ${x1} ${top1}`,
    `L ${x1} ${bottom1}`,
    `C ${mid} ${bottom1}, ${mid} ${bottom0}, ${x0} ${bottom0}`,
    "Z",
  ].join(" ");
}

// Lays the bands out in SVG units. Columns are the steps; each column stacks the visible products top to
// bottom in rank order. Heights share one scale (the tallest column fills `plotHeight`), except that a
// non-zero value is never drawn thinner than `minNode`, so small values stay readable.
export function computeFunnelLayout(
  products,
  { width = 760, plotHeight = 300, nodeWidth = 16, gap = 8, minNode = 16, top = 48, bottom = 12, side = 8 } = {},
) {
  const steps = FUNNEL_STEPS;
  const columnX = steps.map(
    (_, index) => side + (index * (width - 2 * side - nodeWidth)) / (steps.length - 1),
  );

  const totals = steps.map((step) => products.reduce((sum, product) => sum + count(product[step.key]), 0));
  const maxTotal = Math.max(...totals, 0);
  const rows = Math.max(products.length, 1);
  const scale = maxTotal > 0 ? (plotHeight - gap * (rows - 1)) / maxTotal : 0;

  const nodes = [];
  const cursor = steps.map(() => top);
  products.forEach((product) => {
    steps.forEach((step, stepIndex) => {
      const value = count(product[step.key]);
      if (value <= 0) return;
      const height = Math.max(minNode, value * scale);
      nodes.push({
        productId: product.id,
        stepIndex,
        x: columnX[stepIndex],
        y: cursor[stepIndex],
        width: nodeWidth,
        height,
        value,
        color: product.color,
      });
      cursor[stepIndex] += height + gap;
    });
  });

  const byKey = new Map(nodes.map((node) => [`${node.productId}:${node.stepIndex}`, node]));
  const links = [];
  products.forEach((product) => {
    for (let stepIndex = 0; stepIndex < steps.length - 1; stepIndex += 1) {
      const from = byKey.get(`${product.id}:${stepIndex}`);
      const to = byKey.get(`${product.id}:${stepIndex + 1}`);
      if (!from || !to) continue;
      links.push({
        productId: product.id,
        fromStep: stepIndex,
        toStep: stepIndex + 1,
        value: to.value,
        color: product.color,
        d: ribbonPath(
          from.x + from.width,
          from.y,
          from.y + from.height,
          to.x,
          to.y,
          to.y + to.height,
        ),
      });
    }
  });

  const tallest = Math.max(...cursor.map((y) => y - gap), top);
  return { width, height: tallest + bottom, columnX, nodeWidth, nodes, links, steps, top };
}
