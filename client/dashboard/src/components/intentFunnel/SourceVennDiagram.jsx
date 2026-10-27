import { useId } from "react";
import { useTheme } from "@mui/material";
import {
  SOURCE_COLORS,
  VENN_GEOMETRY,
  formatValue,
  getRegionAnchor,
  regionIndices,
} from "./intentSourceOverlapUtils.js";

function truncate(text, max = 12) {
  const value = String(text || "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// Wraps `node` in one clip per circle index, so only the area shared by all of them is drawn / hit.
function clipped(indices, node, uid) {
  return indices.reduceRight(
    (child, index) => (
      <g key={index} clipPath={`url(#${uid}-c-${index})`}>
        {child}
      </g>
    ),
    node,
  );
}

// Three overlapping circles. The seven regions are hit-tested in layers (single circles at the bottom, the
// all-three centre on top) so a pointer always lands on the smallest region under it. Hovering a region (or
// its legend row) highlights exactly that region.
export default function SourceVennDiagram({ sources, regions, activeId, onActiveChange }) {
  const theme = useTheme();
  const uid = useId().replace(/:/g, "");
  const { width, height, radius, centers } = VENN_GEOMETRY;
  const circles = sources.slice(0, centers.length);

  const placed = regions
    .map((region) => ({ region, indices: regionIndices(region, circles) }))
    .filter((item) => item.indices.length > 0);
  const active = placed.find((item) => item.region.id === activeId) || null;
  const byDepth = [...placed].sort((a, b) => a.indices.length - b.indices.length);

  const hitShape = ({ region, indices }) => {
    const last = indices[indices.length - 1];
    const circle = (
      <circle
        cx={centers[last].x}
        cy={centers[last].y}
        r={radius}
        fill="#000"
        fillOpacity={0}
        pointerEvents="all"
        onMouseEnter={() => onActiveChange(region.id)}
        onMouseLeave={() => onActiveChange(null)}
      />
    );
    return <g key={region.id}>{clipped(indices.slice(0, -1), circle, uid)}</g>;
  };

  const highlight = () => {
    const leftOut = circles.map((_, index) => index).filter((index) => !active.indices.includes(index));
    const rect = (
      <rect
        width={width}
        height={height}
        fill={theme.palette.text.primary}
        fillOpacity={0.2}
        pointerEvents="none"
      />
    );
    return (
      <g pointerEvents="none">
        <mask id={`${uid}-hl`} maskUnits="userSpaceOnUse" x={0} y={0} width={width} height={height}>
          <rect width={width} height={height} fill="#fff" />
          {leftOut.map((index) => (
            <circle key={index} cx={centers[index].x} cy={centers[index].y} r={radius} fill="#000" />
          ))}
        </mask>
        <g mask={`url(#${uid}-hl)`}>{clipped(active.indices, rect, uid)}</g>
      </g>
    );
  };

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Venn diagram of visitors across ${circles.map((source) => source.label).join(", ")}`}
      style={{ width: "100%", height: "auto", maxWidth: 340, display: "block" }}
    >
      <defs>
        {circles.map((source, index) => (
          <clipPath key={source.key} id={`${uid}-c-${index}`}>
            <circle cx={centers[index].x} cy={centers[index].y} r={radius} />
          </clipPath>
        ))}
      </defs>

      {circles.map((source, index) => (
        <circle
          key={source.key}
          cx={centers[index].x}
          cy={centers[index].y}
          r={radius}
          fill={SOURCE_COLORS[index]}
          fillOpacity={0.2}
          stroke={SOURCE_COLORS[index]}
          strokeWidth={1.5}
          pointerEvents="none"
        />
      ))}

      {active ? highlight() : null}

      {byDepth.map(hitShape)}

      {placed.map(({ region, indices }) => {
        const anchor = getRegionAnchor(indices);
        if (!anchor) return null;
        const single = region.kind === "only";
        const empty = !region.value;
        return (
          <text
            key={region.id}
            x={anchor.x}
            y={anchor.y}
            textAnchor="middle"
            fill={theme.palette.text.primary}
            pointerEvents="none"
            opacity={empty ? 0.5 : 1}
          >
            {single ? (
              <>
                <tspan x={anchor.x} dy="-0.3em" fontSize={11} fill={theme.palette.text.secondary}>
                  {truncate(circles[indices[0]].label)}
                </tspan>
                <tspan x={anchor.x} dy="1.35em" fontSize={15} fontWeight={700}>
                  {formatValue(region.value)}
                </tspan>
              </>
            ) : (
              <tspan fontSize={13} fontWeight={700} dy="0.35em">
                {formatValue(region.value)}
              </tspan>
            )}
          </text>
        );
      })}
    </svg>
  );
}
