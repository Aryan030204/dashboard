import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  Box,
  Paper,
  Button,
  Divider,
  Popover,
  Typography,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  useTheme,
  Collapse,
  Fade,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Checkbox,
  FormControlLabel,
  Stack,
  TextField,
  InputAdornment,
  Tooltip,
} from "@mui/material";
import {
  CalendarDays,
  ChevronDown,
  Download,
  Filter,
  Search,
  X,
  AlertTriangle,
  ArrowLeftRight,
} from "lucide-react";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { DatePicker } from "@shopify/polaris";
import dayjs from "dayjs";
import SearchableSelect from "./ui/SearchableSelect.jsx";
import StaticSearchableList from "./ui/StaticSearchableList.jsx";
import {
  DEFAULT_DATA_RESTRICTION_CONFIG,
  getDataRestrictionWarningText,
  normalizeDataRestrictionConfig,
  isRangeOverDataRestrictionPeriod,
} from "../lib/dateRange.js";
import { MAX_DISCOUNT_CODES } from "../state/slices/filterSlice.js";

// Date Presets (Same as MobileTopBar for consistency)
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
      dayjs().subtract(7, "day").startOf("day"),
      dayjs().subtract(1, "day").startOf("day"),
    ],
    group: 2,
  },
  {
    label: "Last 30 days",
    getValue: () => [
      dayjs().subtract(30, "day").startOf("day"),
      dayjs().subtract(1, "day").startOf("day"),
    ],
    group: 2,
  },
  {
    label: "Last month",
    getValue: () => [
      dayjs().subtract(1, "month").startOf("month").startOf("day"),
      dayjs().subtract(1, "month").endOf("month").startOf("day"),
    ],
    group: 2,
  },
  {
    label: "Month-to-date",
    getValue: () => [
      dayjs().startOf("month").startOf("day"),
      dayjs().startOf("day"),
    ],
    group: 2,
  },
  {
    label: "Last 90 days",
    getValue: () => [
      dayjs().subtract(90, "day").startOf("day"),
      dayjs().subtract(1, "day").startOf("day"),
    ],
    group: 2,
  },
];

export default function UnifiedFilterBar({
  range,
  onRangeChange,
  brandKey,
  brands = [],
  onBrandChange,
  isAuthor,
  // Compare Mode Props
  compareMode = false,
  onCompareModeChange,
  compareDateRange,
  onCompareDateRangeChange,
  // Filter Props
  productOptions = [],
  productValue,
  onProductChange,
  productDisabled = false,
  productLoading,
  utm = {},
  onUtmChange,
  utmDisabled = false,
  disableUtmMediumCampaign = false,
  allowProductUtmSync = false,
  salesChannel,
  onSalesChannelChange,
  salesChannelDisabled = false,
  deviceType,
  onDeviceTypeChange,
  deviceTypeDisabled = false,
  city = [],
  onCityChange,
  cityDisabled = false,
  discountCodes = [],
  onDiscountCodesChange,
  discountDisabled = false,
  productType,
  onProductTypeChange,
  productTypeDisabled = false,
  allowedFilters = {
    product: true,
    utm: true,
    salesChannel: true,
    deviceType: true,
    city: true,
    discount: true,
    productType: true,
  },
  utmOptions = {}, // Add prop
  dataRestrictionConfig = DEFAULT_DATA_RESTRICTION_CONFIG,
  onDownload, // Callback for download button
  hideAllExceptDate = false,
  children,
}) {

  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const [start, end] = range || [];

  // --- Popover States ---
  const [dateAnchor, setDateAnchor] = useState(null);
  const [brandAnchor, setBrandAnchor] = useState(null);
  const [filterAnchor, setFilterAnchor] = useState(null);
  const [utmSourceAnchor, setUtmSourceAnchor] = useState(null);
  const [utmMediumAnchor, setUtmMediumAnchor] = useState(null);
  const [utmCampaignAnchor, setUtmCampaignAnchor] = useState(null);
  const [utmExpanded, setUtmExpanded] = useState(false); // Toggle visibility of UTM settings
  const [expandedAccordion, setExpandedAccordion] = useState("channel"); // Default expanded
  const [productSearch, setProductSearch] = useState("");
  const [discountSearch, setDiscountSearch] = useState("");
  const [compareToggleAnchor, setCompareToggleAnchor] = useState(null);

  const handleAccordionChange = (panel) => (event, isExpanded) => {
    setExpandedAccordion(isExpanded ? panel : false);
  };

  // --- Date Picker State ---
  const [month, setMonth] = useState((end || start || dayjs()).month());
  const [year, setYear] = useState((end || start || dayjs()).year());

  // --- Compare Date Picker State ---
  const [compDateAnchor, setCompDateAnchor] = useState(null);
  const [compMonth, setCompMonth] = useState(
    (compareDateRange?.[0] ? dayjs(compareDateRange[0]) : dayjs()).month(),
  );
  const [compYear, setCompYear] = useState(
    (compareDateRange?.[0] ? dayjs(compareDateRange[0]) : dayjs()).year(),
  );

  const [compStart, compEnd] = useMemo(
    () => [
      compareDateRange?.[0] ? dayjs(compareDateRange[0]) : null,
      compareDateRange?.[1] ? dayjs(compareDateRange[1]) : null,
    ],
    [compareDateRange],
  );

  // --- Date Logic ---
  useEffect(() => {
    const focus = end || start;
    if (focus) {
      setMonth(focus.month());
      setYear(focus.year());
    }
  }, [start, end, dateAnchor]); // Update when opening

  useEffect(() => {
    const focus = compEnd || compStart;
    if (focus) {
      setCompMonth(focus.month());
      setCompYear(focus.year());
    }
  }, [compStart, compEnd, compDateAnchor]);

  const handleDateClick = (event) => setDateAnchor(event.currentTarget);
  const handleDateClose = () => setDateAnchor(null);

  const handlePresetSelect = (preset) => {
    const [s, e] = preset.getValue();
    onRangeChange([s, e]);
    handleDateClose();
  };

  const handleCalendarChange = ({ start: ns, end: ne }) => {
    const s = ns ? dayjs(ns).startOf("day") : null;
    const e = ne ? dayjs(ne).startOf("day") : null;
    onRangeChange([s, e ?? s ?? null]);
  };

  const dateLabel = useMemo(() => {
    if (!start) return "Select dates";
    if (start && end && start.isSame(end, "day"))
      return start.format("MMM DD, YYYY");
    return `${start.format("MMM DD")} - ${end ? end.format("MMM DD, YYYY") : "..."}`;
  }, [start, end]);

  // --- Compare Mode Logic ---
  const handleCompareModeToggle = (enable) => {
    setCompareToggleAnchor(null);
    if (enable) {
      if (onCompareModeChange) onCompareModeChange(true);
      // Auto-compute compare date: same duration, 7 days back
      // (yesterday would be identical to the default comparison)
      if (start && end) {
        const duration = end.diff(start, "day");
        const compEnd = start.subtract(7, "day");
        const compStart = compEnd.subtract(duration, "day");
        if (onCompareDateRangeChange)
          onCompareDateRangeChange([compStart, compEnd]);
      }
    } else {
      if (onCompareModeChange) onCompareModeChange(false);
    }
  };

  const handleCompDateClick = (event) => setCompDateAnchor(event.currentTarget);
  const handleCompDateClose = () => setCompDateAnchor(null);

  const handleCompCalendarChange = ({ start: ns, end: ne }) => {
    const s = ns ? dayjs(ns).startOf("day") : null;
    const e = ne ? dayjs(ne).startOf("day") : null;
    if (onCompareDateRangeChange) onCompareDateRangeChange([s, e ?? s ?? null]);
  };

  const compDateLabel = useMemo(() => {
    if (!compStart) return "Compare";
    if (compStart && compEnd && compStart.isSame(compEnd, "day"))
      return compStart.format("MMM DD, YYYY");
    return `${compStart.format("MMM DD")} - ${compEnd ? compEnd.format("MMM DD, YYYY") : "..."}`;
  }, [compStart, compEnd]);

  const currDateLabel = useMemo(() => {
    if (!start) return "Select dates";
    if (start && end && start.isSame(end, "day"))
      return start.format("MMM DD, YYYY");
    return `${start.format("MMM DD")} - ${end ? end.format("MMM DD, YYYY") : "..."}`;
  }, [start, end]);

  // --- Brand Logic ---
  const handleBrandClick = (event) => setBrandAnchor(event.currentTarget);
  const handleBrandClose = () => setBrandAnchor(null);
  const handleBrandSelect = (key) => {
    onBrandChange(key);
    handleBrandClose();
  };

  // --- Filter Logic ---
  const handleFilterClick = (event) => setFilterAnchor(event.currentTarget);
  const handleFilterClose = () => setFilterAnchor(null);

  const activeFilterCount = [
    ...(Array.isArray(salesChannel) ? salesChannel : [salesChannel]),
    ...(Array.isArray(deviceType) ? deviceType : []),
    ...(Array.isArray(city) ? city : [city]),
    ...(Array.isArray(discountCodes) ? discountCodes : [discountCodes]),
    ...(Array.isArray(productType) ? productType : []),
    ...(Array.isArray(productValue) ? productValue : [productValue])?.map(
      (p) => p?.id,
    ),
  ].filter(Boolean).length;

  const utmCount = [
    utm?.source?.length || 0,
    utm?.medium?.length || 0,
    utm?.campaign?.length || 0,
    utm?.term?.length || 0,
    utm?.content?.length || 0,
  ].reduce((a, b) => a + b, 0);

  const handleUtmSourceClick = (event) =>
    setUtmSourceAnchor(event.currentTarget);
  const handleUtmSourceClose = () => setUtmSourceAnchor(null);

  const handleUtmMediumClick = (event) =>
    setUtmMediumAnchor(event.currentTarget);
  const handleUtmMediumClose = () => setUtmMediumAnchor(null);

  const handleUtmCampaignClick = (event) =>
    setUtmCampaignAnchor(event.currentTarget);
  const handleUtmCampaignClose = () => setUtmCampaignAnchor(null);
  const normalizedRestrictionConfig = useMemo(
    () => normalizeDataRestrictionConfig(dataRestrictionConfig),
    [dataRestrictionConfig],
  );
  const utmRestrictionWarning = useMemo(
    () => getDataRestrictionWarningText(normalizedRestrictionConfig),
    [normalizedRestrictionConfig],
  );

  const isDateRangeOver30Days = useMemo(() => {
    return isRangeOverDataRestrictionPeriod(
      start,
      end,
      normalizedRestrictionConfig,
    );
  }, [start, end, normalizedRestrictionConfig]);

  // Auto-collapse UTM and clear filters when date range changes to exceed 30 days
  const prevOver30Ref = useRef(isDateRangeOver30Days);
  useEffect(() => {
    // Only act when transitioning from ≤30 to >30 (not on mount)
    if (isDateRangeOver30Days && !prevOver30Ref.current) {
      setUtmExpanded(false);
      if (onUtmChange) {
        onUtmChange({
          source: [],
          medium: [],
          campaign: [],
          term: [],
          content: [],
        });
      }
    }
    prevOver30Ref.current = isDateRangeOver30Days;
  }, [isDateRangeOver30Days]);

  const toggleUtmExpanded = () => {
    if (isDateRangeOver30Days) {
      // Still allow toggle so warning is visible
      setUtmExpanded((prev) => !prev);
      return;
    }
    setUtmExpanded((prev) => !prev);
  };

  // UTM Nested Options
  const utmSourceOptions = useMemo(
    () => Object.keys(utmOptions?.utm_tree || {}),
    [utmOptions],
  );

  const utmMediumOptions = useMemo(() => {
    const sources = utm?.source || [];
    if (sources.length === 0) {
      // If no source selected, show all mediums across all sources?
      // Or only allow selection after source?
      // Let's show all for better UX initially, or follow "strictly nested"
      const allMediums = new Set();
      Object.values(utmOptions?.utm_tree || {}).forEach((s) => {
        Object.keys(s.mediums || {}).forEach((m) => allMediums.add(m));
      });
      return Array.from(allMediums);
    }
    const mediums = new Set();
    sources.forEach((s) => {
      const data = utmOptions?.utm_tree?.[s];
      if (data?.mediums) {
        Object.keys(data.mediums).forEach((m) => mediums.add(m));
      }
    });
    return Array.from(mediums);
  }, [utmOptions, utm?.source]);

  const utmCampaignOptions = useMemo(() => {
    const sources = utm?.source || [];
    const selectedMediums = utm?.medium || [];
    if (sources.length === 0 && selectedMediums.length === 0) {
      const allCampaigns = new Set();
      Object.values(utmOptions?.utm_tree || {}).forEach((s) => {
        Object.values(s.mediums || {}).forEach((m) => {
          Object.keys(m.campaigns || {}).forEach((c) => allCampaigns.add(c));
        });
      });
      return Array.from(allCampaigns);
    }

    const campaigns = new Set();
    Object.entries(utmOptions?.utm_tree || {}).forEach(([s, sData]) => {
      if (sources.length > 0 && !sources.includes(s)) return;
      Object.entries(sData.mediums || {}).forEach(([m, mData]) => {
        if (selectedMediums.length > 0 && !selectedMediums.includes(m)) return;
        Object.keys(mData.campaigns || {}).forEach((c) => campaigns.add(c));
      });
    });
    return Array.from(campaigns);
  }, [utmOptions, utm?.source, utm?.medium]);

  const utmSourceLabel = useMemo(() => {
    const selected = utm?.source || [];
    if (selected.length === 0) return "Source";
    return `Source(${selected.length})`;
  }, [utm?.source]);

  const utmMediumLabel = useMemo(() => {
    const selected = utm?.medium || [];
    if (selected.length === 0) return "Medium";
    return `Medium(${selected.length})`;
  }, [utm?.medium]);

  const utmCampaignLabel = useMemo(() => {
    const selected = utm?.campaign || [];
    if (selected.length === 0) return "Campaign";
    return `Campaign(${selected.length})`;
  }, [utm?.campaign]);

  const utmButtonSx = {
    px: 1.5,
    height: 40,
    maxWidth: { xs: 132, sm: 168, md: 220 },
    minWidth: 0,
    color: "text.secondary",
    textTransform: "none",
    fontWeight: 500,
    fontSize: "0.85rem",
    borderRadius: 0,
    flexShrink: 1,
    "& .MuiButton-endIcon": {
      flexShrink: 0,
      ml: 0.5,
    },
    "&:hover": {
      bgcolor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
    },
  };

  const utmLabelSx = {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    display: "block",
    minWidth: 0,
  };

  // --- Visibility Logic ---
  const showUtm = !hideAllExceptDate && allowedFilters.utm;
  const showBrand = !hideAllExceptDate && (isAuthor || brands.length > 1);
  const showDivision =
    !hideAllExceptDate &&
    (allowedFilters.salesChannel ||
      allowedFilters.deviceType ||
      allowedFilters.city ||
      allowedFilters.discount ||
      allowedFilters.productType ||
      allowedFilters.product);
  const hasChannelValue = Array.isArray(salesChannel) && salesChannel.length > 0;
  const hasDeviceTypeValue = Array.isArray(deviceType) && deviceType.length > 0;
  const hasCityValue = Array.isArray(city) && city.length > 0;
  const hasProductTypeValue = Array.isArray(productType) && productType.length > 0;
  const selectedDiscountCodes = Array.isArray(discountCodes) ? discountCodes : [];
  const hasDiscountValue = selectedDiscountCodes.length > 0;
  const exclusiveGroupReason = hasChannelValue
    ? "Channel"
    : hasDeviceTypeValue
      ? "Device Type"
      : hasCityValue
        ? "City"
        : hasProductTypeValue
          ? "Product Type"
          : "";
  const disabledUtmTooltip = exclusiveGroupReason
    ? `Clear ${exclusiveGroupReason} filter to use UTM filters`
    : hasDiscountValue
      ? "Clear discount filter to use UTM filters"
      : "Clear product filter to use UTM filters";
  const disabledUtmNestedTooltip = exclusiveGroupReason || hasDiscountValue
    ? disabledUtmTooltip
    : disableUtmMediumCampaign
      ? "Clear product filter to use Medium/Campaign"
      : "";
  const disabledProductTooltip = exclusiveGroupReason
    ? `Clear ${exclusiveGroupReason} filter to use product filter`
    : hasDiscountValue
      ? "Clear discount filter to use product filter"
      : allowProductUtmSync
        ? "Clear UTM medium/campaign filters to use product filter"
        : "Clear UTM filters to use product filter";
  const disabledChannelTooltip = "Clear other active filters to use Channel";
  const disabledDeviceTypeTooltip = "Clear other active filters to use Device Type";
  const disabledCityTooltip = "Clear other active filters to use City";
  const disabledDiscountTooltip = "Clear other active filters to use Discount Code";
  const disabledProductTypeTooltip = "Clear other active filters to use Product Type";


  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      {/* The Unified Bar */}
      <Paper
        elevation={0}
        sx={{
          display: "flex",
          alignItems: "center",
          border: "1px solid",
          borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
          borderRadius: "12px",
          bgcolor: isDark ? "rgba(255,255,255,0.05)" : "#fff",
          overflow: "hidden",
          height: 40,
        }}
      >
        {children}
        {children && (
          <Divider
            orientation="vertical"
            flexItem
            sx={{
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
            }}
          />
        )}

        {/* 1. Filter Icon (Far Left) - Toggles UTM Visibility */}
        {showUtm && (
          <Box sx={{ px: 0.75, display: "flex", alignItems: "center" }}>
            <IconButton
              onClick={compareMode ? undefined : toggleUtmExpanded}
              disabled={compareMode}
              size="small"
              sx={{
                width: 32,
                height: 32,
                bgcolor: utmCount > 0 ? "primary.main" : "transparent",
                color: utmCount > 0 ? "primary.contrastText" : "text.secondary",
                borderRadius: "50%",
                border: "1px solid",
                borderColor:
                  utmCount > 0
                    ? "primary.main"
                    : isDark
                      ? "rgba(255,255,255,0.1)"
                      : "rgba(0,0,0,0.1)",
                transition: "all 0.3s ease-in-out",
                transform: utmExpanded ? "rotate(90deg)" : "none",
                "&:hover": {
                  bgcolor:
                    utmCount > 0
                      ? "primary.dark"
                      : isDark
                        ? "rgba(255,255,255,0.05)"
                        : "rgba(0,0,0,0.03)",
                  transform: utmExpanded
                    ? "rotate(90deg) scale(1.1)"
                    : "scale(1.1)",
                },
              }}
            >
              <Filter size={16} />
              {utmCount > 0 && (
                <Box
                  sx={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    bgcolor: "error.main",
                    color: "error.contrastText",
                    borderRadius: "50%",
                    width: 14,
                    height: 14,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.6rem",
                    fontWeight: 700,
                    border: "1px solid",
                    borderColor: isDark ? "#1e1e1e" : "#fff",
                  }}
                >
                  {utmCount}
                </Box>
              )}
            </IconButton>
          </Box>
        )}

        {showUtm && (
          <Divider
            orientation="vertical"
            flexItem
            sx={{
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
            }}
          />
        )}

        {/* 2. UTM Filter Group (Toggled by Icon) */}
        {showUtm && (
          <Collapse
            in={utmExpanded}
            orientation="horizontal"
            unmountOnExit
            timeout={350}
          >
            {isDateRangeOver30Days ? (
              /* Warning message when date range > 30 days */
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.75,
                  px: 2,
                  height: 40,
                  whiteSpace: "nowrap",
                  bgcolor: isDark
                    ? "rgba(255, 152, 0, 0.08)"
                    : "rgba(255, 152, 0, 0.06)",
                }}
              >
                <AlertTriangle
                  size={14}
                  style={{ color: "#ed6c02", flexShrink: 0 }}
                />
                <Typography
                  variant="caption"
                  sx={{
                    color: "#ed6c02",
                    fontWeight: 600,
                    fontSize: "0.75rem",
                    letterSpacing: "0.01em",
                  }}
                >
                  {utmRestrictionWarning}
                </Typography>
                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{
                    borderColor: isDark
                      ? "rgba(255,255,255,0.1)"
                      : "rgba(0,0,0,0.1)",
                  }}
                />
              </Box>
            ) : (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  bgcolor: isDark
                    ? "rgba(255,255,255,0.02)"
                    : "rgba(0,0,0,0.01)",
                  whiteSpace: "nowrap",
                }}
              >
                {/* ... Source Button ... */}
                <Tooltip title={utmDisabled ? disabledUtmTooltip : ""}>
                  <span>
                    <Button
                      onClick={handleUtmSourceClick}
                      disabled={utmDisabled}
                      endIcon={<ChevronDown size={14} />}
                      sx={{
                        ...utmButtonSx,
                        color:
                          (utm?.source?.length || 0) > 0
                            ? "primary.main"
                            : "text.secondary",
                      }}
                    >
                      <Box component="span" sx={utmLabelSx}>
                        {utmSourceLabel}
                      </Box>
                    </Button>
                  </span>
                </Tooltip>

                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{
                    height: 20,
                    my: "auto",
                    borderColor: isDark
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.05)",
                  }}
                />

                {/* ... Medium Button ... */}
                <Tooltip
                  title={
                    utmDisabled || disableUtmMediumCampaign
                      ? disabledUtmNestedTooltip || disabledUtmTooltip
                      : ""
                  }
                >
                  <span>
                    <Button
                      onClick={handleUtmMediumClick}
                      disabled={utmDisabled || disableUtmMediumCampaign}
                      endIcon={<ChevronDown size={14} />}
                      sx={{
                        ...utmButtonSx,
                        color:
                          (utm?.medium?.length || 0) > 0
                            ? "primary.main"
                            : "text.secondary",
                      }}
                    >
                      <Box component="span" sx={utmLabelSx}>
                        {utmMediumLabel}
                      </Box>
                    </Button>
                  </span>
                </Tooltip>

                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{
                    height: 20,
                    my: "auto",
                    borderColor: isDark
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.05)",
                  }}
                />

                {/* ... Campaign Button ... */}
                <Tooltip
                  title={
                    utmDisabled || disableUtmMediumCampaign
                      ? disabledUtmNestedTooltip || disabledUtmTooltip
                      : ""
                  }
                >
                  <span>
                    <Button
                      onClick={handleUtmCampaignClick}
                      disabled={utmDisabled || disableUtmMediumCampaign}
                      endIcon={<ChevronDown size={14} />}
                      sx={{
                        ...utmButtonSx,
                        color:
                          (utm?.campaign?.length || 0) > 0
                            ? "primary.main"
                            : "text.secondary",
                      }}
                    >
                      <Box component="span" sx={utmLabelSx}>
                        {utmCampaignLabel}
                      </Box>
                    </Button>
                  </span>
                </Tooltip>

                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{
                    height: 20,
                    my: "auto",
                    borderColor: isDark
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.05)",
                  }}
                />

                {/* Clear Button at the end of UTMs */}
                <Button
                  onClick={() =>
                    onUtmChange({
                      source: [],
                      medium: [],
                      campaign: [],
                      term: [],
                      content: [],
                    })
                  }
                  sx={{
                    px: 1.5,
                    height: 40,
                    color: "error.main",
                    textTransform: "none",
                    fontWeight: 600,
                    fontSize: "0.75rem",
                    minWidth: "auto",
                    "&:hover": {
                      bgcolor: isDark
                        ? "rgba(255,255,255,0.05)"
                        : "rgba(0,0,0,0.02)",
                    },
                  }}
                >
                  Clear
                </Button>

                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{
                    borderColor: isDark
                      ? "rgba(255,255,255,0.1)"
                      : "rgba(0,0,0,0.1)",
                  }}
                />
              </Box>
            )}
          </Collapse>
        )}

        {/* 3. Compare Toggle - ONLY FOR ADMINS */}
        {isAuthor && !hideAllExceptDate && (
          <>
            <Button
              onClick={(e) => setCompareToggleAnchor(e.currentTarget)}
              endIcon={<ChevronDown size={14} />}
              startIcon={<ArrowLeftRight size={14} />}
              sx={{
                px: 1.5,
                height: "100%",
                color: compareMode ? "primary.main" : "text.secondary",
                textTransform: "none",
                fontWeight: 600,
                fontSize: "0.8rem",
                borderRadius: 0,
                whiteSpace: "nowrap",
                "&:hover": {
                  bgcolor: isDark
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(0,0,0,0.03)",
                },
              }}
            >
              {compareMode ? "Compare" : "No comparison"}
            </Button>

            <Divider
              orientation="vertical"
              flexItem
              sx={{
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.1)",
              }}
            />
          </>
        )}

        {/* 3b. Compare Date ("To") - Only in compare mode */}
        {isAuthor && !hideAllExceptDate && compareMode && (
          <>
            <Button
              onClick={handleCompDateClick}
              sx={{
                px: 1.5,
                height: "100%",
                color: "text.primary",
                textTransform: "none",
                fontWeight: 500,
                fontSize: "0.8rem",
                borderRadius: 0,
                whiteSpace: "nowrap",
                bgcolor: isDark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.02)",
                "&:hover": {
                  bgcolor: isDark
                    ? "rgba(255,255,255,0.07)"
                    : "rgba(0,0,0,0.05)",
                },
              }}
            >
              <Box
                component="span"
                sx={{
                  fontSize: "0.65rem",
                  fontWeight: 700,
                  color: "text.secondary",
                  mr: 0.75,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                To:
              </Box>
              {compDateLabel}
            </Button>
            <Divider
              orientation="vertical"
              flexItem
              sx={{
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.1)",
              }}
            />
          </>
        )}


        {/* 3c. Current Date Segment */}
        <Button
          onClick={handleDateClick}
          startIcon={!compareMode ? <CalendarDays size={16} /> : undefined}
          endIcon={!compareMode ? <ChevronDown size={14} /> : undefined}
          sx={{
            px: compareMode ? 1.5 : 2,
            height: "100%",
            color: compareMode ? "#5ba3e0" : "text.primary",
            textTransform: "none",
            fontWeight: compareMode ? 600 : 500,
            fontSize: compareMode ? "0.8rem" : "0.875rem",
            borderRadius: 0,
            whiteSpace: "nowrap",
            "&:hover": {
              bgcolor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.03)",
            },
          }}
        >
          {compareMode && (
            <Box
              component="span"
              sx={{
                fontSize: "0.65rem",
                fontWeight: 700,
                color: "#5ba3e0",
                mr: 0.75,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Curr:
            </Box>
          )}
          {compareMode ? currDateLabel : dateLabel}
        </Button>

        {(showBrand || showDivision) && (
          <Divider
            orientation="vertical"
            flexItem
            sx={{
              borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
            }}
          />
        )}

        {/* 4. Brand Segment (Only if multibrand/author) */}
        {showBrand && (
          <>
            <Button
              onClick={handleBrandClick}
              endIcon={<ChevronDown size={14} />}
              sx={{
                px: 2,
                height: "100%",
                color: "text.primary",
                textTransform: "none",
                fontWeight: 500,
                fontSize: "0.875rem",
                borderRadius: 0,
                minWidth: 100,
                justifyContent: "space-between",
                whiteSpace: "nowrap",
                "&:hover": {
                  bgcolor: isDark
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(0,0,0,0.03)",
                },
              }}
            >
              <Box
                component="span"
                sx={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 120,
                  display: "block",
                }}
              >
                {brandKey || "Select Brand"}
              </Box>
            </Button>
            {showDivision && (
              <Divider
                orientation="vertical"
                flexItem
                sx={{
                  borderColor: isDark
                    ? "rgba(255,255,255,0.1)"
                    : "rgba(0,0,0,0.1)",
                }}
              />
            )}
          </>
        )}

        {/* 5. Division/Filters Segment */}
        {showDivision && (
          <Button
            onClick={compareMode ? undefined : handleFilterClick}
            disabled={compareMode}
            endIcon={<ChevronDown size={14} />}
            sx={{
              px: 2,
              height: "100%",
              color: compareMode ? "text.disabled" : "text.primary",
              textTransform: "none",
              fontWeight: 500,
              fontSize: "0.875rem",
              borderRadius: 0,
              opacity: compareMode ? 0.5 : 1,
              cursor: compareMode ? "not-allowed" : "pointer",
              "&:hover": {
                bgcolor: compareMode
                  ? "transparent"
                  : isDark
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(0,0,0,0.03)",
              },
            }}
          >
            Division(All)
            {activeFilterCount > 0 && (
              <Box
                component="span"
                sx={{
                  ml: 1,
                  bgcolor: "primary.main",
                  color: "primary.contrastText",
                  borderRadius: "50%",
                  width: 18,
                  height: 18,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.65rem",
                }}
              >
                {activeFilterCount}
              </Box>
            )}
          </Button>
        )}
      </Paper>

      {/* Download Button (Separate) - ONLY FOR ADMINS */}
      {isAuthor && !hideAllExceptDate && (
        <IconButton
          onClick={onDownload}
          sx={{
            border: "1px solid",
            borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
            borderRadius: "10px",
            bgcolor: isDark ? "rgba(255,255,255,0.05)" : "#fff",
            height: 40,
            width: 40,
            color: "text.secondary",
            "&:hover": {
              bgcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)",
              color: "text.primary",
            },
          }}
        >
          <Download size={18} />
        </IconButton>
      )}


      {/* --- Popovers --- */}

      {/* Date Popover */}
      <Popover
        open={Boolean(dateAnchor)}
        anchorEl={dateAnchor}
        onClose={handleDateClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: 1,
            borderRadius: 2,
            overflow: "hidden",
            maxWidth: "fit-content",
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.6)"
              : "rgba(255, 255, 255, 0.8)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <Box
          sx={{ display: "flex", flexDirection: { xs: "column", sm: "row" } }}
        >
          {/* Presets - hidden in compare mode */}
          {!compareMode && (
            <List
              sx={{
                minWidth: 140,
                bgcolor: "transparent",
                borderRight: "1px solid",
                borderColor: isDark
                  ? "rgba(255, 255, 255, 0.1)"
                  : "rgba(0,0,0,0.1)",
                py: 0,
              }}
            >
              {DATE_PRESETS.map((p) => (
                <ListItemButton
                  key={p.label}
                  onClick={() => handlePresetSelect(p)}
                  dense
                  sx={{
                    "&:hover": {
                      bgcolor: isDark
                        ? "rgba(255,255,255,0.05)"
                        : "rgba(0,0,0,0.05)",
                    },
                  }}
                >
                  <ListItemText
                    primary={p.label}
                    primaryTypographyProps={{ variant: "body2" }}
                  />
                </ListItemButton>
              ))}
            </List>
          )}
          {/* Calendar */}
          <Box
            sx={{
              p: 2,
              maxWidth: 350,
              "& .Polaris-DatePicker": { background: "transparent !important" },
              "& .Polaris-DatePicker__Month": {
                background: "transparent !important",
              },
              "& .Polaris-DatePicker__Title": {
                color: isDark ? "#fff" : "inherit",
              },
              "& .Polaris-DatePicker__Day": {
                color: isDark ? "#ddd" : "inherit",
                "&:hover": { bgcolor: isDark ? "rgba(255,255,255,0.1)" : "" },
              },
              "& .Polaris-DatePicker__Day--today": {
                color: isDark ? "#fff" : "inherit",
                fontWeight: "bold",
              },
              "& .Polaris-DatePicker__Day--selected": {
                bgcolor: "primary.main",
                color: "#fff",
              },
              "& .Polaris-DatePicker__Day--inRange": {
                bgcolor: isDark
                  ? "rgba(91, 163, 224, 0.3)"
                  : "rgba(11, 107, 203, 0.1)",
              },
            }}
          >
            <DatePicker
              month={month}
              year={year}
              onChange={handleCalendarChange}
              onMonthChange={(m, y) => {
                setMonth(m);
                setYear(y);
              }}
              selected={
                start && end
                  ? { start: start.toDate(), end: end.toDate() }
                  : undefined
              }
              disableDatesAfter={dayjs().endOf("day").toDate()}
              allowRange
            />
          </Box>
        </Box>
      </Popover>

      {/* Compare Toggle Popover */}
      <Popover
        open={Boolean(compareToggleAnchor)}
        anchorEl={compareToggleAnchor}
        onClose={() => setCompareToggleAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: 0.5,
            borderRadius: 2,
            minWidth: 160,
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.8)"
              : "rgba(255, 255, 255, 0.9)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <List dense sx={{ py: 0.5 }}>
          <ListItemButton
            selected={!compareMode}
            onClick={() => handleCompareModeToggle(false)}
            sx={{
              "&:hover": {
                bgcolor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
              },
            }}
          >
            <ListItemText
              primary="No comparison"
              primaryTypographyProps={{
                variant: "body2",
                fontWeight: !compareMode ? 600 : 400,
              }}
            />
          </ListItemButton>
          <ListItemButton
            selected={compareMode}
            onClick={() => handleCompareModeToggle(true)}
            sx={{
              "&:hover": {
                bgcolor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.05)",
              },
            }}
          >
            <ListItemText
              primary="Compare"
              primaryTypographyProps={{
                variant: "body2",
                fontWeight: compareMode ? 600 : 400,
              }}
            />
          </ListItemButton>
        </List>
      </Popover>

      {/* Compare Date Popover ("To" calendar - no presets) */}
      <Popover
        open={Boolean(compDateAnchor)}
        anchorEl={compDateAnchor}
        onClose={handleCompDateClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: 1,
            borderRadius: 2,
            overflow: "hidden",
            maxWidth: "fit-content",
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.6)"
              : "rgba(255, 255, 255, 0.8)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <Box
          sx={{
            p: 2,
            maxWidth: 350,
            "& .Polaris-DatePicker": { background: "transparent !important" },
            "& .Polaris-DatePicker__Month": {
              background: "transparent !important",
            },
            "& .Polaris-DatePicker__Title": {
              color: isDark ? "#fff" : "inherit",
            },
            "& .Polaris-DatePicker__Day": {
              color: isDark ? "#ddd" : "inherit",
              "&:hover": { bgcolor: isDark ? "rgba(255,255,255,0.1)" : "" },
            },
            "& .Polaris-DatePicker__Day--today": {
              color: isDark ? "#fff" : "inherit",
              fontWeight: "bold",
            },
            "& .Polaris-DatePicker__Day--selected": {
              bgcolor: "primary.main",
              color: "#fff",
            },
            "& .Polaris-DatePicker__Day--inRange": {
              bgcolor: isDark
                ? "rgba(91, 163, 224, 0.3)"
                : "rgba(11, 107, 203, 0.1)",
            },
          }}
        >
          <DatePicker
            month={compMonth}
            year={compYear}
            onChange={handleCompCalendarChange}
            onMonthChange={(m, y) => {
              setCompMonth(m);
              setCompYear(y);
            }}
            selected={
              compStart && compEnd
                ? { start: compStart.toDate(), end: compEnd.toDate() }
                : undefined
            }
            disableDatesAfter={dayjs().endOf("day").toDate()}
            allowRange
          />
        </Box>
      </Popover>

      {/* Brand Popover */}
      <Popover
        open={Boolean(brandAnchor)}
        anchorEl={brandAnchor}
        onClose={handleBrandClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: { mt: 1, borderRadius: 2, minWidth: 200, maxHeight: 300 },
        }}
      >
        <List dense>
          {brands.map((b) => (
            <ListItemButton
              key={b.key}
              selected={(brandKey || "").toUpperCase() === b.key}
              onClick={() => handleBrandSelect(b.key)}
            >
              <ListItemText primary={b.key} />
            </ListItemButton>
          ))}
        </List>
      </Popover>

      {/* Filter Popover */}
      <Popover
        open={Boolean(filterAnchor)}
        anchorEl={filterAnchor}
        onClose={handleFilterClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        PaperProps={{
          sx: {
            mt: 0.5,
            borderRadius: 3,
            width: 400,
            height: 380,
            overflow: "auto",
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.7)"
              : "rgba(255, 255, 255, 0.85)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <Box
          sx={{
            p: 2,
            pb: 1,
            borderBottom: "1px solid",
            borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)",
          }}
        >
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 500,
              fontSize: "0.75rem",
              color: "text.primary",
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            Filter Dashboard
          </Typography>
        </Box>

        <Box sx={{ p: 0.5 }}>
          {/* CHANNEL Section */}
          {allowedFilters.salesChannel && (
            <Tooltip title={salesChannelDisabled ? disabledChannelTooltip : ""}>
              <span>
            <Accordion
              disabled={salesChannelDisabled}
              expanded={expandedAccordion === "channel"}
              onChange={handleAccordionChange("channel")}
              disableGutters
              elevation={0}
              sx={{
                bgcolor: "transparent",
                "&:before": { display: "none" },
                "&.Mui-disabled": { bgcolor: "transparent" },
                borderBottom:
                  expandedAccordion === "channel" ? "1px solid" : "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.05)",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                sx={{
                  px: 2,
                  minHeight: 44,
                  "& .MuiAccordionSummary-content": { my: 1 },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Typography
                  sx={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Channel
                </Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  px: 0,
                  pb: 1,
                  pt: 0,
                  ...(salesChannelDisabled
                    ? { pointerEvents: "none", opacity: 0.5 }
                    : {}),
                }}
              >
                <List dense sx={{ py: 0 }}>
                  {(utmOptions?.sales_channel || []).map((channel) => {
                    const selectedChannels = Array.isArray(salesChannel)
                      ? salesChannel
                      : salesChannel
                        ? [salesChannel]
                        : [];
                    const isSelected = selectedChannels.includes(channel);
                    return (
                      <ListItemButton
                        key={channel}
                        dense
                        onClick={() => {
                          const newChannels = isSelected
                            ? selectedChannels.filter((c) => c !== channel)
                            : [...selectedChannels, channel];
                          onSalesChannelChange(newChannels);
                        }}
                        sx={{
                          px: 2,
                          py: 0.5,
                          "&:hover": {
                            bgcolor: isDark
                              ? "rgba(255,255,255,0.05)"
                              : "rgba(0,0,0,0.03)",
                          },
                        }}
                      >
                        <Checkbox
                          edge="start"
                          checked={isSelected}
                          tabIndex={-1}
                          disableRipple
                          size="small"
                          sx={{ py: 0 }}
                        />
                        <ListItemText
                          primary={channel}
                          primaryTypographyProps={{
                            fontSize: "0.85rem",
                            fontWeight: isSelected ? 600 : 400,
                          }}
                        />
                      </ListItemButton>
                    );
                  })}
                  {(!utmOptions?.sales_channel ||
                    utmOptions.sales_channel.length === 0) && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        No channels found
                      </Typography>
                    </Box>
                  )}
                </List>
              </AccordionDetails>
            </Accordion>
              </span>
            </Tooltip>
          )}

          {/* DEVICE TYPE Section */}
          {allowedFilters.deviceType && (
            <Tooltip title={deviceTypeDisabled ? disabledDeviceTypeTooltip : ""}>
              <span>
            <Accordion
              disabled={deviceTypeDisabled}
              expanded={expandedAccordion === "deviceType"}
              onChange={handleAccordionChange("deviceType")}
              disableGutters
              elevation={0}
              sx={{
                bgcolor: "transparent",
                "&:before": { display: "none" },
                "&.Mui-disabled": { bgcolor: "transparent" },
                borderBottom:
                  expandedAccordion === "deviceType" ? "1px solid" : "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.05)",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                sx={{
                  px: 2,
                  minHeight: 44,
                  "& .MuiAccordionSummary-content": { my: 1 },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Typography
                  sx={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Device Type
                </Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  px: 0,
                  pb: 1,
                  pt: 0,
                  ...(deviceTypeDisabled
                    ? { pointerEvents: "none", opacity: 0.5 }
                    : {}),
                }}
              >
                <List dense sx={{ py: 0 }}>
                  {["Desktop", "Mobile", "Others"].map((type) => {
                    const selectedTypes = Array.isArray(deviceType)
                      ? deviceType
                      : [];
                    const isSelected = selectedTypes.includes(type);
                    return (
                      <ListItemButton
                        key={type}
                        dense
                        onClick={() => {
                          const newTypes = isSelected
                            ? selectedTypes.filter((t) => t !== type)
                            : [...selectedTypes, type];
                          onDeviceTypeChange(newTypes);
                        }}
                        sx={{
                          px: 2,
                          py: 0.5,
                          "&:hover": {
                            bgcolor: isDark
                              ? "rgba(255,255,255,0.05)"
                              : "rgba(0,0,0,0.03)",
                          },
                        }}
                      >
                        <Checkbox
                          edge="start"
                          checked={isSelected}
                          tabIndex={-1}
                          disableRipple
                          size="small"
                          sx={{ py: 0 }}
                        />
                        <ListItemText
                          primary={type}
                          primaryTypographyProps={{
                            fontSize: "0.85rem",
                            fontWeight: isSelected ? 600 : 400,
                          }}
                        />
                      </ListItemButton>
                    );
                  })}
                </List>
              </AccordionDetails>
            </Accordion>
              </span>
            </Tooltip>
          )}

          {allowedFilters.city && (
            <Tooltip title={cityDisabled ? disabledCityTooltip : ""}>
              <span>
            <Accordion
              disabled={cityDisabled}
              expanded={expandedAccordion === "city"}
              onChange={handleAccordionChange("city")}
              disableGutters
              elevation={0}
              sx={{
                bgcolor: "transparent",
                "&:before": { display: "none" },
                "&.Mui-disabled": { bgcolor: "transparent" },
                borderBottom:
                  expandedAccordion === "city" ? "1px solid" : "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.05)",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                sx={{
                  px: 2,
                  minHeight: 44,
                  "& .MuiAccordionSummary-content": { my: 1 },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Typography
                  sx={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  City
                </Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  px: 0,
                  pb: 1,
                  pt: 0,
                  ...(cityDisabled
                    ? { pointerEvents: "none", opacity: 0.5 }
                    : {}),
                }}
              >
                <List dense sx={{ py: 0, maxHeight: 280, overflowY: "auto" }}>
                  {(utmOptions?.city || []).map((cityOption) => {
                    const selectedCities = Array.isArray(city) ? city : [];
                    const isSelected = selectedCities.includes(cityOption);
                    return (
                      <ListItemButton
                        key={cityOption}
                        dense
                        onClick={() => {
                          const nextCities = isSelected
                            ? selectedCities.filter((value) => value !== cityOption)
                            : [...selectedCities, cityOption];
                          onCityChange?.(nextCities);
                        }}
                        sx={{
                          px: 2,
                          py: 0.5,
                          "&:hover": {
                            bgcolor: isDark
                              ? "rgba(255,255,255,0.05)"
                              : "rgba(0,0,0,0.03)",
                          },
                        }}
                      >
                        <Checkbox
                          edge="start"
                          checked={isSelected}
                          tabIndex={-1}
                          disableRipple
                          size="small"
                          sx={{ py: 0 }}
                        />
                        <ListItemText
                          primary={cityOption}
                          primaryTypographyProps={{
                            fontSize: "0.85rem",
                            fontWeight: isSelected ? 600 : 400,
                          }}
                        />
                      </ListItemButton>
                    );
                  })}
                  {(!utmOptions?.city || utmOptions.city.length === 0) && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        No cities found
                      </Typography>
                    </Box>
                  )}
                </List>
              </AccordionDetails>
            </Accordion>
              </span>
            </Tooltip>
          )}

          {/* DISCOUNT CODE Section */}
          {allowedFilters.discount && (
            <Tooltip title={discountDisabled ? disabledDiscountTooltip : ""}>
              <span>
            <Accordion
              disabled={discountDisabled}
              expanded={expandedAccordion === "discount"}
              onChange={handleAccordionChange("discount")}
              disableGutters
              elevation={0}
              sx={{
                bgcolor: "transparent",
                "&:before": { display: "none" },
                "&.Mui-disabled": { bgcolor: "transparent" },
                borderBottom:
                  expandedAccordion === "discount" ? "1px solid" : "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.05)",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                sx={{
                  px: 2,
                  minHeight: 44,
                  "& .MuiAccordionSummary-content": { my: 1 },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Typography
                  sx={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Discount Code
                </Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  px: 0,
                  pb: 0,
                  pt: 0,
                  ...(discountDisabled
                    ? { pointerEvents: "none", opacity: 0.5 }
                    : {}),
                }}
              >
                <Box sx={{ px: 2, pb: 1, pt: 0.5 }}>
                  <TextField
                    size="small"
                    placeholder="Search discounts..."
                    fullWidth
                    value={discountSearch}
                    onChange={(e) => setDiscountSearch(e.target.value)}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <Search size={14} />
                        </InputAdornment>
                      ),
                      endAdornment: discountSearch && (
                        <InputAdornment position="end">
                          <IconButton
                            size="small"
                            onClick={() => setDiscountSearch("")}
                          >
                            <X size={14} />
                          </IconButton>
                        </InputAdornment>
                      ),
                      sx: { fontSize: "0.8rem", borderRadius: "8px" },
                    }}
                  />
                </Box>
                <List
                  dense
                  sx={{
                    maxHeight: 220,
                    overflowY: "auto",
                    py: 0,
                    borderTop: "1px solid",
                    borderColor: isDark
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.05)",
                  }}
                >
                  {hasDiscountValue && (
                    <>
                      <ListItemButton
                        dense
                        onClick={() => onDiscountCodesChange?.([])}
                        sx={{ px: 2, py: 0.5 }}
                      >
                        <ListItemText
                          primary={`Clear ${selectedDiscountCodes.length} selected`}
                          primaryTypographyProps={{
                            fontSize: "0.85rem",
                            color: "error.main",
                            fontWeight: 600,
                          }}
                        />
                      </ListItemButton>
                      <Box sx={{ px: 2, pb: 0.5 }}>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontSize: "0.7rem" }}
                        >
                          {selectedDiscountCodes.length >= MAX_DISCOUNT_CODES
                            ? `Max ${MAX_DISCOUNT_CODES} codes — data is aggregated`
                            : `Select up to ${MAX_DISCOUNT_CODES} codes — data is aggregated`}
                        </Typography>
                      </Box>
                    </>
                  )}
                  {(utmOptions?.discount_codes || [])
                    .filter((code) =>
                      code.toLowerCase().includes(discountSearch.toLowerCase()),
                    )
                    .map((code) => {
                      const isSelected = selectedDiscountCodes.includes(code);
                      const atLimit =
                        !isSelected &&
                        selectedDiscountCodes.length >= MAX_DISCOUNT_CODES;
                      return (
                        <ListItemButton
                          key={code}
                          dense
                          disabled={atLimit}
                          onClick={() => {
                            const next = isSelected
                              ? selectedDiscountCodes.filter((c) => c !== code)
                              : [...selectedDiscountCodes, code];
                            onDiscountCodesChange?.(next);
                          }}
                          sx={{
                            px: 2,
                            py: 0.5,
                            "&:hover": {
                              bgcolor: isDark
                                ? "rgba(255,255,255,0.05)"
                                : "rgba(0,0,0,0.03)",
                            },
                          }}
                        >
                          <Checkbox
                            edge="start"
                            checked={isSelected}
                            tabIndex={-1}
                            disableRipple
                            size="small"
                            sx={{ py: 0 }}
                          />
                          <ListItemText
                            primary={code}
                            primaryTypographyProps={{
                              fontSize: "0.85rem",
                              fontWeight: isSelected ? 600 : 400,
                              noWrap: true,
                            }}
                          />
                        </ListItemButton>
                      );
                    })}
                  {(!utmOptions?.discount_codes ||
                    utmOptions.discount_codes.length === 0) && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        No discounts found
                      </Typography>
                    </Box>
                  )}
                </List>
              </AccordionDetails>
            </Accordion>
              </span>
            </Tooltip>
          )}

          {/* PRODUCT TYPE Section */}
          {allowedFilters.productType && (
            <Tooltip title={productTypeDisabled ? disabledProductTypeTooltip : ""}>
              <span>
            <Accordion
              disabled={productTypeDisabled}
              expanded={expandedAccordion === "productType"}
              onChange={handleAccordionChange("productType")}
              disableGutters
              elevation={0}
              sx={{
                bgcolor: "transparent",
                "&:before": { display: "none" },
                "&.Mui-disabled": { bgcolor: "transparent" },
                borderBottom:
                  expandedAccordion === "productType" ? "1px solid" : "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.05)",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                sx={{
                  px: 2,
                  minHeight: 44,
                  "& .MuiAccordionSummary-content": { my: 1 },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Typography
                  sx={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Product Type
                </Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  px: 0,
                  pb: 1,
                  pt: 0,
                  ...(productTypeDisabled
                    ? { pointerEvents: "none", opacity: 0.5 }
                    : {}),
                }}
              >
                <List dense sx={{ py: 0 }}>
                  {(utmOptions?.product_types || []).map((type) => {
                    const selectedTypes = Array.isArray(productType)
                      ? productType
                      : productType
                        ? [productType]
                        : [];
                    const isSelected = selectedTypes.includes(type);
                    return (
                      <ListItemButton
                        key={type}
                        dense
                        onClick={() => {
                          const newTypes = isSelected
                            ? selectedTypes.filter((t) => t !== type)
                            : [...selectedTypes, type];
                          onProductTypeChange(newTypes);
                        }}
                        sx={{
                          px: 2,
                          py: 0.5,
                          "&:hover": {
                            bgcolor: isDark
                              ? "rgba(255,255,255,0.05)"
                              : "rgba(0,0,0,0.03)",
                          },
                        }}
                      >
                        <Checkbox
                          edge="start"
                          checked={isSelected}
                          tabIndex={-1}
                          disableRipple
                          size="small"
                          sx={{ py: 0 }}
                        />
                        <ListItemText
                          primary={type}
                          primaryTypographyProps={{
                            fontSize: "0.85rem",
                            fontWeight: isSelected ? 600 : 400,
                          }}
                        />
                      </ListItemButton>
                    );
                  })}
                  {(!utmOptions?.product_types ||
                    utmOptions.product_types.length === 0) && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        No product types found
                      </Typography>
                    </Box>
                  )}
                </List>
              </AccordionDetails>
            </Accordion>
              </span>
            </Tooltip>
          )}

          {/* PRODUCT Section */}
          {allowedFilters.product && (
            <Tooltip title={productDisabled ? disabledProductTooltip : ""}>
              <span>
                <Accordion
                  disabled={productDisabled}
              expanded={expandedAccordion === "product"}
              onChange={handleAccordionChange("product")}
              disableGutters
              elevation={0}
              sx={{
                bgcolor: "transparent",
                "&:before": { display: "none" },
                "&.Mui-disabled": { bgcolor: "transparent" },
                borderBottom:
                  expandedAccordion === "product" ? "1px solid" : "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.1)"
                  : "rgba(0,0,0,0.05)",
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
                sx={{
                  px: 2,
                  minHeight: 44,
                  "& .MuiAccordionSummary-content": { my: 1 },
                  "&.Mui-disabled": { opacity: 0.5 },
                }}
              >
                <Typography
                  sx={{
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "text.secondary",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Product
                </Typography>
              </AccordionSummary>
              <AccordionDetails
                sx={{
                  px: 0,
                  pb: 0,
                  pt: 0,
                  ...(productDisabled
                    ? { pointerEvents: "none", opacity: 0.5 }
                    : {}),
                }}
              >
                <Box sx={{ px: 2, pb: 1, pt: 0.5 }}>
                  <TextField
                    size="small"
                    placeholder="Search products..."
                    fullWidth
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <Search size={14} />
                        </InputAdornment>
                      ),
                      endAdornment: productSearch && (
                        <InputAdornment position="end">
                          <IconButton
                            size="small"
                            onClick={() => setProductSearch("")}
                          >
                            <X size={14} />
                          </IconButton>
                        </InputAdornment>
                      ),
                      sx: { fontSize: "0.8rem", borderRadius: "8px" },
                    }}
                  />
                </Box>
                <List
                  dense
                  sx={{
                    maxHeight: 250,
                    overflowY: "auto",
                    py: 0,
                    borderTop: "1px solid",
                    borderColor: isDark
                      ? "rgba(255,255,255,0.05)"
                      : "rgba(0,0,0,0.05)",
                  }}
                >
                  {productOptions
                    .filter((p) =>
                      p.label
                        .toLowerCase()
                        .includes(productSearch.toLowerCase()),
                    )
                    .map((p) => {
                      const selectedProducts = Array.isArray(productValue)
                        ? productValue
                        : productValue?.id
                          ? [productValue]
                          : [];
                      const isSelected = selectedProducts.some(
                        (sp) => sp.id === p.id,
                      );
                      return (
                        <ListItemButton
                          key={p.id}
                          dense
                          onClick={() => {
                            const newProducts = isSelected
                              ? selectedProducts.filter((sp) => sp.id !== p.id)
                              : [...selectedProducts, p];
                            onProductChange(newProducts);
                          }}
                          sx={{
                            px: 2,
                            py: 0.5,
                            "&:hover": {
                              bgcolor: isDark
                                ? "rgba(255,255,255,0.05)"
                                : "rgba(0,0,0,0.03)",
                            },
                          }}
                        >
                          <Checkbox
                            edge="start"
                            checked={isSelected}
                            tabIndex={-1}
                            disableRipple
                            size="small"
                            sx={{ py: 0 }}
                          />
                          <ListItemText
                            primary={p.label}
                            secondary={p.detail}
                            primaryTypographyProps={{
                              fontSize: "0.85rem",
                              fontWeight: isSelected ? 600 : 400,
                              noWrap: true,
                            }}
                            secondaryTypographyProps={{
                              fontSize: "0.75rem",
                              noWrap: true,
                            }}
                          />
                        </ListItemButton>
                      );
                    })}
                  {productOptions.length === 0 && !productLoading && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        No products found
                      </Typography>
                    </Box>
                  )}
                  {productLoading && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="caption" color="text.secondary">
                        Loading products...
                      </Typography>
                    </Box>
                  )}
                </List>
              </AccordionDetails>
                </Accordion>
              </span>
            </Tooltip>
          )}

          {/* UTM PARAMETERS Link (Moved to ball button) */}
        </Box>

        <Box
          sx={{
            p: 2,
            pt: 1,
            borderTop: "1px solid",
            borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)",
          }}
        >
          <Button
            fullWidth
            variant="outlined"
            size="small"
            onClick={() => {
              onSalesChannelChange([]);
              onDeviceTypeChange([]);
              onCityChange?.([]);
              onProductChange(null);
              onDiscountCodesChange?.([]);
              onProductTypeChange?.([]);
              handleFilterClose();
            }}
            sx={{
              textTransform: "none",
              borderRadius: "8px",
              fontWeight: 600,
              borderColor: isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.1)",
              color: "text.primary",
              "&:hover": {
                bgcolor: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)",
                borderColor: isDark
                  ? "rgba(255,255,255,0.3)"
                  : "rgba(0,0,0,0.2)",
              },
            }}
          >
            CLEAR DIVISION FILTERS
          </Button>
        </Box>
      </Popover>

      {/* UTM Source Popover */}
      <Popover
        open={Boolean(utmSourceAnchor)}
        anchorEl={utmSourceAnchor}
        onClose={handleUtmSourceClose}
        TransitionComponent={Fade}
        transitionDuration={300}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: 1,
            borderRadius: 3,
            width: 200,
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.7)"
              : "rgba(255, 255, 255, 0.85)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <StaticSearchableList
          label="UTM Source"
          options={utmSourceOptions}
          value={utm?.source || []}
          onChange={(val) => onUtmChange({ ...utm, source: val })}
          isDark={isDark}
        />
      </Popover>

      {/* UTM Medium Popover */}
      <Popover
        open={Boolean(utmMediumAnchor)}
        anchorEl={utmMediumAnchor}
        onClose={handleUtmMediumClose}
        TransitionComponent={Fade}
        transitionDuration={300}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: 1,
            borderRadius: 3,
            width: 200,
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.7)"
              : "rgba(255, 255, 255, 0.85)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <StaticSearchableList
          label="UTM Medium"
          options={utmMediumOptions}
          value={utm?.medium || []}
          onChange={(val) => onUtmChange({ ...utm, medium: val })}
          isDark={isDark}
        />
      </Popover>

      {/* UTM Campaign Popover */}
      <Popover
        open={Boolean(utmCampaignAnchor)}
        anchorEl={utmCampaignAnchor}
        onClose={handleUtmCampaignClose}
        TransitionComponent={Fade}
        transitionDuration={300}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        PaperProps={{
          sx: {
            mt: 1,
            borderRadius: 3,
            width: 200,
            backdropFilter: "blur(12px)",
            backgroundColor: isDark
              ? "rgba(30, 30, 30, 0.7)"
              : "rgba(255, 255, 255, 0.85)",
            border: "1px solid",
            borderColor: isDark
              ? "rgba(255, 255, 255, 0.1)"
              : "rgba(0, 0, 0, 0.05)",
            boxShadow: isDark
              ? "0 8px 32px rgba(0, 0, 0, 0.5)"
              : "0 8px 32px rgba(0, 0, 0, 0.1)",
          },
        }}
      >
        <StaticSearchableList
          label="UTM Campaign"
          options={utmCampaignOptions}
          value={utm?.campaign || []}
          onChange={(val) => onUtmChange({ ...utm, campaign: val })}
          isDark={isDark}
        />
      </Popover>
    </Box>
  );
}
