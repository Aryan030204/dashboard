import { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Typography,
  IconButton,
  Chip,
  Divider,
  CircularProgress,
  Avatar,
  Tooltip,
  Collapse,
} from "@mui/material";
import {
  X,
  Copy,
  Check,
  AlertCircle,
  CheckCircle,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { doGet } from "../lib/api";
import dayjs from "dayjs";

const HIDDEN_KEYS = new Set(["email_body", "__v"]);

const DATE_KEY_RE = /(_at|_on|date|time|createdat|updatedat)$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function isPlainObject(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function formatLabel(path) {
  return path
    .split(".")
    .map((part) =>
      part
        .replace(/_/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    )
    .join(" › ");
}

function formatValue(key, value) {
  if (value === null || value === undefined) return "—";
  if (value instanceof Date) return dayjs(value).format("DD MMM YYYY, HH:mm:ss");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (typeof value === "string") {
    if (ISO_DATE_RE.test(value) || (DATE_KEY_RE.test(key) && !Number.isNaN(Date.parse(value)))) {
      const parsed = dayjs(value);
      if (parsed.isValid()) return parsed.format("DD MMM YYYY, HH:mm:ss");
    }
    return value;
  }
  return JSON.stringify(value);
}

/** Flattens the Mongo document into ordered [path, value] pairs for display. */
function flattenDoc(obj, prefix = "", out = []) {
  Object.entries(obj || {}).forEach(([key, value]) => {
    if (HIDDEN_KEYS.has(key)) return;
    const path = prefix ? `${prefix}.${key}` : key;

    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        out.push([path, "—"]);
      } else {
        flattenDoc(value, path, out);
      }
      return;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        out.push([path, "—"]);
      } else if (value.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
        out.push([path, value.map((item) => formatValue(key, item)).join(", ")]);
      } else {
        value.forEach((item, idx) => {
          if (isPlainObject(item)) flattenDoc(item, `${path}[${idx}]`, out);
          else out.push([`${path}[${idx}]`, formatValue(key, item)]);
        });
      }
      return;
    }

    out.push([path, formatValue(key, value)]);
  });
  return out;
}

function stateVisuals(state, darkMode) {
  const presets = {
    NORMAL: ["#10b981", CheckCircle],
    TRIGGERED: ["#f59e0b", AlertCircle],
    "NEEDS ATTENTION": ["#fb923c", AlertCircle],
    "ALMOST CRITICAL": ["#f87171", AlertCircle],
    "NEEDS IMMEDIATE ATTENTION": ["#c2410c", AlertCircle],
    CRITICAL: ["#dc2626", XCircle],
  };
  const [color, Icon] = presets[state] || ["#ef4444", AlertCircle];
  return {
    color,
    Icon,
    bg: darkMode ? `${color}1f` : `${color}14`,
  };
}

export default function AlertDetailDialog({ open, notification, darkMode, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState("");
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);

  const notifId = notification?._id ? String(notification._id) : "";

  useEffect(() => {
    if (!open || !notifId) return;

    let cancelled = false;
    setLoading(true);
    setError("");
    setShowRaw(false);
    setCopied(false);
    // Start from the list payload so something renders immediately, then
    // replace it with the complete document straight from Mongo.
    setDetail(notification);
    setSource("");

    (async () => {
      try {
        const res = await doGet(`/push/notifications/${encodeURIComponent(notifId)}`);
        if (cancelled) return;
        if (res.error || !res.data?.notification) {
          setError("Could not load the full record. Showing summary data.");
          return;
        }
        setDetail(res.data.notification);
        setSource(res.data.source || "");
      } catch (err) {
        if (!cancelled) setError("Could not load the full record. Showing summary data.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, notifId]);

  const doc = detail || notification || {};
  const evt = doc.event || {};
  const state = evt.current_state || doc.current_state || "ALERT";
  const { color, Icon, bg } = stateVisuals(state, darkMode);

  const title =
    (typeof doc.subject === "string" && doc.subject.trim()) ||
    [evt.brand, evt.metric && String(evt.metric).replace(/_/g, " ")]
      .filter(Boolean)
      .join(" | ") ||
    "Alert details";

  const rows = useMemo(() => flattenDoc(doc), [doc]);
  const rawJson = useMemo(() => JSON.stringify(doc, null, 2), [doc]);
  const emailBody =
    typeof doc.email_body === "string"
      ? doc.email_body
      : doc.email_body?.html || doc.email_body?.text || "";
  const emailIsHtml = /<\/?[a-z][\s\S]*>/i.test(emailBody);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(rawJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="md"
      PaperProps={{
        sx: {
          borderRadius: "14px",
          bgcolor: "background.paper",
          backgroundImage: "none",
        },
      }}
    >
      <DialogTitle sx={{ p: 2.5, pb: 1.5 }}>
        <Box sx={{ display: "flex", alignItems: "flex-start", gap: 2 }}>
          <Avatar
            sx={{ bgcolor: bg, color, width: 44, height: 44, borderRadius: "12px" }}
          >
            <Icon size={22} />
          </Avatar>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              sx={{
                fontWeight: 800,
                fontSize: "1rem",
                color: "text.primary",
                wordBreak: "break-word",
              }}
            >
              {title}
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, mt: 1 }}>
              <Chip
                size="small"
                label={state}
                sx={{
                  bgcolor: bg,
                  color,
                  fontWeight: 700,
                  fontSize: "0.68rem",
                  height: 22,
                }}
              />
              {source && (
                <Chip
                  size="small"
                  variant="outlined"
                  label={source}
                  sx={{ fontSize: "0.68rem", height: 22 }}
                />
              )}
              <Chip
                size="small"
                variant="outlined"
                label={doc.read ? "Read" : "Unread"}
                sx={{ fontSize: "0.68rem", height: 22 }}
              />
              {doc.stored_at || doc.createdAt ? (
                <Chip
                  size="small"
                  variant="outlined"
                  label={dayjs(doc.stored_at || doc.createdAt).format(
                    "DD MMM YYYY, HH:mm:ss",
                  )}
                  sx={{ fontSize: "0.68rem", height: 22 }}
                />
              ) : null}
            </Box>
          </Box>
          <IconButton onClick={onClose} size="small" sx={{ mt: -0.5 }}>
            <X size={18} />
          </IconButton>
        </Box>
      </DialogTitle>

      <Divider />

      <DialogContent sx={{ p: 2.5 }}>
        {loading && !detail ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress size={26} />
          </Box>
        ) : (
          <>
            {error && (
              <Typography
                variant="caption"
                sx={{ color: "warning.main", display: "block", mb: 1.5 }}
              >
                {error}
              </Typography>
            )}

            {typeof doc.description === "string" && doc.description.trim() && (
              <Typography
                variant="body2"
                sx={{ color: "text.secondary", mb: 2, lineHeight: 1.5 }}
              >
                {doc.description}
              </Typography>
            )}

            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr", sm: "minmax(150px, 34%) 1fr" },
                border: "1px solid",
                borderColor: "divider",
                borderRadius: "10px",
                overflow: "hidden",
              }}
            >
              {rows.map(([path, value], index) => (
                <Box
                  key={path}
                  sx={{
                    display: "contents",
                    "& > *": {
                      bgcolor:
                        index % 2 === 0
                          ? "transparent"
                          : darkMode
                            ? "rgba(255,255,255,0.025)"
                            : "rgba(0,0,0,0.015)",
                    },
                  }}
                >
                  <Box sx={{ px: 1.5, py: 1, borderBottom: "1px solid", borderColor: "divider" }}>
                    <Typography
                      variant="caption"
                      sx={{
                        fontWeight: 700,
                        color: "text.secondary",
                        textTransform: "uppercase",
                        letterSpacing: "0.03em",
                        fontSize: "0.66rem",
                      }}
                    >
                      {formatLabel(path)}
                    </Typography>
                  </Box>
                  <Box sx={{ px: 1.5, py: 1, borderBottom: "1px solid", borderColor: "divider" }}>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.primary",
                        fontSize: "0.8rem",
                        wordBreak: "break-word",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {String(value)}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Box>

            {emailBody && (
              <Box sx={{ mt: 2.5 }}>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                  }}
                >
                  Email body
                </Typography>
                <Box
                  sx={{
                    mt: 1,
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: "10px",
                    overflow: "hidden",
                    bgcolor: darkMode ? "rgba(255,255,255,0.02)" : "#fff",
                  }}
                >
                  {emailIsHtml ? (
                    <Box
                      component="iframe"
                      title="Alert email body"
                      sandbox=""
                      srcDoc={emailBody}
                      sx={{ width: "100%", height: 320, border: 0, display: "block" }}
                    />
                  ) : (
                    <Typography
                      component="pre"
                      sx={{
                        m: 0,
                        p: 1.5,
                        fontSize: "0.75rem",
                        fontFamily: "monospace",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        maxHeight: 320,
                        overflow: "auto",
                      }}
                    >
                      {emailBody}
                    </Typography>
                  )}
                </Box>
              </Box>
            )}

            <Box sx={{ mt: 2.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Box
                  onClick={() => setShowRaw((prev) => !prev)}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    cursor: "pointer",
                    color: "text.secondary",
                  }}
                >
                  {showRaw ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    Raw document
                  </Typography>
                </Box>
                <Tooltip title={copied ? "Copied" : "Copy JSON"}>
                  <IconButton size="small" onClick={handleCopy}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </IconButton>
                </Tooltip>
              </Box>
              <Collapse in={showRaw} unmountOnExit>
                <Typography
                  component="pre"
                  sx={{
                    mt: 1,
                    p: 1.5,
                    fontSize: "0.72rem",
                    fontFamily: "monospace",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    maxHeight: 360,
                    overflow: "auto",
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: "10px",
                    bgcolor: darkMode ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
                  }}
                >
                  {rawJson}
                </Typography>
              </Collapse>
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
