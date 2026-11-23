// Datum design tokens, JS mirror of src/styles/datum-tokens.css.
// MUI cannot read CSS variables for palette math (alpha(), lighten()), so the MUI theme is built from these values.
// src/design/tokens.parity.node.test.js asserts this file and the CSS never drift apart.
// Keep this file free of imports (it is loaded by `node --test`).

export const LIGHT = {
  bg: "#F5F6F5",
  side: "#FBFCFB",
  panel: "#FFFFFF",
  sunk: "#F1F3F2",
  hover: "#F4F6F5",
  line: "#E3E7E5",
  "line-2": "#D1D8D4",
  text: "#0E1712",
  "text-2": "#3A4741",
  muted: "#5D6B64",
  accent: "#0F7A50",
  "accent-hi": "#0B6341",
  "accent-soft": "#E6F2EC",
  "accent-ink": "#FFFFFF",
  "accent-line": "#9FCDB7",
  good: "#127A4A",
  bad: "#C0392B",
  warn: "#8F5E00",
  info: "#1F5FC4",
  "good-bg": "#E5F3EB",
  "bad-bg": "#FBEAE7",
  "warn-bg": "#FBF1DD",
  "info-bg": "#E8EFFB",
  c1: "#2a78d6",
  c2: "#eb6834",
  c3: "#1baf7a",
  c4: "#eda100",
  c5: "#e87ba4",
  c6: "#008300",
  prev: "#B5BFBA",
  grid: "#EDF0EE",
  scrim: "rgba(14, 23, 18, 0.42)",
  shadow: "0 1px 2px rgba(14, 23, 18, 0.05)",
};

export const DARK = {
  bg: "#0A0D0B",
  side: "#0D110F",
  panel: "#111614",
  sunk: "#0C100E",
  hover: "#161D19",
  line: "#1E2823",
  "line-2": "#2B3731",
  text: "#E8EEEA",
  "text-2": "#B5C1BA",
  muted: "#8E9C95",
  accent: "#3FB68B",
  "accent-hi": "#5CC9A0",
  "accent-soft": "rgba(63, 182, 139, 0.13)",
  "accent-ink": "#04130C",
  "accent-line": "rgba(63, 182, 139, 0.45)",
  good: "#4CC38A",
  bad: "#F07A6E",
  warn: "#E5B04B",
  info: "#6EA8FE",
  "good-bg": "rgba(76, 195, 138, 0.13)",
  "bad-bg": "rgba(240, 122, 110, 0.13)",
  "warn-bg": "rgba(229, 176, 75, 0.13)",
  "info-bg": "rgba(110, 168, 254, 0.13)",
  c1: "#3987e5",
  c2: "#d95926",
  c3: "#199e70",
  c4: "#c98500",
  c5: "#d55181",
  c6: "#0ca30c",
  prev: "#4F5E56",
  grid: "#19221E",
  scrim: "rgba(0, 0, 0, 0.6)",
  shadow: "none",
};

export const FONT_SANS = '"Geist", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export const getTokens = (mode) => (mode === "dark" ? DARK : LIGHT);

// Series colors for charts (read-only helper; chart data is never touched).
export const chartSeries = (mode) => {
  const t = getTokens(mode);
  return [t.c1, t.c2, t.c3, t.c4, t.c5, t.c6];
};
