import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  IconButton,
  Typography,
} from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import { fetchWeeklyReportSlide, weeklyReportErrorMessage } from "../../../lib/api.js";

const THUMB_WIDTH = 128;

// Slides are authenticated WebP images, so they are fetched as blobs and shown
// through object URLs. This keeps a per-report cache and revokes every URL when
// the report changes or the viewer unmounts.
function useSlideCache({ brandKey, reportId }) {
  const cacheRef = useRef(new Map());
  const controllerRef = useRef(null);
  const [, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const cache = cacheRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => {
      controller.abort();
      cache.forEach((entry) => {
        if (entry.url) URL.revokeObjectURL(entry.url);
      });
      cache.clear();
    };
  }, [brandKey, reportId]);

  const ensure = useCallback(
    (slide, thumb = false) => {
      const key = `${thumb ? "t" : "f"}${slide}`;
      const cache = cacheRef.current;
      const controller = controllerRef.current;
      if (cache.has(key) || !controller || controller.signal.aborted) return;
      cache.set(key, { status: "loading" });
      fetchWeeklyReportSlide({ brandKey, id: reportId, slide, thumb, signal: controller.signal }).then(
        (res) => {
          if (controller.signal.aborted) return;
          if (res.error) {
            cache.set(key, {
              status: "error",
              message: weeklyReportErrorMessage(res, "Couldn't load this slide."),
            });
          } else {
            cache.set(key, { status: "ready", url: URL.createObjectURL(res.blob) });
          }
          bump();
        },
      );
      bump();
    },
    [brandKey, reportId],
  );

  const retry = useCallback(
    (slide, thumb = false) => {
      cacheRef.current.delete(`${thumb ? "t" : "f"}${slide}`);
      ensure(slide, thumb);
    },
    [ensure],
  );

  const get = (slide, thumb = false) => cacheRef.current.get(`${thumb ? "t" : "f"}${slide}`) || null;

  return { ensure, retry, get };
}

function Thumbnail({ slide, active, entry, onVisible, onSelect }) {
  const ref = useRef(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      onVisible(slide);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((item) => item.isIntersecting)) {
        onVisible(slide);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [slide, onVisible]);

  return (
    <Box
      ref={ref}
      component="button"
      type="button"
      data-slide={slide}
      aria-label={`Go to slide ${slide}`}
      aria-current={active ? "true" : undefined}
      onClick={() => onSelect(slide)}
      sx={{
        position: "relative",
        flex: "0 0 auto",
        width: THUMB_WIDTH,
        aspectRatio: "16 / 9",
        p: 0,
        borderRadius: 1,
        overflow: "hidden",
        cursor: "pointer",
        bgcolor: "#1a1a1a",
        border: "2px solid",
        borderColor: active ? "primary.main" : "transparent",
        opacity: active ? 1 : 0.75,
        "&:hover": { opacity: 1 },
      }}
    >
      {entry?.status === "ready" && (
        <img
          src={entry.url}
          alt=""
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}
      <Typography
        variant="caption"
        sx={{
          position: "absolute",
          right: 4,
          bottom: 2,
          px: 0.5,
          borderRadius: 0.5,
          bgcolor: "rgba(0,0,0,0.6)",
          color: "#fff",
          lineHeight: 1.4,
        }}
      >
        {slide}
      </Typography>
    </Box>
  );
}

// Shared by the admin preview overlay and the client page. `fill` makes the
// stage take the available height (overlay); otherwise it keeps a 16:9 ratio.
export function SlideViewer({ report, brandKey, onClose, fill = false }) {
  const total = Number(report?.slide_count) || 0;
  const [current, setCurrent] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef(null);
  const railRef = useRef(null);
  const { ensure, retry, get } = useSlideCache({ brandKey, reportId: report?.id });

  // Current slide first, then its neighbours so next/previous feel instant.
  useEffect(() => {
    if (!total) return;
    ensure(current);
    if (current < total) ensure(current + 1);
    if (current > 1) ensure(current - 1);
  }, [current, total, ensure]);

  const ensureThumb = useCallback((slide) => ensure(slide, true), [ensure]);

  useEffect(() => {
    const node = railRef.current?.querySelector(`[data-slide="${current}"]`);
    node?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [current]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      node.requestFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
          event.preventDefault();
          setCurrent((value) => Math.min(total, value + 1));
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          setCurrent((value) => Math.max(1, value - 1));
          break;
        case "Home":
          event.preventDefault();
          setCurrent(1);
          break;
        case "End":
          event.preventDefault();
          setCurrent(total || 1);
          break;
        case "f":
        case "F":
          event.preventDefault();
          toggleFullscreen();
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [total, toggleFullscreen]);

  const entry = total ? get(current) : null;
  const fillStage = fill || isFullscreen;

  return (
    <Box
      ref={containerRef}
      sx={{
        display: "flex",
        flexDirection: "column",
        bgcolor: "#0a0a0a",
        color: "#fff",
        height: fillStage ? "100%" : "auto",
        minHeight: 0,
        borderRadius: fill || isFullscreen ? 0 : 2,
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 2,
          py: 1,
          borderBottom: "1px solid rgba(255,255,255,0.12)",
        }}
      >
        <Typography variant="subtitle2" fontWeight={700} noWrap sx={{ flex: 1, minWidth: 0 }}>
          {report?.title}
        </Typography>
        {total > 0 && (
          <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.8)" }}>
            {current} / {total}
          </Typography>
        )}
        <IconButton
          size="small"
          color="inherit"
          aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
          title={isFullscreen ? "Exit full screen (F)" : "Full screen (F)"}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
        </IconButton>
        {onClose && (
          <IconButton size="small" color="inherit" aria-label="Close preview" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        )}
      </Box>

      <Box
        onContextMenu={(event) => event.preventDefault()}
        sx={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flex: fillStage ? 1 : "none",
          aspectRatio: fillStage ? "auto" : "16 / 9",
          minHeight: 0,
          bgcolor: "#000",
        }}
      >
        {!total ? (
          <Typography variant="body2" sx={{ color: "rgba(255,255,255,0.7)" }}>
            This presentation has no slides.
          </Typography>
        ) : entry?.status === "ready" ? (
          <img
            src={entry.url}
            alt={`Slide ${current} of ${total}`}
            draggable={false}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              userSelect: "none",
              display: "block",
            }}
          />
        ) : entry?.status === "error" ? (
          <Box sx={{ textAlign: "center", px: 2 }}>
            <Typography variant="body2" sx={{ mb: 1.5, color: "rgba(255,255,255,0.8)" }}>
              {entry.message}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              onClick={() => {
                retry(current);
              }}
            >
              Retry
            </Button>
          </Box>
        ) : (
          <CircularProgress size={28} color="inherit" />
        )}

        {total > 1 && current > 1 && (
          <IconButton
            aria-label="Previous slide"
            onClick={() => setCurrent((value) => Math.max(1, value - 1))}
            sx={{
              position: "absolute",
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "#fff",
              bgcolor: "rgba(0,0,0,0.45)",
              "&:hover": { bgcolor: "rgba(0,0,0,0.7)" },
            }}
          >
            <ChevronLeftIcon />
          </IconButton>
        )}
        {total > 1 && current < total && (
          <IconButton
            aria-label="Next slide"
            onClick={() => setCurrent((value) => Math.min(total, value + 1))}
            sx={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "#fff",
              bgcolor: "rgba(0,0,0,0.45)",
              "&:hover": { bgcolor: "rgba(0,0,0,0.7)" },
            }}
          >
            <ChevronRightIcon />
          </IconButton>
        )}
      </Box>

      {total > 1 && (
        <Box
          ref={railRef}
          sx={{
            display: "flex",
            gap: 1,
            p: 1,
            overflowX: "auto",
            borderTop: "1px solid rgba(255,255,255,0.12)",
          }}
        >
          {Array.from({ length: total }, (_, index) => index + 1).map((slide) => (
            <Thumbnail
              key={slide}
              slide={slide}
              active={slide === current}
              entry={get(slide, true)}
              onVisible={ensureThumb}
              onSelect={setCurrent}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

// The app's fixed sidebar toggle (App.jsx) uses zIndex 1301, which is above a normal MUI dialog (1300),
// so it floated over this full-screen preview and covered the title. The preview must sit above it.
const VIEWER_Z_INDEX = 1400;

export function SlideViewerDialog({ report, brandKey, onClose }) {
  return (
    <Dialog
      fullScreen
      open={Boolean(report)}
      onClose={onClose}
      sx={{ zIndex: VIEWER_Z_INDEX }}
      PaperProps={{ sx: { bgcolor: "#0a0a0a" } }}
    >
      {report && (
        <SlideViewer key={report.id} report={report} brandKey={brandKey} onClose={onClose} fill />
      )}
    </Dialog>
  );
}
