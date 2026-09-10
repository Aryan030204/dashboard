import { useState, useEffect, useMemo } from "react";
import CloseIcon from "@mui/icons-material/Close";
import FilterListIcon from "@mui/icons-material/FilterList";
import CheckIcon from "@mui/icons-material/Check";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteIcon from "@mui/icons-material/Delete";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import dayjs from "dayjs";
import {
  Drawer,
  Box,
  Typography,
  Chip,
  Stack,
  IconButton,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Autocomplete,
  TextField,
  Button,
  List,
  ListItemButton,
  ListItemText,
  Fade,
  Grow,
  Slide,
  Checkbox,
  CircularProgress,
} from "@mui/material";
import { TransitionGroup } from "react-transition-group";
import { GlassChip } from "./ui/GlassChip";
import { getSummaryFilterOptions, getTopProducts, getProductTypes } from "../lib/api";
import {
  DEFAULT_DATA_RESTRICTION_CONFIG,
  getDataRestrictionDescription,
  getDataRestrictionWarningText,
  normalizeDataRestrictionConfig,
  isRangeOverDataRestrictionPeriod,
} from "../lib/dateRange.js";
import { MAX_DISCOUNT_CODES } from "../state/slices/filterSlice.js";

export default function MobileFilterDrawer({
  open,
  onClose,
  brands = [],
  brandKey,
  onBrandChange,
  productOptions = [],
  productValue,
  onProductChange,
  productDisabled = false,
  utm = {},
  onUtmChange,
  utmDisabled = false,
  disableUtmMediumCampaign = false,
  allowProductUtmSync = false,
  salesChannel = "",
  onSalesChannelChange,
  salesChannelDisabled = false,
  city = [],
  onCityChange,
  cityDisabled = false,
  utmOptions: propUtmOptions,
  dateRange,
  dataRestrictionConfig = DEFAULT_DATA_RESTRICTION_CONFIG,
  isDark = false,
  showBrandFilter = true,
  showProductFilter = true,
  showUtmFilter = true,
  showSalesChannel = true,
  showCityFilter = true,

  deviceType = [],
  onDeviceTypeChange,
  deviceTypeDisabled = false,
  showDeviceType = true,
  discountCodes = [],
  onDiscountCodesChange,
  discountDisabled = false,
  showDiscountFilter = true,

  showProductTypeFilter = false,
  productTypes = [],
  onProductTypeChange,

  // Division "Product Type" filter (mv_product_type_funnel_daily) — distinct
  // from showProductTypeFilter/productTypes/onProductTypeChange above, which
  // is the unrelated client-side product-table type filter.
  divisionProductType = [],
  onDivisionProductTypeChange,
  divisionProductTypeDisabled = false,
  showDivisionProductType = true,
}) {
  // Local state for deferred application
  const [tempBrand, setTempBrand] = useState(brandKey);
  const [tempProduct, setTempProduct] = useState(productValue);
  const [tempUtm, setTempUtm] = useState(utm);
  const [tempSalesChannel, setTempSalesChannel] = useState(salesChannel);
  const [tempCity, setTempCity] = useState(city);
  const [tempDeviceType, setTempDeviceType] = useState(deviceType);
  const [tempDiscountCodes, setTempDiscountCodes] = useState(
    Array.isArray(discountCodes) ? discountCodes : [],
  );
  const [tempDivisionProductType, setTempDivisionProductType] = useState(divisionProductType);
  const [drawerProductOptions, setDrawerProductOptions] = useState(productOptions);

  // Product Type State
  const [tempProductTypes, setTempProductTypes] = useState(productTypes || []);
  const [availableProductTypes, setAvailableProductTypes] = useState([]);
  const [typesLoading, setTypesLoading] = useState(false);

  const [view, setView] = useState("ROOT"); // ROOT, BRAND, PRODUCT, UTM, UTM_SOURCE, UTM_MEDIUM, UTM_CAMPAIGN, SALES_CHANNEL, CITY
  const [utmOptions, setUtmOptions] = useState(null);
  const [searchText, setSearchText] = useState("");
  const normalizedRestrictionConfig = useMemo(
    () => normalizeDataRestrictionConfig(dataRestrictionConfig),
    [dataRestrictionConfig],
  );
  const dataRestrictionDescription = useMemo(
    () => getDataRestrictionDescription(normalizedRestrictionConfig),
    [normalizedRestrictionConfig],
  );
  const utmRestrictionWarning = useMemo(
    () => getDataRestrictionWarningText(normalizedRestrictionConfig),
    [normalizedRestrictionConfig],
  );

  useEffect(() => {
    setSearchText("");
  }, [view]);

  // Sync local state with props when drawer opens
  // Sync local state with props when drawer opens
  useEffect(() => {
    if (open) {
      setTempBrand(brandKey);
      setTempProduct(productValue);
      setTempUtm(utm);
      setTempSalesChannel(salesChannel);
      setTempCity(city);
      setTempDeviceType(deviceType);
      setTempDiscountCodes(Array.isArray(discountCodes) ? discountCodes : []);
      setTempProductTypes(productTypes || []);
      setTempDivisionProductType(divisionProductType || []);
      setView("ROOT");
    }
  }, [open, brandKey, productValue, utm, salesChannel, city, deviceType, discountCodes, divisionProductType]); // Removed productTypes to prevent reset loop

  useEffect(() => {
    setDrawerProductOptions(productOptions);
  }, [productOptions]);

  // Fetch Product Types
  useEffect(() => {
    if (open && showProductTypeFilter && tempBrand) {
      setTypesLoading(true);
      getProductTypes({ brand_key: tempBrand })
        .then((res) => {
          const types = res.types || [];
          setAvailableProductTypes(types);
        })
        .catch((err) => console.error("Failed to load product types", err))
        .finally(() => setTypesLoading(false));
    }
  }, [open, showProductTypeFilter, tempBrand]);

  // Fetch UTM options
  const lastFetchParams = useMemo(() => {
    return {
      open,
      brand: tempBrand,
      start: dateRange?.[0]?.format?.("YYYY-MM-DD"),
      end: dateRange?.[1]?.format?.("YYYY-MM-DD"),
    };
  }, [open, tempBrand, dateRange]);

  useEffect(() => {
    const selectedProductIds = Array.isArray(tempProduct)
      ? tempProduct.map((product) => product?.id).filter(Boolean).join(",")
      : tempProduct?.id || "";
    const committedProductIds = Array.isArray(productValue)
      ? productValue.map((product) => product?.id).filter(Boolean).join(",")
      : productValue?.id || "";

    if (
      propUtmOptions &&
      propUtmOptions.brand_key === tempBrand &&
      propUtmOptions.utm_tree &&
      selectedProductIds === committedProductIds
    ) {
      setUtmOptions(propUtmOptions);
      return;
    }

    if (!open || !tempBrand) return;
    if (
      isRangeOverDataRestrictionPeriod(
        dateRange?.[0],
        dateRange?.[1],
        normalizedRestrictionConfig,
      )
    ) {
      setUtmOptions({ brand_key: tempBrand });
      return;
    }

    // If we already have options for THIS brand, and it's not a dependent refresh trigger, skip?
    // Actually, if we depend on lastFetchParams, this effect only runs when they change.
    if (utmOptions && utmOptions.brand_key === tempBrand && !propUtmOptions) {
      // If we have local options for this brand and no updated props, we might still want to refresh
      // if tempUtm changed. But to avoid loops, let's be conservative.
    }

    getSummaryFilterOptions({
      brand_key: tempBrand,
      start: lastFetchParams.start,
      end: lastFetchParams.end,
      product_id: allowProductUtmSync ? selectedProductIds : undefined,
    })
      .then((res) => {
        if (res.filter_options) {
          setUtmOptions({ ...res.filter_options, brand_key: tempBrand });
        }
      })
      .catch((err) => console.error("Failed to load UTM options", err));
  }, [
    lastFetchParams,
    propUtmOptions,
    dateRange,
    normalizedRestrictionConfig,
    open,
    tempBrand,
    tempProduct,
    productValue,
    allowProductUtmSync,
  ]);

  useEffect(() => {
    if (!open || !tempBrand || !dateRange?.[0] || !dateRange?.[1]) return;

    const params = {
      brand_key: tempBrand,
      start: dateRange[0].format("YYYY-MM-DD"),
      end: dateRange[1].format("YYYY-MM-DD"),
      limit: 50,
    };

    if (allowProductUtmSync && tempUtm?.source && tempUtm.source.length > 0) {
      params.utm_source = tempUtm.source;
    }

    getTopProducts(params)
      .then(({ products, error }) => {
        if (error) return;
        const mapped = Array.isArray(products)
          ? products.map((p) => {
              const rawPath = (p.landing_page_path || "").toString();
              const slug = rawPath.includes("/products/")
                ? rawPath.split("/products/")[1] || rawPath
                : rawPath || p.product_id;
              const label = slug || p.product_id || "Unknown product";
              const sessions = Number(p.sessions || 0);
              const detail = `${sessions.toLocaleString()} sessions`;
              return { id: p.product_id, label, detail };
            })
          : [];

        setDrawerProductOptions([
          { id: "", label: "All products", detail: "Whole store" },
          ...mapped,
        ]);
      })
      .catch(() => {});
  }, [open, tempBrand, tempUtm?.source, dateRange, allowProductUtmSync]);

  const handleBack = () => {
    if (
      ["BRAND", "PRODUCT", "UTM", "SALES_CHANNEL", "CITY", "DEVICE_TYPE", "DISCOUNT", "DIVISION_PRODUCT_TYPE"].includes(view)
    ) {
      setView("ROOT");
    } else if (["UTM_SOURCE", "UTM_MEDIUM", "UTM_CAMPAIGN"].includes(view)) {
      setView("UTM");
    } else {
      setView("ROOT");
    }
  };

  const isDateRangeOver30Days = useMemo(() => {
    return isRangeOverDataRestrictionPeriod(
      dateRange?.[0],
      dateRange?.[1],
      normalizedRestrictionConfig,
    );
  }, [dateRange, normalizedRestrictionConfig]);

  // Clear UTM filters if date range > 30 days
  useEffect(() => {
    if (isDateRangeOver30Days) {
      setTempUtm({
        source: [],
        medium: [],
        campaign: [],
        term: [],
        content: [],
      });
    }
  }, [isDateRangeOver30Days]);

  const getViewTitle = () => {
    switch (view) {
      case "ROOT":
        return "Filters";
      case "BRAND":
        return "Select Brand";
      case "PRODUCT":
        return "Select Product";
      case "PRODUCT_TYPE":
        return "Product Type";
      case "UTM":
        return "UTM Parameters";
      case "UTM_SOURCE":
        return "Source";
      case "UTM_MEDIUM":
        return "Medium";
      case "UTM_CAMPAIGN":
        return "Campaign";
      case "SALES_CHANNEL":
        return "Sales Channel";
      case "CITY":
        return "City";
      case "DEVICE_TYPE":
        return "Device Type";
      case "DISCOUNT":
        return "Discount Code";
      case "DIVISION_PRODUCT_TYPE":
        return "Product Type";
      default:
        return "Filters";
    }
  };

  // --- UTM Logic (Mirrors UnifiedFilterBar) ---
  const utmSourceOptions = useMemo(
    () => Object.keys(utmOptions?.utm_tree || {}),
    [utmOptions],
  );

  const utmMediumOptions = useMemo(() => {
    const sources = tempUtm?.source || [];
    // If no source selected, show all mediums? UnifiedFilterBar shows all.
    if (!sources || sources.length === 0) {
      const allMediums = new Set();
      Object.values(utmOptions?.utm_tree || {}).forEach((s) => {
        Object.keys(s.mediums || {}).forEach((m) => allMediums.add(m));
      });
      return Array.from(allMediums);
    }

    // If source selected, show only relevant mediums
    const mediums = new Set();
    (Array.isArray(sources) ? sources : [sources]).forEach((s) => {
      const data = utmOptions?.utm_tree?.[s];
      if (data?.mediums) {
        Object.keys(data.mediums).forEach((m) => mediums.add(m));
      }
    });
    return Array.from(mediums);
  }, [utmOptions, tempUtm?.source]);

  const utmCampaignOptions = useMemo(() => {
    const sources = tempUtm?.source || [];
    const selectedMediums = tempUtm?.medium || [];

    if (
      (!sources || sources.length === 0) &&
      (!selectedMediums || selectedMediums.length === 0)
    ) {
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
      const sourceMatch =
        !sources ||
        sources.length === 0 ||
        (Array.isArray(sources) ? sources.includes(s) : sources === s);
      if (!sourceMatch) return;

      Object.entries(sData.mediums || {}).forEach(([m, mData]) => {
        const mediumMatch =
          !selectedMediums ||
          selectedMediums.length === 0 ||
          (Array.isArray(selectedMediums)
            ? selectedMediums.includes(m)
            : selectedMediums === m);
        if (!mediumMatch) return;

        Object.keys(mData.campaigns || {}).forEach((c) => campaigns.add(c));
      });
    });
    return Array.from(campaigns);
  }, [utmOptions, tempUtm?.source, tempUtm?.medium]);

  const activeUtmCount = [tempUtm?.source, tempUtm?.medium, tempUtm?.campaign]
    .map((v) => {
      if (Array.isArray(v)) return v.length > 0;
      return !!v;
    })
    .filter(Boolean).length;
  const hasTempProductFilter = Array.isArray(tempProduct)
    ? tempProduct.some((p) => p?.id)
    : !!tempProduct?.id;
  const isProductBlocked = productDisabled;
  const isUtmBlocked = utmDisabled;
  const areUtmMediumCampaignBlocked =
    utmDisabled || disableUtmMediumCampaign || hasTempProductFilter;
  const isChannelBlocked = salesChannelDisabled;
  const isDeviceTypeBlocked = deviceTypeDisabled;
  const isCityBlocked = cityDisabled;
  const isDiscountBlocked = discountDisabled;
  const committedDiscountCodes = Array.isArray(discountCodes) ? discountCodes : [];
  const hasCommittedDiscount = committedDiscountCodes.length > 0;
  const isDivisionProductTypeBlocked = divisionProductTypeDisabled;

  const handleClearAll = () => {
    if (onUtmChange) onUtmChange({ source: "", medium: "", campaign: "" });
    if (onProductChange)
      onProductChange({ id: "", label: "All products", detail: "Whole store" });
    if (onSalesChannelChange) onSalesChannelChange("");
    if (onCityChange) onCityChange([]);
    if (onDeviceTypeChange) onDeviceTypeChange([]);
    if (onDiscountCodesChange) onDiscountCodesChange([]);
    if (onDivisionProductTypeChange) onDivisionProductTypeChange([]);
    onClose();
  };

  const handleApply = () => {
    if (onBrandChange && tempBrand !== brandKey) onBrandChange(tempBrand);
    if (onProductChange) onProductChange(tempProduct);
    if (onUtmChange) onUtmChange(tempUtm);
    if (onSalesChannelChange) onSalesChannelChange(tempSalesChannel);
    if (onCityChange) onCityChange(tempCity);
    if (onDeviceTypeChange) onDeviceTypeChange(tempDeviceType);
    if (onDiscountCodesChange) onDiscountCodesChange(tempDiscountCodes);
    if (onProductTypeChange) onProductTypeChange(tempProductTypes);
    if (onDivisionProductTypeChange) onDivisionProductTypeChange(tempDivisionProductType);
    onClose();
  };

  // Product Type Logic
  const isAllTypesSelected = useMemo(() => {
    if (availableProductTypes.length === 0) return false;
    return tempProductTypes.length === availableProductTypes.length;
  }, [tempProductTypes, availableProductTypes]);

  const isIndeterminateTypes = useMemo(() => {
    return (
      tempProductTypes.length > 0 &&
      tempProductTypes.length < availableProductTypes.length
    );
  }, [tempProductTypes, availableProductTypes]);

  const handleToggleType = (type) => {
    if (tempProductTypes.includes(type)) {
      setTempProductTypes((prev) => prev.filter((t) => t !== type));
    } else {
      setTempProductTypes((prev) => [...prev, type]);
    }
  };

  const handleToggleAllTypes = () => {
    if (isAllTypesSelected) {
      setTempProductTypes([]);
    } else {
      setTempProductTypes([...availableProductTypes]);
    }
  };

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      sx={{ zIndex: 11000 }}
      PaperProps={{
        sx: {
          borderTopLeftRadius: 24,
          borderTopRightRadius: 24,
          height: "70vh",
          bgcolor: isDark
            ? "rgba(255, 255, 255, 0.08)"
            : "rgba(255, 255, 255, 0.7)",
          backdropFilter: "blur(25px)",
          backgroundImage: "none",
          display: "flex",
          flexDirection: "column",
          border: "1px solid",
          borderColor: isDark
            ? "rgba(255, 255, 255, 0.15)"
            : "rgba(0, 0, 0, 0.05)",
          boxShadow: "0 -10px 40px rgba(0,0,0,0.3)",
        },
      }}
    >
      {/* Active Filters List (Scrollable) - Shows COMMITTED filters (props) */}
      {((Array.isArray(productValue)
        ? productValue.some((p) => p.id !== "")
        : productValue?.id && productValue.id !== "") ||
        (Array.isArray(utm?.source) ? utm.source.length > 0 : utm?.source) ||
        (Array.isArray(utm?.medium) ? utm.medium.length > 0 : utm?.medium) ||
        (Array.isArray(utm?.medium) ? utm.medium.length > 0 : utm?.medium) ||
        (Array.isArray(utm?.campaign)
          ? utm.campaign.length > 0
          : utm?.campaign) ||
        (Array.isArray(salesChannel)
          ? salesChannel.length > 0
          : salesChannel) ||
        (Array.isArray(city) ? city.length > 0 : city) ||
        (Array.isArray(deviceType) ? deviceType.length > 0 : deviceType) ||
        hasCommittedDiscount) && (
        <Fade in={true} timeout={500}>
          <Box
            sx={{
              width: "100%",
              overflowX: "auto",
              bgcolor: "transparent",
              py: 1,
              scrollbarWidth: "none",
              "&::-webkit-scrollbar": { display: "none" },
            }}
          >
            <Box
              sx={{
                display: "flex",
                gap: 1,
                px: 2,
                alignItems: "center",
                minWidth: "max-content",
              }}
            >
              {/* Product Chip */}
              {(Array.isArray(productValue)
                ? productValue.some((p) => p.id !== "")
                : productValue?.id && productValue.id !== "") && (
                <Grow in={true}>
                  <div>
                    <GlassChip
                      label={
                        Array.isArray(productValue) && productValue.length > 1
                          ? `Products: ${productValue.length}`
                          : `Product: ${Array.isArray(productValue) ? productValue[0]?.label : productValue?.label}`
                      }
                      onDelete={() => {
                        if (onProductChange)
                          onProductChange({
                            id: "",
                            label: "All products",
                            detail: "Whole store",
                          });
                        setTempProduct({
                          id: "",
                          label: "All products",
                          detail: "Whole store",
                        });
                      }}
                      size="small"
                      isDark={isDark}
                      sx={{ borderRadius: "9999px" }}
                    />
                  </div>
                </Grow>
              )}
              {/* Product Type Chip */}
              {productTypes && productTypes.length > 0 && (
                <Grow in={true}>
                  <div>
                    <GlassChip
                      label={`Types: ${productTypes.length} selected`}
                      onDelete={() => {
                        if (onProductTypeChange) onProductTypeChange([]);
                        setTempProductTypes([]);
                      }}
                      size="small"
                      isDark={isDark}
                      sx={{ borderRadius: "9999px" }}
                    />
                  </div>
                </Grow>
              )}
              {/* UTM Chips */}
              {["source", "medium", "campaign"].map((field) => {
                const val = utm?.[field];
                if (!val || (Array.isArray(val) && val.length === 0))
                  return null;
                return (
                  <Grow key={field} in={true}>
                    <div>
                      <GlassChip
                        label={`${field.charAt(0).toUpperCase() + field.slice(1)}: ${Array.isArray(val) ? val.join(", ") : val}`}
                        onDelete={() => {
                          const update = { ...utm, [field]: "" };
                          if (onUtmChange) onUtmChange(update);
                          setTempUtm(update);
                        }}
                        size="small"
                        isDark={isDark}
                        sx={{ borderRadius: "9999px" }}
                      />
                    </div>
                  </Grow>
                );
              })}
              {/* Sales Channel Chip */}
              {(Array.isArray(salesChannel)
                ? salesChannel.length > 0
                : salesChannel) && (
                <Grow in={true}>
                  <div>
                    <GlassChip
                      label={`Channel: ${salesChannel}`}
                      onDelete={() => {
                        if (onSalesChannelChange) onSalesChannelChange("");
                        setTempSalesChannel("");
                      }}
                      size="small"
                      isDark={isDark}
                      sx={{ borderRadius: "9999px" }}
                    />
                  </div>
                </Grow>
              )}
              {(Array.isArray(city) ? city.length > 0 : city) && (
                <Grow in={true}>
                  <div>
                    <GlassChip
                      label={`City: ${Array.isArray(city) ? city.join(", ") : city}`}
                      onDelete={() => {
                        if (onCityChange) onCityChange([]);
                        setTempCity([]);
                      }}
                      size="small"
                      isDark={isDark}
                      sx={{ borderRadius: "9999px" }}
                    />
                  </div>
                </Grow>
              )}
              {/* Device Type Chip */}
              {(Array.isArray(deviceType)
                ? deviceType.length > 0
                : deviceType) && (
                <Grow in={true}>
                  <div>
                    <GlassChip
                      label={`Device: ${Array.isArray(deviceType) ? deviceType.join(", ") : deviceType}`}
                      onDelete={() => {
                        if (onDeviceTypeChange) onDeviceTypeChange([]);
                        setTempDeviceType([]);
                      }}
                      size="small"
                      isDark={isDark}
                      sx={{ borderRadius: "9999px" }}
                    />
                  </div>
                </Grow>
              )}
              {/* Discount Chips */}
              {committedDiscountCodes.map((code) => (
                <Grow in={true} key={code}>
                  <div>
                    <GlassChip
                      label={`Discount: ${code}`}
                      onDelete={() => {
                        const next = committedDiscountCodes.filter(
                          (c) => c !== code,
                        );
                        if (onDiscountCodesChange) onDiscountCodesChange(next);
                        setTempDiscountCodes(next);
                      }}
                      size="small"
                      isDark={isDark}
                      sx={{ borderRadius: "9999px" }}
                    />
                  </div>
                </Grow>
              ))}
            </Box>
          </Box>
        </Fade>
      )}

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
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {view !== "ROOT" && (
            <IconButton onClick={handleBack} size="small" edge="start">
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          <Typography variant="h6" fontSize={16} fontWeight={600}>
            {getViewTitle()}
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Content */}
      <Box
        sx={{
          p: 0,
          overflowY: "auto",
          flex: 1,
          bgcolor: "transparent",
          position: "relative",
        }}
      >
        {/* ANIMATED VIEWS */}
        <Box key={view} sx={{ animation: "fadeIn 0.3s ease-in-out" }}>
          <style>
            {`
                            @keyframes fadeIn {
                                from { opacity: 0; transform: translateX(10px); }
                                to { opacity: 1; transform: translateX(0); }
                            }
                        `}
          </style>

          {/* ROOT VIEW */}
          {view === "ROOT" && (
            <List disablePadding>
              {/* Brand Item */}
              {showBrandFilter && (
                <ListItemButton
                  onClick={() => setView("BRAND")}
                  sx={{ py: 2, justifyContent: "space-between" }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Brand
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {tempBrand || "Select Brand"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* Product Item */}
              {showProductFilter && (
                <ListItemButton
                  onClick={() => setView("PRODUCT")}
                  disabled={isProductBlocked}
                  sx={{ py: 2, justifyContent: "space-between" }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Product
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {isProductBlocked
                        ? "Clear discount filter first"
                        : Array.isArray(tempProduct)
                        ? tempProduct.length > 1
                          ? `${tempProduct.length} Products`
                          : tempProduct[0]?.label || "All products"
                        : tempProduct?.label || "All products"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* Product Type Item (New) */}
              {showProductTypeFilter && (
                <ListItemButton
                  onClick={() => setView("PRODUCT_TYPE")}
                  sx={{ py: 2, justifyContent: "space-between" }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Product Type
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {tempProductTypes.length > 0
                        ? `${tempProductTypes.length} selected`
                        : "All types"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* UTM Item */}
              {showUtmFilter && (
                <ListItemButton
                  onClick={() => setView("UTM")}
                  disabled={isUtmBlocked}
                  sx={{
                    py: 2,
                    justifyContent: "space-between",
                    opacity: isDateRangeOver30Days ? 0.7 : 1,
                  }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 0.5,
                      }}
                    >
                      UTM Parameters
                      {isDateRangeOver30Days && (
                        <WarningAmberIcon
                          sx={{ fontSize: 14, color: "#ed6c02" }}
                        />
                      )}
                    </Typography>
                    <Typography
                      variant="body1"
                      fontSize={14}
                      fontWeight={500}
                      sx={{
                        color: isDateRangeOver30Days ? "#ed6c02" : "inherit",
                      }}
                    >
                      {isDateRangeOver30Days
                        ? dataRestrictionDescription
                        : isUtmBlocked
                          ? hasCommittedDiscount
                            ? "Clear discount filter first"
                            : "Clear product filter first"
                          : activeUtmCount > 0
                          ? `${activeUtmCount} Active`
                          : "All"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* Discount Code Item */}
              {showDiscountFilter && (
                <ListItemButton
                  onClick={() => setView("DISCOUNT")}
                  disabled={isDiscountBlocked}
                  sx={{ py: 2, justifyContent: "space-between" }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Discount Code
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {isDiscountBlocked
                        ? "Clear other filters first"
                        : tempDiscountCodes.length > 0
                          ? `${tempDiscountCodes.length} selected`
                          : "All"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* Sales Channel Item */}
              {/* SALES CHANNEL Item */}
              {showSalesChannel && (
                <ListItemButton
                  onClick={() => setView("SALES_CHANNEL")}
                  disabled={isChannelBlocked}
                  sx={{ py: 2, justifyContent: "space-between" }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Sales Channel
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {isChannelBlocked
                        ? "Clear other filters first"
                        : Array.isArray(tempSalesChannel)
                        ? tempSalesChannel.length > 0
                          ? tempSalesChannel.join(", ")
                          : "All"
                        : tempSalesChannel || "All"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {showCityFilter && (
                <ListItemButton
                  onClick={() => setView("CITY")}
                  disabled={isCityBlocked}
                  sx={{ py: 2, justifyContent: "space-between" }}
                  divider
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      City
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {isCityBlocked
                        ? "Clear other filters first"
                        : Array.isArray(tempCity)
                        ? tempCity.length > 0
                          ? `${tempCity.length} selected`
                          : "All"
                        : tempCity || "All"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* DEVICE TYPE Item */}
              {showDeviceType && (
                <ListItemButton
                  onClick={() => setView("DEVICE_TYPE")}
                  disabled={isDeviceTypeBlocked}
                  sx={{ py: 2, justifyContent: "space-between" }}
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Device Type
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {isDeviceTypeBlocked
                        ? "Clear other filters first"
                        : Array.isArray(tempDeviceType)
                        ? tempDeviceType.length > 0
                          ? tempDeviceType.join(", ")
                          : "All"
                        : tempDeviceType || "All"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}

              {/* DIVISION PRODUCT TYPE Item */}
              {showDivisionProductType && (
                <ListItemButton
                  onClick={() => setView("DIVISION_PRODUCT_TYPE")}
                  disabled={isDivisionProductTypeBlocked}
                  sx={{ py: 2, justifyContent: "space-between" }}
                >
                  <Box>
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      Product Type
                    </Typography>
                    <Typography variant="body1" fontSize={14} fontWeight={500}>
                      {isDivisionProductTypeBlocked
                        ? "Clear other filters first"
                        : Array.isArray(tempDivisionProductType)
                        ? tempDivisionProductType.length > 0
                          ? tempDivisionProductType.join(", ")
                          : "All"
                        : tempDivisionProductType || "All"}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="action" />
                </ListItemButton>
              )}
            </List>
          )}

          {/* BRAND VIEW */}
          {view === "BRAND" && (
            <List disablePadding>
              {(brands || [])
                .filter((b) => b.key !== "MILA")
                .map((b) => (
                  <ListItemButton
                    key={b.key}
                    onClick={() => {
                      setTempBrand(b.key);
                      handleBack();
                    }}
                    selected={tempBrand === b.key}
                    sx={{ py: 1.5 }}
                  >
                    <ListItemText
                      primary={b.key}
                      primaryTypographyProps={{
                        fontWeight: tempBrand === b.key ? 600 : 400,
                      }}
                    />
                    {tempBrand === b.key && (
                      <CheckIcon fontSize="small" color="primary" />
                    )}
                  </ListItemButton>
                ))}
            </List>
          )}

          {/* PRODUCT VIEW */}
          {view === "PRODUCT" && (
            <Box
              sx={{ height: "100%", display: "flex", flexDirection: "column" }}
            >
              <Box
                sx={{
                  px: 2,
                  py: 1,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  position: "sticky",
                  top: 0,
                  bgcolor: isDark
                    ? "rgba(15, 15, 15, 0.9)"
                    : "rgba(255, 255, 255, 0.9)",
                  backdropFilter: "blur(40px)",
                  zIndex: 10,
                }}
              >
                <TextField
                  size="small"
                  fullWidth
                  placeholder="Search products..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  autoFocus
                />
              </Box>
              <List disablePadding>
                {drawerProductOptions
                  .filter(
                    (opt) =>
                      !searchText ||
                      (opt.label || "")
                        .toLowerCase()
                        .includes(searchText.toLowerCase()),
                  )
                  .map((opt) => {
                    const isSelected = Array.isArray(tempProduct)
                      ? tempProduct.some((p) => p.id === opt.id)
                      : (tempProduct?.id || "") === (opt.id || "");
                    return (
                      <ListItemButton
                        key={opt.id || "all"}
                        onClick={() => {
                          setTempProduct(opt);
                          handleBack();
                        }}
                        selected={isSelected}
                        sx={{ py: 1.5 }}
                      >
                        <ListItemText
                          primary={opt.id ? opt.label : "All products"}
                          secondary={opt.detail}
                          primaryTypographyProps={{
                            fontWeight: isSelected ? 600 : 400,
                            fontSize: 14,
                          }}
                          secondaryTypographyProps={{ fontSize: 12 }}
                        />
                        {isSelected && (
                          <CheckIcon fontSize="small" color="primary" />
                        )}
                      </ListItemButton>
                    );
                  })}
              </List>
            </Box>
          )}

          {/* PRODUCT TYPE VIEW */}
          {view === "PRODUCT_TYPE" && (
            <Box>
              {typesLoading ? (
                <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
                  <CircularProgress size={24} />
                </Box>
              ) : (
                <List disablePadding>
                  {/* Select All */}
                  <ListItemButton
                    onClick={handleToggleAllTypes}
                    sx={{ py: 1.5 }}
                  >
                    <Checkbox
                      checked={
                        isAllTypesSelected && availableProductTypes.length > 0
                      }
                      indeterminate={isIndeterminateTypes}
                      size="small"
                      sx={{ p: 0.5, mr: 1 }}
                    />
                    <ListItemText
                      primary="Select All"
                      primaryTypographyProps={{ fontWeight: 600, fontSize: 14 }}
                    />
                  </ListItemButton>
                  <Box sx={{ height: 1, bgcolor: "divider", my: 0.5 }} />

                  {/* Types List */}
                  {availableProductTypes.map((type) => {
                    const isSelected = tempProductTypes.includes(type);
                    return (
                      <ListItemButton
                        key={type}
                        onClick={() => handleToggleType(type)}
                        sx={{ py: 0.5 }}
                      >
                        <Checkbox
                          checked={isSelected}
                          size="small"
                          sx={{ p: 0.5, mr: 1 }}
                        />
                        <ListItemText
                          primary={type}
                          primaryTypographyProps={{ fontSize: 14 }}
                        />
                      </ListItemButton>
                    );
                  })}
                  {availableProductTypes.length === 0 && (
                    <Box sx={{ p: 2, textAlign: "center" }}>
                      <Typography variant="body2" color="text.secondary">
                        No product types found.
                      </Typography>
                    </Box>
                  )}
                </List>
              )}
            </Box>
          )}

          {/* UTM ROOT VIEW */}
          {view === "UTM" && (
            <List disablePadding>
              {isDateRangeOver30Days && (
                <Box
                  sx={{
                    px: 2,
                    py: 1.5,
                    bgcolor: isDark
                      ? "rgba(255, 152, 0, 0.1)"
                      : "rgba(255, 152, 0, 0.05)",
                    display: "flex",
                    alignItems: "center",
                    gap: 1.5,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <WarningAmberIcon sx={{ color: "#ed6c02", fontSize: 20 }} />
                  <Typography
                    variant="body2"
                    sx={{ color: "#ed6c02", fontWeight: 600, fontSize: 13 }}
                  >
                    {utmRestrictionWarning}
                  </Typography>
                </Box>
              )}
              <List
                disablePadding
                sx={{
                  opacity: isDateRangeOver30Days ? 0.5 : 1,
                  pointerEvents: isDateRangeOver30Days ? "none" : "auto",
                }}
              >
                {["source", "medium", "campaign"].map((field, index) => (
                  <ListItemButton
                    key={field}
                    onClick={() => {
                      if (
                        (field === "medium" || field === "campaign") &&
                        areUtmMediumCampaignBlocked
                      ) {
                        return;
                      }
                      setView(`UTM_${field.toUpperCase()}`);
                    }}
                    disabled={
                      (field === "medium" || field === "campaign") &&
                      areUtmMediumCampaignBlocked
                    }
                    divider={index < 2}
                    sx={{ py: 2, justifyContent: "space-between" }}
                  >
                    <Box>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ textTransform: "capitalize", fontSize: 12 }}
                      >
                        {field}
                      </Typography>
                      <Typography
                        variant="body1"
                        fontSize={14}
                        fontWeight={500}
                        noWrap
                      >
                        {(() => {
                          const val = tempUtm?.[field];
                          if (Array.isArray(val) && val.length > 0)
                            return val.join(", ");
                          if (val && !Array.isArray(val)) return val;
                          return "All";
                        })()}
                      </Typography>
                    </Box>
                    <ChevronRightIcon fontSize="small" color="action" />
                  </ListItemButton>
                ))}
              </List>
            </List>
          )}

          {/* UTM OPTIONS VIEWS */}
          {["UTM_SOURCE", "UTM_MEDIUM", "UTM_CAMPAIGN"].includes(view) && (
            <Box
              sx={{ height: "100%", display: "flex", flexDirection: "column" }}
            >
              {["UTM_MEDIUM", "UTM_CAMPAIGN"].includes(view) && areUtmMediumCampaignBlocked ? (
                <Box sx={{ px: 2, py: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Clear product filter to use {view === "UTM_MEDIUM" ? "Medium" : "Campaign"}.
                  </Typography>
                </Box>
              ) : null}
              <Box
                sx={{
                  px: 2,
                  py: 1,
                  borderBottom: "1px solid",
                  borderColor: "divider",
                  position: "sticky",
                  top: 0,
                  bgcolor: isDark
                    ? "rgba(15, 15, 15, 0.9)"
                    : "rgba(255, 255, 255, 0.9)",
                  backdropFilter: "blur(40px)",
                  zIndex: 10,
                }}
              >
                <TextField
                  size="small"
                  fullWidth
                  placeholder={`Search ${view.replace("UTM_", "").toLowerCase()}...`}
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  autoFocus
                  disabled={
                    ["UTM_MEDIUM", "UTM_CAMPAIGN"].includes(view) &&
                    areUtmMediumCampaignBlocked
                  }
                />
              </Box>
              <List disablePadding>
                <ListItemButton
                  onClick={() => {
                    const field = view.replace("UTM_", "").toLowerCase();
                    setTempUtm({ ...tempUtm, [field]: "" });
                    // handleBack(); // Don't close on clear all in multi-select mode? Or maybe just clear selection.
                    // Actually better UX: 'All' means clear current selection
                  }}
                  sx={{ py: 1.5 }}
                >
                  <Checkbox
                    checked={
                      !tempUtm?.[view.replace("UTM_", "").toLowerCase()] ||
                      (Array.isArray(
                        tempUtm?.[view.replace("UTM_", "").toLowerCase()],
                      ) &&
                        tempUtm?.[view.replace("UTM_", "").toLowerCase()]
                          .length === 0)
                    }
                    size="small"
                    sx={{ p: 0.5, mr: 1 }}
                  />
                  <ListItemText primary="All" />
                </ListItemButton>

                {(() => {
                  let options = [];
                  if (view === "UTM_SOURCE") options = utmSourceOptions;
                  else if (view === "UTM_MEDIUM") options = utmMediumOptions;
                  else if (view === "UTM_CAMPAIGN")
                    options = utmCampaignOptions;

                  return options
                    .filter(
                      (opt) =>
                        !searchText ||
                        String(opt)
                          .toLowerCase()
                          .includes(searchText.toLowerCase()),
                    )
                    .map((opt) => {
                      const field = view.replace("UTM_", "").toLowerCase();
                      const current = tempUtm?.[field];
                      const isSelected = Array.isArray(current)
                        ? current.includes(opt)
                        : current === opt;

                      return (
                        <ListItemButton
                          key={opt}
                          disabled={
                            ["UTM_MEDIUM", "UTM_CAMPAIGN"].includes(view) &&
                            areUtmMediumCampaignBlocked
                          }
                          onClick={() => {
                            let newVal;
                            if (Array.isArray(current)) {
                              newVal = current.includes(opt)
                                ? current.filter((x) => x !== opt)
                                : [...current, opt];
                            } else {
                              // Was string or null, now array
                              // If it was already this val (shouldn't happen if we strictly use arrays but for safety), toggle off
                              if (current === opt) newVal = [];
                              else newVal = current ? [current, opt] : [opt];
                            }
                            // Handle the case where user had single string selected before update
                            // If current was string and not equal to opt, we make it array [current, opt]

                            setTempUtm({ ...tempUtm, [field]: newVal });
                            // handleBack(); // Keep open for multi-select
                          }}
                          selected={isSelected}
                          sx={{ py: 0.5 }} // denser
                        >
                          <Checkbox
                            checked={isSelected}
                            size="small"
                            sx={{ p: 0.5, mr: 1 }}
                          />
                          <ListItemText
                            primary={opt}
                            primaryTypographyProps={{
                              fontSize: 14,
                              noWrap: true,
                            }}
                          />
                        </ListItemButton>
                      );
                    });
                })()}
              </List>
            </Box>
          )}

          {/* DISCOUNT VIEW */}
          {view === "DISCOUNT" && (
            <List disablePadding>
              <ListItemButton
                onClick={() => setTempDiscountCodes([])}
                selected={tempDiscountCodes.length === 0}
                sx={{ py: 1.5 }}
              >
                <ListItemText primary="All" />
                {tempDiscountCodes.length === 0 && (
                  <CheckIcon fontSize="small" color="primary" />
                )}
              </ListItemButton>
              <Box sx={{ px: 2, py: 1 }}>
                <Typography variant="caption" color="text.secondary">
                  {tempDiscountCodes.length >= MAX_DISCOUNT_CODES
                    ? `Max ${MAX_DISCOUNT_CODES} codes selected — data is aggregated`
                    : `Select up to ${MAX_DISCOUNT_CODES} codes — data is aggregated`}
                </Typography>
              </Box>
              {(utmOptions?.discount_codes || []).map((code) => {
                const isSelected = tempDiscountCodes.includes(code);
                const atLimit =
                  !isSelected && tempDiscountCodes.length >= MAX_DISCOUNT_CODES;
                return (
                  <ListItemButton
                    key={code}
                    disabled={atLimit}
                    onClick={() => {
                      if (isSelected) {
                        setTempDiscountCodes(
                          tempDiscountCodes.filter((c) => c !== code),
                        );
                        return;
                      }
                      // First discount selection is mutually exclusive with the
                      // other filter groups — clear them.
                      if (tempDiscountCodes.length === 0) {
                        setTempProduct({ id: "", label: "All products", detail: "Whole store" });
                        setTempUtm({ source: [], medium: [], campaign: [], term: [], content: [] });
                        setTempSalesChannel("");
                        setTempDeviceType([]);
                        setTempCity([]);
                      }
                      setTempDiscountCodes([...tempDiscountCodes, code]);
                    }}
                    selected={isSelected}
                    sx={{ py: 1.5 }}
                  >
                    <ListItemText
                      primary={code}
                      primaryTypographyProps={{ noWrap: true }}
                    />
                    {isSelected && (
                      <CheckIcon fontSize="small" color="primary" />
                    )}
                  </ListItemButton>
                );
              })}
              {(!utmOptions?.discount_codes ||
                utmOptions.discount_codes.length === 0) && (
                <Box sx={{ p: 2, textAlign: "center" }}>
                  <Typography variant="body2" color="text.secondary">
                    No discounts found
                  </Typography>
                </Box>
              )}
            </List>
          )}

          {/* SALES CHANNEL VIEW */}
          {view === "SALES_CHANNEL" && (
            <List disablePadding>
              <ListItemButton
                onClick={() => {
                  setTempSalesChannel("");
                  handleBack();
                }}
                selected={!tempSalesChannel}
                sx={{ py: 1.5 }}
              >
                <ListItemText primary="All" />
                {!tempSalesChannel && (
                  <CheckIcon fontSize="small" color="primary" />
                )}
              </ListItemButton>
              {(utmOptions?.sales_channel || []).map((channel) => (
                <ListItemButton
                  key={channel}
                  onClick={() => {
                    setTempSalesChannel(channel);
                    handleBack();
                  }}
                  selected={
                    Array.isArray(tempSalesChannel)
                      ? tempSalesChannel.includes(channel)
                      : tempSalesChannel === channel
                  }
                  sx={{ py: 1.5 }}
                >
                  <ListItemText primary={channel} />
                  {(Array.isArray(tempSalesChannel)
                    ? tempSalesChannel.includes(channel)
                    : tempSalesChannel === channel) && (
                    <CheckIcon fontSize="small" color="primary" />
                  )}
                </ListItemButton>
              ))}
            </List>
          )}

          {view === "CITY" && (
            <List disablePadding>
              <ListItemButton
                onClick={() => {
                  setTempCity([]);
                  handleBack();
                }}
                selected={!tempCity || tempCity.length === 0}
                sx={{ py: 1.5 }}
              >
                <ListItemText primary="All" />
                {(!tempCity || tempCity.length === 0) && (
                  <CheckIcon fontSize="small" color="primary" />
                )}
              </ListItemButton>
              {(utmOptions?.city || []).map((cityOption) => {
                const selectedCities = Array.isArray(tempCity) ? tempCity : [];
                const isSelected = selectedCities.includes(cityOption);
                return (
                  <ListItemButton
                    key={cityOption}
                    onClick={() => {
                      const nextCities = isSelected
                        ? selectedCities.filter((value) => value !== cityOption)
                        : [...selectedCities, cityOption];
                      setTempCity(nextCities);
                    }}
                    selected={isSelected}
                    sx={{ py: 1.5 }}
                  >
                    <ListItemText primary={cityOption} />
                    {isSelected && (
                      <CheckIcon fontSize="small" color="primary" />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          )}

          {/* DEVICE TYPE VIEW */}
          {view === "DEVICE_TYPE" && (
            <List disablePadding>
              <ListItemButton
                onClick={() => {
                  setTempDeviceType([]);
                  handleBack();
                }}
                selected={!tempDeviceType || tempDeviceType.length === 0}
                sx={{ py: 1.5 }}
              >
                <ListItemText primary="All" />
                {(!tempDeviceType || tempDeviceType.length === 0) && (
                  <CheckIcon fontSize="small" color="primary" />
                )}
              </ListItemButton>
              {["Desktop", "Mobile", "Others"].map((type) => {
                const selectedTypes = Array.isArray(tempDeviceType)
                  ? tempDeviceType
                  : [];
                const isSelected = selectedTypes.includes(type);
                return (
                  <ListItemButton
                    key={type}
                    onClick={() => {
                      const newTypes = isSelected
                        ? selectedTypes.filter((t) => t !== type)
                        : [...selectedTypes, type];
                      setTempDeviceType(newTypes);
                    }}
                    selected={isSelected}
                    sx={{ py: 1.5 }}
                  >
                    <ListItemText primary={type} />
                    {isSelected && (
                      <CheckIcon fontSize="small" color="primary" />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          )}

          {/* DIVISION PRODUCT TYPE VIEW */}
          {view === "DIVISION_PRODUCT_TYPE" && (
            <List disablePadding>
              <ListItemButton
                onClick={() => {
                  setTempDivisionProductType([]);
                  handleBack();
                }}
                selected={!tempDivisionProductType || tempDivisionProductType.length === 0}
                sx={{ py: 1.5 }}
              >
                <ListItemText primary="All" />
                {(!tempDivisionProductType || tempDivisionProductType.length === 0) && (
                  <CheckIcon fontSize="small" color="primary" />
                )}
              </ListItemButton>
              {(utmOptions?.product_types || []).map((typeOption) => {
                const selectedTypes = Array.isArray(tempDivisionProductType)
                  ? tempDivisionProductType
                  : [];
                const isSelected = selectedTypes.includes(typeOption);
                return (
                  <ListItemButton
                    key={typeOption}
                    onClick={() => {
                      const nextTypes = isSelected
                        ? selectedTypes.filter((value) => value !== typeOption)
                        : [...selectedTypes, typeOption];
                      setTempDivisionProductType(nextTypes);
                    }}
                    selected={isSelected}
                    sx={{ py: 1.5 }}
                  >
                    <ListItemText primary={typeOption} />
                    {isSelected && (
                      <CheckIcon fontSize="small" color="primary" />
                    )}
                  </ListItemButton>
                );
              })}
            </List>
          )}
        </Box>
      </Box>

      {/* Footer */}
      <Box
        sx={{
          p: 2,
          borderTop: "1px solid",
          borderColor: "divider",
          display: "flex",
          gap: 2,
          bgcolor: isDark
            ? "rgba(255, 255, 255, 0.05)"
            : "rgba(255,255,255,0.3)",
        }}
      >
        <Button
          fullWidth
          variant="outlined"
          color="inherit"
          onClick={handleClearAll}
          startIcon={<DeleteIcon />}
          sx={{
            textTransform: "none",
            borderColor: "divider",
            color: "text.secondary",
            borderRadius: "12px",
          }}
        >
          Clear
        </Button>
        <Button
          fullWidth
          variant="contained"
          onClick={handleApply}
          sx={{ textTransform: "none", borderRadius: "12px" }}
        >
          Apply
        </Button>
      </Box>
    </Drawer>
  );
}
