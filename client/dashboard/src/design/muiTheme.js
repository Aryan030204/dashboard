import { createTheme } from "@mui/material/styles";
import { getTokens, FONT_SANS, FONT_MONO } from "./tokens.js";

// MUI theme built from the Datum tokens. Presentation only:
// it changes how existing MUI components look, never what they do.
// `mode` is "light" | "dark" (the same string App.jsx keeps in its `darkMode` state).
export function createDatumTheme(mode = "light") {
  const isDark = mode === "dark";
  const t = getTokens(mode);

  return createTheme({
    palette: {
      mode: isDark ? "dark" : "light",
      primary: { main: t.accent, dark: t["accent-hi"], contrastText: t["accent-ink"] },
      success: { main: t.good },
      error: { main: t.bad },
      warning: { main: t.warn },
      info: { main: t.info },
      background: { default: t.bg, paper: t.panel },
      text: { primary: t.text, secondary: t.muted, disabled: isDark ? "#626A7B" : "#9aa6a0" },
      divider: t.line,
      action: { hover: t.hover, selected: t["accent-soft"] },
    },
    shape: { borderRadius: 8 },
    typography: {
      fontFamily: FONT_SANS,
      fontSize: 14,
      h1: { fontWeight: 650, letterSpacing: "-0.025em" },
      h2: { fontWeight: 650, letterSpacing: "-0.025em" },
      h3: { fontWeight: 650, letterSpacing: "-0.02em" },
      h4: { fontWeight: 650, letterSpacing: "-0.02em" },
      h5: { fontWeight: 650, letterSpacing: "-0.02em" },
      h6: { fontWeight: 600, letterSpacing: "-0.01em" },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      button: { textTransform: "none", fontWeight: 550 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: t.bg,
            color: t.text,
            WebkitFontSmoothing: "antialiased",
            fontVariantNumeric: "tabular-nums",
          },
          "code, kbd, pre, samp": { fontFamily: FONT_MONO },
          ":focus-visible": { outline: `2px solid ${t.accent}`, outlineOffset: 2 },
        },
      },
      // Flat bordered panels: no glass, no blur, no hover lift.
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundColor: t.panel,
            backgroundImage: "none",
            border: `1px solid ${t.line}`,
            borderRadius: 12,
            boxShadow: t.shadow,
            backdropFilter: "none",
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: "none", backdropFilter: "none" },
          outlined: { borderColor: t.line },
          rounded: { borderRadius: 12 },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            border: `1px solid ${t["line-2"]}`,
            borderRadius: 10,
            boxShadow: "0 6px 20px rgba(0,0,0,.12)",
            backgroundColor: t.panel,
          },
        },
      },
      MuiMenu: {
        styleOverrides: { paper: { borderRadius: 10 } },
      },
      MuiMenuItem: {
        styleOverrides: { root: { fontSize: 13, minHeight: 36 } },
      },
      MuiDialog: {
        styleOverrides: {
          paper: { borderRadius: 14, border: `1px solid ${t.line}`, backgroundColor: t.panel },
        },
      },
      MuiDrawer: {
        styleOverrides: { paper: { backgroundColor: t.side, backgroundImage: "none" } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { borderRadius: 8, textTransform: "none", fontWeight: 550, fontSize: 13 },
          sizeSmall: { fontSize: 12.5 },
          outlined: {
            borderColor: t["line-2"],
            color: t.text,
            backgroundColor: t.panel,
            "&:hover": { backgroundColor: t.hover, borderColor: t["line-2"] },
          },
          containedPrimary: {
            backgroundColor: t.accent,
            color: t["accent-ink"],
            "&:hover": { backgroundColor: t["accent-hi"] },
          },
          text: { "&:hover": { backgroundColor: t.hover } },
        },
      },
      MuiIconButton: {
        styleOverrides: { root: { borderRadius: 8, "&:hover": { backgroundColor: t.hover } } },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 6, fontWeight: 600, fontSize: 12 },
          sizeSmall: { fontSize: 11, height: 22 },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            backgroundColor: isDark ? t["line-2"] : t.text,
            color: isDark ? t.text : t.panel,
            fontSize: 12,
            borderRadius: 6,
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            fontSize: 13,
            backgroundColor: t.panel,
            "& .MuiOutlinedInput-notchedOutline": { borderColor: t["line-2"] },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: t.muted },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: t.accent, borderWidth: 1 },
          },
        },
      },
      MuiInputLabel: { styleOverrides: { root: { fontSize: 13 } } },
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40, borderBottom: `1px solid ${t.line}` },
          indicator: { backgroundColor: t.accent, height: 2 },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: "none",
            fontWeight: 550,
            fontSize: 13,
            minHeight: 40,
            color: t.muted,
            "&.Mui-selected": { color: t.text },
          },
        },
      },
      // Segmented-control look for existing ToggleButtonGroups.
      MuiToggleButtonGroup: {
        styleOverrides: {
          root: {
            backgroundColor: t.sunk,
            border: `1px solid ${t.line}`,
            borderRadius: 9,
            padding: 3,
            gap: 2,
          },
          grouped: {
            border: 0,
            borderRadius: 6,
            margin: 0,
            "&:not(:first-of-type)": { borderRadius: 6, marginLeft: 0, borderLeft: 0 },
            "&:not(:last-of-type)": { borderRadius: 6 },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            textTransform: "none",
            fontSize: 12.5,
            fontWeight: 550,
            color: t.muted,
            border: 0,
            "&.Mui-selected": {
              backgroundColor: t.panel,
              color: t.text,
              boxShadow: `0 0 0 1px ${t["line-2"]}`,
              "&:hover": { backgroundColor: t.panel },
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: { borderBottom: `1px solid ${t.line}`, fontSize: 13, fontVariantNumeric: "tabular-nums" },
          head: {
            backgroundColor: t.sunk,
            color: t.muted,
            fontSize: 11.5,
            fontWeight: 600,
            whiteSpace: "nowrap",
          },
          sizeSmall: { padding: "8px 14px" },
        },
      },
      MuiTableRow: {
        styleOverrides: { root: { "&.MuiTableRow-hover:hover": { backgroundColor: t.hover } } },
      },
      MuiTablePagination: {
        styleOverrides: {
          root: { fontSize: 12.5, color: t.muted, borderTop: `1px solid ${t.line}` },
          selectLabel: { fontSize: 12.5 },
          displayedRows: { fontSize: 12.5 },
        },
      },
      MuiLinearProgress: {
        styleOverrides: {
          root: { height: 6, borderRadius: 3, backgroundColor: t.sunk },
          bar: { borderRadius: 3 },
        },
      },
      MuiSkeleton: { styleOverrides: { root: { backgroundColor: t.sunk } } },
      MuiAlert: { styleOverrides: { root: { borderRadius: 10 } } },
      MuiLink: { styleOverrides: { root: { color: t.accent } } },
      MuiDivider: { styleOverrides: { root: { borderColor: t.line } } },
    },
  });
}
