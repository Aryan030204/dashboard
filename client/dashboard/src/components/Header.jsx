import {
  AppBar,
  Toolbar,
  Box,
  Button,
  IconButton,
  useTheme,
  useMediaQuery,
  Tooltip,
  Typography,
  ButtonBase,
} from "@mui/material";
import { useEffect, useState } from "react";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import bridge from "dayjs/plugin/utc"; // Using a different name to avoid collision if needed, but 'utc' is standard
import customParseFormat from "dayjs/plugin/customParseFormat";
import { getLastUpdatedPTS } from "../lib/api.js";
import {
  SlidersHorizontal,
  LogOut,
  Menu,
} from "lucide-react";
import SkyToggle from "./ui/SkyToggle.jsx";
import LayoutPanelsIcon from "./ui/LayoutPanelsIcon.jsx";
import NotificationsMenu from "./NotificationsMenu.jsx";

export default function Header({
  user,
  onLogout,
  onMenuClick,
  showMenuButton = false,
  darkMode = false,
  onToggleDarkMode,
  onFilterClick,
  onTabChange, // Added
  showFilterButton = false,
  showCustomizeButton = false,
  onCustomizeLayoutClick,
  isAdmin = false,
  brandKey = "",
  pageTitle = "", // breadcrumb = current page title only
}) {
  dayjs.extend(relativeTime);
  dayjs.extend(customParseFormat);

  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  const [last, setLast] = useState({ loading: true, ts: null, tz: null });

  useEffect(() => {
    let cancelled = false;
    const normalizedKey = (brandKey || "").toString().trim().toUpperCase();
    setLast({ loading: true, ts: null, tz: null });
    getLastUpdatedPTS(normalizedKey ? { brandKey: normalizedKey } : undefined)
      .then((r) => {
        if (cancelled) return;
        let parsed = null;
        const sources = [];
        if (r.iso) sources.push(r.iso);
        if (r.raw) sources.push(r.raw);
        for (const src of sources) {
          if (parsed) break;
          const cleaned =
            typeof src === "string" ? src.replace(/ IST$/, "").trim() : src;
          if (!cleaned) continue;
          if (typeof cleaned === "string") {
            const formats = [
              "YYYY-MM-DDTHH:mm:ss.SSSZ",
              "YYYY-MM-DDTHH:mm:ssZ",
              "YYYY-MM-DD hh:mm:ss A",
              "YYYY-MM-DD HH:mm:ss",
              "YYYY-MM-DD hh:mm A",
            ];
            for (const f of formats) {
              const d = dayjs(cleaned, f, true);
              if (d.isValid()) {
                parsed = d;
                break;
              }
            }
            if (!parsed) {
              const auto = dayjs(cleaned);
              if (auto.isValid()) parsed = auto;
            }
          } else if (cleaned instanceof Date) {
            const auto = dayjs(cleaned);
            if (auto.isValid()) parsed = auto;
          }
        }
        setLast((prev) => ({
          loading: false,
          ts: parsed || prev.ts,
          tz: r.timezone || prev.tz || null,
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setLast((prev) => ({ loading: false, ts: prev.ts, tz: prev.tz }));
      });
    return () => {
      cancelled = true;
    };
  }, [brandKey]);

  // "Updated ..." indicator: same states and same data as before (loading / timestamp / unavailable).
  const updatedNode = last.loading ? (
    <span className="dz-live is-idle">Updating…</span>
  ) : last.ts ? (
    <Tooltip
      title={`${last.ts.format("YYYY-MM-DD HH:mm:ss")}${last.tz ? ` ${last.tz}` : ""}`}
      arrow
    >
      <span className="dz-live">Updated {last.ts.fromNow()}</span>
    </Tooltip>
  ) : (
    <span className="dz-live is-idle">Updated: unavailable</span>
  );

  return (
    <AppBar
      position="static"
      color="transparent"
      elevation={0}
      sx={{
        bgcolor: "transparent",
        borderBottom: "1px solid",
        borderBottomColor: "var(--dz-line)",
        px: { xs: 1, md: 4 },
        py: 0,
      }}
    >
      <Toolbar
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: { xs: 56, md: 56 },
          p: 0,
          position: "relative",
        }}
      >
        {isMobile ? (
          <>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-start",
                gap: 1.5,
                zIndex: 2,
              }}
            >
              {showMenuButton ? (
                <IconButton
                  onClick={onMenuClick}
                  size="small"
                  sx={{
                    color: "var(--dz-text)",
                    bgcolor: "var(--dz-panel)",
                    border: "1px solid",
                    borderColor: "var(--dz-line-2)",
                    borderRadius: "8px",
                    p: 0.8,
                  }}
                >
                  <Menu size={18} />
                </IconButton>
              ) : null}
              {pageTitle ? (
                <Typography
                  component="span"
                  sx={{ fontSize: 15, fontWeight: 600, color: "var(--dz-text)" }}
                >
                  {pageTitle}
                </Typography>
              ) : (
                <Box
                  component="img"
                  src="/brand-logo-dark.png"
                  alt="Brand"
                  sx={{
                    height: 48,
                    width: "auto",
                    filter: darkMode
                      ? "invert(1) hue-rotate(180deg) brightness(1.2)"
                      : "none",
                  }}
                />
              )}
            </Box>

            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                ml: "auto",
                zIndex: 2,
              }}
            >
              {isAdmin && (
                <NotificationsMenu
                  darkMode={darkMode}
                  onTabChange={onTabChange}
                />
              )}

              {showFilterButton && (
                <IconButton
                  onClick={onFilterClick}
                  size="small"
                  sx={{
                    color: "var(--dz-text)",
                    bgcolor: "var(--dz-panel)",
                    border: "1px solid",
                    borderColor: "var(--dz-line-2)",
                    borderRadius: "8px",
                    p: 0.8,
                  }}
                >
                  <SlidersHorizontal size={18} />
                </IconButton>
              )}

              {showCustomizeButton && (
                <Tooltip title="Customize Layout">
                  <ButtonBase
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onCustomizeLayoutClick?.();
                    }}
                    sx={{
                      width: 34,
                      height: 34,
                      borderRadius: "8px",
                      color: "var(--dz-text)",
                      bgcolor: "var(--dz-panel)",
                      border: "1px solid",
                      borderColor: "var(--dz-line-2)",
                    }}
                  >
                    <LayoutPanelsIcon size={18} />
                  </ButtonBase>
                </Tooltip>
              )}

              <SkyToggle checked={darkMode} onChange={onToggleDarkMode} />
              <IconButton
                onClick={onLogout}
                size="small"
                sx={{ color: "var(--dz-bad)" }}
              >
                <LogOut size={20} />
              </IconButton>
            </Box>
          </>
        ) : (
          <>
            <Box component="nav" aria-label="Breadcrumb" sx={{ minWidth: 0 }}>
              <Typography
                component="span"
                aria-current="page"
                sx={{ fontSize: 14, fontWeight: 600, color: "var(--dz-text)" }}
              >
                {pageTitle}
              </Typography>
            </Box>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: { xs: 1, md: 1.5 },
              }}
            >
              {updatedNode}

              {/* Notifications - Only for admins */}
              {isAdmin && (
                <NotificationsMenu
                  darkMode={darkMode}
                  onTabChange={onTabChange}
                />
              )}

              {/* Theme Toggle */}
              <SkyToggle checked={darkMode} onChange={onToggleDarkMode} />

              {/* Logout - Only for non-admins (admins have it in sidebar) */}
              {!isAdmin && (
                <Tooltip title="Logout">
                  <IconButton
                    onClick={onLogout}
                    size="small"
                    sx={{
                      bgcolor: "var(--dz-bad-bg)",
                      borderRadius: "10px",
                      p: 1.2,
                      color: "var(--dz-bad)",
                      "&:hover": { bgcolor: "var(--dz-bad-bg)", opacity: 0.85 },
                    }}
                  >
                    <LogOut size={20} />
                  </IconButton>
                </Tooltip>
              )}

              {/* Brand logo - Only for admins (unchanged) */}
              {isAdmin && (
                <Box sx={{ ml: 1 }}>
                  <img
                    src="/brand-logo.jpg"
                    alt="TechIt"
                    style={{
                      height: "36px",
                      width: "auto",
                      objectFit: "contain",
                      opacity: 0.9,
                      filter: darkMode
                        ? "invert(1) hue-rotate(180deg) brightness(1.5)"
                        : "none",
                    }}
                  />
                </Box>
              )}
            </Box>
          </>
        )}
      </Toolbar>
    </AppBar>
  );
}
