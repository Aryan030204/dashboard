import { useState, useEffect, useRef } from "react";
import {
  Badge,
  IconButton,
  Popover,
  Box,
  Typography,
  List,
  ListItem,
  CircularProgress,
  Divider,
  Avatar,
  useTheme,
  Tooltip,
} from "@mui/material";
import {
  Bell,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Info,
  CheckCircle,
  XCircle,
  Target,
} from "lucide-react";
import { doGet, doPut } from "../lib/api";
import AlertDetailDialog from "./AlertDetailDialog";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export default function NotificationsMenu({ darkMode, onTabChange }) {
  const theme = useTheme();
  const [anchorEl, setAnchorEl] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [visibleCount, setVisibleCount] = useState(5);
  const [selectedAlert, setSelectedAlert] = useState(null);
  const hasOpenedRef = useRef(false);

  const fetchNotifications = async () => {
    try {
      const res = await doGet("/push/notifications");
      if (res.error) throw new Error("API Error");
      setNotifications(res.data.notifications || []);
      setUnreadCount(res.data.unreadCount || 0);
    } catch (error) {
      console.error("Failed to fetch notifications", error);
    }
  };

  // Poll for new notifications
  useEffect(() => {
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 15000);

    const handleFcmEvent = () => fetchNotifications();
    window.addEventListener("fcm-foreground-message", handleFcmEvent);

    return () => {
      clearInterval(interval);
      window.removeEventListener("fcm-foreground-message", handleFcmEvent);
    };
  }, []);

  const handleClick = (event) => {
    setAnchorEl(event.currentTarget);
    setVisibleCount(5);
    hasOpenedRef.current = true;
    fetchNotifications();
  };

  const handleClose = () => {
    setAnchorEl(null);
    // Mark as read ONLY when the popover CLOSES, not when it opens
    if (hasOpenedRef.current) {
      markAsRead();
      hasOpenedRef.current = false;
    }
  };

  const markAsRead = async () => {
    if (unreadCount <= 0) return;

    try {
      // Mark all unread notifications in the backend so the badge count
      // does not get stuck on older or hidden items outside the current list.
      await doPut("/push/notifications/read", {});
      setUnreadCount(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      fetchNotifications();
    } catch (error) {
      console.error("Failed to mark notifications as read", error);
    }
  };

  const open = Boolean(anchorEl);
  const id = open ? "notifications-popover" : undefined;
  const visibleNotifications = notifications.slice(0, visibleCount);
  const hasMoreNotifications = notifications.length > visibleCount;

  return (
    <>
      <IconButton
        onClick={handleClick}
        size="small"
        sx={{
          bgcolor: darkMode ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
          borderRadius: "10px",
          p: 1.2,
          color: darkMode ? "zinc.400" : "zinc.500",
          "&:hover": {
            bgcolor: darkMode ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.06)",
          },
        }}
      >
        <Badge
          badgeContent={unreadCount}
          color="error"
          sx={{ "& .MuiBadge-badge": { right: -3, top: 3 } }}
        >
          <Bell size={20} />
        </Badge>
      </IconButton>
      <Popover
        id={id}
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
        PaperProps={{
          sx: {
            width: { xs: "calc(100vw - 24px)", sm: 500 },
            maxHeight: { xs: "70vh", sm: 620 },
            mt: 1,
            bgcolor: "background.paper",
            backgroundImage: "none",
            borderRadius: "12px",
            boxShadow: theme.shadows[10],
          },
        }}
      >
        <Box
          sx={{
            p: 2,
            borderBottom: "1px solid",
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Typography
            variant="h6"
            sx={{ fontSize: "1rem", fontWeight: 700, color: "text.primary" }}
          >
            Recent Alerts
          </Typography>
          {unreadCount > 0 && (
            <Typography
              variant="caption"
              sx={{ color: "primary.main", fontWeight: 600, cursor: "pointer" }}
              onClick={markAsRead}
            >
              Mark all as read
            </Typography>
          )}
        </Box>
        <List
          sx={{
            p: 0,
            maxHeight: { xs: "calc(70vh - 128px)", sm: "calc(620px - 128px)" },
            overflowY: "auto",
          }}
        >
          {loading ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
              <CircularProgress size={24} />
            </Box>
          ) : notifications.length === 0 ? (
            <Box sx={{ p: 3, textAlign: "center" }}>
              <Typography variant="body2" color="text.secondary">
                No notifications yet
              </Typography>
            </Box>
          ) : (
            visibleNotifications.map((notif, index) => {
              const evt = notif.event || {};
              const metricName = (evt.metric || "Metric").replace(/_/g, " ");
              const deltaValue = Number(evt.delta_percent || 0);
              const delta = Math.abs(deltaValue).toFixed(2);
              const thresholdType = String(evt.threshold_type || "").toLowerCase();
              const eventDirection = String(evt.direction || "").toLowerCase();
              const conditionText = String(evt.condition || "").toLowerCase();
              const direction =
                eventDirection.includes("below") ||
                eventDirection.includes("drop") ||
                eventDirection.includes("down") ||
                eventDirection.includes("decrease") ||
                conditionText.includes("drop") ||
                conditionText.includes("below") ||
                thresholdType.includes("drop") ||
                thresholdType.includes("less_than")
                  ? "dropped"
                  : eventDirection.includes("above") ||
                      eventDirection.includes("rise") ||
                      eventDirection.includes("up") ||
                      eventDirection.includes("increase") ||
                      conditionText.includes("rise") ||
                      conditionText.includes("above") ||
                      thresholdType.includes("rise") ||
                      thresholdType.includes("greater_than")
                    ? "rose"
                    : deltaValue < 0
                      ? "dropped"
                      : "rose";
              const state = evt.current_state || "ALERT";
              const brand = evt.brand || "System";
              const hasCustomText =
                typeof notif.subject === "string" &&
                notif.subject.trim().length > 0 &&
                typeof notif.description === "string" &&
                notif.description.trim().length > 0;
              const subjectText = hasCustomText ? String(notif.subject) : "";
              const subjectParts = subjectText.split("|").map((part) => part.trim());
              const hasStyledSubjectParts =
                hasCustomText &&
                subjectParts.length >= 3 &&
                /^current\s+value\s*:/i.test(subjectParts[2]);
              const currentValueDisplay = hasStyledSubjectParts
                ? subjectParts[2].replace(/^current\s+value\s*:\s*/i, "").trim()
                : "";

              // State-based icons and colors
              let StatusIcon = AlertCircle;
              let iconColor = "#ef4444"; // Red for Alert/Critical
              let bgColor = darkMode
                ? "rgba(239, 68, 68, 0.1)"
                : "rgba(239, 68, 68, 0.05)";

              if (state === "NORMAL") {
                StatusIcon = CheckCircle;
                iconColor = "#10b981"; // Green
                bgColor = darkMode
                  ? "rgba(16, 185, 129, 0.1)"
                  : "rgba(16, 185, 129, 0.05)";
              } else if (state === "TRIGGERED") {
                StatusIcon = AlertCircle;
                iconColor = "#f59e0b"; // Yellow/Amber
                bgColor = darkMode
                  ? "rgba(245, 158, 11, 0.1)"
                  : "rgba(245, 158, 11, 0.05)";
              } else if (state === "NEEDS ATTENTION") {
                StatusIcon = AlertCircle;
                iconColor = "#fb923c"; // Light orange
                bgColor = darkMode
                  ? "rgba(251, 146, 60, 0.1)"
                  : "rgba(251, 146, 60, 0.05)";
              } else if (state === "ALMOST CRITICAL") {
                StatusIcon = AlertCircle;
                iconColor = "#f87171"; // Light red
                bgColor = darkMode
                  ? "rgba(248, 113, 113, 0.1)"
                  : "rgba(248, 113, 113, 0.05)";
              } else if (state === "NEEDS IMMEDIATE ATTENTION") {
                StatusIcon = AlertCircle;
                iconColor = "#c2410c"; // Dark orange
                bgColor = darkMode
                  ? "rgba(194, 65, 12, 0.1)"
                  : "rgba(194, 65, 12, 0.05)";
              } else if (state === "CRITICAL") {
                StatusIcon = XCircle;
                iconColor = "#dc2626"; // Alarming red
                bgColor = darkMode
                  ? "rgba(220, 38, 38, 0.1)"
                  : "rgba(220, 38, 38, 0.05)";
              }

              const handleItemClick = () => {
                setSelectedAlert(notif);
                // Close the bell popover so the detail dialog is not stacked
                // on top of it (this also marks the list as read).
                handleClose();
              };

              if (notif.is_item_qty_push) {
                const prevQty = evt.previous_quantity || 0;
                const currQty = evt.current_value || 0;
                const prodTitle = evt.brand || "Item";
                const varTitle = evt.metric || "Variant";

                return (
                  <div key={notif._id || index}>
                    <ListItem
                      onClick={handleItemClick}
                      sx={{
                        px: 2,
                        py: 1.5,
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 2,
                        cursor: "pointer",
                        bgcolor: notif.read
                          ? "transparent"
                          : darkMode
                            ? "rgba(255,255,255,0.03)"
                            : "rgba(0,0,0,0.02)",
                        transition: "background-color 0.2s",
                        "&:hover": {
                          bgcolor: darkMode
                            ? "rgba(255,255,255,0.07)"
                            : "rgba(0,0,0,0.04)",
                        },
                      }}
                    >
                      <Avatar
                        sx={{
                          bgcolor: darkMode ? "rgba(239, 68, 68, 0.1)" : "rgba(239, 68, 68, 0.05)",
                          color: "#ef4444",
                          width: 40,
                          height: 40,
                          borderRadius: "10px",
                        }}
                      >
                        <AlertCircle size={20} />
                      </Avatar>

                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Box
                          sx={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            mb: 0.5,
                          }}
                        >
                            <Box 
                              sx={{ minWidth: 0, flex: 1, overflow: "hidden" }}
                              title={`🚨Inventory update: ${prodTitle} | ${prevQty} -> ${currQty}`}
                            >
                              <Typography
                                variant="subtitle2"
                                noWrap
                                sx={{
                                  fontWeight: 600,
                                  color: "text.primary",
                                  fontSize: "0.85rem",
                                  cursor: "help",
                                }}
                              >
                                🚨Inventory update: <strong style={{ fontWeight: 800 }}>{prodTitle}</strong> | {prevQty} -{'>'} {currQty}
                              </Typography>
                            </Box>
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.disabled",
                              whiteSpace: "nowrap",
                              ml: 1,
                            }}
                          >
                            {notif.stored_at
                              ? dayjs(notif.stored_at).fromNow()
                              : ""}
                          </Typography>
                        </Box>

                        <Typography
                          variant="body2"
                          sx={{
                            color: "text.secondary",
                            lineHeight: 1.4,
                            mb: 0.5,
                            fontSize: "0.825rem",
                          }}
                        >
                          <strong style={{ fontWeight: 800 }}>{prodTitle} ({varTitle})</strong> stock dropped from {prevQty} to {currQty} units
                        </Typography>
                      </Box>
                      {!notif.read && (
                        <Box
                          sx={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            bgcolor: "primary.main",
                            mt: 1,
                          }}
                        />
                      )}
                    </ListItem>
                    {index < visibleNotifications.length - 1 && <Divider />}
                  </div>
                );
              }

              return (
                <div key={notif._id || index}>
                  <ListItem
                    onClick={handleItemClick}
                    sx={{
                      px: 2,
                      py: 1.5,
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 2,
                      cursor: "pointer",
                      bgcolor: notif.read
                        ? "transparent"
                        : darkMode
                          ? "rgba(255,255,255,0.03)"
                          : "rgba(0,0,0,0.02)",
                      transition: "background-color 0.2s",
                      "&:hover": {
                        bgcolor: darkMode
                          ? "rgba(255,255,255,0.07)"
                          : "rgba(0,0,0,0.04)",
                      },
                    }}
                  >
                    <Avatar
                      sx={{
                        bgcolor: bgColor,
                        color: iconColor,
                        width: 40,
                        height: 40,
                        borderRadius: "10px",
                      }}
                    >
                      <StatusIcon size={20} />
                    </Avatar>

                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          mb: 0.5,
                        }}
                      >
                        <Typography
                          variant="subtitle2"
                          sx={{
                            fontWeight: 800,
                            color: "text.primary",
                            fontSize: "0.8rem",
                            letterSpacing: "0.02em",
                            textTransform: hasCustomText ? "none" : "uppercase",
                            whiteSpace: "normal",
                            overflow: "visible",
                            textOverflow: "unset",
                            wordBreak: "break-word",
                          }}
                        >
                          {hasStyledSubjectParts ? (
                            <>
                              {subjectParts[0]} |{" "}
                              <Box component="span" sx={{ color: "#facc15", fontWeight: 800 }}>
                                {subjectParts[1]}
                              </Box>{" "}
                              | current value:{" "}
                              <Box component="span" sx={{ color: "#22c55e", fontWeight: 800 }}>
                                {currentValueDisplay}
                              </Box>
                            </>
                          ) : hasCustomText ? (
                            notif.subject
                          ) : (
                            brand
                          )}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.disabled",
                            whiteSpace: "nowrap",
                            ml: 1,
                          }}
                        >
                          {notif.stored_at
                            ? dayjs(notif.stored_at).fromNow()
                            : ""}
                        </Typography>
                      </Box>

                      <Typography
                        variant="body2"
                        sx={{
                          color: "text.secondary",
                          lineHeight: 1.4,
                          mb: 0.5,
                          fontSize: "0.78rem",
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                        }}
                      >
                        {hasCustomText ? (
                          notif.description
                        ) : state === "NORMAL" ? (
                          <>
                            {metricName} came back to normal value
                          </>
                        ) : (
                          <>
                            {metricName} {direction} by{" "}
                            <Box
                              component="span"
                              sx={{
                                fontWeight: 700,
                                color: iconColor,
                              }}
                            >
                              {delta}%
                            </Box>{" "}
                            | current state:{" "}
                            <Box
                              component="span"
                              sx={{
                                fontWeight: 600,
                                color: iconColor,
                                fontSize: "0.75rem",
                              }}
                            >
                              {state}
                            </Box>
                          </>
                        )}
                      </Typography>

                      {!hasCustomText && (
                        <Box
                          sx={{ display: "flex", alignItems: "center", gap: 0.5 }}
                        >
                          <Target size={12} style={{ color: iconColor }} />
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.secondary",
                              display: "flex",
                              alignItems: "center",
                            }}
                          >
                            {evt.current_value !== undefined
                              ? `current value: ${Number(evt.current_value).toFixed(2)}`
                              : evt.condition || "Value changed significantly."}
                          </Typography>
                        </Box>
                      )}
                    </Box>
                    {!notif.read && (
                      <Box
                        sx={{
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          bgcolor: "primary.main",
                          mt: 1,
                        }}
                      />
                    )}
                  </ListItem>
                  {index < visibleNotifications.length - 1 && <Divider />}
                </div>
              );
            })
          )}
        </List>
        {hasMoreNotifications && (
          <Box
            sx={{
              p: 1.5,
              borderTop: "1px solid",
              borderColor: "divider",
              textAlign: "center",
            }}
          >
            <Typography
              variant="button"
              onClick={() => setVisibleCount((prev) => prev + 5)}
              sx={{
                fontSize: "0.75rem",
                fontWeight: 700,
                color: "primary.main",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                cursor: "pointer",
              }}
            >
              View More
            </Typography>
          </Box>
        )}
      </Popover>
      <AlertDetailDialog
        open={Boolean(selectedAlert)}
        notification={selectedAlert}
        darkMode={darkMode}
        onClose={() => setSelectedAlert(null)}
      />
    </>
  );
}
