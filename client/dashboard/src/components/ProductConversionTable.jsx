import { useEffect, useMemo, useState, useCallback, useRef, memo } from "react";
import dayjs from "dayjs";
import {
  Box,
  Card,
  CardContent,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Typography,
  TablePagination,
  Button,
  CircularProgress,
  Alert,
  List,
  ListItemButton,
  ListItemText,
  Switch,
  FormControlLabel,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  TextField,
  Chip,
  Popover as MuiPopover,
  InputAdornment,
  Grow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import DownloadIcon from "@mui/icons-material/Download";
import CheckIcon from "@mui/icons-material/Check";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import FilterListIcon from "@mui/icons-material/FilterList";
import CloseIcon from "@mui/icons-material/Close";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import { useMediaQuery, Drawer } from "@mui/material";

import { DatePicker } from "@shopify/polaris";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { useAppDispatch, useAppSelector } from "../state/hooks.js";
import {
  fetchProductConversion,
  setDateRange,
  setPage,
  setPageSize,
  setSort,
  setCompareMode,
  setCompareDateRange,
  addFilter,
  removeFilter,
  clearFilters,
  setSearch,
  setProductTypes,
  setPageTypes,
  setInventoryPeriod,
} from "../state/slices/productConversionSlice.js";

import { exportProductConversionCsv, getProductTypes } from "../lib/api.js";
import { formatInrAmount, useInrCurrency } from "../lib/currency.js";
import { useTheme } from "@mui/material/styles";
import { validateFilter } from "../lib/filterValidation.js";
import { GlassChip } from "./ui/GlassChip.jsx";

const DATE_PRESETS = [
  {
    label: "Today",
    getValue: () => [dayjs().startOf("day"), dayjs().startOf("day")],
    group: 1,
  },
  {
    label: "Yesterday",
    getValue: () => [
      dayjs().subtract(1, "day").startOf("day"),
      dayjs().subtract(1, "day").startOf("day"),
    ],
    group: 1,
  },
  {
    label: "Last 7 days",
    getValue: () => [
      dayjs().subtract(6, "day").startOf("day"),
      dayjs().startOf("day"),
    ],
    group: 2,
  },
  {
    label: "Last 30 days",
    getValue: () => [
      dayjs().subtract(29, "day").startOf("day"),
      dayjs().startOf("day"),
    ],
    group: 2,
  },
  {
    label: "Last 90 days",
    getValue: () => [
      dayjs().subtract(89, "day").startOf("day"),
      dayjs().startOf("day"),
    ],
    group: 2,
  },
];

function formatNumber(val) {
  return Number(val || 0).toLocaleString();
}

function formatCurrency(val, convertAmount) {
  return formatInrAmount(convertAmount(val || 0), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(val) {
  const num = Number(val || 0);
  if (!Number.isFinite(num)) return "0%";
  return `${num.toFixed(2)}%`;
}

function PaginationActions({
  count,
  page,
  rowsPerPage,
  onPageChange,
  disabled,
}) {
  const handleBack = (event) => {
    onPageChange(event, page - 1);
  };
  const handleNext = (event) => {
    onPageChange(event, page + 1);
  };
  const lastPage = Math.max(0, Math.ceil(count / rowsPerPage) - 1);
  return (
    <Box sx={{ flexShrink: 0, ml: 2.5, display: "flex", alignItems: "center" }}>
      <Button
        onClick={handleBack}
        disabled={disabled || page <= 0}
        sx={{ minWidth: 0, px: 1 }}
      >
        <KeyboardArrowLeft />
      </Button>
      <Button
        onClick={handleNext}
        disabled={disabled || page >= lastPage}
        sx={{ minWidth: 0, px: 1 }}
      >
        <KeyboardArrowRight />
      </Button>
    </Box>
  );
}

// --- Reusable Date Picker Component ---
function DateRangePicker({
  startDate,
  endDate,
  onApply,
  label = "Select dates",
  activePresetLabel,
  presets = DATE_PRESETS,
  bgColor = "background.paper",
  textColor = "text.primary",
  variant = "default",
  disabled = false,
  singleDate = false,
  labelPrefix = null,

  disableDatesAfter,
  sx = {},
}) {
  const [anchorEl, setAnchorEl] = useState(null);
  const active = Boolean(anchorEl);
  const [month, setMonth] = useState(dayjs().month());
  const [year, setYear] = useState(dayjs().year());
  const [internalStart, setInternalStart] = useState(null);
  const [internalEnd, setInternalEnd] = useState(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const toggle = useCallback(
    (event) => {
      if (disabled) return;
      if (anchorEl) {
        setAnchorEl(null);
      } else {
        setAnchorEl(event.currentTarget);
        const s = startDate ? dayjs(startDate) : dayjs();
        const e = endDate ? dayjs(endDate) : s;
        setInternalStart(s);
        setInternalEnd(e);
        setMonth(e.month());
        setYear(e.year());
      }
    },
    [startDate, endDate, disabled, anchorEl],
  );

  const handleClose = useCallback(() => setAnchorEl(null), []);
  const handleMonthChange = useCallback((m, y) => {
    setMonth(m);
    setYear(y);
  }, []);

  const handleRangeChange = useCallback(
    ({ start: sRaw, end: eRaw }) => {
      const s = sRaw ? dayjs(sRaw).startOf("day") : null;
      const e = eRaw ? dayjs(eRaw).startOf("day") : null;
      const focus = e || s;
      if (focus) {
        setMonth(focus.month());
        setYear(focus.year());
      }
      setInternalStart(s);
      setInternalEnd(e);

      if (singleDate) {
        if (s) {
          onApply(s, s);
          setAnchorEl(null);
        }
        return;
      }

      if (s && e && s.isAfter(e)) {
        onApply(e, s);
        setInternalStart(e);
        setInternalEnd(s);
        return;
      }
      if (s && !e) {
        onApply(s, s);
        return;
      }
      if (s && e) {
        onApply(s, e);
      }
    },
    [onApply, singleDate],
  );

  const handlePreset = useCallback(
    (preset) => {
      let [ps, pe] = preset.getValue();

      // Auto-adjust range if it exceeds disableDatesAfter
      if (disableDatesAfter) {
        const cutoff = dayjs(disableDatesAfter).endOf("day");
        if (pe.isAfter(cutoff)) {
          const diff = pe.diff(cutoff, "day");
          // Shift entire range back
          pe = cutoff;
          ps = ps.subtract(diff, "day");
        }
      }

      setMonth(pe.month());
      setYear(pe.year());
      setInternalStart(ps);
      setInternalEnd(pe);
      onApply(ps, pe);
      setAnchorEl(null);
    },
    [onApply, disableDatesAfter],
  );

  const selectedRange = useMemo(() => {
    if (!internalStart || !internalEnd) {
      const s = startDate ? dayjs(startDate) : null;
      const e = endDate ? dayjs(endDate) : s;
      if (!s || !e) return undefined;
      return {
        start: s.startOf("day").toDate(),
        end: e.startOf("day").toDate(),
      };
    }
    return {
      start: internalStart.startOf("day").toDate(),
      end: internalEnd.startOf("day").toDate(),
    };
  }, [internalStart, internalEnd, startDate, endDate]);

  const displayLabel = useMemo(() => {
    const s = startDate ? dayjs(startDate) : null;
    const e = endDate ? dayjs(endDate) : null;
    if (s && e)
      return s.isSame(e, "day")
        ? s.format("DD MMM YYYY")
        : `${s.format("DD MMM YYYY")} – ${e.format("DD MMM YYYY")}`;
    return label;
  }, [startDate, endDate, label]);

  return (
    <AppProvider
      i18n={enTranslations}
      theme={{ colorScheme: isDark ? "dark" : "light" }}
    >
      <Card
        elevation={0}
        onClick={toggle}
        role="button"
        tabIndex={0}
        sx={{
          px: 1.25,
          height: 36,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: disabled ? "default" : "pointer",
          minWidth: { xs: 160, md: 200 },
          textAlign: "center",
          userSelect: "none",
          border: "1px solid",
          borderColor: disabled ? "action.disabledBackground" : "divider",
          boxShadow: "none",
          bgcolor: disabled
            ? "transparent"
            : variant === "primary"
              ? "#5ba3e0"
              : bgColor,
          color: disabled
            ? "text.disabled"
            : variant === "primary"
              ? "#0a1f33"
              : textColor,
          opacity: disabled ? 0.6 : 1,
          pointerEvents: disabled ? "none" : "auto",
          "&:hover": { filter: disabled ? "none" : "brightness(0.97)" },
          ...sx,
        }}
      >
        <Typography variant="body2" noWrap sx={{ color: "inherit" }}>
          {labelPrefix && (
            <Box
              component="span"
              sx={{ opacity: 0.7, mr: 0.5, fontWeight: 400 }}
            >
              {labelPrefix}
            </Box>
          )}
          {displayLabel}
        </Typography>
      </Card>

      <MuiPopover
        open={active}
        anchorEl={anchorEl}
        onClose={handleClose}
        TransitionComponent={Grow}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            borderRadius: 1,
            mt: 1,
            overflow: "hidden",
            boxShadow: theme.shadows[8],
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "row",
            maxHeight: "80vh",
            overflowX: "hidden",
            overflowY: "auto",
          }}
        >
          {!singleDate && (
            <Box
              sx={{
                minWidth: 120,
                maxHeight: 320,
                overflowY: "auto",
                borderRight: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
                display: { xs: "block", md: "none" },
              }}
            >
              <List disablePadding>
                {presets.map((preset, idx) => {
                  const isSelected = activePresetLabel === preset.label;
                  const [ps, pe] = preset.getValue();
                  const isSingleDay = ps.isSame(pe, "day");
                  const isDisabled =
                    disableDatesAfter &&
                    isSingleDay &&
                    pe.isAfter(dayjs(disableDatesAfter).endOf("day"));

                  return (
                    <Box key={preset.label}>
                      <ListItemButton
                        selected={isSelected}
                        onClick={() => !isDisabled && handlePreset(preset)}
                        disabled={isDisabled}
                        sx={{ py: 1, px: 1.5 }}
                      >
                        <ListItemText
                          primary={preset.label}
                          primaryTypographyProps={{
                            variant: "body2",
                            fontWeight: isSelected ? 600 : 400,
                            fontSize: 12,
                            color: isDisabled
                              ? "text.disabled"
                              : "text.primary",
                          }}
                        />
                        {isSelected && (
                          <CheckIcon
                            sx={{
                              fontSize: 14,
                              ml: 0.5,
                              color: isDisabled ? "text.disabled" : "inherit",
                            }}
                          />
                        )}
                      </ListItemButton>

                      {idx < presets.length - 1 && <Divider />}
                    </Box>
                  );
                })}
              </List>
            </Box>
          )}
          {!singleDate && (
            <Box
              sx={{
                minWidth: 160,
                maxHeight: 320,
                overflowY: "auto",
                borderRight: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
                display: { xs: "none", md: "block" },
              }}
            >
              <List dense disablePadding>
                {presets.map((preset, idx) => {
                  const isSelected = activePresetLabel === preset.label;
                  const [ps, pe] = preset.getValue();
                  const isSingleDay = ps.isSame(pe, "day");
                  const isDisabled =
                    disableDatesAfter &&
                    isSingleDay &&
                    pe.isAfter(dayjs(disableDatesAfter).endOf("day"));

                  return (
                    <Box key={preset.label}>
                      <ListItemButton
                        selected={isSelected}
                        onClick={() => !isDisabled && handlePreset(preset)}
                        disabled={isDisabled}
                        sx={{ py: 1, px: 1.5 }}
                      >
                        <ListItemText
                          primary={preset.label}
                          primaryTypographyProps={{
                            variant: "body2",
                            fontWeight: isSelected ? 600 : 400,
                            color: isDisabled
                              ? "text.disabled"
                              : "text.primary",
                          }}
                        />
                        {isSelected && (
                          <CheckIcon
                            sx={{
                              fontSize: 16,
                              ml: 0.5,
                              color: isDisabled
                                ? "text.disabled"
                                : "text.primary",
                            }}
                          />
                        )}
                      </ListItemButton>
                      {idx < presets.length - 1 && <Divider />}
                    </Box>
                  );
                })}
              </List>
            </Box>
          )}
          <Box
            sx={{
              flex: 1,
              p: 1,
              minWidth: 200,
              maxWidth: 320,
              bgcolor: "background.paper",
            }}
          >
            <DatePicker
              month={month}
              year={year}
              onChange={handleRangeChange}
              onMonthChange={handleMonthChange}
              selected={selectedRange}
              allowRange={!singleDate}
              disableDatesAfter={disableDatesAfter}
            />
          </Box>
        </Box>
      </MuiPopover>
    </AppProvider>
  );
}

function DeltaBadge({ current, previous, isPercent }) {
  const diff = current - previous;
  // If previous is 0:
  // - If current is 0, no change (null).
  // - If current != 0, it's effectively "New" or infinite growth.
  if (previous === 0 && current === 0) return null;

  let diffPct = 0;
  if (previous === 0) {
    diffPct = 100; // Treat as 100% increase if starting from 0
  } else {
    // ALWAYS use relative change.
    // (2.5 - 2.0) / 2.0 * 100 = 25%.
    diffPct = (diff / previous) * 100;
  }

  const color = diff >= 0 ? "success.main" : "error.main";
  const Icon = diff >= 0 ? TrendingUpIcon : TrendingDownIcon;

  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        ml: 0,
        color,
        fontSize: "0.75rem",
        fontWeight: 500,
      }}
    >
      {Math.abs(diff) > 0.0001 && <Icon fontSize="inherit" sx={{ mr: 0.25 }} />}
      {Math.abs(diffPct).toFixed(1)}%
    </Box>
  );
}

import {
  Collapse,
  IconButton,
  Checkbox,
  ListItem,
  ListItemIcon,
  ListItemSecondaryAction,
  Paper,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/Delete";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

// --- Detailed Filter Panel Component (Persistent Side Panel Mode) ---
function DetailedFilterPanel({
  onClose,
  allColumns,
  visibleColumnIds,
  setVisibleColumnIds,
  filters,
  onAddFilter,
  onRemoveFilter,
  onClearFilters,
  height,
  brandKey,
  date,
  productTypes = [],
  availableProductTypes = [],
  loadingTypes = false,
  onProductTypeChange,
  pageTypes = [],
  onPageTypeChange,
  inventoryPeriod = "7d",
  onInventoryPeriodChange,
  expanded,
  onExpandedChange,
  permissions = [],
  isAuthor = false,
  isGranularMode = false,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  const hasDrrDohAccess = useMemo(() => {
    if (isAuthor || (permissions || []).includes("all")) return true;
    if ((permissions || []).includes("product_conversion")) return true;
    return (permissions || []).some(p => p === "product_conversion:drr" || p === "product_conversion:doh");
  }, [isAuthor, permissions]);

  const glassStyle = {
    bgcolor: isDark ? "rgba(65, 65, 65, 0.15)" : "rgba(255, 255, 255, 0.6)",
    backdropFilter: "blur(12px)",
    border: "1px solid",
    borderColor: "divider",
    borderRadius: 2,
    transition: "all 0.2s ease",
  };

  const handleAccordionChange = (panel) => (event, isExpanded) => {
    onExpandedChange(isExpanded ? panel : false);
  };

  // Product Types State - MOVED TO PARENT

  const handleToggleType = (type) => {
    const current = productTypes || [];
    if (current.includes(type)) {
      onProductTypeChange(current.filter((t) => t !== type));
    } else {
      onProductTypeChange([...current, type]);
    }
  };

  const handleToggleAllTypes = () => {
    if (productTypes.length === availableProductTypes.length) {
      onProductTypeChange([]);
    } else {
      onProductTypeChange([...availableProductTypes]);
    }
  };

  const isAllTypesSelected =
    availableProductTypes.length > 0 &&
    productTypes.length === availableProductTypes.length;
  const isIndeterminateTypes =
    productTypes.length > 0 &&
    productTypes.length < availableProductTypes.length;

  const handleTogglePageType = (type) => {
    const current = pageTypes || [];
    if (current.includes(type)) {
      onPageTypeChange(current.filter((t) => t !== type));
    } else {
      onPageTypeChange([...current, type]);
    }
  };

  const PAGE_TYPES = ["Product", "Collection"];

  // State for new filter creation
  const [showAddForm, setShowAddForm] = useState(false);
  const [field, setField] = useState("");
  const [operator, setOperator] = useState("gt");
  const [value, setValue] = useState("");

  const handleToggleColumn = (colId) => {
    if (visibleColumnIds.includes(colId)) {
      if (visibleColumnIds.length > 1) {
        // Prevent hiding all columns
        setVisibleColumnIds(visibleColumnIds.filter((id) => id !== colId));
      }
    } else {
      setVisibleColumnIds([...visibleColumnIds, colId]);
    }
  };

  const handleToggleAllMetrics = () => {
    const metricIds = allColumns
      .filter((c) => c.id !== "landing_page_path")
      .map((c) => c.id);
    const allMetricsVisible = metricIds.every((id) =>
      visibleColumnIds.includes(id),
    );

    if (allMetricsVisible) {
      // Hide all except landing_page (primary key)
      setVisibleColumnIds(["landing_page_path"]);
    } else {
      // Show all
      setVisibleColumnIds(allColumns.map((c) => c.id));
    }
  };

  // Validation Logic
  const validation = useMemo(() => {
    if (!field || value === "") return { valid: true };
    return validateFilter({ field, operator, value }, filters);
  }, [field, operator, value, filters]);

  const handleAddF = () => {
    if (field && value !== "" && validation.valid) {
      onAddFilter({ field, operator, value });
      setField("");
      setValue("");
      setShowAddForm(false);
    }
  };

  const metricCols = useMemo(
    () => allColumns.filter((c) => c.id !== "landing_page_path"),
    [allColumns],
  );
  const isAllSelected = metricCols.length > 0 && metricCols.every((c) =>
    visibleColumnIds.includes(c.id),
  );

  // Render as a persistent panel (Box/Card style)
  return (
    <Box
      sx={{
        width: { xs: "100%", md: 320 },
        height: { xs: "100%", md: height || 800 },
        display: "flex",
        flexDirection: "column",
        ...glassStyle,
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: { md: 3 },
        overflow: "hidden",
        boxShadow: isDark
          ? "0 20px 40px rgba(0, 0, 0, 0.6), inset 1px 1px 0px 0px rgba(255, 255, 255, 0.1)"
          : "0 8px 32px rgba(0, 0, 0, 0.12)",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          p: 2,
          borderBottom: "1px solid",
          borderColor: "divider",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          bgcolor: "transparent",
        }}
      >
        <Typography
          variant="h6"
          fontWeight={600}
          fontSize="0.95rem"
          color="text.primary"
        >
          Filter Panel
        </Typography>
        <IconButton
          onClick={onClose}
          size="small"
          sx={{ ...glassStyle, borderRadius: "50%", p: 0.5 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ overflowY: "auto", flex: 1, p: 2 }}>
        {/* NEW ACCORDION LAYOUT */}

        {/* 1. Metrics Section */}
        {metricCols.length > 0 && (
          <Accordion
            expanded={expanded === "metrics"}
            onChange={handleAccordionChange("metrics")}
            disableGutters
            elevation={0}
            sx={{
              bgcolor: "transparent",
              "&:before": { display: "none" },
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography
                variant="subtitle2"
                color="text.primary"
                sx={{
                  textTransform: "uppercase",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  letterSpacing: 0.5,
                }}
              >
                Metrics
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ p: 0, pb: 2 }}>
              <List dense disablePadding>
                {/* "All" Toggle */}
                <ListItem dense divider button onClick={handleToggleAllMetrics}>
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    <Checkbox
                      edge="start"
                      checked={isAllSelected}
                      indeterminate={
                        !isAllSelected &&
                        metricCols.some((c) => visibleColumnIds.includes(c.id))
                      }
                      tabIndex={-1}
                      disableRipple
                      size="small"
                    />
                  </ListItemIcon>
                  <ListItemText
                    primary="All Metrics"
                    primaryTypographyProps={{
                      fontWeight: 600,
                      fontSize: "0.875rem",
                      color: isAllSelected ? "primary.main" : "text.primary",
                    }}
                  />
                </ListItem>

                {/* Individual Metrics */}
                {metricCols.map((col) => {
                  const isChecked = visibleColumnIds.includes(col.id);
                  return (
                    <ListItem
                      key={col.id}
                      dense
                      divider
                      button
                      onClick={() => handleToggleColumn(col.id)}
                      sx={{
                        transition: "background-color 0.2s",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                    >
                      <ListItemIcon sx={{ minWidth: 36 }}>
                        <Checkbox
                          edge="start"
                          checked={isChecked}
                          tabIndex={-1}
                          disableRipple
                          size="small"
                          sx={{
                            p: 0.5,
                            color: "action.disabled",
                            "&.Mui-checked": { color: "primary.main" },
                          }}
                        />
                      </ListItemIcon>
                      <ListItemText
                        primary={col.label}
                        primaryTypographyProps={{ fontSize: "0.875rem" }}
                      />
                    </ListItem>
                  );
                })}
              </List>
            </AccordionDetails>
          </Accordion>
        )}

        {(isAuthor ||
          (permissions.includes("product_table_filters:inventory") && hasDrrDohAccess) ||
          (permissions.includes("product_table_filters") && !isGranularMode && hasDrrDohAccess)) && (
          <Accordion
            expanded={expanded === "inventory"}
            onChange={handleAccordionChange("inventory")}
            disableGutters
            elevation={0}
            sx={{
              bgcolor: "transparent",
              "&:before": { display: "none" },
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography
              variant="subtitle2"
              color="text.primary"
              sx={{
                textTransform: "uppercase",
                fontSize: "0.75rem",
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            >
              Inventory Analysis
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 2, pb: 2 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mb: 1.5, display: "block", fontSize: "0.7rem" }}
            >
              Select calculation period for Daily Run Rate & Days On Hand
            </Typography>
            <ToggleButtonGroup
              value={inventoryPeriod}
              exclusive
              onChange={(e, val) => val && onInventoryPeriodChange(val)}
              size="small"
              fullWidth
              sx={{
                bgcolor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
                borderRadius: 2,
                p: "4px",
                "& .MuiToggleButton-root": {
                  border: "none",
                  borderRadius: "6px !important",
                  py: 0.5,
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  color: "text.secondary",
                  textTransform: "none",
                  "&.Mui-selected": {
                    bgcolor: isDark ? "rgba(255,255,255,0.1)" : "background.paper",
                    color: "primary.main",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                    "&:hover": {
                      bgcolor: isDark
                        ? "rgba(255,255,255,0.15)"
                        : "background.paper",
                    },
                  },
                },
              }}
            >
              {["7d", "30d", "90d"].map((period) => (
                <ToggleButton key={period} value={period}>
                  {period}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </AccordionDetails>
        </Accordion>
        )}

        {(isAuthor ||
          permissions.includes("product_table_filters:page_type") ||
          (permissions.includes("product_table_filters") && !isGranularMode)) && (
          <Accordion
            expanded={expanded === "page-type"}
            onChange={handleAccordionChange("page-type")}
            disableGutters
            elevation={0}
            sx={{
              bgcolor: "transparent",
              "&:before": { display: "none" },
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography
              variant="subtitle2"
              color="text.primary"
              sx={{
                textTransform: "uppercase",
                fontSize: "0.75rem",
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            >
              Page Type
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0, pb: 2 }}>
            <List dense disablePadding>
              {PAGE_TYPES.map((type) => {
                const isChecked = pageTypes.includes(type);
                return (
                  <ListItem
                    key={type}
                    dense
                    divider
                    button
                    onClick={() => handleTogglePageType(type)}
                  >
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <Checkbox
                        edge="start"
                        checked={isChecked}
                        tabIndex={-1}
                        disableRipple
                        size="small"
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={type}
                      primaryTypographyProps={{
                        fontSize: "0.8125rem",
                        fontWeight: isChecked ? 600 : 400,
                        color: isChecked ? "primary.main" : "text.secondary",
                      }}
                    />
                  </ListItem>
                );
              })}
            </List>
          </AccordionDetails>
        </Accordion>
        )}

        {(isAuthor ||
          permissions.includes("product_table_filters:product_types") ||
          (permissions.includes("product_table_filters") && !isGranularMode)) && (
          <Accordion
            expanded={expanded === "productTypes"}
            onChange={handleAccordionChange("productTypes")}
            disableGutters
            elevation={0}
            sx={{
              bgcolor: "transparent",
              "&:before": { display: "none" },
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography
              variant="subtitle2"
              color="text.primary"
              sx={{
                textTransform: "uppercase",
                fontSize: "0.75rem",
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            >
              Product Types
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 0, pb: 2 }}>
            <Box sx={{ maxHeight: 300, overflowY: "auto" }}>
              {loadingTypes ? (
                <Box sx={{ p: 2, display: "flex", justifyContent: "center" }}>
                  <CircularProgress size={20} />
                </Box>
              ) : (
                <List dense disablePadding>
                  <ListItem dense divider button onClick={handleToggleAllTypes}>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <Checkbox
                        edge="start"
                        checked={isAllTypesSelected}
                        indeterminate={isIndeterminateTypes}
                        tabIndex={-1}
                        disableRipple
                        size="small"
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary="Select All"
                      primaryTypographyProps={{
                        fontWeight: 600,
                        fontSize: "0.875rem",
                        color: isAllTypesSelected
                          ? "primary.main"
                          : "text.primary",
                      }}
                    />
                  </ListItem>
                  {availableProductTypes.map((type) => {
                    const isChecked = productTypes.includes(type);
                    return (
                      <ListItem
                        key={type}
                        dense
                        divider
                        button
                        onClick={() => handleToggleType(type)}
                        sx={{
                          transition: "background-color 0.2s",
                          "&:hover": { bgcolor: "action.hover" },
                        }}
                      >
                        <ListItemIcon sx={{ minWidth: 36 }}>
                          <Checkbox
                            edge="start"
                            checked={isChecked}
                            tabIndex={-1}
                            disableRipple
                            size="small"
                            sx={{
                              p: 0.5,
                              color: "action.disabled",
                              "&.Mui-checked": { color: "primary.main" },
                            }}
                          />
                        </ListItemIcon>
                        <ListItemText
                          primary={type}
                          primaryTypographyProps={{ fontSize: "0.875rem" }}
                        />
                      </ListItem>
                    );
                  })}
                  {availableProductTypes.length === 0 && (
                    <ListItem>
                      <ListItemText
                        primary="No types found"
                        primaryTypographyProps={{
                          fontSize: "0.875rem",
                          color: "text.secondary",
                          textAlign: "center",
                        }}
                      />
                    </ListItem>
                  )}
                </List>
              )}
            </Box>
          </AccordionDetails>
        </Accordion>
        )}

        {(isAuthor ||
          permissions.includes("product_table_filters:sort_filter") ||
          (permissions.includes("product_table_filters") && !isGranularMode)) && (
          <Accordion
            expanded={expanded === "filters"}
            onChange={handleAccordionChange("filters")}
            disableGutters
            elevation={0}
            sx={{
              bgcolor: "transparent",
              "&:before": { display: "none" },
              borderBottom: "1px solid",
              borderColor: "divider",
            }}
          >
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography
              variant="subtitle2"
              color="text.primary"
              sx={{
                textTransform: "uppercase",
                fontSize: "0.75rem",
                fontWeight: 700,
                letterSpacing: 0.5,
              }}
            >
              Filters
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ p: 1 }}>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                mb: 1,
              }}
            >
              <Tooltip title="Add New Filter">
                <IconButton
                  size="small"
                  onClick={() => setShowAddForm(!showAddForm)}
                  color={showAddForm ? "primary" : "default"}
                  sx={{
                    bgcolor: showAddForm ? "action.selected" : "transparent",
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <AddIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>

            {/* Add Filter Form */}
            <Collapse in={showAddForm} unmountOnExit>
              <Card
                variant="outlined"
                sx={{
                  p: 2,
                  mb: 2,
                  borderRadius: 2,
                  bgcolor: "action.hover",
                  border: "1px dashed",
                  borderColor: "divider",
                }}
              >
                <Stack spacing={2}>
                  <FormControl size="small" fullWidth>
                    <InputLabel>Field</InputLabel>
                    <Select
                      value={field}
                      label="Field"
                      onChange={(e) => setField(e.target.value)}
                      MenuProps={{
                        PaperProps: {
                          sx: {
                            width: "var(--select-width)",
                          },
                        },
                        onEntering: (node) => {
                          const selectNode =
                            node.parentElement?.querySelector(
                              '[role="combobox"]',
                            );
                          if (selectNode) {
                            node.style.width = `${selectNode.clientWidth}px`;
                          }
                        },
                      }}
                    >
                      {allColumns
                        .filter((c) => c.id !== "landing_page_path")
                        .map((c) => (
                          <MenuItem key={c.id} value={c.id}>
                            {c.label}
                          </MenuItem>
                        ))}
                    </Select>
                  </FormControl>
                  <Stack direction="row" spacing={1}>
                    <FormControl size="small" sx={{ width: "40%" }}>
                      <Select
                        value={operator}
                        onChange={(e) => setOperator(e.target.value)}
                        MenuProps={{
                          PaperProps: {
                            sx: {
                              width: "var(--select-width)",
                            },
                          },
                          onEntering: (node) => {
                            const selectNode =
                              node.parentElement?.querySelector(
                                '[role="combobox"]',
                              );
                            if (selectNode) {
                              node.style.width = `${selectNode.clientWidth}px`;
                            }
                          },
                        }}
                      >
                        <MenuItem value="gt">&gt; (Gt)</MenuItem>
                        <MenuItem value="lt">&lt; (Lt)</MenuItem>
                      </Select>
                    </FormControl>
                    <TextField
                      size="small"
                      type="number"
                      placeholder="Val"
                      value={value}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === "" || Number(val) >= 0) {
                          setValue(val);
                        }
                      }}
                      inputProps={{ min: 0 }}
                      sx={{ flex: 1 }}
                    />
                  </Stack>

                  {!validation.valid && (
                    <Alert
                      severity="warning"
                      sx={{
                        py: 0,
                        px: 1,
                        "& .MuiAlert-message": { fontSize: "0.75rem" },
                        alignItems: "center",
                      }}
                    >
                      {validation.message}
                    </Alert>
                  )}

                  <Button
                    variant="contained"
                    size="small"
                    disabled={!field || !value || !validation.valid}
                    onClick={handleAddF}
                    sx={{
                      alignSelf: "flex-end",
                      textTransform: "none",
                      borderRadius: 2,
                      boxShadow: "none",
                    }}
                  >
                    Apply Filter
                  </Button>
                </Stack>
              </Card>
            </Collapse>

            {/* Active Filters List */}
            {filters.length === 0 && !showAddForm ? (
              <Box
                sx={{
                  p: 3,
                  textAlign: "center",
                  bgcolor: "action.hover",
                  borderRadius: 2,
                  border: "1px dashed",
                  borderColor: "divider",
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  No active filters
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  Click + to add one
                </Typography>
              </Box>
            ) : (
              <Box sx={{ maxHeight: 200, overflowY: "auto", pr: 0.5 }}>
                <Stack spacing={1}>
                  {filters.map((f, idx) => {
                    const col = allColumns.find((c) => c.id === f.field);
                    return (
                      <Card
                        key={idx}
                        variant="outlined"
                        sx={{
                          p: 1,
                          pl: 2,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          borderRadius: 2,
                          bgcolor: isDark
                            ? "rgba(91, 163, 224, 0.08)"
                            : "rgba(11, 107, 203, 0.04)",
                          border: "1px solid",
                          borderColor: isDark
                            ? "rgba(91, 163, 224, 0.3)"
                            : "rgba(11, 107, 203, 0.2)",
                        }}
                      >
                        <Box>
                          <Typography
                            variant="caption"
                            display="block"
                            color="text.secondary"
                            fontSize="0.65rem"
                            fontWeight={600}
                            sx={{ textTransform: "uppercase" }}
                          >
                            {col?.label || f.field}
                          </Typography>
                          <Typography
                            variant="body2"
                            fontWeight={500}
                            fontSize="0.75rem"
                          >
                            {f.operator === "gt" ? "Greater than" : "Less than"}{" "}
                            <b>{f.value}</b>
                          </Typography>
                        </Box>
                        <IconButton
                          size="small"
                          onClick={() => onRemoveFilter(idx)}
                          sx={{
                            color: "text.secondary",
                            "&:hover": { color: "error.main" },
                          }}
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Card>
                    );
                  })}
                </Stack>
              </Box>
            )}
          </AccordionDetails>
        </Accordion>
        )}
      </Box>

      {/* Footer */}
      {filters.length > 0 && (
        <Box
          sx={{
            p: 2,
            borderTop: "1px solid",
            borderColor: "divider",
            bgcolor: "transparent",
          }}
        >
          <Button
            fullWidth
            variant="text"
            color="error"
            onClick={onClearFilters}
            startIcon={<DeleteIcon />}
            sx={{
              ...glassStyle,
              textTransform: "none",
              bgcolor: "rgba(211, 47, 47, 0.08)",
              borderColor: "rgba(211, 47, 47, 0.3)",
              "&:hover": {
                bgcolor: "rgba(211, 47, 47, 0.15)",
                borderColor: "rgba(211, 47, 47, 0.5)",
              },
            }}
          >
            Clear All Filters
          </Button>
        </Box>
      )}
    </Box>
  );
}

const MemoizedTable = memo(
  ({
    columns,
    rows,
    status,
    sortBy,
    sortDir,
    compareMode,
    handleSort,
    start,
    end,
    compareStart,
    compareEnd,
    columnWidths,
    handleMouseDown,
  }) => {
    return (
      <Table size="small" sx={{ tableLayout: "fixed", minWidth: "100%" }}>
        <TableHead>
          <TableRow sx={{ bgcolor: "rgba(255,255,255,0.08)" }}>
            {columns.map((col) => (
              <TableCell
                key={col.id}
                align={col.align}
                sx={{
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  position: "relative",
                  width: columnWidths[col.id] || "auto",
                  minWidth: columnWidths[col.id] || "auto",
                  maxWidth: columnWidths[col.id] || "auto",
                  "&:hover .resize-handle": {
                    opacity: 1,
                  },
                }}
              >
                {col.sortable === false ? (
                  col.label
                ) : (
                  <TableSortLabel
                    active={sortBy === col.id}
                    direction={sortBy === col.id ? sortDir : "asc"}
                    onClick={() => handleSort(col.id)}
                  >
                    {col.label}
                  </TableSortLabel>
                )}
                <Box
                  className="resize-handle"
                  onMouseDown={(e) => handleMouseDown(e, col.id)}
                  sx={{
                    position: "absolute",
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: "1px",
                    cursor: "col-resize",
                    bgcolor: "#10b981",
                    opacity: 0,
                    transition: "opacity 0.2s",
                    zIndex: 1,
                  }}
                />
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {status !== "loading" && rows.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={columns.length}
                align="center"
                sx={{ py: 3, color: "text.secondary" }}
              >
                No data for the selected range.
              </TableCell>
            </TableRow>
          )}
          {rows.map((row, idx) => (
            <TableRow key={`${row.landing_page_path || "path"}-${idx}`}>
              {columns.map((col) => {
                const raw = row[col.id] ?? "";
                const value = col.format ? col.format(raw) : formatNumber(raw);
                const display =
                  col.id === "landing_page_path"
                    ? row.landing_page_path || "—"
                    : value;

                let delta = null;
                if (
                  compareMode &&
                  row.previous &&
                  col.id !== "landing_page_path"
                ) {
                  const prev = Number(row.previous[col.id] || 0);
                  const curr = Number(raw || 0);
                  delta = (
                    <DeltaBadge
                      current={curr}
                      previous={prev}
                      isPercent={["atc_rate", "checkout_rate", "cvr"].includes(col.id)}
                    />
                  );
                }
                const prevRaw =
                  compareMode && row.previous ? row.previous[col.id] : null;
                const prevDisplay =
                  prevRaw !== null && prevRaw !== undefined
                    ? col.format
                      ? col.format(prevRaw)
                      : formatNumber(prevRaw)
                    : null;

                const cellContent = (
                  <Box
                    sx={{
                      position: "relative",
                      display: "flex",
                      flexDirection: "column",
                      alignItems:
                        col.align === "right" ? "flex-end" : "flex-start",
                      pr: compareMode && col.align === "right" ? "70px" : 0,
                      width: "100%",
                    }}
                  >
                    <span
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "block",
                        width: "100%",
                      }}
                    >
                      {display}
                    </span>
                    {prevDisplay && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontSize: "0.70rem", lineHeight: 1.2 }}
                      >
                        {prevDisplay}
                      </Typography>
                    )}
                    {delta && (
                      <Box
                        sx={{
                          position: "absolute",
                          right: col.align === "right" ? 0 : "auto",
                          left: col.align === "right" ? "auto" : "100%",
                          top: "50%",
                          transform: "translateY(-50%)",
                          ml: col.align === "right" ? 0 : 1,
                        }}
                      >
                        {delta}
                      </Box>
                    )}
                  </Box>
                );

                return (
                  <TableCell
                    key={col.id}
                    align={col.align}
                    sx={{
                      verticalAlign: "middle",
                      width: columnWidths[col.id] || "auto",
                      minWidth: columnWidths[col.id] || "auto",
                      maxWidth: columnWidths[col.id] || "auto",
                      overflow: "hidden",
                    }}
                  >
                    {col.id === "landing_page_path" ? (
                      <Tooltip title={row.landing_page_path || ""} arrow>
                        {cellContent}
                      </Tooltip>
                    ) : (
                      cellContent
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  },
);

export default function ProductConversionTable({
  brandKey,
  showCompareMode = true,
  isAuthor,
  permissions = [],
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  // Available Product Types (Fetched here now)
  const [availableProductTypes, setAvailableProductTypes] = useState([]);
  const [loadingTypes, setLoadingTypes] = useState(false);
  const [expanded, setExpanded] = useState("metrics");

  const dispatch = useAppDispatch();
  const productState = useAppSelector((state) => state.productConversion);
  const {
    start,
    end,
    page,
    pageSize,
    sortBy,
    sortDir,
    rows,
    totalCount,
    status,
    error,
    compareMode,
    compareStart,
    compareEnd,
    productTypes,
    pageTypes,
    inventoryPeriod,
  } = productState;
  const { convertAmount } = useInrCurrency(brandKey, end);
  const [exporting, setExporting] = useState(false);
  const [localSearch, setLocalSearch] = useState(productState.search || "");

  useEffect(() => {
    if (!brandKey) return;
    setLoadingTypes(true);
    getProductTypes({
      brand_key: brandKey,
      date: end ? dayjs(end).format("YYYY-MM-DD") : undefined,
    })
      .then((res) => {
        if (res.types) setAvailableProductTypes(res.types);
      })
      .finally(() => setLoadingTypes(false));
  }, [brandKey, end]);

  const glassStyle = {
    bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(255, 255, 255, 0.6)",
    backdropFilter: "blur(12px)",
    border: "1px solid",
    borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.08)",
    borderRadius: 2,
    transition: "all 0.2s ease",
    "&:hover": {
      bgcolor: isDark
        ? "rgba(255, 255, 255, 0.06)"
        : "rgba(255, 255, 255, 0.8)",
      borderColor: isDark ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.12)",
    },
  };

  // Columns definition (Memoized to prevent recreation)
  const columns = useMemo(
    () => [
      { id: "landing_page_path", label: "Landing Page", align: "left" },
      { id: "sessions", label: "Sessions", align: "right" },
      { id: "atc", label: "ATC Sessions", align: "right" },
      {
        id: "atc_rate",
        label: "ATC Rate",
        align: "right",
        format: formatPercent,
      },
      { id: "ci_events", label: "CI Events", align: "right" },
      {
        id: "checkout_rate",
        label: "Checkout Rate",
        align: "right",
        format: formatPercent,
      },
      { id: "orders", label: "Orders", align: "right" },
      {
        id: "sales",
        label: "Sales",
        align: "right",
        format: (val) => formatCurrency(val, convertAmount),
      },
      { id: "cvr", label: "CVR", align: "right", format: formatPercent },
      {
        id: "drr",
        label: `DRR (${productState.inventoryPeriod || "7d"})`,
        align: "right",
        format: (val) => (val !== null ? formatNumber(val) : "-"),
        sortable: false,
      },
      {
        id: "doh",
        label: `DOH (${productState.inventoryPeriod || "7d"})`,
        align: "right",
        format: (val) => (val !== null ? formatNumber(val) : "-"),
        sortable: false,
      },
    ],
    [productState.inventoryPeriod, convertAmount],
  );

  const isGranularMode = useMemo(() => {
    return (permissions || []).some(
      (p) =>
        p.startsWith("product_conversion:") ||
        p.startsWith("product_table_filters:"),
    );
  }, [permissions]);

  const permittedColumns = useMemo(() => {
    // 1. Author and 'all' permission override everything
    if (isAuthor || (permissions && permissions.includes("all"))) {
      return columns;
    }

    // 2. If granular permissions (column OR filter) are defined, use strict mode
    if (isGranularMode) {
      const hasAnyColumnSub = (permissions || []).some((p) =>
        p.startsWith("product_conversion:"),
      );

      // If specific columns are defined, show only those.
      if (hasAnyColumnSub) {
        return columns.filter(
          (col) =>
            col.id === "landing_page_path" ||
            permissions.includes(`product_conversion:${col.id}`),
        );
      }

      // 2.3 Default Landing Page Enforcement: 
      // If they have the master 'product_conversion' tag, but NO column-specific scopes are defined,
      // return ALL columns (legacy behavior). 
      // BUT if NO master tag AND no column scopes, return just landing page.
      if (!permissions.includes("product_conversion")) {
        return columns.filter((c) => c.id === "landing_page_path");
      }
    }

    // 3. Fallback: If not in granular mode, use master 'product_conversion' tag
    if (permissions && permissions.includes("product_conversion")) {
      return columns;
    }

    // 4. Default: Just the landing page
    return columns.filter((c) => c.id === "landing_page_path");
  }, [columns, isAuthor, permissions, isGranularMode]);

  // Panel State (Boolean togglable)
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showTypeFilter, setShowTypeFilter] = useState(false);
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  // Dynamic Height Calculation for Filter Panel
  const estimatedRowHeight = 55; // Avg row height with padding
  const tableHeaderFooterHeight = 56 + 52; // Header + Pagination
  const estimatedTableHeight =
    pageSize * estimatedRowHeight + tableHeaderFooterHeight;

  // If 10 rows, match table height (approx). Else, 1/3 of table height.
  // Exception: if table is very small (no data), use min height.
  const panelHeight =
    pageSize === 10
      ? Math.max(600, estimatedTableHeight)
      : Math.max(400, estimatedTableHeight / 4);
  const [visibleColumnIds, setVisibleColumnIds] = useState(() => {
    const permittedIds = permittedColumns.map((c) => c.id);
    const hasAnyColumnSub = (permissions || []).some((p) =>
      p.startsWith("product_conversion:"),
    );

    // If explicit granular columns are set, show ALL of them by default
    if (hasAnyColumnSub) {
      return permittedIds;
    }

    // Otherwise, use hardcoded defaults filtered by permissions
    const defaults = [
      "landing_page_path",
      "sessions",
      "atc_rate",
      permittedIds.includes("checkout_rate") ? "checkout_rate" : "ci_events",
      "orders",
      "cvr",
    ];
    return defaults.filter((id) => permittedIds.includes(id));
  });

  // Forced Range Sync: If user has DRR/DOH columns but NO inventory filter access, lock to 7d
  useEffect(() => {
    if (isAuthor || (permissions && permissions.includes("all"))) return;

    const hasInventoryFilterAccess =
      permissions.includes("product_table_filters:inventory") ||
      (permissions.includes("product_table_filters") && !isGranularMode);

    const hasDrrDohAccess = (permissions || []).some((p) =>
      p.includes("product_conversion:drr") || p.includes("product_conversion:doh")
    );

    if (
      hasDrrDohAccess &&
      !hasInventoryFilterAccess &&
      inventoryPeriod !== "7d"
    ) {
      dispatch(setInventoryPeriod("7d"));
    }
  }, [permissions, inventoryPeriod, isGranularMode, isAuthor, dispatch]);

  // Column Resizing Logic
  const [columnWidths, setColumnWidths] = useState({
    landing_page_path: 320,
    sessions: 120,
    ci_events: 120,
    checkout_rate: 120,
    orders: 120,
    cvr: 100,
    atc: 120,
    atc_rate: 120,
    sales: 120,
  });

  const resizingColumn = useRef(null);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleMouseDown = (e, colId) => {
    resizingColumn.current = colId;
    startX.current = e.pageX;
    startWidth.current = columnWidths[colId];
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    e.preventDefault();
  };

  const handleMouseMove = useCallback((e) => {
    if (!resizingColumn.current) return;
    const diff = e.pageX - startX.current;
    const newWidth = Math.max(80, startWidth.current + diff);
    setColumnWidths((prev) => ({
      ...prev,
      [resizingColumn.current]: newWidth,
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    resizingColumn.current = null;
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  }, [handleMouseMove]);

  // Effect to enforce compareMode = false if showCompareMode is false
  useEffect(() => {
    if (!showCompareMode && compareMode) {
      dispatch(setCompareMode(false));
    }
  }, [showCompareMode, compareMode, dispatch]);

  // Compute visible columns
  const visibleColumns = useMemo(() => {
    return permittedColumns.filter((c) => visibleColumnIds.includes(c.id));
  }, [permittedColumns, visibleColumnIds]);

  // Handler for clearing all filters
  const handleClearFilters = () => {
    dispatch(clearFilters());
    dispatch(setProductTypes([]));
    dispatch(setPageTypes([]));
    triggerFetch({ filters: [], productTypes: [], pageTypes: [] });
  };

  const handleProductTypeChange = (types) => {
    dispatch(setProductTypes(types));
    triggerFetch({ productTypes: types, page: 1 });
  };

  const handleRemoveProductType = (typeToRemove) => {
    const newTypes = (productTypes || []).filter((t) => t !== typeToRemove);
    dispatch(setProductTypes(newTypes));
    triggerFetch({ productTypes: newTypes, page: 1 });
  };

  const handlePageTypeChange = (types) => {
    dispatch(setPageTypes(types));
    triggerFetch({ pageTypes: types, page: 1 });
  };

  const handleRemovePageType = (typeToRemove) => {
    const newTypes = (pageTypes || []).filter((t) => t !== typeToRemove);
    dispatch(setPageTypes(newTypes));
    triggerFetch({ pageTypes: newTypes, page: 1 });
  };

  // const isDark = theme.palette.mode === 'dark'; // Handled in DateRangePicker
  const fetchTimer = useRef(null);
  const inflight = useRef(null);
  const paramsRef = useRef({
    start,
    end,
    page,
    pageSize,
    sortBy,
    sortDir,
    compareMode,
    compareStart,
    compareEnd,
    filters: productState.filters,
    search: productState.search,
    productTypes: productState.productTypes,
    pageTypes: productState.pageTypes,
  });

  // Effects for paramsRef and fetch cancellation
  useEffect(() => {
    return () => {
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      if (inflight.current?.abort) inflight.current.abort();
    };
  }, []);

  useEffect(() => {
    paramsRef.current = {
      start,
      end,
      page,
      pageSize,
      sortBy,
      sortDir,
      compareMode,
      compareStart,
      compareEnd,
      filters: productState.filters,
      search: productState.search,
      productTypes: productState.productTypes,
      pageTypes: productState.pageTypes,
    };
  }, [
    start,
    end,
    page,
    pageSize,
    sortBy,
    sortDir,
    compareMode,
    compareStart,
    compareEnd,
    productState.filters,
    productState.search,
    productState.productTypes,
    productState.pageTypes,
  ]);

  const runFetch = useCallback(
    (params = {}) => {
      if (fetchTimer.current) {
        clearTimeout(fetchTimer.current);
        fetchTimer.current = null;
      }
      if (!brandKey) return;
      if (inflight.current?.abort) inflight.current.abort();

      // Merge params and ensure dates are formatted as YYYY-MM-DD strings for the API
      const base = paramsRef.current || {};
      const merged = { ...base, ...params };

      const formatDate = (val) => {
        if (!val) return null;
        // If it's a dayjs object
        if (val.format) return val.format("YYYY-MM-DD");
        // If it's a string, try to parse and clean it, or just return strict substring if it looks like ISO
        if (typeof val === "string") {
          if (val.includes("T")) return val.split("T")[0];
          return val;
        }
        // If it's a Date object
        if (val instanceof Date) return dayjs(val).format("YYYY-MM-DD");
        return val;
      };

      if (merged.start) merged.start = formatDate(merged.start);
      if (merged.end) merged.end = formatDate(merged.end);
      if (merged.compareStart)
        merged.compareStart = formatDate(merged.compareStart);
      if (merged.compareEnd) merged.compareEnd = formatDate(merged.compareEnd);

      const promise = dispatch(
        fetchProductConversion({ brand_key: brandKey, ...merged }),
      );
      inflight.current = promise;
      promise.finally(() => {
        if (inflight.current === promise) inflight.current = null;
      });
    },
    [brandKey, dispatch],
  );

  const triggerFetch = useCallback(
    (params = {}) => {
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      fetchTimer.current = setTimeout(() => {
        runFetch(params);
      }, 200);
    },
    [runFetch],
  );

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (localSearch !== (productState.search || "")) {
        dispatch(setSearch(localSearch));
        triggerFetch({ search: localSearch, page: 1 });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [localSearch, productState.search, dispatch, triggerFetch]);

  useEffect(() => {
    if (brandKey) runFetch();
  }, [brandKey, runFetch]);

  const applyDateChange = useCallback(
    (s, e) => {
      const nextStart = s
        ? s.format("YYYY-MM-DD")
        : dayjs().format("YYYY-MM-DD");
      const nextEnd = e ? e.format("YYYY-MM-DD") : nextStart;
      dispatch(setDateRange({ start: nextStart, end: nextEnd }));
      runFetch({ start: nextStart, end: nextEnd, page: 1 });
    },
    [dispatch, runFetch],
  );

  const applyCompDateChange = useCallback(
    (s, e) => {
      const nextStart = s ? s.format("YYYY-MM-DD") : null;
      const nextEnd = e ? e.format("YYYY-MM-DD") : nextStart;
      dispatch(setCompareDateRange({ start: nextStart, end: nextEnd }));
      triggerFetch({ compareStart: nextStart, compareEnd: nextEnd });
    },
    [dispatch, triggerFetch],
  );

  const activePreset = useMemo(() => {
    const s = start ? dayjs(start) : null;
    const e = end ? dayjs(end) : null;
    if (!s || !e) return null;
    const found = DATE_PRESETS.find((preset) => {
      const [ps, pe] = preset.getValue();
      return s.isSame(ps, "day") && e.isSame(pe, "day");
    });
    return found?.label || null;
  }, [start, end]);

  const activeCompPreset = useMemo(() => {
    const s = compareStart ? dayjs(compareStart) : null;
    const e = compareEnd ? dayjs(compareEnd) : null;
    if (!s || !e) return null;
    const found = DATE_PRESETS.find((preset) => {
      const [ps, pe] = preset.getValue();
      return s.isSame(ps, "day") && e.isSame(pe, "day");
    });
    return found?.label || null;
  }, [compareStart, compareEnd]);

  const showHourlyCompareAvailabilityWarning = useMemo(() => {
    if (!compareMode) return false;

    const hourlyDataCutoff = dayjs().startOf("day").subtract(6, "day");
    const currentStart = start ? dayjs(start).startOf("day") : null;
    const currentEnd = end ? dayjs(end).startOf("day") : currentStart;
    const previousStart = compareStart ? dayjs(compareStart).startOf("day") : null;
    const previousEnd = compareEnd ? dayjs(compareEnd).startOf("day") : previousStart;

    const isRangeOutsideHourlyWindow = (rangeStart, rangeEnd) => {
      if (!rangeStart || !rangeEnd) return false;
      return rangeStart.isBefore(hourlyDataCutoff) || rangeEnd.isBefore(hourlyDataCutoff);
    };

    return (
      isRangeOutsideHourlyWindow(currentStart, currentEnd) ||
      isRangeOutsideHourlyWindow(previousStart, previousEnd)
    );
  }, [compareMode, start, end, compareStart, compareEnd]);

  const handleCompareModeChange = (e) => {
    const isCompare = e.target.value === "compare";

    const currentStart = dayjs(start);
    const currentEnd = dayjs(end);

    dispatch(setCompareMode(isCompare));

    if (isCompare && !compareStart) {
      // Default to same duration previous to the current start date.
      const s = currentStart;
      const e = currentEnd;
      const duration = e.diff(s, "day");
      const prevEnd = s.subtract(1, "day");
      const prevStart = prevEnd.subtract(duration, "day");

      const startStr = currentStart.format("YYYY-MM-DD");
      const endStr = currentEnd.format("YYYY-MM-DD");
      const compStartStr = prevStart.format("YYYY-MM-DD");
      const compEndStr = prevEnd.format("YYYY-MM-DD");

      dispatch(setCompareDateRange({ start: compStartStr, end: compEndStr }));
      triggerFetch({
        start: startStr,
        end: endStr,
        compareMode: true,
        compareStart: compStartStr,
        compareEnd: compEndStr,
      });
    } else {
      triggerFetch({
        start: currentStart.format("YYYY-MM-DD"),
        end: currentEnd.format("YYYY-MM-DD"),
        compareMode: isCompare,
      });
    }
  };

  const handleChangePage = (_e, newPage) => {
    const nextPage = newPage + 1;
    dispatch(setPage(nextPage));
    triggerFetch({ page: nextPage });
  };
  const handleChangeRowsPerPage = (e) => {
    const nextSize = parseInt(e.target.value, 10);
    dispatch(setPageSize(nextSize));
    triggerFetch({ page: 1, pageSize: nextSize });
  };
  const handleSort = useCallback(
    (column) => {
      const isAsc = sortBy === column && sortDir === "asc";
      const nextDir = isAsc ? "desc" : "asc";
      dispatch(setSort({ sortBy: column, sortDir: nextDir }));
      triggerFetch({ page: 1, sortBy: column, sortDir: nextDir });
    },
    [dispatch, sortBy, sortDir, triggerFetch],
  );

  const handleOpenFilterPanel = useCallback(() => {
    setShowFilterPanel(true);
  }, []);

  const handleExport = async () => {
    setExporting(true);
    const permittedIds = permittedColumns.map((c) => c.id);
    const exportColumns = (visibleColumnIds || []).filter((id) =>
      permittedIds.includes(id),
    );

    const resp = await exportProductConversionCsv({
      brand_key: brandKey,
      start,
      end,
      sortBy,
      sortDir,
      filters: productState.filters,
      search: productState.search,
      visible_columns: exportColumns,
      compareStart: compareMode ? compareStart : undefined,
      compareEnd: compareMode ? compareEnd : undefined,
    });
    setExporting(false);
    if (resp.error || !resp.blob) return;
    const url = URL.createObjectURL(resp.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resp.filename || "product_conversion.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack spacing={2}>
      {/* Shopify-like Mobile Filter Bar */}
      <Box
        sx={{
          display: { xs: "flex", md: "none" },
          flexDirection: "column",
          gap: 1.5,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <TextField
            size="small"
            placeholder="Search products..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="action" />
                </InputAdornment>
              ),
              sx: {
                bgcolor: "background.paper",
                fontSize: "0.875rem",
                borderRadius: 2,
                "& fieldset": { borderColor: "divider" },
              },
            }}
          />
          <IconButton
            size="small"
            onClick={handleExport}
            disabled={exporting || status === "loading"}
            sx={{
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 2,
              width: 40,
              height: 40,
              bgcolor: "background.paper",
              color: "text.primary",
              mr: 1,
            }}
          >
            {exporting ? (
              <CircularProgress size={16} />
            ) : (
              <DownloadIcon fontSize="small" />
            )}
          </IconButton>

          <IconButton
            size="small"
            onClick={() => setShowFilterPanel(true)}
            sx={{
              border: "1px solid",
              borderColor: "divider",
              borderRadius: 2,
              width: 40,
              height: 40,
              bgcolor:
                showFilterPanel || productState.filters?.length > 0
                  ? "primary.main"
                  : "background.paper",
              color:
                showFilterPanel || productState.filters?.length > 0
                  ? "primary.contrastText"
                  : "text.primary",
              "&:hover": {
                bgcolor:
                  showFilterPanel || productState.filters?.length > 0
                    ? "primary.dark"
                    : "action.hover",
              },
            }}
          >
            <FilterListIcon fontSize="small" />
          </IconButton>
        </Box>

        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: compareMode ? "1fr 1fr auto" : "1fr auto",
            gap: 1,
            alignItems: "center",
            width: "100%",
          }}
        >
          {/* Primary Date (Left) */}
          <Box sx={{ justifySelf: "start", width: "100%" }}>
            <DateRangePicker
              startDate={start}
              endDate={end}
              onApply={applyDateChange}
              variant="default"
              labelPrefix="Current:"
              activePresetLabel={activePreset}
              sx={{
                width: "100%",
                minWidth: 0,
                height: 36,
                borderRadius: 2,
                px: 0.5,
                "& .MuiTypography-root": {
                  fontSize: 12,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                },
              }}
            />
          </Box>

          {/* Secondary Date (Middle) - Only if compareMode */}
          {compareMode && (
            <Box sx={{ justifySelf: "start", width: "100%" }}>
              <DateRangePicker
                startDate={compareStart}
                endDate={compareEnd}
                onApply={applyCompDateChange}
                label="Compare"
                labelPrefix="Compare:"
                activePresetLabel={activeCompPreset}
                disableDatesAfter={dayjs().toDate()}
                sx={{
                  width: "100%",
                  minWidth: 0,
                  height: 36,
                  borderRadius: 2,
                  px: 0.5,
                  "& .MuiTypography-root": {
                    fontSize: 12,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  },
                }}
              />
            </Box>
          )}

          {/* Compare Selector (Right) */}
          {showCompareMode && (
            <Box sx={{ justifySelf: "end" }}>
              <FormControl size="small">
                <Select
                  value={compareMode ? "compare" : "none"}
                  onChange={handleCompareModeChange}
                  size="small"
                  sx={{
                    bgcolor: "background.paper",
                    fontSize: 12,
                    height: 36,
                    borderRadius: 2,
                    fontWeight: 500,
                    "& .MuiOutlinedInput-notchedOutline": {
                      borderColor: "divider",
                    },
                    "& .MuiSelect-select": { py: 0.5, px: 2 },
                  }}
                  MenuProps={{
                    PaperProps: { sx: { width: "var(--select-width)" } },
                    onEntering: (node) => {
                      const selectNode =
                        node.parentElement?.querySelector('[role="combobox"]');
                      if (selectNode)
                        node.style.width = `${selectNode.clientWidth}px`;
                    },
                  }}
                >
                  <MenuItem value="none" sx={{ fontSize: 13 }}>
                    No comparison
                  </MenuItem>
                  <MenuItem value="compare" sx={{ fontSize: 13 }}>
                    Compare
                  </MenuItem>
                </Select>
              </FormControl>
            </Box>
          )}
        </Box>
      </Box>

      {/* Desktop Header - Redesigned */}
      <Box
        sx={{
          display: { xs: "none", md: "flex" },
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          gap: 2,
        }}
      >
        {/* Left Actions */}
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Add Metrics Button (Old Filter) */}
          <Button
            variant="text"
            size="small"
            startIcon={<AddIcon fontSize="small" />}
            onClick={() => {
              setShowFilterPanel(!showFilterPanel);
              setExpanded("metrics");
            }}
            sx={{
              ...glassStyle,
              height: 38,
              px: 1.5,
              textTransform: "none",
              color: "text.secondary",
              fontSize: "0.8125rem",
              fontWeight: 500,
            }}
          >
            Add Metrics
          </Button>

          {/* Compare Button */}
          {showCompareMode && (
            <FormControl size="small" sx={{ minWidth: 100 }}>
              <Select
                value={compareMode ? "compare" : "none"}
                onChange={handleCompareModeChange}
                size="small"
                IconComponent={SwapVertIcon}
                sx={{
                  ...glassStyle,
                  height: 38,
                  fontSize: "0.8125rem",
                  color: "text.secondary",
                  "& .MuiSelect-select": { py: 0, px: 1.5 },
                  "& .MuiOutlinedInput-notchedOutline": { border: "none" },
                }}
              >
                <MenuItem value="none">No comparison</MenuItem>
                <MenuItem value="compare">Compare</MenuItem>
              </Select>
            </FormControl>
          )}

          {/* Export CSV Button */}
          <Button
            variant="text"
            size="small"
            startIcon={
              exporting ? (
                <CircularProgress size={16} />
              ) : (
                <DownloadIcon fontSize="small" />
              )
            }
            onClick={handleExport}
            disabled={exporting || status === "loading"}
            sx={{
              ...glassStyle,
              height: 38,
              px: 1.5,
              textTransform: "none",
              color: "text.secondary",
              fontSize: "0.8125rem",
              fontWeight: 500,
            }}
          >
            Export CSV
          </Button>

          {/* Date Range Pickers (Cleaned up) */}
          <Box
            sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: 0.5 }}
          >
            {showCompareMode && (
              <DateRangePicker
                startDate={compareStart}
                endDate={compareEnd}
                onApply={applyCompDateChange}
                label="Compare"
                labelPrefix="Comp:"
                activePresetLabel={activeCompPreset}
                disabled={!compareMode}
                disableDatesAfter={dayjs().toDate()}
                sx={{
                  ...glassStyle,
                  minWidth: 150,
                  height: 38,
                  borderRadius: 2,
                  "& .MuiTypography-root": { fontSize: "0.72rem" },
                }}
              />
            )}

            <DateRangePicker
              startDate={start}
              endDate={end}
              onApply={applyDateChange}
              variant="primary"
              labelPrefix="Curr:"
              activePresetLabel={activePreset}
              disableDatesAfter={dayjs().toDate()}
              sx={{
                ...glassStyle,
                minWidth: 150,
                height: 38,
                borderRadius: 2,
                bgcolor: isDark
                  ? "rgba(92, 163, 224, 0.1)"
                  : "rgba(91, 163, 226, 0.08)",
                color: isDark ? "#5ba3e0" : "#1976d2",
                borderColor: isDark
                  ? "rgba(91, 163, 224, 0.3)"
                  : "rgba(25, 118, 210, 0.2)",
                "& .MuiTypography-root": {
                  fontSize: "0.72rem",
                  fontWeight: 600,
                },
              }}
            />
          </Box>
        </Box>

        {/* Right Search */}
        <Box sx={{ width: 240 }}>
          <TextField
            size="small"
            placeholder="Search products..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" color="disabled" />
                </InputAdornment>
              ),
              sx: {
                ...glassStyle,
                height: 38,
                fontSize: "0.875rem",
                "& fieldset": { border: "none" },
                "& input::placeholder": { opacity: 0.6 },
              },
            }}
          />
        </Box>
      </Box>

      {showHourlyCompareAvailabilityWarning && (
        <Alert
          severity="warning"
          sx={{
            py: 0.5,
            px: 1.25,
            alignItems: "center",
            "& .MuiAlert-message": { fontSize: "0.8rem" },
          }}
        >
          Hourly compare data is only available for the last 7 days. Selected range is outside that window.
        </Alert>
      )}

      {/* Filter Summary / Active Chips (optional display if panel is closed) */}
      {/* Filter Summary / Active Chips (Scrollable Row) */}
      {((productState.filters && productState.filters.length > 0) ||
        (productTypes && productTypes.length > 0) ||
        (pageTypes && pageTypes.length > 0)) && (
        <Box
          sx={{
            display: "flex",
            gap: 1,
            overflowX: "auto",
            alignItems: "center",
            pb: 0.5,
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {/* Page Types (Product/Collection) */}
          {(pageTypes || []).map((type) => (
            <Grow key={`page-type-${type}`} in={true}>
              <div>
                <GlassChip
                  label={`Page: ${type}`}
                  onDelete={() => handleRemovePageType(type)}
                  size="small"
                  isDark={theme.palette.mode === "dark"}
                  sx={{ borderRadius: "9999px", whiteSpace: "nowrap" }}
                />
              </div>
            </Grow>
          ))}

          {/* Product Types */}
          {(productTypes || []).map((type) => (
            <Grow key={`type-${type}`} in={true}>
              <div>
                <GlassChip
                  label={`Type: ${type}`}
                  onDelete={() => handleRemoveProductType(type)}
                  size="small"
                  isDark={theme.palette.mode === "dark"}
                  sx={{ borderRadius: "9999px", whiteSpace: "nowrap" }}
                />
              </div>
            </Grow>
          ))}

          {/* Metric Filters */}
          {productState.filters.map((f, idx) => {
            const col = columns.find((c) => c.id === f.field);
            return (
              <Grow key={`filter-${idx}`} in={true}>
                <div>
                  <GlassChip
                    label={`${col?.label || f.field} ${f.operator === "gt" ? ">" : "<"} ${f.value}`}
                    size="small"
                    onDelete={() => {
                      dispatch(removeFilter(idx));
                      const newFilters = [...productState.filters];
                      newFilters.splice(idx, 1);
                      triggerFetch({ filters: newFilters });
                    }}
                    isDark={theme.palette.mode === "dark"}
                    sx={{ borderRadius: "9999px", whiteSpace: "nowrap" }}
                  />
                </div>
              </Grow>
            );
          })}

          <Button
            size="small"
            color="primary"
            onClick={handleClearFilters}
            sx={{
              textTransform: "none",
              fontSize: "0.75rem",
              minWidth: "auto",
              whiteSpace: "nowrap",
            }}
          >
            Clear all
          </Button>
        </Box>
      )}

      {/* Flex Container for Table + Side Panel */}
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 2,
          minHeight: 500,
        }}
      >
        {/* Main Table Content (Flex Grow) */}
        <Box sx={{ flex: 1, minWidth: 0, transition: "all 0.3s ease" }}>
          <Card variant="outlined" sx={{ height: "100%" }}>
            <CardContent
              sx={{
                p: 0,
                height: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <TableContainer sx={{ flex: 1, overflow: "auto" }}>
                <MemoizedTable
                  columns={visibleColumns}
                  rows={rows}
                  status={status}
                  sortBy={sortBy}
                  sortDir={sortDir}
                  compareMode={compareMode}
                  handleSort={handleSort}
                  start={start}
                  end={end}
                  compareStart={compareStart}
                  compareEnd={compareEnd}
                  columnWidths={columnWidths}
                  handleMouseDown={handleMouseDown}
                  onOpenFilter={handleOpenFilterPanel}
                  hasActiveFilters={
                    productState.filters?.length > 0 ||
                    visibleColumnIds.length < columns.length
                  }
                />
                {error && (
                  <Box
                    sx={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      bgcolor: "rgba(0,0,0,0.16)",
                      px: 2,
                    }}
                  >
                    <Alert severity="error">Failed to load data</Alert>
                  </Box>
                )}
                {status === "loading" && (
                  <Box
                    sx={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      bgcolor: "rgba(0,0,0,0.12)",
                      pointerEvents: "none",
                    }}
                  >
                    <CircularProgress size={24} />
                  </Box>
                )}
              </TableContainer>
              <Divider />
              <Box sx={{ display: "flex", justifyContent: "center" }}>
                <TablePagination
                  component="div"
                  count={totalCount}
                  page={Math.max(0, page - 1)}
                  onPageChange={handleChangePage}
                  rowsPerPage={pageSize}
                  onRowsPerPageChange={handleChangeRowsPerPage}
                  rowsPerPageOptions={[10, 25, 50]}
                  ActionsComponent={(props) => (
                    <PaginationActions
                      {...props}
                      disabled={status === "loading" || exporting}
                    />
                  )}
                  SelectProps={{ disabled: status === "loading" || exporting }}
                />
              </Box>
            </CardContent>
          </Card>
        </Box>

        {/* Filter Panel (Collapsible on Desktop, Drawer on Mobile) */}
        {isMobile ? (
          <Drawer
            anchor="bottom"
            open={showFilterPanel}
            onClose={() => setShowFilterPanel(false)}
            PaperProps={{
              sx: {
                height: "80vh",
                borderRadius: "16px 16px 0 0",
                bgcolor: "background.paper",
                backgroundImage: "none",
              },
            }}
          >
            <DetailedFilterPanel
              isAuthor={isAuthor}
              isGranularMode={isGranularMode}
              permissions={permissions}
              onClose={() => setShowFilterPanel(false)}
              allColumns={permittedColumns}
              visibleColumnIds={visibleColumnIds}
              setVisibleColumnIds={setVisibleColumnIds}
              filters={productState.filters || []}
              onAddFilter={(newFilter) => {
                const existingIdx = (productState.filters || []).findIndex(
                  (f) =>
                    f.field === newFilter.field &&
                    f.operator === newFilter.operator,
                );
                if (existingIdx !== -1) {
                  // Replace existing
                  dispatch(removeFilter(existingIdx));
                  dispatch(addFilter(newFilter));
                  const updated = [...(productState.filters || [])];
                  updated.splice(existingIdx, 1, newFilter);
                  triggerFetch({ filters: updated });
                } else {
                  // Add new
                  dispatch(addFilter(newFilter));
                  triggerFetch({
                    filters: [...(productState.filters || []), newFilter],
                  });
                }
              }}
              onRemoveFilter={(idx) => {
                dispatch(removeFilter(idx));
                const newFilters = [...(productState.filters || [])];
                newFilters.splice(idx, 1);
                triggerFetch({ filters: newFilters });
              }}
              onClearFilters={handleClearFilters}
              brandKey={brandKey}
              date={end}
              productTypes={productTypes}
              availableProductTypes={availableProductTypes}
              loadingTypes={loadingTypes}
              onProductTypeChange={handleProductTypeChange}
              pageTypes={pageTypes}
              onPageTypeChange={handlePageTypeChange}
              inventoryPeriod={inventoryPeriod}
              onInventoryPeriodChange={(val) => dispatch(setInventoryPeriod(val))}
              expanded={expanded}
              onExpandedChange={setExpanded}
            />
          </Drawer>
        ) : (
          <Collapse in={showFilterPanel} orientation="horizontal" timeout={300}>
            <DetailedFilterPanel
              isAuthor={isAuthor}
              isGranularMode={isGranularMode}
              permissions={permissions}
              onClose={() => setShowFilterPanel(false)}
              allColumns={permittedColumns}
              visibleColumnIds={visibleColumnIds}
              setVisibleColumnIds={setVisibleColumnIds}
              filters={productState.filters || []}
              height={panelHeight}
              onAddFilter={(newFilter) => {
                const existingIdx = (productState.filters || []).findIndex(
                  (f) =>
                    f.field === newFilter.field &&
                    f.operator === newFilter.operator,
                );
                if (existingIdx !== -1) {
                  // Replace existing
                  dispatch(removeFilter(existingIdx));
                  dispatch(addFilter(newFilter));
                  const updated = [...(productState.filters || [])];
                  updated.splice(existingIdx, 1, newFilter);
                  triggerFetch({ filters: updated });
                } else {
                  // Add new
                  dispatch(addFilter(newFilter));
                  triggerFetch({
                    filters: [...(productState.filters || []), newFilter],
                  });
                }
              }}
              onRemoveFilter={(idx) => {
                dispatch(removeFilter(idx));
                const newFilters = [...(productState.filters || [])];
                newFilters.splice(idx, 1);
                triggerFetch({ filters: newFilters });
              }}
              onClearFilters={handleClearFilters}
              brandKey={brandKey}
              date={end}
              productTypes={productTypes}
              availableProductTypes={availableProductTypes}
              loadingTypes={loadingTypes}
              onProductTypeChange={handleProductTypeChange}
              pageTypes={pageTypes}
              onPageTypeChange={handlePageTypeChange}
              inventoryPeriod={inventoryPeriod}
              onInventoryPeriodChange={(val) => dispatch(setInventoryPeriod(val))}
              expanded={expanded}
              onExpandedChange={setExpanded}
            />
          </Collapse>
        )}
      </Box>
    </Stack>
  );
}
