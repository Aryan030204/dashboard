import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, CircularProgress, IconButton, Skeleton, Tooltip, Typography } from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import useSlideImages from "./useSlideImages.js";

const INK = "#0b1220";
const PANEL = "#111a2e";
const EDGE = "rgba(255,255,255,0.12)";

function Thumb({ n, active, url, onVisible, onSelect, onRetry }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      onVisible(n);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onVisible(n);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [n, onVisible]);

  return (
    <Box
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={`Go to slide ${n}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(n)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(n);
        }
      }}
      sx={{
        position: "relative",
        flex: "0 0 auto",
        width: { xs: 96, md: "100%" },
        aspectRatio: "16 / 9",
        borderRadius: 1,
        overflow: "hidden",
        cursor: "pointer",
        border: `2px solid ${active ? "#4aa3ff" : EDGE}`,
        bgcolor: PANEL,
        outline: "none",
        "&:focus-visible": { boxShadow: "0 0 0 2px #4aa3ff" },
      }}
    >
      {url && url !== "error" ? (
        <img
          src={url}
          alt=""
          draggable={false}
          onContextMenu={(e) => e.preventDefault()}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : url === "error" ? (
        <Button size="small" onClick={(e) => { e.stopPropagation(); onRetry(n); }} sx={{ color: "#9db2d1", minWidth: 0, width: "100%", height: "100%" }}>
          Retry
        </Button>
      ) : (
        <Skeleton variant="rectangular" width="100%" height="100%" sx={{ bgcolor: "rgba(255,255,255,0.06)" }} />
      )}
      <Typography
        variant="caption"
        sx={{ position: "absolute", left: 4, bottom: 2, px: 0.5, borderRadius: 0.5, bgcolor: "rgba(0,0,0,0.6)", color: "#fff", lineHeight: 1.4 }}
      >
        {n}
      </Typography>
    </Box>
  );
}

// Full-screen-style slide viewer. Slides arrive as images through the authorized API; there is
// no download, share, print or open-original control, and image dragging / the context menu are
// disabled on slides. Those are deterrents only: a viewer can still screenshot (see the PRD).
export default function PresentationViewer({ brandKey, report, onClose }) {
  const total = Number(report.slide_count) || 0;
  const [current, setCurrent] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rootRef = useRef(null);
  const touchStartX = useRef(null);
  const { urls, request, retry } = useSlideImages({ brandKey, reportId: report.id, slideCount: total, current });

  const go = useCallback((n) => setCurrent((c) => Math.min(total, Math.max(1, typeof n === "function" ? n(c) : n))), [total]);
  const next = useCallback(() => go((c) => c + 1), [go]);
  const prev = useCallback(() => go((c) => c - 1), [go]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
        case " ":
          e.preventDefault();
          next();
          break;
        case "ArrowLeft":
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          e.preventDefault();
          go(1);
          break;
        case "End":
          e.preventDefault();
          go(total);
          break;
        case "f":
        case "F":
          toggleFullscreen();
          break;
        case "Escape":
          // In fullscreen the browser consumes Esc to leave fullscreen first.
          if (!document.fullscreenElement) onClose();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev, go, total, toggleFullscreen, onClose]);

  // Lock page scroll behind the viewer.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (document.fullscreenElement) document.exitFullscreen?.();
    };
  }, []);

  const onTouchStart = (e) => { touchStartX.current = e.touches[0].clientX; };
  const onTouchEnd = (e) => {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) > 50) (dx < 0 ? next : prev)();
  };

  const requestThumb = useCallback((n) => request(n, true), [request]);
  const retryThumb = useCallback((n) => retry(n, true), [retry]);
  const currentUrl = urls[`f${current}`];

  return (
    <Box
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${report.title}, ${report.reporting_week}`}
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 1600,
        display: "flex",
        flexDirection: "column",
        bgcolor: INK,
        color: "#fff",
        "@media print": { display: "none" },
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1, borderBottom: `1px solid ${EDGE}` }}>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography noWrap sx={{ fontWeight: 700 }}>{report.title}</Typography>
          <Typography variant="caption" sx={{ color: "#9db2d1" }}>{report.reporting_week}</Typography>
        </Box>
        <Tooltip title={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}>
          <IconButton onClick={toggleFullscreen} aria-label="Toggle fullscreen" sx={{ color: "#fff" }}>
            {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
          </IconButton>
        </Tooltip>
        <Tooltip title="Close (Esc)">
          <IconButton onClick={onClose} aria-label="Close viewer" sx={{ color: "#fff" }}>
            <CloseIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: { xs: "column-reverse", md: "row" } }}>
        <Box
          component="nav"
          aria-label="Slides"
          sx={{
            flex: "0 0 auto",
            display: "flex",
            flexDirection: { xs: "row", md: "column" },
            gap: 1,
            p: 1,
            width: { md: 168 },
            overflow: "auto",
            borderRight: { md: `1px solid ${EDGE}` },
            borderTop: { xs: `1px solid ${EDGE}`, md: "none" },
          }}
        >
          {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
            <Thumb
              key={n}
              n={n}
              active={n === current}
              url={urls[`t${n}`]}
              onVisible={requestThumb}
              onSelect={go}
              onRetry={retryThumb}
            />
          ))}
        </Box>

        <Box
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          sx={{ position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", p: { xs: 1, md: 2 } }}
        >
          <Box sx={{ position: "relative", flex: 1, minHeight: 0, width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {currentUrl && currentUrl !== "error" ? (
              <img
                key={current}
                src={currentUrl}
                alt={`Slide ${current} of ${total}`}
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", userSelect: "none", borderRadius: 4, background: "#fff" }}
              />
            ) : currentUrl === "error" ? (
              <Box sx={{ textAlign: "center" }}>
                <Typography sx={{ mb: 1 }}>This slide could not be loaded.</Typography>
                <Button variant="outlined" onClick={() => retry(current, false)} sx={{ color: "#fff", borderColor: EDGE }}>Retry</Button>
              </Box>
            ) : (
              <CircularProgress aria-label="Loading slide" sx={{ color: "#4aa3ff" }} />
            )}

            <IconButton
              onClick={prev}
              disabled={current <= 1}
              aria-label="Previous slide"
              sx={{ position: "absolute", left: 4, color: "#fff", bgcolor: "rgba(0,0,0,0.35)", "&:hover": { bgcolor: "rgba(0,0,0,0.55)" }, "&.Mui-disabled": { opacity: 0.25, color: "#fff" } }}
            >
              <ChevronLeftIcon />
            </IconButton>
            <IconButton
              onClick={next}
              disabled={current >= total}
              aria-label="Next slide"
              sx={{ position: "absolute", right: 4, color: "#fff", bgcolor: "rgba(0,0,0,0.35)", "&:hover": { bgcolor: "rgba(0,0,0,0.55)" }, "&.Mui-disabled": { opacity: 0.25, color: "#fff" } }}
            >
              <ChevronRightIcon />
            </IconButton>
          </Box>

          <Typography aria-live="polite" sx={{ mt: 1, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
            {current} / {total}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
