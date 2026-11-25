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
  series: "#10b981",
  pay1: "#2cc995",
  pay2: "#1f5748",
  pay3: "#8da399",
};

export const DARK = {
  bg: "#0F1117",
  side: "#12141B",
  panel: "#171A22",
  sunk: "#12141B",
  hover: "#1D212B",
  line: "#262B36",
  "line-2": "#343A48",
  text: "#E6E8EE",
  "text-2": "#BAC0CD",
  muted: "#8B93A5",
  accent: "#8FA6E3",
  "accent-hi": "#A6B9EC",
  "accent-soft": "rgba(143, 166, 227, 0.14)",
  "accent-ink": "#0E1220",
  "accent-line": "rgba(143, 166, 227, 0.45)",
  good: "#6CC49A",
  bad: "#E88A86",
  warn: "#D9B36C",
  info: "#7FB4D9",
  "good-bg": "rgba(108, 196, 154, 0.13)",
  "bad-bg": "rgba(232, 138, 134, 0.13)",
  "warn-bg": "rgba(217, 179, 108, 0.13)",
  "info-bg": "rgba(127, 180, 217, 0.13)",
  c1: "#6F9BE0",
  c2: "#E0956B",
  c3: "#5FB8A5",
  c4: "#D4B061",
  c5: "#C98BB5",
  c6: "#8F87D6",
  prev: "#4A5163",
  grid: "#1E222C",
  scrim: "rgba(0, 0, 0, 0.6)",
  shadow: "none",
  series: "#8FA6E3",
  pay1: "#8FA6E3",
  pay2: "#5B6DAA",
  pay3: "#B4BCD1",
};

export const FONT_SANS = '"Geist", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';
export const FONT_MONO = '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

export const getTokens = (mode) => (mode === "dark" ? DARK : LIGHT);

// Series colors for charts (read-only helper; chart data is never touched).
export const chartSeries = (mode) => {
  const t = getTokens(mode);
  return [t.c1, t.c2, t.c3, t.c4, t.c5, t.c6];
};
