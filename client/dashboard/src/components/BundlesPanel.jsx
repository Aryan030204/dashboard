import { useCallback, useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Alert,
  Box,
  Button,
  Card,
  Checkbox,
  CircularProgress,
  Divider,
  Grow,
  List,
  ListItemButton,
  ListItemText,
  Popover as MuiPopover,
  Stack,
  TablePagination,
  TextField,
  Typography,
} from "@mui/material";
import CheckIcon from "@mui/icons-material/Check";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import InputAdornment from "@mui/material/InputAdornment";
import { useTheme } from "@mui/material/styles";
import { AppProvider } from "@shopify/polaris";
import { DatePicker } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import SearchIcon from "@mui/icons-material/Search";
import CloseIcon from "@mui/icons-material/Close";
import { getBundleOptions, getBundleProducts, getBundleSummary, exportBundleSummaryCsv, exportBundleProductsCsv } from "../lib/api.js";
import { PageHeader, Panel, FilterBar, DataTable as DzDataTable } from "./datum/index.js";
import { formatInrAmount, useInrCurrency } from "../lib/currency.js";

const DATE_PRESETS = [
  {
    label: "Today",
    getValue: () => [dayjs().startOf("day"), dayjs().startOf("day")],
  },
  {
    label: "Yesterday",
    getValue: () => [
      dayjs().subtract(1, "day").startOf("day"),
      dayjs().subtract(1, "day").startOf("day"),
    ],
  },
  {
    label: "Last 7 days",
    getValue: () => [
      dayjs().subtract(6, "day").startOf("day"),
      dayjs().startOf("day"),
    ],
  },
  {
    label: "Last 30 days",
    getValue: () => [
      dayjs().subtract(29, "day").startOf("day"),
      dayjs().startOf("day"),
    ],
  },
];
const ALL_BUNDLES_VALUE = "__all__";

function formatDate(value) {
  return dayjs(value).format("YYYY-MM-DD");
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString();
}

function formatCurrency(value, convertAmount) {
  return formatInrAmount(convertAmount(value || 0), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function PaginationActions({ count, page, rowsPerPage, onPageChange, disabled }) {
  const lastPage = Math.max(0, Math.ceil(count / rowsPerPage) - 1);
  return (
    <Box sx={{ flexShrink: 0, ml: 2.5, display: "flex", alignItems: "center" }}>
      <Button
        onClick={(event) => onPageChange(event, page - 1)}
        disabled={disabled || page <= 0}
        sx={{ minWidth: 0, px: 1 }}
      >
        <KeyboardArrowLeft />
      </Button>
      <Button
        onClick={(event) => onPageChange(event, page + 1)}
        disabled={disabled || page >= lastPage}
        sx={{ minWidth: 0, px: 1 }}
      >
        <KeyboardArrowRight />
      </Button>
    </Box>
  );
}

function DateRangePicker({ startDate, endDate, onApply }) {
  const [anchorEl, setAnchorEl] = useState(null);
  const active = Boolean(anchorEl);
  const [month, setMonth] = useState(dayjs().month());
  const [year, setYear] = useState(dayjs().year());
  const [internalStart, setInternalStart] = useState(null);
  const [internalEnd, setInternalEnd] = useState(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";

  useEffect(() => {
    const focus = endDate || startDate || dayjs();
    setMonth(dayjs(focus).month());
    setYear(dayjs(focus).year());
  }, [startDate, endDate, anchorEl]);

  const toggle = useCallback(
    (event) => {
      if (anchorEl) {
        setAnchorEl(null);
        return;
      }
      const nextStart = dayjs(startDate || dayjs()).startOf("day");
      const nextEnd = dayjs(endDate || startDate || dayjs()).startOf("day");
      setInternalStart(nextStart);
      setInternalEnd(nextEnd);
      setMonth(nextEnd.month());
      setYear(nextEnd.year());
      setAnchorEl(event.currentTarget);
    },
    [anchorEl, startDate, endDate],
  );

  const handleRangeChange = useCallback(
    ({ start: nextStartRaw, end: nextEndRaw }) => {
      const nextStart = nextStartRaw ? dayjs(nextStartRaw).startOf("day") : null;
      const nextEnd = nextEndRaw ? dayjs(nextEndRaw).startOf("day") : null;
      const focus = nextEnd || nextStart;
      if (focus) {
        setMonth(focus.month());
        setYear(focus.year());
      }
      setInternalStart(nextStart);
      setInternalEnd(nextEnd);
      if (nextStart && nextEnd && nextStart.isAfter(nextEnd)) {
        onApply(nextEnd, nextStart);
        setInternalStart(nextEnd);
        setInternalEnd(nextStart);
        return;
      }
      if (nextStart && !nextEnd) {
        onApply(nextStart, nextStart);
        return;
      }
      onApply(nextStart, nextEnd);
    },
    [onApply],
  );

  const handlePreset = useCallback(
    (preset) => {
      const [nextStart, nextEnd] = preset.getValue();
      setMonth(nextEnd.month());
      setYear(nextEnd.year());
      setInternalStart(nextStart);
      setInternalEnd(nextEnd);
      onApply(nextStart, nextEnd);
      setAnchorEl(null);
    },
    [onApply],
  );

  const selectedRange = useMemo(() => {
    const nextStart = internalStart || dayjs(startDate || dayjs()).startOf("day");
    const nextEnd = internalEnd || dayjs(endDate || startDate || dayjs()).startOf("day");
    return {
      start: nextStart.toDate(),
      end: nextEnd.toDate(),
    };
  }, [internalStart, internalEnd, startDate, endDate]);

  const label = useMemo(() => {
    const nextStart = startDate ? dayjs(startDate) : null;
    const nextEnd = endDate ? dayjs(endDate) : null;
    if (nextStart && nextEnd) {
      return nextStart.isSame(nextEnd, "day")
        ? nextStart.format("DD MMM YYYY")
        : `${nextStart.format("DD MMM YYYY")} - ${nextEnd.format("DD MMM YYYY")}`;
    }
    return "Select dates";
  }, [startDate, endDate]);

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
          height: 32,
          minWidth: { xs: "100%", sm: "fit-content" },
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          borderRadius: "8px",
          userSelect: "none",
          textAlign: "center",
          border: "1px solid",
          borderColor: "divider",
          boxShadow: "none",
          bgcolor: "background.paper",
          color: "text.primary",
          "&:hover": { filter: "brightness(0.97)" },
        }}
      >
        <Typography variant="body2" noWrap sx={{ color: "inherit", fontWeight: 500, px: 0.5 }}>
          <Box component="span" sx={{ color: "text.secondary", fontWeight: 450, mr: 0.75 }}>Date</Box>
          {label}
        </Typography>
      </Card>

      <MuiPopover
        open={active}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
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
              {DATE_PRESETS.map((preset, idx) => (
                <Box key={preset.label}>
                  <ListItemButton
                    onClick={() => handlePreset(preset)}
                    sx={{ py: 1, px: 1.5 }}
                  >
                    <ListItemText
                      primary={preset.label}
                      primaryTypographyProps={{
                        variant: "body2",
                        color: "text.primary",
                      }}
                    />
                    {label === (() => {
                      const [s, e] = preset.getValue();
                      return s.isSame(e, "day")
                        ? s.format("DD MMM YYYY")
                        : `${s.format("DD MMM YYYY")} - ${e.format("DD MMM YYYY")}`;
                    })() && (
                      <CheckIcon sx={{ fontSize: 16, ml: 0.5, color: "text.primary" }} />
                    )}
                  </ListItemButton>
                  {idx < DATE_PRESETS.length - 1 && <Divider />}
                </Box>
              ))}
            </List>
          </Box>

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
              onMonthChange={(nextMonth, nextYear) => {
                setMonth(nextMonth);
                setYear(nextYear);
              }}
              selected={selectedRange}
              allowRange
              disableDatesBefore={dayjs().subtract(30, 'day').toDate()}
              disableDatesAfter={dayjs().endOf('day').toDate()}
            />
          </Box>
        </Box>
      </MuiPopover>
    </AppProvider>
  );
}

function DataTable({
  title,
  action,
  columns,
  rows,
  status,
  error,
  emptyMessage,
  sortBy,
  sortDir,
  onSort,
  page,
  rowsPerPage,
  onPageChange,
  onRowsPerPageChange,
  renderCell,
}) {
  const pagedRows = useMemo(() => {
    const startIdx = page * rowsPerPage;
    return rows.slice(startIdx, startIdx + rowsPerPage);
  }, [page, rows, rowsPerPage]);

  const tableColumns = columns.map((column) => ({
    key: column.id,
    header: column.label,
    align: column.align === "right" ? "right" : "left",
    sortable: Boolean(column.sortable),
    render: (row) => renderCell(row, column),
  }));

  return (
    <Panel title={title} actions={action} flush>
      <div style={{ position: "relative" }}>
        <DzDataTable
          ariaLabel={typeof title === "string" ? title : undefined}
          columns={tableColumns}
          rows={pagedRows}
          getRowKey={(row, index) => `${row.id || row.bundle_product_id || row.child_product_sku || index}`}
          sort={{ key: sortBy, direction: sortDir }}
          onSort={onSort}
          emptyLabel={emptyMessage}
        />

        {status === "loading" && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "rgba(0,0,0,0.08)",
            }}
          >
            <CircularProgress size={24} />
          </Box>
        )}

        {error && (
          <Box sx={{ p: 2 }}>
            <Alert severity="error">{error}</Alert>
          </Box>
        )}
      </div>

      <Divider />
      <Box sx={{ display: "flex", justifyContent: "flex-end", px: 1 }}>
        <TablePagination
          component="div"
          count={rows.length}
          page={page}
          onPageChange={onPageChange}
          rowsPerPage={rowsPerPage}
          onRowsPerPageChange={onRowsPerPageChange}
          rowsPerPageOptions={[5, 10, 25]}
          ActionsComponent={(props) => (
            <PaginationActions {...props} disabled={status === "loading"} />
          )}
          SelectProps={{ disabled: status === "loading" }}
        />
      </Box>
    </Panel>
  );
}

function sortRows(rows, sortBy, sortDir) {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const a = left?.[sortBy];
    const b = right?.[sortBy];

    if (typeof a === "number" || typeof b === "number") {
      return ((Number(a) || 0) - (Number(b) || 0)) * direction;
    }

    return String(a || "").localeCompare(String(b || "")) * direction;
  });
}

export default function BundlesPanel({
  brandKey,
  initialStartDate,
  initialEndDate,
}) {
  const today = dayjs().startOf("day");
  const [startDate, setStartDate] = useState(dayjs(initialStartDate || today).startOf("day"));
  const [endDate, setEndDate] = useState(dayjs(initialEndDate || initialStartDate || today).startOf("day"));
  const [bundleOptions, setBundleOptions] = useState([]);
  const [selectedBundleIds, setSelectedBundleIds] = useState([ALL_BUNDLES_VALUE]);
  const [bundleAnchorEl, setBundleAnchorEl] = useState(null);
  const [bundleSearchText, setBundleSearchText] = useState("");
  const [summaryRows, setSummaryRows] = useState([]);
  const [productRows, setProductRows] = useState([]);
  const [optionsStatus, setOptionsStatus] = useState("idle");
  const [summaryStatus, setSummaryStatus] = useState("idle");
  const [productsStatus, setProductsStatus] = useState("idle");
  const [optionsError, setOptionsError] = useState("");
  const [summaryError, setSummaryError] = useState("");
  const [productsError, setProductsError] = useState("");
  const [productSortBy, setProductSortBy] = useState("orders");
  const [productSortDir, setProductSortDir] = useState("desc");
  const [summarySortBy, setSummarySortBy] = useState("sort_order");
  const [summarySortDir, setSummarySortDir] = useState("asc");
  const [productPage, setProductPage] = useState(0);
  const [summaryPage, setSummaryPage] = useState(0);
  const [productRowsPerPage, setProductRowsPerPage] = useState(10);
  const [summaryRowsPerPage, setSummaryRowsPerPage] = useState(10);
  const [exportingSummary, setExportingSummary] = useState(false);
  const [exportingProducts, setExportingProducts] = useState(false);

  useEffect(() => {
    if (!initialStartDate || !initialEndDate) return;
    setStartDate(dayjs(initialStartDate).startOf("day"));
    setEndDate(dayjs(initialEndDate).startOf("day"));
  }, [initialStartDate, initialEndDate]);

  const start = useMemo(() => formatDate(startDate), [startDate]);
  const end = useMemo(() => formatDate(endDate), [endDate]);
  const { convertAmount } = useInrCurrency(brandKey, end);
  const bundleFilterOptions = useMemo(
    () => [
      { bundle_product_id: ALL_BUNDLES_VALUE, bundle_name: "All" },
      ...bundleOptions,
    ],
    [bundleOptions],
  );
  const effectiveBundleIds = useMemo(() => {
    if (selectedBundleIds.includes(ALL_BUNDLES_VALUE)) {
      return bundleOptions.map((bundle) => bundle.bundle_product_id).filter(Boolean);
    }
    return selectedBundleIds.filter(Boolean);
  }, [bundleOptions, selectedBundleIds]);
  const selectedSpecificBundles = useMemo(
    () =>
      bundleOptions.filter((bundle) =>
        selectedBundleIds.includes(bundle.bundle_product_id),
      ),
    [bundleOptions, selectedBundleIds],
  );
  const filteredBundleFilterOptions = useMemo(() => {
    if (!bundleSearchText.trim()) return bundleFilterOptions;
    const lower = bundleSearchText.trim().toLowerCase();
    return bundleFilterOptions.filter((bundle) =>
      String(bundle.bundle_name || "").toLowerCase().includes(lower),
    );
  }, [bundleFilterOptions, bundleSearchText]);

  useEffect(() => {
    if (!brandKey) return;
    const controller = new AbortController();
    let active = true;

    setOptionsStatus("loading");
    setSummaryStatus("loading");
    setOptionsError("");
    setSummaryError("");

    getBundleOptions(
      { brand_key: brandKey, start, end },
      { signal: controller.signal },
    )
      .then((result) => {
        if (!active || controller.signal.aborted) return;
        if (result.error) {
          setBundleOptions([]);
          setSelectedBundleIds([ALL_BUNDLES_VALUE]);
          setOptionsError("Failed to load bundle options.");
          setOptionsStatus("failed");
          return;
        }

        const nextBundles = Array.isArray(result.bundles) ? result.bundles : [];
        setBundleOptions(nextBundles);
        setOptionsError("");
        setOptionsStatus("succeeded");

        setSelectedBundleIds((current) => {
          if (!Array.isArray(current) || current.length === 0) {
            return [ALL_BUNDLES_VALUE];
          }
          if (current.includes(ALL_BUNDLES_VALUE)) {
            return [ALL_BUNDLES_VALUE];
          }
          const validSelections = current.filter((bundleId) =>
            nextBundles.some((bundle) => bundle.bundle_product_id === bundleId),
          );
          return validSelections.length > 0
            ? validSelections
            : [ALL_BUNDLES_VALUE];
        });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setBundleOptions([]);
        setSelectedBundleIds([ALL_BUNDLES_VALUE]);
        setOptionsError("Failed to load bundle options.");
        setOptionsStatus("failed");
      });

    getBundleSummary(
      { brand_key: brandKey, start, end },
      { signal: controller.signal },
    )
      .then((result) => {
        if (!active || controller.signal.aborted) return;
        if (result.error) {
          setSummaryRows([]);
          setSummaryError("Failed to load bundle summary.");
          setSummaryStatus("failed");
          return;
        }

        setSummaryRows(Array.isArray(result.rows) ? result.rows : []);
        setSummaryError("");
        setSummaryStatus("succeeded");
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setSummaryRows([]);
        setSummaryError("Failed to load bundle summary.");
        setSummaryStatus("failed");
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [brandKey, start, end]);

  useEffect(() => {
    if (!brandKey || effectiveBundleIds.length === 0) {
      setProductRows([]);
      setProductsStatus("idle");
      setProductsError("");
      return;
    }

    const controller = new AbortController();
    let active = true;
    setProductsStatus("loading");
    setProductsError("");

    getBundleProducts(
      {
        brand_key: brandKey,
        start,
        end,
        bundle_product_id: effectiveBundleIds,
      },
      { signal: controller.signal },
    )
      .then((result) => {
        if (!active || controller.signal.aborted) return;
        if (result.error) {
          setProductRows([]);
          setProductsError("Failed to load bundle products.");
          setProductsStatus("failed");
          return;
        }

        setProductRows(Array.isArray(result.rows) ? result.rows : []);
        setProductsError("");
        setProductsStatus("succeeded");
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setProductRows([]);
        setProductsError("Failed to load bundle products.");
        setProductsStatus("failed");
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [brandKey, effectiveBundleIds, start, end]);

  const sortedProductRows = useMemo(
    () => sortRows(productRows, productSortBy, productSortDir),
    [productRows, productSortBy, productSortDir],
  );
  const sortedSummaryRows = useMemo(
    () => sortRows(summaryRows, summarySortBy, summarySortDir),
    [summaryRows, summarySortBy, summarySortDir],
  );

  const productColumns = useMemo(
    () => [
      { id: "child_product_sku", label: "SKU", sortable: true },
      { id: "child_product_title", label: "Product Name", sortable: true },
      { id: "orders", label: "Allocated Orders", sortable: true, align: "right" },
      { id: "sales", label: "Sales", sortable: true, align: "right" },
    ],
    [],
  );
  const summaryColumns = useMemo(
    () => [
      { id: "bundle_name", label: "Bundle Name", sortable: true },
      { id: "orders", label: "Orders", sortable: true, align: "right" },
      { id: "sales", label: "Sales", sortable: true, align: "right" },
    ],
    [],
  );

  const handleSort = useCallback((scope, columnId) => {
    if (scope === "products") {
      setProductSortBy((current) => {
        if (current === columnId) {
          setProductSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
          return current;
        }
        setProductSortDir("asc");
        return columnId;
      });
      setProductPage(0);
      return;
    }

    setSummarySortBy((current) => {
      if (current === columnId) {
        setSummarySortDir((dir) => (dir === "asc" ? "desc" : "asc"));
        return current;
      }
      setSummarySortDir("asc");
      return columnId;
    });
    setSummaryPage(0);
  }, []);

  const handleBundleSelectionChange = useCallback((nextSelection) => {
    const values = Array.isArray(nextSelection) ? nextSelection : [];
    if (values.length === 0) {
      setSelectedBundleIds([ALL_BUNDLES_VALUE]);
      setProductPage(0);
      return;
    }

    const hasAll = values.includes(ALL_BUNDLES_VALUE);
    if (hasAll) {
      const previousHadAll = selectedBundleIds.includes(ALL_BUNDLES_VALUE);
      const specificValues = values.filter((value) => value !== ALL_BUNDLES_VALUE);
      setSelectedBundleIds(
        previousHadAll && specificValues.length > 0
          ? specificValues
          : [ALL_BUNDLES_VALUE],
      );
      setProductPage(0);
      return;
    }

    setSelectedBundleIds(values);
    setProductPage(0);
  }, [selectedBundleIds]);

  const bundleRenderValue = useCallback((selected) => {
    const values = Array.isArray(selected) ? selected : [];
    if (values.length === 0 || values.includes(ALL_BUNDLES_VALUE)) {
      return "All";
    }
    const labels = values
      .map((value) =>
        bundleOptions.find((bundle) => bundle.bundle_product_id === value)?.bundle_name || value,
      )
      .filter(Boolean);
    if (labels.length <= 2) {
      return labels.join(", ");
    }
    return `${labels.length} selected`;
  }, [bundleOptions]);
  const bundleFilterLabel = useMemo(
    () => bundleRenderValue(selectedBundleIds),
    [bundleRenderValue, selectedBundleIds],
  );

  const productTableTitle = useMemo(() => {
    if (selectedBundleIds.includes(ALL_BUNDLES_VALUE)) {
      return "All Bundle Products";
    }
    if (selectedSpecificBundles.length === 1) {
      return `${selectedSpecificBundles[0].bundle_name} Products`;
    }
    if (selectedSpecificBundles.length > 1) {
      return "Selected Bundle Products";
    }
    return "Bundle Products";
  }, [selectedBundleIds, selectedSpecificBundles]);

  const productEmptyMessage = effectiveBundleIds.length > 0
    ? "No products found for the selected bundles and date range."
    : "No bundles available for the selected date range.";

  const handleExportSummary = async () => {
    setExportingSummary(true);
    const resp = await exportBundleSummaryCsv({
      brand_key: brandKey,
      start,
      end,
    });
    setExportingSummary(false);
    if (resp.error || !resp.blob) return;
    const url = URL.createObjectURL(resp.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resp.filename || "bundle_summary.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportProducts = async () => {
    setExportingProducts(true);
    const resp = await exportBundleProductsCsv({
      brand_key: brandKey,
      start,
      end,
      bundle_product_id: effectiveBundleIds,
    });
    setExportingProducts(false);
    if (resp.error || !resp.blob) return;
    const url = URL.createObjectURL(resp.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = resp.filename || "bundle_products.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack spacing={2}>
      <PageHeader
        title="Bundles"
        description="Orders and sales allocated to bundle products"
        meta={[bundleFilterLabel]}
      />
      <FilterBar ariaLabel="Bundles filters">
        <Box sx={{ display: "contents" }}>
          <Box sx={{ minWidth: { xs: "100%", sm: 240 } }}>
            <Button
              variant="outlined"
              onClick={(event) => setBundleAnchorEl(event.currentTarget)}
              disabled={optionsStatus === "loading" || bundleOptions.length === 0}
              sx={{
                width: "100%",
                minHeight: 32,
                px: 1.5,
                borderRadius: "8px",
                textTransform: "none",
                justifyContent: "space-between",
                color: "text.primary",
                borderColor: "divider",
                bgcolor: "background.paper",
              }}
            >
              <Typography variant="body2" noWrap sx={{ fontWeight: 600, color: "inherit" }}>
                <Box component="span" sx={{ color: "text.secondary", fontWeight: 450, mr: 0.75 }}>Bundle</Box>
                {bundleFilterLabel}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary", ml: 1 }}>
                {bundleAnchorEl ? "^" : "v"}
              </Typography>
            </Button>
            <MuiPopover
              open={Boolean(bundleAnchorEl)}
              anchorEl={bundleAnchorEl}
              onClose={() => {
                setBundleAnchorEl(null);
                setBundleSearchText("");
              }}
              anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
              transformOrigin={{ vertical: "top", horizontal: "left" }}
              PaperProps={{
                sx: {
                  mt: 1,
                  width: 320,
                  borderRadius: 3,
                  overflow: "hidden",
                  backgroundColor: "background.paper",
                  border: "1px solid",
                  borderColor: "divider",
                  boxShadow: "0 6px 20px rgba(0,0,0,.12)",
                },
              }}
            >
              <Box sx={{ p: 1.25, pb: 1 }}>
                <TextField
                  size="small"
                  fullWidth
                  placeholder="Search"
                  value={bundleSearchText}
                  onChange={(event) => setBundleSearchText(event.target.value)}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon fontSize="small" color="action" />
                      </InputAdornment>
                    ),
                    endAdornment: bundleSearchText ? (
                      <InputAdornment position="end">
                        <CloseIcon
                          fontSize="small"
                          sx={{ cursor: "pointer", fontSize: 16 }}
                          onClick={() => setBundleSearchText("")}
                        />
                      </InputAdornment>
                    ) : null,
                  }}
                />
              </Box>
              <Divider />
              <List
                sx={{
                  py: 0,
                  maxHeight: 360,
                  overflowY: "auto",
                }}
              >
                {filteredBundleFilterOptions.map((bundle) => {
                  const bundleId = bundle.bundle_product_id;
                  const isChecked = selectedBundleIds.includes(bundleId);
                  return (
                    <ListItemButton
                      key={bundleId}
                      onClick={() => {
                        const nextSelection = isChecked
                          ? selectedBundleIds.filter((value) => value !== bundleId)
                          : [...selectedBundleIds, bundleId];
                        handleBundleSelectionChange(nextSelection);
                      }}
                      dense
                      sx={{ py: 0.75 }}
                    >
                      <Checkbox
                        checked={isChecked}
                        size="small"
                        disableRipple
                        sx={{
                          p: 0.5,
                          mr: 1,
                        }}
                      />
                      <ListItemText
                        primary={bundle.bundle_name}
                        primaryTypographyProps={{
                          fontSize: "0.95rem",
                          noWrap: true,
                        }}
                      />
                    </ListItemButton>
                  );
                })}
                {filteredBundleFilterOptions.length === 0 && (
                  <Box sx={{ p: 2, textAlign: "center" }}>
                    <Typography variant="body2" color="text.secondary">
                      No bundles found
                    </Typography>
                  </Box>
                )}
              </List>
            </MuiPopover>
          </Box>

          <Box sx={{ minWidth: { xs: "100%", sm: "auto" } }}>
            <DateRangePicker
              startDate={startDate}
              endDate={endDate}
              onApply={(nextStart, nextEnd) => {
                setStartDate(nextStart);
                setEndDate(nextEnd);
                setSelectedBundleIds([ALL_BUNDLES_VALUE]);
                setProductPage(0);
                setSummaryPage(0);
              }}
            />
          </Box>
        </Box>
      </FilterBar>

      {optionsError && <Alert severity="error">{optionsError}</Alert>}

      <DataTable
        title={productTableTitle}
        action={
          <Button
            size="small"
            variant="outlined"
            onClick={handleExportProducts}
            disabled={productsStatus === "loading" || exportingProducts}
          >
            {exportingProducts ? (
              <CircularProgress size={20} color="inherit" />
            ) : (
              "Export CSV"
            )}
          </Button>
        }
        columns={productColumns}
        rows={sortedProductRows}
        status={productsStatus}
        error={productsError}
        emptyMessage={productEmptyMessage}
        sortBy={productSortBy}
        sortDir={productSortDir}
        onSort={(columnId) => handleSort("products", columnId)}
        page={productPage}
        rowsPerPage={productRowsPerPage}
        onPageChange={(_event, nextPage) => setProductPage(nextPage)}
        onRowsPerPageChange={(event) => {
          setProductRowsPerPage(parseInt(event.target.value, 10));
          setProductPage(0);
        }}
        renderCell={(row, column) => {
          if (column.id === "orders") return formatInteger(row.orders);
          if (column.id === "sales") return formatCurrency(row.sales, convertAmount);
          if (column.id === "child_product_sku") return row.child_product_sku || "-";
          return row.child_product_title || "-";
        }}
      />

      <DataTable
        title="Overall Snapshot"
        action={
          <Button
            size="small"
            variant="outlined"
            onClick={handleExportSummary}
            disabled={summaryStatus === "loading" || exportingSummary}
          >
            {exportingSummary ? (
              <CircularProgress size={20} color="inherit" />
            ) : (
              "Export CSV"
            )}
          </Button>
        }
        columns={summaryColumns}
        rows={sortedSummaryRows}
        status={summaryStatus}
        error={summaryError}
        emptyMessage="No bundle activity found for the selected date range."
        sortBy={summarySortBy}
        sortDir={summarySortDir}
        onSort={(columnId) => handleSort("summary", columnId)}
        page={summaryPage}
        rowsPerPage={summaryRowsPerPage}
        onPageChange={(_event, nextPage) => setSummaryPage(nextPage)}
        onRowsPerPageChange={(event) => {
          setSummaryRowsPerPage(parseInt(event.target.value, 10));
          setSummaryPage(0);
        }}
        renderCell={(row, column) => {
          if (column.id === "orders") return formatInteger(row.orders);
          if (column.id === "sales") return formatCurrency(row.sales, convertAmount);
          return row.bundle_name || "-";
        }}
      />
    </Stack>
  );
}
