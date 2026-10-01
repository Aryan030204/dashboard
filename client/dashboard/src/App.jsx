import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  Suspense,
  lazy,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useLocation, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { AppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  Box,
  Stack,
  IconButton,
  Tooltip,
  Typography,
  useMediaQuery,
} from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Header from "./components/Header.jsx";
import Sidebar from "./components/Sidebar.jsx";
import LayoutPanelsIcon from "./components/ui/LayoutPanelsIcon.jsx";
import SidebarToggle from "./components/ui/SidebarToggle.jsx";
import MaintenanceScreen from "./components/MaintenanceScreen.jsx";
import DailyInsightBar from "./components/DailyInsightBar.jsx";
import DailyInsightsEditor from "./components/DailyInsightsEditor.jsx";

import {
  LayoutGrid,
  Activity,
  HeartPulse,
  Table2,
  Bell,
  ShieldCheck,
  Store,
  Filter,
  Package,
  ClipboardList,
  Gauge,
  Settings,
} from "lucide-react";

const MOBILE_NAV_ITEMS = [
  { id: "overall-snapshot", label: "Overall Snapshot", icon: LayoutGrid },
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { id: "session-analytics", label: "Dashboard Sessions", icon: Activity },
  { id: "product-conversion", label: "Product Funnel", icon: Filter },
  { id: "daily-funnel", label: "Conversion Funnel", icon: Table2 },
  { id: "bundles", label: "Bundles", icon: Table2 },
  { id: "inventory", label: "Inventory", icon: Package },
  { id: "web-vitals", label: "Web Vitals", icon: Gauge },
  { id: "health-monitor", label: "Health Monitor", icon: HeartPulse },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "requests", label: "Requests", icon: ClipboardList },
  { id: "tenant-setup", label: "Tenant Setup", icon: Store },
  { id: "client-settings", label: "Client Side Settings", icon: Settings },
  //  { id: "notifications-log", label: "Logs", icon: Bell },
  { id: "access", label: "Access", icon: ShieldCheck },
  { id: "traffic-split-config", label: "Traffic Config", icon: Table2 },
  //  { id: 'brands', label: 'Setup', icon: Store },
];

const TAB_ROUTE_MAP = {
  "overall-snapshot": "/overall-snapshot",
  dashboard: "/dashboard",
  "session-analytics": "/session-analytics",
  "product-conversion": "/funnels",
  "daily-funnel": "/daily-funnel",
  bundles: "/bundles",
  inventory: "/inventory",
  "web-vitals": "/web-vitals",
  "health-monitor": "/health-monitor",
  alerts: "/alerts",
  requests: "/requests",
  access: "/access-control",
  "traffic-split-config": "/configurations",
  "tenant-setup": "/tenant-setup",
  "client-settings": "/client-settings",
};

const ROUTE_TAB_MAP = Object.fromEntries(
  Object.entries(TAB_ROUTE_MAP).map(([tabId, path]) => [path, tabId]),
);

function normalizeRoutePath(pathname) {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1).toLowerCase();
  }
  return pathname.toLowerCase();
}

function getTabFromPathname(pathname) {
  return ROUTE_TAB_MAP[normalizeRoutePath(pathname)] || null;
}

function getPathForTab(tabId) {
  return TAB_ROUTE_MAP[tabId] || TAB_ROUTE_MAP["overall-snapshot"];
}

function getSanitizedSearch(search) {
  const params = new URLSearchParams(search || "");
  params.delete("access_token");
  const next = params.toString();
  return next ? `?${next}` : "";
}

function isPublicPath(pathname) {
  const normalized = normalizeRoutePath(pathname);
  return normalized === "/login" || normalized === "/unauthorized";
}

const MotionDiv = motion.div;

import {
  listAuthorBrands,
  getDataRestrictionConfig,
  getTopProducts,
  getDashboardSummary,
  getSummaryFilterOptions,
  doPost,
} from "./lib/api.js";
import { initializeSessionTracking } from "./lib/sessionTracker.js";
import {
  DEFAULT_DATA_RESTRICTION_CONFIG,
  getDataRestrictionDescription,
  isRangeOverDataRestrictionPeriod,
} from "./lib/dateRange.js";
import { setFrontendUserContext } from "./observability.js";
import axios from "axios";
import { requestForToken, onMessageListener } from "./firebase";
import useSessionHeartbeat from "./hooks/useSessionHeartbeat.js";
import { useAppDispatch, useAppSelector } from "./state/hooks.js";
import {
  fetchCurrentUser,
  fetchClientSettings,
  loginUser,
  logoutUser,
  clearAuthState,
} from "./state/slices/authSlice.js";
import { setBrand } from "./state/slices/brandSlice.js";
import {
  DEFAULT_PRODUCT_OPTION,
  setProductSelection,
  setRange,
  setCompareMode,
  setCompareDateRange,
  setTrendMetricSelection,
  setUtm,
  setSalesChannel,
  setDeviceType,
  setDiscountCode,
  setCity,
  setProductType,
} from "./state/slices/filterSlice.js";
import {
  CI_TREND_METRICS,
  DEFAULT_TREND_METRIC,
  DISCOUNT_ALLOWED_TREND_METRICS,
  normalizeTrendMetric,
  sanitizeTrendMetricSelection,
  toggleTrendMetricSelection,
} from "./lib/trendSelection.js";
import MobileTopBar from "./components/MobileTopBar.jsx";
import AdminRouteContainer from "./routes/AdminRouteContainer.jsx";
import AuthRouteContainer from "./routes/AuthRouteContainer.jsx";
import BundlesRouteContainer from "./routes/BundlesRouteContainer.jsx";
import DailyFunnelRouteContainer from "./routes/DailyFunnelRouteContainer.jsx";
import DashboardRouteContainer from "./routes/DashboardRouteContainer.jsx";
import InventoryRouteContainer from "./routes/InventoryRouteContainer.jsx";
import MerchantRequestsRouteContainer from "./routes/MerchantRequestsRouteContainer.jsx";
import OverallSnapshotRouteContainer from "./routes/OverallSnapshotRouteContainer.jsx";
import ProductConversionRouteContainer from "./routes/ProductConversionRouteContainer.jsx";
import SessionAnalyticsRouteContainer from "./routes/SessionAnalyticsRouteContainer.jsx";
import HealthMonitorRouteContainer from "./routes/HealthMonitorRouteContainer.jsx";
import WebVitalsRouteContainer from "./routes/WebVitalsRouteContainer.jsx";
const MobileFilterDrawer = lazy(
  () => import("./components/MobileFilterDrawer.jsx"),
);
const UnifiedFilterBar = lazy(
  () => import("./components/UnifiedFilterBar.jsx"),
);
const AuthorBrandSelector = lazy(
  () => import("./components/AuthorBrandSelector.jsx"),
);
const Footer = lazy(() => import("./components/Footer.jsx"));

function formatDate(dt) {
  return dt ? dayjs(dt).format("YYYY-MM-DD") : undefined;
}

const SESSION_TRACKING_ENABLED =
  String(import.meta.env.VITE_SESSION_TRACKING || "false").toLowerCase() ===
  "true";
const AUTHOR_BRAND_STORAGE_KEY = "author_active_brand_v1";
const THEME_MODE_KEY = "dashboard_theme_mode";
const TRAFFIC_SPLIT_RULES_STORAGE_PREFIX = "traffic_split_rules_v1";
const DRAWER_WIDTH = 260;

function loadInitialThemeMode() {
  try {
    const saved = localStorage.getItem(THEME_MODE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    // Ignore storage access errors
  }
  return "light";
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const globalBrandKey = useAppSelector((state) => state.brand.brand);
  const {
    user,
    initialized,
    loginStatus,
    loginError,
    maintenanceMode,
    dashboardBannerEnabled,
  } = useAppSelector((state) => state.auth);
  const {
    range,
    compareMode,
    compareDateRange,
    selectedMetrics,
    activeMetric,
    productSelection,
    utm,
    discountCode,
    salesChannel,
    deviceType,
    city,
    productType,
  } = useAppSelector((state) => state.filters);
  const productTableStart = useAppSelector(
    (state) => state.productConversion?.start,
  );
  const productTableEnd = useAppSelector(
    (state) => state.productConversion?.end,
  );
  const loggingIn = loginStatus === "loading";
  // range holds ISO strings; normalize to dayjs for components that expect it
  const [start, end] = useMemo(
    () => [
      range?.[0] && dayjs(range[0]).isValid() ? dayjs(range[0]) : null,
      range?.[1] && dayjs(range[1]).isValid() ? dayjs(range[1]) : null,
    ],
    [range],
  );
  const normalizedRange = useMemo(() => [start, end], [start, end]);
  // Daily Insight is keyed to a single business date; multi-day ranges have no
  // single insight to show, so this is null in that case.
  const singleDayInsightDate = useMemo(() => {
    if (!start || !end || !start.isSame(end, "day")) return null;
    return end.format("YYYY-MM-DD");
  }, [start, end]);
  const [dailyInsightRefreshToken, setDailyInsightRefreshToken] = useState(0);
  const [dataRestrictionConfig, setDataRestrictionConfig] = useState(
    DEFAULT_DATA_RESTRICTION_CONFIG,
  );
  const isLongRangeDashboard = useMemo(
    () => isRangeOverDataRestrictionPeriod(start, end, dataRestrictionConfig),
    [start, end, dataRestrictionConfig],
  );
  const dataRestrictionDescription = useMemo(
    () => getDataRestrictionDescription(dataRestrictionConfig),
    [dataRestrictionConfig],
  );
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });

  const isAuthor = !!user?.isAuthor;
  const isBrandUser = !!user && !user.isAuthor;

  const [authorBrands, setAuthorBrands] = useState([]);
  const [authorBrandsLoading, setAuthorBrandsLoading] = useState(false);
  // New state to strictly track if the initial fetch has completed
  const [brandsLoaded, setBrandsLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getDataRestrictionConfig()
      .then((config) => {
        if (cancelled) return;
        setDataRestrictionConfig({
          enabled:
            typeof config?.enabled === "boolean"
              ? config.enabled
              : DEFAULT_DATA_RESTRICTION_CONFIG.enabled,
          periodDays:
            Number.isFinite(Number(config?.periodDays)) &&
            Number(config.periodDays) > 0
              ? Number(config.periodDays)
              : DEFAULT_DATA_RESTRICTION_CONFIG.periodDays,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const authorBrandKey = useMemo(
    () => (globalBrandKey || "").toString().trim().toUpperCase(),
    [globalBrandKey],
  );
  const viewerBrands = useMemo(() => {
    if (!user?.brand_memberships) return [];
    const seen = new Set();
    const list = [];
    for (const m of user.brand_memberships) {
      if (m?.status !== "active") continue;
      const key = (m.brand_id || "").toString().trim().toUpperCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        list.push(key);
      }
    }
    return list;
  }, [user]);
  const snapshotBrands = useMemo(
    () => (isAuthor ? authorBrands : viewerBrands.map((key) => ({ key }))),
    [authorBrands, isAuthor, viewerBrands],
  );

  // Initialize tab checking storage; guard against invalid reads
  const [authorTab, setAuthorTab] = useState(() => {
    const routeTab =
      typeof window !== "undefined"
        ? getTabFromPathname(window.location.pathname)
        : null;
    if (routeTab) return routeTab;
    try {
      const stored =
        localStorage.getItem("author_active_tab_v1") || "dashboard";
      return stored === "adjustments" ? "dashboard" : stored;
    } catch {
      return "dashboard";
    }
  });

  const isMobile = useMediaQuery("(max-width:900px)"); // Responsive breakpoint for mobile

  const [authorRefreshKey, setAuthorRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false); // Valid New State
  const [darkMode, setDarkMode] = useState(loadInitialThemeMode);
  const [isScrolled, setIsScrolled] = useState(false);
  const [productOptions, setProductOptions] = useState([
    DEFAULT_PRODUCT_OPTION,
  ]);
  const [productOptionsLoading, setProductOptionsLoading] = useState(false);
  const [funnelData, setFunnelData] = useState({
    stats: null,
    deltas: null,
    loading: true,
  });
  const [utmOptions, setUtmOptions] = useState(null);
  const [trafficSplitRules, setTrafficSplitRules] = useState([]);

  // Track navigation direction for transitions
  const [direction, setDirection] = useState(0);
  const dashboardRouteActionsRef = useRef({});
  const currentRouteTab = useMemo(
    () => getTabFromPathname(location.pathname),
    [location.pathname],
  );
  const sanitizedSearch = useMemo(
    () => getSanitizedSearch(location.search),
    [location.search],
  );

  // Animation variants for page content
  const pageVariants = {
    initial: (dir) => {
      const isMobileNow = window.innerWidth <= 900;
      const offset =
        dir > 0
          ? isMobileNow
            ? "100%"
            : 40
          : dir < 0
            ? isMobileNow
              ? "-100%"
              : -40
            : 0;
      return isMobileNow
        ? { x: offset, opacity: 0 }
        : { y: offset, opacity: 0 };
    },
    animate: {
      x: 0,
      y: 0,
      opacity: 1,
      transition: {
        type: "spring",
        stiffness: 260,
        damping: 28,
      },
    },
    exit: (dir) => {
      const isMobileNow = window.innerWidth <= 900;
      const offset =
        dir > 0
          ? isMobileNow
            ? "-100%"
            : -40
          : dir < 0
            ? isMobileNow
              ? "100%"
              : 40
            : 0;
      return isMobileNow
        ? { x: offset, opacity: 0 }
        : { y: offset, opacity: 0 };
    },
  };

  // Keep a data attribute on the body so global CSS (e.g., Polaris overrides) can react to theme changes.
  useEffect(() => {
    document.body.dataset.theme = darkMode;
    if (darkMode === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  // Track scroll position for sticky panel border
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 0);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  useSessionHeartbeat(SESSION_TRACKING_ENABLED && isBrandUser);

  // Push Notification setup
  useEffect(() => {
    if (!user) return;

    if (isAuthor) {
      requestForToken()
        .then((token) => {
          if (token) {
            doPost("/push/register-token", {
              token,
              user_info: {
                id: user.id || user._id,
                email: user.email,
                name: user.name,
              },
            }).then((res) => {
              if (res.error) {
                console.error("Failed to register FCM token:", res.status);
              } else {
                console.log("FCM token registered successfully");
              }
            });
          }
        })
        .catch((err) => console.error("Token request failed:", err));
    } else if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      // Non-admin user with existing permission: ensure token is unregistered
      requestForToken()
        .then((token) => {
          if (token) {
            doPost("/push/unregister-token", { token });
          }
        })
        .catch(() => {}); // Ignore errors when trying to clear
    }
  }, [user, isAuthor]);

  useEffect(() => {
    if (!isAuthor) return;

    // onMessageListener sometimes returns undefined if permissions aren't granted yet,
    // but our wrapper returns the unsubscribe function when successfully listening.
    let unsubscribe;
    try {
      unsubscribe = onMessageListener((payload) => {
        console.log("FCM Foreground message received:", payload);
        // We can trigger an event or state to refresh the notifications menu!
        // To keep it simple, we listen for window events in NotificationsMenu.
        window.dispatchEvent(new CustomEvent("fcm-foreground-message"));
      });
    } catch (err) {
      console.warn("FCM listen failed:", err);
    }
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [isAuthor]);

  const activeBrandKey = isAuthor
    ? authorBrandKey || user?.primary_brand_id || ""
    : (globalBrandKey || "").toString().trim().toUpperCase() ||
      (user?.primary_brand_id || "").toString().trim().toUpperCase() ||
      (user?.brandKey || "").toString().trim().toUpperCase() ||
      viewerBrands[0] ||
      "";

  useEffect(() => {
    setFrontendUserContext(user, activeBrandKey);
  }, [user, activeBrandKey]);

  // Session Tracking Initialization
  useEffect(() => {
    if (initialized && user && activeBrandKey) {
      // Small delay to ensure everything is fully loaded and stable
      const timer = setTimeout(() => {
        initializeSessionTracking(user, activeBrandKey);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [initialized, user, activeBrandKey]);

  const trafficSplitRulesStorageKey = useMemo(() => {

    const brand = (activeBrandKey || "GLOBAL").toString().trim().toUpperCase();
    return `${TRAFFIC_SPLIT_RULES_STORAGE_PREFIX}_${brand}`;
  }, [activeBrandKey]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(trafficSplitRulesStorageKey);
      if (!raw) {
        setTrafficSplitRules([]);
        return;
      }
      const parsed = JSON.parse(raw);
      setTrafficSplitRules(Array.isArray(parsed) ? parsed : []);
    } catch {
      setTrafficSplitRules([]);
    }
  }, [trafficSplitRulesStorageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(
        trafficSplitRulesStorageKey,
        JSON.stringify(trafficSplitRules || []),
      );
    } catch {
      // Ignore storage write issues
    }
  }, [trafficSplitRulesStorageKey, trafficSplitRules]);

  const viewerPermissions = useMemo(() => {
    if (isAuthor) return ["all"];
    const memberships = user?.brand_memberships || [];
    const active = memberships.find(
      (m) =>
        (m.brand_id || "").toString().trim().toUpperCase() ===
        (activeBrandKey || "").toString().trim().toUpperCase(),
    );
    const source = active || memberships[0];
    const perms = source?.permissions || [];
    return perms.length ? perms : []; // Default to NO permissions if empty
  }, [isAuthor, user, activeBrandKey]);

  const hasPermission = useCallback(
    (perm) => {
      if (isAuthor) return true;
      if (viewerPermissions.includes("all")) return true;
      return viewerPermissions.includes(perm);
    },
    [isAuthor, viewerPermissions],
  );
  const canCustomizeDashboardLayout = hasPermission(
    "dashboard_layout_customize",
  );
  const canMultiSelectableKpiCards = hasPermission(
    "multiselectable_kpi_cards",
  );

  const canAccessInventoryPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("inventory_panel");
  }, [hasPermission, isAuthor]);

  const canAccessBundlesPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("bundles_panel");
  }, [hasPermission, isAuthor]);

  const canAccessDailyFunnelPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("daily_funnel_panel");
  }, [hasPermission, isAuthor]);

  const canAccessUtmFunnelTable = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("utm_funnel_table");
  }, [hasPermission, isAuthor]);

  const canAccessUtmCampaignGrain = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("utm_funnel_table:utm_campaign_grain");
  }, [hasPermission, isAuthor]);

  const canAccessRequestsPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("requests_panel");
  }, [hasPermission, isAuthor]);

  const canAccessSessionAnalyticsPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("session_analytics");
  }, [hasPermission, isAuthor]);

  const canAccessOverallSnapshotPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("overall_snapshot");
  }, [hasPermission, isAuthor]);

  const canAccessHealthMonitorPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("health_monitor_panel");
  }, [hasPermission, isAuthor]);

  const canAccessWebVitalsPanel = useMemo(() => {
    if (isAuthor) return true;
    return hasPermission("web_vitals_panel");
  }, [hasPermission, isAuthor]);

  const defaultLandingTab = useMemo(() => {
    if (isAuthor) return "overall-snapshot";
    return canAccessOverallSnapshotPanel ? "overall-snapshot" : "dashboard";
  }, [canAccessOverallSnapshotPanel, isAuthor]);

  const accessibleTabs = useMemo(() => {
    if (isAuthor) return null;
    const tabs = ["dashboard"];
    if (canAccessOverallSnapshotPanel) tabs.unshift("overall-snapshot");
    if (canAccessSessionAnalyticsPanel) tabs.push("session-analytics");
    if (canAccessDailyFunnelPanel) tabs.push("daily-funnel");
    if (canAccessRequestsPanel) tabs.push("requests");
    if (canAccessBundlesPanel) tabs.push("bundles");
    if (canAccessInventoryPanel) tabs.push("inventory");
    if (canAccessWebVitalsPanel) tabs.push("web-vitals");
    if (canAccessHealthMonitorPanel) tabs.push("health-monitor");
    return tabs;
  }, [
    canAccessOverallSnapshotPanel,
    canAccessDailyFunnelPanel,
    canAccessBundlesPanel,
    canAccessInventoryPanel,
    canAccessRequestsPanel,
    canAccessSessionAnalyticsPanel,
    canAccessWebVitalsPanel,
    canAccessHealthMonitorPanel,
    isAuthor,
  ]);

  useEffect(() => {
    if (!initialized) return;
    if (authorTab === "overall-snapshot" && !canAccessOverallSnapshotPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP.dashboard,
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "inventory" && !canAccessInventoryPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "bundles" && !canAccessBundlesPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "daily-funnel" && !canAccessDailyFunnelPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "requests" && !canAccessRequestsPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "session-analytics" && !canAccessSessionAnalyticsPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "web-vitals" && !canAccessWebVitalsPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }
    if (authorTab === "health-monitor" && !canAccessHealthMonitorPanel) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
    }
  }, [
    authorTab,
    defaultLandingTab,
    canAccessOverallSnapshotPanel,
    canAccessDailyFunnelPanel,
    canAccessBundlesPanel,
    canAccessInventoryPanel,
    canAccessRequestsPanel,
    canAccessSessionAnalyticsPanel,
    canAccessWebVitalsPanel,
    canAccessHealthMonitorPanel,
    initialized,
    location.search,
    sanitizedSearch,
    navigate,
  ]);

  const showSidebar = isAuthor || (accessibleTabs && accessibleTabs.length > 1);

  // Derived arrays/labels for product multi-select used directly by child components
  const selectedProductIds = useMemo(() => {
    if (!productSelection) return "";
    if (Array.isArray(productSelection)) {
      return productSelection
        .map((p) => p.id)
        .filter(Boolean)
        .join(",");
    }
    return productSelection.id || "";
  }, [productSelection]);

  const selectedProductLabel = useMemo(() => {
    if (!productSelection) return "";
    if (Array.isArray(productSelection)) {
      if (productSelection.length > 1) {
        return `${productSelection.length} Products`;
      }
      return productSelection[0]?.label || "";
    }
    return productSelection.label || "";
  }, [productSelection]);
  const dashboardScopeLabel = useMemo(() => {
    if (!selectedProductIds) return "All products";
    return selectedProductLabel || selectedProductIds;
  }, [selectedProductIds, selectedProductLabel]);

  const hasActiveProductFilter = useMemo(() => {
    if (!productSelection) return false;
    const products = Array.isArray(productSelection)
      ? productSelection
      : [productSelection];
    return products.some((p) => p?.id);
  }, [productSelection]);
  const hasActiveUtmFilter = useMemo(() => {
    const values = [
      utm?.source,
      utm?.medium,
      utm?.campaign,
      utm?.term,
      utm?.content,
    ];
    return values.some((value) =>
      Array.isArray(value) ? value.length > 0 : !!value,
    );
  }, [utm]);
  const hasActiveNonSourceUtmFilter = useMemo(() => {
    const values = [utm?.medium, utm?.campaign, utm?.term, utm?.content];
    return values.some((value) =>
      Array.isArray(value) ? value.length > 0 : !!value,
    );
  }, [utm]);
  const hasActiveSourceUtmFilter = useMemo(() => {
    const value = utm?.source;
    return Array.isArray(value) ? value.length > 0 : !!value;
  }, [utm]);
  const canSyncProductUtmFilters = hasPermission("product_utm_filter_sync");
  const hasActiveSalesChannelFilter = useMemo(
    () => Array.isArray(salesChannel) && salesChannel.length > 0,
    [salesChannel],
  );
  const hasActiveDeviceTypeFilter = useMemo(
    () => Array.isArray(deviceType) && deviceType.length > 0,
    [deviceType],
  );
  const hasActiveCityFilter = useMemo(
    () => Array.isArray(city) && city.length > 0,
    [city],
  );
  const hasActiveDiscountFilter = !!discountCode;
  const hasActiveProductTypeFilter = useMemo(
    () => Array.isArray(productType) && productType.length > 0,
    [productType],
  );
  // Channel / Device Type / City / Discount Code / Product Type are mutually
  // exclusive with every other filter (including each other) — applying any
  // one of them locks out Product, UTM, and the remaining four of this group.
  const hasActiveExclusiveGroupFilter =
    hasActiveSalesChannelFilter ||
    hasActiveDeviceTypeFilter ||
    hasActiveCityFilter ||
    hasActiveDiscountFilter ||
    hasActiveProductTypeFilter;
  const salesChannelDisabled =
    hasActiveDeviceTypeFilter ||
    hasActiveCityFilter ||
    hasActiveDiscountFilter ||
    hasActiveProductTypeFilter ||
    hasActiveProductFilter ||
    hasActiveUtmFilter;
  const deviceTypeDisabled =
    hasActiveSalesChannelFilter ||
    hasActiveCityFilter ||
    hasActiveDiscountFilter ||
    hasActiveProductTypeFilter ||
    hasActiveProductFilter ||
    hasActiveUtmFilter;
  const cityDisabled =
    hasActiveSalesChannelFilter ||
    hasActiveDeviceTypeFilter ||
    hasActiveDiscountFilter ||
    hasActiveProductTypeFilter ||
    hasActiveProductFilter ||
    hasActiveUtmFilter;
  const discountDisabled =
    hasActiveSalesChannelFilter ||
    hasActiveDeviceTypeFilter ||
    hasActiveCityFilter ||
    hasActiveProductTypeFilter ||
    hasActiveProductFilter ||
    hasActiveUtmFilter;
  const productTypeDisabled =
    hasActiveSalesChannelFilter ||
    hasActiveDeviceTypeFilter ||
    hasActiveCityFilter ||
    hasActiveDiscountFilter ||
    hasActiveProductFilter ||
    hasActiveUtmFilter;
  const productFilterDisabled =
    hasActiveExclusiveGroupFilter ||
    (canSyncProductUtmFilters ? hasActiveNonSourceUtmFilter : hasActiveUtmFilter);
  const utmFilterDisabled =
    hasActiveExclusiveGroupFilter ||
    (!canSyncProductUtmFilters && hasActiveProductFilter);
  const utmMediumCampaignDisabled = hasActiveExclusiveGroupFilter || hasActiveProductFilter;

  useEffect(() => {
    if (!isAuthor && viewerBrands.length) {
      const current = (globalBrandKey || "").toString().trim().toUpperCase();
      // If current brand is not in the allowed list, force switch to the first allowed brand
      const isValid = viewerBrands.includes(current);
      if (!isValid) {
        dispatch(setBrand(viewerBrands[0]));
      }
    }
  }, [isAuthor, viewerBrands, globalBrandKey, dispatch]);

  // Trend Query (Supports Arrays)
  const trendMetricsQuery = useMemo(() => {
    const base = { start: formatDate(start), end: formatDate(end) };
    const key = (activeBrandKey || "").toString().trim().toUpperCase();
    if (key) base.brand_key = key;
    if (utm?.source && (!hasActiveProductFilter || canSyncProductUtmFilters)) {
      base.utm_source = utm.source;
    }
    if (utm?.medium) base.utm_medium = utm.medium;
    if (utm?.campaign) base.utm_campaign = utm.campaign;
    if (utm?.term) base.utm_term = utm.term;
    if (utm?.content) base.utm_content = utm.content;
    if (discountCode) base.discount_code = discountCode;

    // Arrays allowed here
    if (salesChannel) base.sales_channel = salesChannel;
    if (deviceType && deviceType.length > 0) base.device_type = deviceType;
    if (city && city.length > 0) base.city = city;
    if (productType && productType.length > 0) base.product_type = productType;

    if (isAuthor) {
      base.refreshKey = authorRefreshKey;
    }

    if (productSelection && (isAuthor || hasPermission("product_filter"))) {
      // Support array of products
      const products = Array.isArray(productSelection)
        ? productSelection
        : [productSelection];
      const ids = products.map((p) => p.id).filter(Boolean);
      if (ids.length > 0) base.product_id = ids;
    }

    // Compare mode: pass compare date range
    if (compareMode && compareDateRange?.[0] && compareDateRange?.[1]) {
      base.compare_start = formatDate(dayjs(compareDateRange[0]));
      base.compare_end = formatDate(dayjs(compareDateRange[1]));
    }

    return base;
  }, [
    start,
    end,
    compareMode,
    compareDateRange,
    activeBrandKey,
    isAuthor,
    authorRefreshKey,
    productSelection,
    hasPermission,
    utm,
    discountCode,
    salesChannel,
    deviceType,
    city,
    productType,
    hasActiveProductFilter,
    canSyncProductUtmFilters,
  ]);

  // General Query (Legacy / Single Value Fallback)
  const generalMetricsQuery = useMemo(() => {
    const base = { ...trendMetricsQuery };

    // Fallback to single value for components that don't support arrays yet
    if (Array.isArray(base.sales_channel)) {
      base.sales_channel = base.sales_channel[0] || "";
    }
    if (Array.isArray(base.product_id)) {
      base.product_id = base.product_id[0] || "";
    }
    // Also fallback UTMs if needed? most backends handle arrays now but let's be safe if specific components break
    // Actually metricsController seems to handle arrays mostly via `extractUtmParam` or `appendUtmWhere` which handles arrays.
    // But let's keep consistency with the requirement "only Trend Graph and 6 KPI Cards".

    return base;
  }, [trendMetricsQuery]);
  const overallSnapshotQuery = useMemo(() => {
    const base = { ...generalMetricsQuery };
    delete base.brand_key;
    delete base.product_id;
    delete base.refreshKey;
    return base;
  }, [generalMetricsQuery]);

  const handleAuthorBrandChange = useCallback(
    (nextKeyRaw) => {
      const normalized = (nextKeyRaw || "").toString().trim().toUpperCase();
      const changed = normalized !== authorBrandKey;
      // Persist immediately alongside Redux
      try {
        localStorage.setItem("author_active_brand_v1", normalized);
      } catch {
        // Ignore storage write errors
      }

      dispatch(setBrand(normalized || ""));
      if (changed) {
        setAuthorRefreshKey((prev) => prev + 1);
      }
    },
    [authorBrandKey, dispatch],
  );

  const handleOverallSnapshotBrandSelect = useCallback(
    (nextKeyRaw) => {
      const normalized = (nextKeyRaw || "").toString().trim().toUpperCase();
      if (!normalized) return;

      try {
        localStorage.setItem("author_active_brand_v1", normalized);
      } catch {
        // Ignore storage write errors
      }

      if (isAuthor) {
        handleAuthorBrandChange(normalized);
      } else {
        dispatch(setBrand(normalized));
      }

      navigate(
        {
          pathname: TAB_ROUTE_MAP.dashboard,
          search: sanitizedSearch,
        },
        { replace: currentRouteTab === "dashboard" },
      );
    },
    [
      currentRouteTab,
      dispatch,
      handleAuthorBrandChange,
      isAuthor,
      navigate,
      sanitizedSearch,
    ],
  );

  // Reset UTM filters when brand changes
  useEffect(() => {
    dispatch(
      setUtm({ source: [], medium: [], campaign: [], term: [], content: [] }),
    );
  }, [activeBrandKey, dispatch]);

  useEffect(() => {
    if (!isAuthor) {
      setAuthorBrands([]);
      setAuthorBrandsLoading(false);
      setBrandsLoaded(false);
      return;
    }
    let cancelled = false;
    setAuthorBrandsLoading(true);
    setBrandsLoaded(false); // Reset loaded state on new fetch start
    listAuthorBrands()
      .then((json) => {
        if (cancelled) return;
        if (json.__error || json.error) {
          setAuthorBrands([]);
          return;
        }
        const payload = json.data ?? json;
        const arr = Array.isArray(payload.brands)
          ? payload.brands.map((b) => ({
              key: (b.key || "").toString().trim().toUpperCase(),
              host: b.host,
              db: b.db,
            }))
          : []; // EXPLICIT REMOVAL
        setAuthorBrands(arr);
      })
      .finally(() => {
        if (!cancelled) {
          setAuthorBrandsLoading(false);
          setBrandsLoaded(true); // Mark as fully loaded
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthor]);

  useEffect(() => {
    if (!isAuthor) return;
    // CRITICAL: Strict check for completion of initial load
    if (!brandsLoaded) return;

    if (!authorBrands.length) {
      if (authorBrandKey) {
        handleAuthorBrandChange("");
      }
      return;
    }
    const normalized = (authorBrandKey || "").toString().trim().toUpperCase();
    const exists = normalized && authorBrands.some((b) => b.key === normalized);

    // Only force reset if we are sure the list is loaded and the key is truly invalid
    if (!exists) {
      handleAuthorBrandChange(authorBrands[0].key);
    }
  }, [
    isAuthor,
    authorBrands,
    authorBrandKey,
    handleAuthorBrandChange,
    brandsLoaded,
  ]);

  // Brand Enforcement on Load (URL Parameter > Primary Brand > Persisted)
  const [brandEnforcementDone, setBrandEnforcementDone] = useState(false);
  useEffect(() => {
    if (!initialized || !user || brandEnforcementDone) return;

    let enforcedBrand = null;
    const current = (globalBrandKey || "").toString().trim().toUpperCase();

    // 1. Check URL parameters
    const params = new URLSearchParams(window.location.search);
    const urlBrand = params.get("brand");

    if (urlBrand) {
      const normalizedUrl = urlBrand.trim().toUpperCase();
      // For authors, we assume the URL brand is acceptable for now.
      // It will be strictly validated later when authorBrands loaded.
      const isValidUrlBrand = isAuthor || viewerBrands.includes(normalizedUrl);

      if (isValidUrlBrand) {
        enforcedBrand = normalizedUrl;
        // Clean URL
        params.delete("brand");
        const newSearch = params.toString() ? `?${params.toString()}` : "";
        const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}${newSearch}${window.location.hash}`;
        window.history.replaceState({ path: newUrl }, "", newUrl);
      }
    }

    // 2. If no valid URL brand, and user is viewer, check Primary
    if (!enforcedBrand && !isAuthor) {
      const primary = (user.primary_brand_id || "")
        .toString()
        .trim()
        .toUpperCase();
      if (primary && viewerBrands.includes(primary)) {
        enforcedBrand = primary;
      }
    }

    if (enforcedBrand && current !== enforcedBrand) {
      handleAuthorBrandChange(enforcedBrand);
    }

    setBrandEnforcementDone(true);
  }, [
    initialized,
    user,
    isAuthor,
    viewerBrands,
    globalBrandKey,
    brandEnforcementDone,
    handleAuthorBrandChange,
  ]);

  useEffect(() => {
    const normalizedPath = normalizeRoutePath(location.pathname);

    if (!user && isPublicPath(normalizedPath)) {
      return;
    }

    if (normalizedPath === "/") {
      navigate(
        {
          pathname: user ? TAB_ROUTE_MAP[defaultLandingTab] : "/login",
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }

    if (!currentRouteTab) {
      navigate(
        {
          pathname: user ? TAB_ROUTE_MAP[defaultLandingTab] : "/login",
          search: sanitizedSearch,
        },
        { replace: true },
      );
    }
  }, [currentRouteTab, defaultLandingTab, location.pathname, sanitizedSearch, navigate, user]);

  useEffect(() => {
    if (!currentRouteTab) return;
    setAuthorTab((prev) => (prev === currentRouteTab ? prev : currentRouteTab));
    try {
      localStorage.setItem("author_active_tab_v1", currentRouteTab);
    } catch {
      // Ignore storage write errors
    }
  }, [currentRouteTab]);

  // Persist tab state only for authors
  useEffect(() => {
    // Wait until initialized to decide if we should reset tab
    if (
      initialized &&
      !isAuthor &&
      (!accessibleTabs || !accessibleTabs.includes(authorTab))
    ) {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
      return;
    }

    // Guard against legacy tab state that no longer exists
    if (initialized && authorTab === "adjustments") {
      navigate(
        {
          pathname: TAB_ROUTE_MAP[defaultLandingTab],
          search: sanitizedSearch,
        },
        { replace: true },
      );
    }
  }, [
    isAuthor,
    initialized,
    defaultLandingTab,
    authorTab,
    accessibleTabs,
    sanitizedSearch,
    navigate,
  ]);

  useEffect(() => {
    // Product filter options are only used by tabs with a filter bar; skip
    // the fetch entirely on brand-agnostic-UI tabs like Web Vitals/Health Monitor.
    if (authorTab === "web-vitals" || authorTab === "health-monitor") {
      setProductOptions([DEFAULT_PRODUCT_OPTION]);
      setProductSelection(DEFAULT_PRODUCT_OPTION);
      setProductOptionsLoading(false);
      return;
    }

    // Only authors or users with product_filter permission should see/use product filters; reset for everyone else.
    if (!isAuthor && !hasPermission("product_filter")) {
      setProductOptions([DEFAULT_PRODUCT_OPTION]);
      setProductSelection(DEFAULT_PRODUCT_OPTION);
      setProductOptionsLoading(false);
      return;
    }

    if (!start || !end) {
      setProductOptions([DEFAULT_PRODUCT_OPTION]);
      setProductSelection(DEFAULT_PRODUCT_OPTION);
      return;
    }

    if (!initialized || !user) {
      setProductOptions([DEFAULT_PRODUCT_OPTION]);
      setProductSelection(DEFAULT_PRODUCT_OPTION);
      setProductOptionsLoading(false);
      return;
    }

    if (!activeBrandKey) {
      setProductOptions([DEFAULT_PRODUCT_OPTION]);
      setProductSelection(DEFAULT_PRODUCT_OPTION);
      setProductOptionsLoading(false);
      return;
    }

    let cancelled = false;
    setProductOptionsLoading(true);

    const params = {
      start: formatDate(start),
      end: formatDate(end),
      limit: 50,
      brand_key: activeBrandKey,
    };
    if (canSyncProductUtmFilters && utm?.source && utm.source.length > 0) {
      params.utm_source = utm.source;
    }

    getTopProducts(params)
      .then(({ products, error }) => {
        if (cancelled) return;
        const existingSelection = Array.isArray(productSelection)
          ? productSelection.filter((p) => p?.id)
          : productSelection?.id
            ? [productSelection]
            : [];

        if (error) {
          setProductOptions([DEFAULT_PRODUCT_OPTION]);
          if (existingSelection.length === 0) {
            setProductSelection(DEFAULT_PRODUCT_OPTION);
          }
          return;
        }

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

        const mergedMapped = [...mapped];
        for (const item of existingSelection) {
          const itemId = String(item.id);
          if (!mergedMapped.some((opt) => String(opt.id) === itemId)) {
            mergedMapped.unshift(item);
          }
        }

        const nextOptions = [DEFAULT_PRODUCT_OPTION, ...mergedMapped];
        setProductOptions(nextOptions);

        // map current selection IDs to new options
        const currentIds = new Set(
          existingSelection.map((p) => String(p.id)),
        );
        const validSelection = nextOptions.filter(
          (opt) => opt.id !== "" && currentIds.has(String(opt.id)),
        );

        if (validSelection.length > 0) {
          setProductSelection(
            Array.isArray(productSelection)
              ? validSelection
              : validSelection[0],
          );
        } else {
          setProductSelection(
            existingSelection.length > 0
              ? Array.isArray(productSelection)
                ? existingSelection
                : existingSelection[0]
              : DEFAULT_PRODUCT_OPTION,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setProductOptionsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    start,
    end,
    activeBrandKey,
    authorRefreshKey,
    productSelection,
    utm?.source,
    canSyncProductUtmFilters,
    initialized,
    user,
    isAuthor,
    hasPermission,
    authorTab,
  ]);

  const handleSelectMetric = useCallback(
    (metricKey) => {
      const normalizedMetric = normalizeTrendMetric(metricKey);
      if (!normalizedMetric) return;

      dispatch(
        setTrendMetricSelection(
          sanitizeTrendMetricSelection(
            [],
            normalizedMetric,
          ),
        ),
      );
    },
    [dispatch],
  );

  const handleToggleMetric = useCallback(
    (metricKey, options = {}) => {
      if (!canMultiSelectableKpiCards) return;
      const normalizedMetric = normalizeTrendMetric(metricKey);
      if (!normalizedMetric) return;

      const nextSelection = toggleTrendMetricSelection(
        selectedMetrics,
        activeMetric,
        normalizedMetric,
        options,
      );

      let allowedMetrics = Array.isArray(nextSelection.selectedMetrics)
        ? [...nextSelection.selectedMetrics]
        : [];

      if (!hasPermission("ci_events")) {
        allowedMetrics = allowedMetrics.filter(
          (entry) => !CI_TREND_METRICS.has(entry),
        );
      }
      if (discountCode) {
        allowedMetrics = allowedMetrics.filter((entry) =>
          DISCOUNT_ALLOWED_TREND_METRICS.has(entry),
        );
      }

      const fallbackMetric =
        nextSelection.activeMetric &&
        (!discountCode ||
          DISCOUNT_ALLOWED_TREND_METRICS.has(nextSelection.activeMetric)) &&
        (hasPermission("ci_events") ||
          !CI_TREND_METRICS.has(nextSelection.activeMetric))
          ? nextSelection.activeMetric
          : DEFAULT_TREND_METRIC;

      dispatch(
        setTrendMetricSelection(
          sanitizeTrendMetricSelection(
            allowedMetrics,
            nextSelection.activeMetric || fallbackMetric,
          ),
        ),
      );
    },
    [
      activeMetric,
      canMultiSelectableKpiCards,
      dispatch,
      discountCode,
      hasPermission,
      selectedMetrics,
    ],
  );

  const handleRangeChange = useCallback(
    (nextRange) => {
      if (!Array.isArray(nextRange)) return;
      dispatch(setRange(nextRange));
    },
    [dispatch],
  );

  const handleProductChange = useCallback(
    (value) => {
      if (!canSyncProductUtmFilters && hasActiveUtmFilter) {
        dispatch(
          setUtm({
            source: [],
            medium: [],
            campaign: [],
            term: [],
            content: [],
          }),
        );
      }
      dispatch(setProductSelection(value || DEFAULT_PRODUCT_OPTION));
      dispatch(setDiscountCode(""));
    },
    [canSyncProductUtmFilters, dispatch, hasActiveUtmFilter],
  );

  const handleUtmChange = useCallback(
    (val) => {
      if (!canSyncProductUtmFilters && hasActiveProductFilter) {
        dispatch(setProductSelection(DEFAULT_PRODUCT_OPTION));
      }
      dispatch(setUtm(val));
      dispatch(setDiscountCode(""));
    },
    [canSyncProductUtmFilters, dispatch, hasActiveProductFilter],
  );

  const handleSalesChannelChange = useCallback(
    (val) => {
      dispatch(setSalesChannel(val));
      dispatch(setDiscountCode(""));
    },
    [dispatch],
  );

  const handleDeviceTypeChange = useCallback(
    (val) => {
      dispatch(setDeviceType(val));
      dispatch(setDiscountCode(""));
    },
    [dispatch],
  );

  const handleCityChange = useCallback(
    (val) => {
      dispatch(setCity(val));
    },
    [dispatch],
  );

  const handleProductTypeChange = useCallback(
    (val) => {
      dispatch(setProductType(val));
      dispatch(setDiscountCode(""));
    },
    [dispatch],
  );

  const handleDiscountCodeChange = useCallback(
    (val) => {
      const next = val || "";
      dispatch(setDiscountCode(next));
      if (next) {
        dispatch(setProductSelection(DEFAULT_PRODUCT_OPTION));
        dispatch(setUtm({ source: [], medium: [], campaign: [], term: [], content: [] }));
        dispatch(setSalesChannel([]));
        dispatch(setDeviceType([]));
        dispatch(setCity([]));
        dispatch(setProductType([]));
      }
    },
    [dispatch],
  );

  const handleCompareModeChange = useCallback(
    (enabled) => {
      dispatch(setCompareMode(enabled));
      if (!enabled) {
        dispatch(setCompareDateRange([null, null]));
      }
    },
    [dispatch],
  );

  const handleCompareDateRangeChange = useCallback(
    (nextRange) => {
      if (!Array.isArray(nextRange)) return;
      dispatch(setCompareDateRange(nextRange));
    },
    [dispatch],
  );

  const handleSidebarOpen = useCallback(() => setSidebarOpen(true), []);
  const handleSidebarClose = useCallback(() => setSidebarOpen(false), []);
  const handleSidebarTabChange = useCallback((tabId) => {
    const oldIndex = MOBILE_NAV_ITEMS.findIndex((item) => item.id === authorTab);
    const newIndex = MOBILE_NAV_ITEMS.findIndex((item) => item.id === tabId);

    if (oldIndex !== -1 && newIndex !== -1) {
      setDirection(newIndex > oldIndex ? 1 : -1);
    } else {
      setDirection(0);
    }

    try {
      localStorage.setItem("author_active_tab_v1", tabId);
    } catch {
      // Ignore storage write errors
    }
    navigate(
      {
        pathname: getPathForTab(tabId),
        search: sanitizedSearch,
      },
      { replace: false },
    );
  }, [authorTab, sanitizedSearch, navigate]);

  const handleToggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_MODE_KEY, next);
      } catch {
        // Ignore storage write errors
      }
      return next;
    });
  }, []);

  // Wrapper to prevent skeleton flash on refresh
  const handleFunnelData = useCallback((newData) => {
    setFunnelData((prev) => {
      // If we are loading and have no stats yet in the new update,
      // but we ALREADY have stats from before, keep showing the old stats
      // to avoid a skeleton flash during the refresh.
      if (newData.loading && !newData.stats && prev?.stats) {
        return { ...newData, stats: prev.stats };
      }
      return newData;
    });
  }, []);

  const handleRegisterDashboardActions = useCallback((actions) => {
    dashboardRouteActionsRef.current = actions || {};
  }, []);

  const handleOpenDashboardLayoutEditor = useCallback(() => {
    dashboardRouteActionsRef.current?.openLayoutEditor?.();
  }, []);

  const handleDashboardDownloadSnapshot = useCallback(() => {
    dashboardRouteActionsRef.current?.downloadSnapshot?.();
  }, []);

  const glassStyles = useMemo(
    () => ({
      backdropFilter: "blur(12px)",
      backgroundColor:
        darkMode === "dark"
          ? "rgba(255, 255, 255, 0.08)"
          : "rgba(255, 255, 255, 0.7)",
      border: "1px solid",
      borderColor:
        darkMode === "dark"
          ? "rgba(255, 255, 255, 0.15)"
          : "rgba(0, 0, 0, 0.05)",
    }),
    [darkMode],
  );

  const depthShadows = useMemo(
    () => ({
      boxShadow:
        darkMode === "dark"
          ? "0 20px 40px rgba(0, 0, 0, 0.6), inset 1px 1px 0px 0px rgba(255, 255, 255, 0.15)"
          : "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05), inset 1px 1px 0px 0px rgba(255, 255, 255, 0.5)",
    }),
    [darkMode],
  );

  const theme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: darkMode,
          ...(darkMode === "light"
            ? {
                primary: { main: "#0b6bcb" },
                background: { default: "#FDFDFD", paper: "#ffffff" },
              }
            : {
                primary: { main: "#5ba3e0" },
                background: { default: "#000000", paper: "#1a1a1a" },
                text: {
                  primary: "#f0f0f0",
                  secondary: "#c0c0c0",
                  disabled: "#808080",
                },
                divider: "#404040",
              }),
        },
        shape: { borderRadius: 12 },
        components: {
          MuiCard: {
            styleOverrides: {
              root: {
                borderRadius: 16,
                transition: "transform 0.2s ease, box-shadow 0.2s ease",
                ...glassStyles,
                ...depthShadows,
                backgroundImage: "none",
                "&:hover": {
                  transform: "translateY(-4px)",
                  boxShadow:
                    darkMode === "dark"
                      ? "0 30px 60px rgba(0, 0, 0, 0.8), inset 1px 1px 0px 0px rgba(255, 255, 255, 0.25)"
                      : "0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.08)",
                },
              },
            },
          },
          MuiPaper: {
            styleOverrides: {
              root: {
                backgroundImage: "none",
                ...(darkMode === "dark"
                  ? {
                      backgroundColor: "rgba(65, 65, 65, 0.15)",
                      backdropFilter: "blur(12px)",
                      border: "1px solid rgba(255, 255, 255, 0.1)",
                    }
                  : {}),
              },
            },
          },
        },
      }),
    [darkMode, depthShadows, glassStyles],
  );

  // Light-only theme for sign-in page
  const lightTheme = useMemo(
    () =>
      createTheme({
        palette: {
          mode: "light",
          primary: { main: "#0b6bcb" },
          background: { default: "#FDFDFD", paper: "#ffffff" },
        },
        shape: { borderRadius: 12 },
      }),
    [],
  );

  // Persist when range changes
  useEffect(() => {
    if (start && end) {
      try {
        const sIso = dayjs(start).isValid() ? dayjs(start).toISOString() : null;
        const eIso = dayjs(end).isValid() ? dayjs(end).toISOString() : null;
        if (sIso && eIso) {
          localStorage.setItem(
            "pts_date_range_v2",
            JSON.stringify({ start: sIso, end: eIso, savedAt: Date.now() }),
          );
        }
      } catch {
        // Ignore storage write errors
      }
    }
  }, [start, end]);

  useEffect(() => {
    try {
      localStorage.setItem("pts_utm_filters_v1", JSON.stringify(utm));
    } catch {
      // Ignore
    }
  }, [utm]);

  useEffect(() => {
    try {
      localStorage.setItem("pts_discount_filter_v1", JSON.stringify(discountCode || ""));
    } catch {
      // Ignore
    }
  }, [discountCode]);

  useEffect(() => {
    if (!canMultiSelectableKpiCards && selectedMetrics.length > 0) {
      dispatch(
        setTrendMetricSelection({
          selectedMetrics: [],
          activeMetric: activeMetric || DEFAULT_TREND_METRIC,
        }),
      );
    }
  }, [
    activeMetric,
    canMultiSelectableKpiCards,
    dispatch,
    selectedMetrics,
  ]);

  useEffect(() => {
    if (
      selectedMetrics.some((metric) => CI_TREND_METRICS.has(metric)) &&
      !hasPermission("ci_events")
    ) {
      const nextSelection = sanitizeTrendMetricSelection(
        selectedMetrics.filter((metric) => !CI_TREND_METRICS.has(metric)),
        activeMetric,
      );
      dispatch(
        setTrendMetricSelection(
          nextSelection.selectedMetrics.length
            ? nextSelection
            : {
                selectedMetrics: [],
                activeMetric:
                  CI_TREND_METRICS.has(activeMetric)
                    ? DEFAULT_TREND_METRIC
                    : activeMetric || DEFAULT_TREND_METRIC,
              },
        ),
      );
    }
  }, [activeMetric, dispatch, hasPermission, selectedMetrics]);

  useEffect(() => {
    if (
      !hasPermission("web_vitals") &&
      (activeMetric === "performance" ||
        selectedMetrics.includes("performance"))
    ) {
      const nextSelection = sanitizeTrendMetricSelection(
        selectedMetrics.filter((metric) => metric !== "performance"),
        activeMetric === "performance" ? DEFAULT_TREND_METRIC : activeMetric,
      );
      dispatch(
        setTrendMetricSelection(
          nextSelection.selectedMetrics.length
            ? nextSelection
            : {
                selectedMetrics: [],
                activeMetric:
                  activeMetric === "performance"
                    ? DEFAULT_TREND_METRIC
                    : activeMetric || DEFAULT_TREND_METRIC,
              },
        ),
      );
    }
  }, [activeMetric, dispatch, hasPermission, selectedMetrics]);

  useEffect(() => {
    if (
      discountCode &&
      selectedMetrics.some((metric) => !DISCOUNT_ALLOWED_TREND_METRICS.has(metric))
    ) {
      const nextSelection = sanitizeTrendMetricSelection(
        selectedMetrics.filter((metric) =>
          DISCOUNT_ALLOWED_TREND_METRICS.has(metric),
        ),
        activeMetric,
      );
      dispatch(
        setTrendMetricSelection(
          nextSelection.selectedMetrics.length
            ? nextSelection
            : {
                selectedMetrics: [],
                activeMetric:
                  activeMetric &&
                  DISCOUNT_ALLOWED_TREND_METRICS.has(activeMetric)
                    ? activeMetric
                    : DEFAULT_TREND_METRIC,
              },
        ),
      );
    }
  }, [activeMetric, discountCode, dispatch, selectedMetrics]);

  useEffect(() => {
    if (!isAuthor && !hasPermission("discount_filter") && discountCode) {
      dispatch(setDiscountCode(""));
    }
  }, [isAuthor, hasPermission, discountCode, dispatch]);

  // Centralized UTM clearing for > 30 days
  useEffect(() => {
    if (!start || !end) return;
    const isOver30 = isRangeOverDataRestrictionPeriod(
      start,
      end,
      dataRestrictionConfig,
    );
    const hasUtm = Object.values(utm).some((v) =>
      Array.isArray(v) ? v.length > 0 : !!v,
    );

    if (isOver30 && hasUtm) {
      dispatch(
        setUtm({ source: [], medium: [], campaign: [], term: [], content: [] }),
      );
    }
  }, [start, end, utm, dispatch, dataRestrictionConfig]);

  useEffect(() => {
    if (canSyncProductUtmFilters) return;
    if (!hasActiveProductFilter || !hasActiveSourceUtmFilter) return;
    dispatch(
      setUtm({ source: [], medium: [], campaign: [], term: [], content: [] }),
    );
  }, [
    canSyncProductUtmFilters,
    dispatch,
    hasActiveProductFilter,
    hasActiveSourceUtmFilter,
  ]);

  // Fetch UTM Options (Lifted from MobileTopBar)
  // Fetch UTM Options (Lifted from MobileTopBar)
  const lastFetchParams = useMemo(() => {
    return {
      brand: activeBrandKey,
      start: formatDate(start),
      end: formatDate(end),
    };
  }, [
    activeBrandKey,
    start,
    end,
  ]);

  useEffect(() => {
    if (!activeBrandKey) return;
    // UTM filter options are only used by tabs with a filter bar; skip the
    // fetch entirely on brand-agnostic-UI tabs like Web Vitals/Health Monitor.
    if (authorTab === "web-vitals" || authorTab === "health-monitor") return;
    if (isLongRangeDashboard) {
      setUtmOptions({ brand_key: activeBrandKey });
      return;
    }

    getSummaryFilterOptions({
      brand_key: activeBrandKey,
      start: formatDate(start),
      end: formatDate(end),
      product_id: canSyncProductUtmFilters ? selectedProductIds : undefined,
    })
      .then((res) => {
        if (res.filter_options) {
          setUtmOptions({ ...res.filter_options, brand_key: activeBrandKey });
        }
      })
      .catch(() => {});
  }, [
    lastFetchParams,
    activeBrandKey,
    start,
    end,
    isLongRangeDashboard,
    selectedProductIds,
    canSyncProductUtmFilters,
    authorTab,
  ]);

  // Sync funnel data with product table's Curr date when on Funnels tab
  useEffect(() => {
    if (!isAuthor || authorTab !== "product-conversion") return;
    if (!activeBrandKey || !productTableStart || !productTableEnd) return;

    // Fetch funnel data using the product table's current date range
    getDashboardSummary({
      brand_key: activeBrandKey,
      start: productTableStart,
      end: productTableEnd,
      include_utm_options: false,
    })
      .then((res) => {
        if (res.metrics) {
          const m = res.metrics;
          const stats = {
            total_sessions: m.total_sessions?.value ?? 0,
            total_atc_sessions: m.total_atc_sessions?.value ?? 0,
            total_ci_events: m.total_ci_events?.value ?? 0,
            total_orders: m.total_orders?.value ?? 0,
          };
          const deltas = {
            sessions: {
              diff_pct: m.total_sessions?.diff_pct,
              direction: m.total_sessions?.direction,
            },
            atc: {
              diff_pct: m.total_atc_sessions?.diff_pct,
              direction: m.total_atc_sessions?.direction,
            },
            ci: {
              diff_pct: m.total_ci_events?.diff_pct,
              direction: m.total_ci_events?.direction,
            },
            orders: {
              diff_pct: m.total_orders?.diff_pct,
              diff_pp: m.total_orders?.diff_pp,
              direction: m.total_orders?.direction,
            },
          };
          handleFunnelData({ stats, deltas, loading: false });
        }
      })
      .catch(() => {
        // Don't clear funnel data on error — keep previous data
      });
  }, [
    isAuthor,
    authorTab,
    activeBrandKey,
    productTableStart,
    productTableEnd,
    handleFunnelData,
  ]);

  // Check auth on mount
  useEffect(() => {
    // Check for access_token in URL (OAuth callback)
    const params = new URLSearchParams(window.location.search);
    const token = params.get("access_token");
    if (token) {
      window.localStorage.setItem("gateway_access_token", token);
      window.localStorage.removeItem("gateway_refresh_token");
      // Clean URL
      params.delete("access_token");
      const nextSearch = params.toString() ? `?${params.toString()}` : "";
      const nextUrl = `${window.location.pathname}${nextSearch}${window.location.hash}`;
      window.history.replaceState({}, document.title, nextUrl);
    }

    dispatch(fetchCurrentUser());

    // Check for brand parameter to select it automatically (Deep Linking)
    const brandParam = params.get("brand");
    if (brandParam) {
      dispatch(setBrand(brandParam.toUpperCase()));
    }
  }, [dispatch]);

  // Poll the global client-settings flag (data-discrepancy banner) so brand
  // users see it appear/disappear within ~1 minute without a page refresh.
  // Authors/admins never see the banner, so skip polling for them.
  useEffect(() => {
    if (!initialized || !user || user.isAuthor) return undefined;
    dispatch(fetchClientSettings());
    const interval = setInterval(() => {
      dispatch(fetchClientSettings());
    }, 60000);
    return () => clearInterval(interval);
  }, [dispatch, initialized, user]);

  useEffect(() => {
    const handleSessionExpired = () => {
      dispatch(clearAuthState());
      navigate(
        {
          pathname: "/login",
          search: sanitizedSearch,
        },
        { replace: true },
      );
    };
    window.addEventListener("auth:session-expired", handleSessionExpired);
    return () => window.removeEventListener("auth:session-expired", handleSessionExpired);
  }, [dispatch, navigate, sanitizedSearch]);

  // Session Expiry Notification - DISABLED per user request
  // useEffect(() => {
  //   if (!user || !expiresAt) return; // 'expiresAt' needs to be selected from state
  //
  //   const expiryTime = new Date(expiresAt).getTime();
  //   const now = Date.now();
  //   const tenMinutes = 10 * 60 * 1000;
  //   const timeUntilWarning = expiryTime - now - tenMinutes;
  //
  //   if (timeUntilWarning > 0) {
  //     console.log(`[Session] Warning scheduled in ${(timeUntilWarning / 60000).toFixed(1)} minutes`);
  //     const timer = setTimeout(() => {
  //       if (Notification.permission === 'granted') {
  //         new Notification('Session Expiring soon ⏳', {
  //           body: 'Your session will expire in 10 minutes. Please refresh or save your work.',
  //           icon: '/favicon.png'
  //         });
  //       }
  //     }, timeUntilWarning);
  //     return () => clearTimeout(timer);
  //   }
  // }, [user, expiresAt]);

  async function handleLogin(e) {
    e.preventDefault();
    const action = await dispatch(
      loginUser({ email: loginForm.email, password: loginForm.password }),
    );
    if (loginUser.fulfilled.match(action)) {
      setLoginForm({ email: "", password: "" });
    }
  }

  async function handleLogout() {
    // Attempt to unregister FCM token before logging out
    try {
      if (
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      ) {
        const token = await requestForToken();
        if (token) {
          await axios.post(
            "/api/push/unregister-token",
            { token },
            { withCredentials: true },
          );
        }
      }
    } catch (err) {
      console.warn("FCM unregister on logout failed:", err);
    }
    try {
      localStorage.setItem("author_active_tab_v1", "dashboard");
    } catch {
      // Ignore storage write errors
    }
    await dispatch(logoutUser());
    navigate(
      {
        pathname: "/login",
        search: sanitizedSearch,
      },
      { replace: true },
    );
  }

  if (!initialized) return null;

  if (maintenanceMode) {
    return <MaintenanceScreen />;
  }

  if (!user) {
    return (
      <AuthRouteContainer
        lightTheme={lightTheme}
        loginForm={loginForm}
        setLoginForm={setLoginForm}
        loginError={loginError}
        loggingIn={loggingIn}
        handleLogin={handleLogin}
      />
    );
  }

  // Unified layout for both author and viewer roles
  const hasBrand = Boolean((activeBrandKey || "").trim());
  const brandsForSelector = isAuthor
    ? authorBrands
    : viewerBrands.map((key) => ({ key }));
  const showMultipleBrands = isAuthor
    ? authorBrands.length > 0
    : viewerBrands.length > 1;
  const activeRouteContent = (() => {
    switch (authorTab) {
      case "overall-snapshot":
        return (
          <OverallSnapshotRouteContainer
            direction={direction}
            pageVariants={pageVariants}
            isMobile={isMobile}
            normalizedRange={normalizedRange}
            handleRangeChange={handleRangeChange}
            compareMode={compareMode}
            handleCompareModeChange={handleCompareModeChange}
            compareDateRange={compareDateRange}
            handleCompareDateRangeChange={handleCompareDateRangeChange}
            dataRestrictionConfig={dataRestrictionConfig}
            overallSnapshotQuery={overallSnapshotQuery}
            snapshotBrands={snapshotBrands}
            isAuthor={isAuthor}
            authorBrandsLoading={authorBrandsLoading}
            handleOverallSnapshotBrandSelect={handleOverallSnapshotBrandSelect}
          />
        );
      case "dashboard":
        return (
          <DashboardRouteContainer
            initialized={initialized}
            user={user}
            hasBrand={hasBrand}
            isMobile={isMobile}
            isAuthor={isAuthor}
            hasPermission={hasPermission}
            canCustomizeDashboardLayout={canCustomizeDashboardLayout}
            canMultiSelectableKpiCards={canMultiSelectableKpiCards}
            dashboardScopeLabel={dashboardScopeLabel}
            trendMetricsQuery={trendMetricsQuery}
            generalMetricsQuery={generalMetricsQuery}
            overallSnapshotQuery={overallSnapshotQuery}
            selectedMetrics={selectedMetrics}
            activeMetric={activeMetric}
            onSelectMetric={handleSelectMetric}
            onToggleMetric={handleToggleMetric}
            onFunnelData={handleFunnelData}
            selectedProductIds={selectedProductIds}
            selectedProductLabel={selectedProductLabel}
            utmOptions={utmOptions}
            compareMode={compareMode}
            snapshotBrands={snapshotBrands}
            authorBrandsLoading={authorBrandsLoading}
            onOverallSnapshotBrandSelect={handleOverallSnapshotBrandSelect}
            dataRestrictionDescription={dataRestrictionDescription}
            isLongRangeDashboard={isLongRangeDashboard}
            activeBrandKey={activeBrandKey}
            viewerPermissions={viewerPermissions}
            funnelData={funnelData}
            trafficSplitRules={trafficSplitRules}
            onRegisterActions={handleRegisterDashboardActions}
          />
        );
      case "product-conversion":
        return (
          <ProductConversionRouteContainer
            hasBrand={hasBrand}
            darkMode={darkMode}
            funnelData={funnelData}
            hasPermission={hasPermission}
            activeBrandKey={activeBrandKey}
            isAuthor={isAuthor}
            viewerPermissions={viewerPermissions}
          />
        );
      case "daily-funnel":
        return (
          <DailyFunnelRouteContainer
            hasBrand={hasBrand}
            activeBrandKey={activeBrandKey}
            canAccessUtmFunnelTable={canAccessUtmFunnelTable}
            canAccessUtmCampaignGrain={canAccessUtmCampaignGrain}
            canAccessPercentBasisToggle={isAuthor}
          />
        );
      case "inventory":
        return (
          <InventoryRouteContainer
            hasBrand={hasBrand}
            activeBrandKey={activeBrandKey}
            productTableStart={productTableStart}
            productTableEnd={productTableEnd}
          />
        );
      case "web-vitals":
        return (
          <WebVitalsRouteContainer
            hasBrand={hasBrand}
            activeBrandKey={activeBrandKey}
            canViewAllBrandsSnapshot={isAuthor || hasPermission("all")}
          />
        );
      case "session-analytics":
        return (
          <SessionAnalyticsRouteContainer
            activeBrandKey={activeBrandKey}
            isAuthor={isAuthor}
            authorBrands={authorBrands}
            viewerBrands={viewerBrands}
          />
        );
      case "health-monitor":
        return <HealthMonitorRouteContainer />;
      case "bundles":
        return (
          <BundlesRouteContainer
            hasBrand={hasBrand}
            activeBrandKey={activeBrandKey}
            start={start}
            end={end}
          />
        );
      case "requests":
        return (
          <MerchantRequestsRouteContainer
            activeBrandKey={activeBrandKey}
            isAuthor={isAuthor}
            authorBrands={authorBrands}
          />
        );
      case "alerts":
      case "access":
      case "notifications-log":
      case "tenant-setup":
      case "client-settings":
      case "traffic-split-config":
        return (
          <AdminRouteContainer
            tab={authorTab}
            direction={direction}
            pageVariants={pageVariants}
            isMobile={isMobile}
            hasBrand={hasBrand}
            authorBrands={authorBrands}
            authorBrandKey={authorBrandKey}
            darkMode={darkMode}
            trafficSplitRules={trafficSplitRules}
            setTrafficSplitRules={setTrafficSplitRules}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />

      <AppProvider
        i18n={enTranslations}
        theme={{ colorScheme: darkMode === "dark" ? "dark" : "light" }}
      >
        <Box
          sx={{
            display: "flex",
            minHeight: "100svh",
            bgcolor: "background.default",
          }}
        >
          {/* Sidebar Navigation - for authors OR viewers with multiple tabs */}
          {showSidebar && (
            <Sidebar
              open={isMobile ? sidebarOpen : desktopSidebarOpen}
              onClose={
                isMobile
                  ? handleSidebarClose
                  : () => setDesktopSidebarOpen(false)
              }
              activeTab={authorTab}
              onTabChange={handleSidebarTabChange}
              darkMode={darkMode === "dark"}
              user={user}
              onLogout={handleLogout}
              allowedTabs={accessibleTabs}
            />
          )}

          {/* Sidebar Toggle Button - Desktop Only */}
          {showSidebar && !isMobile && (
            <SidebarToggle
              checked={desktopSidebarOpen}
              onChange={setDesktopSidebarOpen}
              isDark={darkMode === "dark"}
              style={{
                position: "fixed",
                top: 24,
                left: desktopSidebarOpen ? DRAWER_WIDTH - 44 : 16,
                zIndex: 1301,
                transition: "left 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
              }}
            />
          )}

          {/* Main content area */}
          <Box
            component="main"
            sx={{
              flexGrow: 1,
              display: "flex",
              flexDirection: "column",
              minHeight: "100svh",
              width: showSidebar
                ? {
                    xs: "100%",
                    md: desktopSidebarOpen
                      ? `calc(100% - ${DRAWER_WIDTH}px)`
                      : "100%",
                  }
                : "100%",
              ml: showSidebar
                ? { xs: 0, md: desktopSidebarOpen ? `${DRAWER_WIDTH}px` : 0 }
                : 0,
              transition: (theme) =>
                theme.transitions.create(["width", "margin"], {
                  easing: theme.transitions.easing.sharp,
                  duration: theme.transitions.duration.enteringScreen,
                }),
            }}
          >
            {/* Sticky Header */}
            <Box
              sx={{
                position: { xs: "sticky", md: "static" },
                top: 0,
                zIndex: (theme) => theme.zIndex.appBar,
                bgcolor: darkMode === "dark" ? "#000000" : "#FDFDFD",
                borderBottom: isScrolled ? { xs: 1, md: 0 } : 0,
                borderColor:
                  darkMode === "dark"
                    ? "rgba(255,255,255,0.1)"
                    : "rgba(0,0,0,0.08)",
                transition: "all 0.3s ease",
                pl:
                  showSidebar && !isMobile && !desktopSidebarOpen ? "56px" : 0,
              }}
            >
              <Header
                user={user}
                onLogout={handleLogout}
                onMenuClick={showSidebar ? handleSidebarOpen : undefined}
                showMenuButton={showSidebar}
                onTabChange={handleSidebarTabChange}
                isAdmin={isAuthor}
                darkMode={darkMode === "dark"}
                onToggleDarkMode={handleToggleDarkMode}
                brandKey={activeBrandKey}
                showFilterButton={
                  showSidebar ||
                  hasPermission("product_filter") ||
                  hasPermission("utm_filter") ||
                  hasPermission("discount_filter") ||
                  hasPermission("sales_channel_filter") ||
                  hasPermission("device_type_filter") ||
                  showMultipleBrands
                }
                showCustomizeButton={
                  isMobile &&
                  authorTab === "dashboard" &&
                  hasBrand &&
                  canCustomizeDashboardLayout
                }
                onFilterClick={() => setMobileFilterOpen(true)}
                onCustomizeLayoutClick={handleOpenDashboardLayoutEditor}
              />
            </Box>

              {/* Non-Sticky Sub-Header (MobileTopBar etc) */}
              <Box
                sx={{
                  bgcolor: darkMode === "dark" ? "#000000" : "#FDFDFD",
                  pb: 0,
                }}
              >
              <Box
                sx={{
                  px: { xs: 1.5, sm: 2.5, md: 4 },
                  pt: 0,
                  maxWidth: 1200,
                  mx: "auto",
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: { xs: "column", md: "row" },
                    alignItems: "center",
                    justifyContent: { xs: "space-between", md: "flex-end" },
                    width: "100%",
                    gap: 1,
                  }}
                >
                  {/* Unified Filter Bar - Desktop Only (Dashboard Tab) */}
                  {!isMobile && authorTab === "overall-snapshot" && (
                    <Box sx={{ mb: { xs: 1, md: 0 } }}>
                      <UnifiedFilterBar
                        range={normalizedRange}
                        onRangeChange={handleRangeChange}
                        brandKey=""
                        brands={[]}
                        onBrandChange={() => {}}
                        isAuthor={false}
                        compareMode={compareMode}
                        onCompareModeChange={handleCompareModeChange}
                        compareDateRange={compareDateRange}
                        onCompareDateRangeChange={handleCompareDateRangeChange}
                        dataRestrictionConfig={dataRestrictionConfig}
                        hideAllExceptDate
                      />
                    </Box>
                  )}

                  {!isMobile && authorTab === "dashboard" && hasBrand && (
                    <Box sx={{ mb: { xs: 1, md: 0 } }}>

                      <UnifiedFilterBar
                        range={normalizedRange}
                        onRangeChange={handleRangeChange}
                        brandKey={activeBrandKey}
                        brands={brandsForSelector}
                        hideAllExceptDate={false}
                        onBrandChange={

                          isAuthor
                            ? handleAuthorBrandChange
                            : (val) =>
                                dispatch(
                                  setBrand(
                                    (val || "").toString().trim().toUpperCase(),
                                  ),
                                )
                        }
                        isAuthor={isAuthor}
                        // Compare Mode Props
                        compareMode={compareMode}
                        onCompareModeChange={handleCompareModeChange}
                        compareDateRange={compareDateRange}
                        onCompareDateRangeChange={handleCompareDateRangeChange}
                        // Filter Props
                        productOptions={productOptions}
                        productValue={productSelection}
                        onProductChange={handleProductChange}
                        productDisabled={productFilterDisabled}
                        productLoading={productOptionsLoading}
                        utm={utm}
                        onUtmChange={handleUtmChange}
                        utmDisabled={utmFilterDisabled}
                        disableUtmMediumCampaign={utmMediumCampaignDisabled}
                        allowProductUtmSync={canSyncProductUtmFilters}
                        salesChannel={salesChannel}
                        onSalesChannelChange={handleSalesChannelChange}
                        salesChannelDisabled={salesChannelDisabled}
                        deviceType={deviceType}
                        onDeviceTypeChange={handleDeviceTypeChange}
                        deviceTypeDisabled={deviceTypeDisabled}
                        city={city}
                        onCityChange={handleCityChange}
                        cityDisabled={cityDisabled}
                        discountCode={discountCode}
                        onDiscountCodeChange={handleDiscountCodeChange}
                        discountDisabled={discountDisabled}
                        productType={productType}
                        onProductTypeChange={handleProductTypeChange}
                        productTypeDisabled={productTypeDisabled}
                        allowedFilters={{
                          product: hasPermission("product_filter"),
                          utm: hasPermission("utm_filter"),
                          salesChannel: hasPermission("sales_channel_filter"),
                          deviceType: hasPermission("device_type_filter"),
                          city: hasPermission("city_filter"),
                          discount: hasPermission("discount_filter"),
                          productType: hasPermission("product_type_filter"),
                        }}
                        utmOptions={utmOptions}
                        dataRestrictionConfig={dataRestrictionConfig}
                        onDownload={handleDashboardDownloadSnapshot}
                        children={
                          canCustomizeDashboardLayout ? (
                            <Tooltip title="Customize Layout">
                              <IconButton
                                size="small"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  handleOpenDashboardLayoutEditor();
                                }}
                                sx={{
                                  width: 32,
                                  height: 32,
                                  borderRadius: "10px",
                                  color: "text.secondary",
                                }}
                              >
                                <LayoutPanelsIcon size={16} />
                              </IconButton>
                            </Tooltip>
                          ) : null
                        }
                      />
                    </Box>
                  )}

                  {!isMobile &&
                    authorTab !== "dashboard" &&
                    authorTab !== "overall-snapshot" &&
                    authorTab !== "session-analytics" &&
                    authorTab !== "alerts" &&
                    authorTab !== "access" &&
                    authorTab !== "notifications-log" &&
                    authorTab !== "tenant-setup" &&
                    authorTab !== "requests" &&
                    authorTab !== "web-vitals" &&
                    (isAuthor || showMultipleBrands) && (
                      <Box sx={{ mb: 1 }}>
                        <AuthorBrandSelector
                          brands={
                            isAuthor
                              ? authorBrands
                              : viewerBrands.map((key) => ({ key }))
                          }
                          value={activeBrandKey}
                          loading={isAuthor ? authorBrandsLoading : false}
                          onChange={
                            isAuthor
                              ? handleAuthorBrandChange
                              : (val) =>
                                  dispatch(
                                    setBrand(
                                      (val || "")
                                        .toString()
                                        .trim()
                                        .toUpperCase(),
                                    ),
                                  )
                          }
                        />
                      </Box>
                    )}

                  {/* Mobile Components (Keep existing MobileTopBar for mobile view) */}
                  {isMobile && authorTab === "dashboard" && hasBrand && (
                    <MobileTopBar
                      value={normalizedRange}
                      onChange={handleRangeChange}
                      brandKey={activeBrandKey}
                      dataRestrictionConfig={dataRestrictionConfig}
                      compareMode={compareMode}
                      onCompareModeChange={handleCompareModeChange}
                      compareDateRange={compareDateRange}
                      onCompareDateRangeChange={handleCompareDateRangeChange}
                      showProductFilter={hasPermission("product_filter")}
                      productOptions={productOptions}
                      productValue={productSelection}
                      onProductChange={handleProductChange}
                      productDisabled={productFilterDisabled}
                      productLoading={productOptionsLoading}
                      utm={utm}
                      onUtmChange={handleUtmChange}
                      utmDisabled={utmFilterDisabled}
                      disableUtmMediumCampaign={utmMediumCampaignDisabled}
                      allowProductUtmSync={canSyncProductUtmFilters}
                      salesChannel={salesChannel}
                      onSalesChannelChange={handleSalesChannelChange}
                      salesChannelDisabled={salesChannelDisabled}
                      deviceType={deviceType}
                      onDeviceTypeChange={handleDeviceTypeChange}
                        deviceTypeDisabled={deviceTypeDisabled}
                      city={city}
                      onCityChange={handleCityChange}
                        cityDisabled={cityDisabled}
                      discountCode={discountCode}
                      onDiscountCodeChange={handleDiscountCodeChange}
                        discountDisabled={discountDisabled}
                      showUtmFilter={hasPermission("utm_filter")}
                      showSalesChannel={hasPermission("sales_channel_filter")}
                      showCityFilter={hasPermission("city_filter")}
                      showDiscountFilter={hasPermission("discount_filter")}
                      utmOptions={utmOptions}
                      isAuthor={isAuthor}
                    />
                  )}
                </Box>
                <MobileFilterDrawer
                  showBrandFilter={showMultipleBrands}
                  showProductFilter={hasPermission("product_filter")}
                  showUtmFilter={hasPermission("utm_filter")}
                  showSalesChannel={hasPermission("sales_channel_filter")}
                  showCityFilter={hasPermission("city_filter")}
                  showDeviceType={hasPermission("device_type_filter")}
                  open={mobileFilterOpen}
                  onClose={() => setMobileFilterOpen(false)}
                  brandKey={activeBrandKey}
                  brands={
                    isAuthor
                      ? authorBrands
                      : viewerBrands.map((b) => ({ key: b }))
                  }
                  onBrandChange={handleAuthorBrandChange}
                  productOptions={productOptions}
                  productValue={productSelection}
                  onProductChange={handleProductChange}
                  productDisabled={productFilterDisabled}
                  utm={utm}
                  onUtmChange={handleUtmChange}
                  utmDisabled={utmFilterDisabled}
                  disableUtmMediumCampaign={utmMediumCampaignDisabled}
                  allowProductUtmSync={canSyncProductUtmFilters}
                  salesChannel={salesChannel}
                  onSalesChannelChange={handleSalesChannelChange}
                  salesChannelDisabled={salesChannelDisabled}
                  deviceType={deviceType}
                  onDeviceTypeChange={handleDeviceTypeChange}
                        deviceTypeDisabled={deviceTypeDisabled}
                  city={city}
                  onCityChange={handleCityChange}
                        cityDisabled={cityDisabled}
                  discountCode={discountCode}
                  onDiscountCodeChange={handleDiscountCodeChange}
                        discountDisabled={discountDisabled}
                  showDiscountFilter={hasPermission("discount_filter")}
                  divisionProductType={productType}
                  onDivisionProductTypeChange={handleProductTypeChange}
                  divisionProductTypeDisabled={productTypeDisabled}
                  showDivisionProductType={hasPermission("product_type_filter")}
                  utmOptions={utmOptions}
                  dateRange={normalizedRange}
                  dataRestrictionConfig={dataRestrictionConfig}
                  isDark={darkMode === "dark"}
                />
              </Box>
              </Box>

              {authorTab === "dashboard" &&
                hasBrand &&
                singleDayInsightDate &&
                (isAuthor || hasPermission("daily_insight_view")) && (
                <Box
                  sx={{
                    width: "100%",
                    maxWidth: 1200,
                    mx: "auto",
                    px: { xs: 1.5, sm: 2.5, md: 4 },
                    pt: { xs: 1, md: 1.5 },
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                  }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <DailyInsightBar
                      brandKey={activeBrandKey}
                      date={singleDayInsightDate}
                      refreshToken={dailyInsightRefreshToken}
                    />
                  </Box>
                  {/* Editing is strictly author/admin only — no permission scope
                      can grant a brand_user edit access. */}
                  {isAuthor && (
                    <DailyInsightsEditor
                      key={singleDayInsightDate}
                      brandKey={activeBrandKey}
                      initialDate={singleDayInsightDate}
                      onSaved={() => setDailyInsightRefreshToken((t) => t + 1)}
                    />
                  )}
                </Box>
              )}

              {authorTab === "dashboard" &&
                !isAuthor &&
                dashboardBannerEnabled && (
                <Box
                  sx={{
                    width: "100%",
                    maxWidth: 1200,
                    mx: "auto",
                    px: { xs: 1.5, sm: 2.5, md: 4 },
                    pt: { xs: 1, md: 1.5 },
                  }}
                >
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{
                      px: 1.5,
                      py: 0.75,
                      borderRadius: "10px",
                      border: "1px solid",
                      borderColor: darkMode === "dark"
                        ? "rgba(255,171,64,0.4)"
                        : "rgba(237,108,2,0.35)",
                      bgcolor: darkMode === "dark"
                        ? "rgba(255,171,64,0.08)"
                        : "rgba(237,108,2,0.06)",
                    }}
                  >
                    <WarningAmberIcon
                      fontSize="small"
                      sx={{ color: "warning.main", flexShrink: 0 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Datum is facing some issues, data may have some discrepancies.
                    </Typography>
                  </Stack>
                </Box>
              )}

              {authorTab === "dashboard" &&
                hasBrand &&
                hasActiveProductTypeFilter && (
                <Box
                  sx={{
                    width: "100%",
                    maxWidth: 1200,
                    mx: "auto",
                    px: { xs: 1.5, sm: 2.5, md: 4 },
                    pt: { xs: 1, md: 1.5 },
                  }}
                >
                  <Stack
                    direction="row"
                    alignItems="center"
                    spacing={1}
                    sx={{
                      px: 1.5,
                      py: 0.75,
                      borderRadius: "10px",
                      border: "1px solid",
                      borderColor: darkMode === "dark"
                        ? "rgba(255,255,255,0.12)"
                        : "rgba(0,0,0,0.1)",
                      bgcolor: darkMode === "dark"
                        ? "rgba(255,255,255,0.04)"
                        : "rgba(0,0,0,0.03)",
                    }}
                  >
                    <InfoOutlinedIcon
                      fontSize="small"
                      sx={{ color: "text.secondary", flexShrink: 0 }}
                    />
                    <Typography variant="caption" color="text.secondary">
                      Product Type filter is active — data shown is full-day
                      only, not hourly-grained.
                    </Typography>
                  </Stack>
                </Box>
              )}

              <Box
                sx={{
                  flex: 1,
                  width: "100%",
                  maxWidth: 1200,
                  mx: "auto",
                  px: { xs: 1.5, sm: 2.5, md: 4 },
                  py: { xs: 1, md: 2 },
                  pb: { xs: 11, md: 2 }, // Extra space for mobile bottom sheet nav
                  overflowX: "hidden",
                  overflowY: authorTab === "overall-snapshot" ? "visible" : "hidden",
                  position: "relative",
                }}
              >
              <Stack spacing={{ xs: 1, md: 2 }} sx={{ position: "relative" }}>
                <AnimatePresence mode="wait" custom={direction} initial={false}>
                  <MotionDiv
                    key={authorTab}
                    custom={direction}
                    variants={pageVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    style={{ width: "100%" }}
                  >
                    {activeRouteContent}
                  </MotionDiv>
                </AnimatePresence>
              </Stack>
              </Box>
              <Suspense fallback={null}>
                <Footer />
              </Suspense>
          </Box>
        </Box>
      </AppProvider>
    </ThemeProvider>
  );
}
