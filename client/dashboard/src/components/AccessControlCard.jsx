import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  Stack,
  Typography,
  Alert,
  Button,
  Autocomplete,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  IconButton,
  Tooltip,
  Box,
  CircularProgress,
  useTheme,
  useMediaQuery,
  Switch,
  Paper,
  Divider,
} from "@mui/material";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import PersonOutlineIcon from "@mui/icons-material/PersonOutline";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import DomainIcon from "@mui/icons-material/Domain";
import FilterListIcon from "@mui/icons-material/FilterList";
import DownloadIcon from "@mui/icons-material/Download";
import {
  adminListUsers,
  adminUpsertUser,
  adminDeleteUser,
  listAuthorBrands,
  listDomainRules,
  upsertDomainRule,
  deleteDomainRule,
  listCustomRoles,
  createCustomRole,
  updateCustomRole,
  deleteCustomRole,
} from "../lib/api";

const GlassChip = ({ label, size = "small", isDark }) => (
  <Chip
    label={label}
    size={size}
    sx={{
      bgcolor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
      color: isDark ? "rgba(255, 255, 255, 0.8)" : "rgba(0, 0, 0, 0.8)",
      borderRadius: "8px",
      fontWeight: 600,
      fontSize: "0.7rem",
      border: "1px solid",
      borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)",
      height: 24,
      "& .MuiChip-label": { px: 1 },
    }}
  />
);

const PERMISSION_OPTIONS = [
  "all",
  "overall_snapshot",
  "requests_panel",
  "requests_timeline",
  "bundles_panel",
  "inventory_panel",
  "daily_funnel_panel",
  "intent_funnel_panel",
  "utm_funnel_table",
  "utm_funnel_table:utm_campaign_grain",
  "product_filter",
  "utm_filter",
  "product_utm_filter_sync",
  "discount_filter",
  "intent_metrics",
  "ci_events",
  "rto_kpi",
  "web_vitals",
  "payment_split_order",
  "payment_split_sales",
  "traffic_split",
  "dashboard_layout_customize",
  "session_analytics",
  "sales_channel_filter",
  "device_type_filter",
  "product_type_filter",
  "city_filter",
  "sessions_drop_off_funnel",
  "product_conversion",
  "compare_mode",
  "multiselectable_kpi_cards",
  "product_conversion:landing_page_path",
  "product_conversion:sessions",
  "product_conversion:atc",
  "product_conversion:atc_rate",
  "product_conversion:orders",
  "product_conversion:sales",
  "product_conversion:cvr",
  "product_conversion:drr",
  "product_conversion:doh",
  "product_table_filters",
  "product_table_filters:inventory",
  "product_table_filters:page_type",
  "product_table_filters:product_types",
  "product_table_filters:sort_filter",
  "daily_insight_view",
  "health_monitor_panel",
  "web_vitals_panel",
];

const COLUMN_PERMISSIONS = [
  { id: "product_conversion:landing_page_path", label: "Landing Page" },
  { id: "product_conversion:sessions", label: "Sessions" },
  { id: "product_conversion:atc", label: "ATC" },
  { id: "product_conversion:atc_rate", label: "ATC Rate" },
  { id: "product_conversion:orders", label: "Orders" },
  { id: "product_conversion:sales", label: "Sales" },
  { id: "product_conversion:cvr", label: "CVR" },
  { id: "product_conversion:drr", label: "DRR" },
  { id: "product_conversion:doh", label: "DOH" },
];

const FILTER_PANEL_PERMISSIONS = [
  { id: "product_table_filters:inventory", label: "Inventory Analysis" },
  { id: "product_table_filters:page_type", label: "Page Type" },
  { id: "product_table_filters:product_types", label: "Product Types" },
  { id: "product_table_filters:sort_filter", label: "Sort Filter" },
];

// UI-only grouping for the Custom Role permission picker — organizational
// metadata only, does not change what any permission string means anywhere
// else in the app.
const PERMISSION_CATEGORIES = [
  {
    label: "Dashboard",
    permissions: [
      "overall_snapshot",
      "requests_panel",
      "requests_timeline",
      "bundles_panel",
      "inventory_panel",
      "daily_funnel_panel",
      "intent_funnel_panel",
      "dashboard_layout_customize",
      "session_analytics",
      "sessions_drop_off_funnel",
      "intent_metrics",
      "rto_kpi",
      "web_vitals",
      "health_monitor_panel",
      "web_vitals_panel",
      "daily_insight_view",
      "compare_mode",
      "multiselectable_kpi_cards",
      "product_conversion",
    ],
  },
  {
    label: "Filters",
    permissions: [
      "product_filter",
      "utm_filter",
      "product_utm_filter_sync",
      "discount_filter",
      "sales_channel_filter",
      "device_type_filter",
      "product_type_filter",
      "city_filter",
      "utm_funnel_table",
      "utm_funnel_table:utm_campaign_grain",
    ],
  },
  {
    label: "Payment",
    permissions: ["payment_split_order", "payment_split_sales"],
  },
  {
    label: "Traffic & Events",
    permissions: ["traffic_split", "ci_events"],
  },
  {
    label: "Product Table Columns",
    permissions: COLUMN_PERMISSIONS.map((p) => p.id),
  },
  {
    label: "Product Table Filters",
    permissions: FILTER_PANEL_PERMISSIONS.map((p) => p.id),
  },
  {
    label: "Other",
    permissions: ["all"],
  },
];

const ROLE_OPTIONS = [
  { value: "author", label: "Author" },
  { value: "viewer", label: "Viewer" },
  { value: "super_admin", label: "Super Admin" },
  { value: "brand_user", label: "Brand User" },
];

function isValidEmailAddress(value) {
  const normalized = (value || "").toString().trim().toLowerCase();
  if (!normalized || normalized.length > 254) return false;
  if (normalized.includes("..")) return false;

  const parts = normalized.split("@");
  if (parts.length !== 2) return false;

  const [localPart, domainPart] = parts;
  if (!localPart || !domainPart) return false;
  if (localPart.startsWith(".") || localPart.endsWith(".")) return false;
  if (domainPart.startsWith(".") || domainPart.endsWith(".")) return false;
  if (!domainPart.includes(".")) return false;

  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(normalized);
}

function getRoleLabel(role) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label || role;
}

function isElevatedRole(role) {
  return role === "author" || role === "super_admin" || role === "admin";
}

function normalizeBrandValue(value) {
  return (value || "").toString().trim().toUpperCase();
}

function summarizePermissions(role, permissions = []) {
  if (isElevatedRole(role) || permissions[0] === "all") {
    return "Full Access";
  }
  return `${permissions.length || 0} Permissions`;
}

function getRoleTone(role) {
  if (role === "super_admin" || role === "admin") {
    return { color: "#8b5cf6", icon: <ShieldOutlinedIcon sx={{ fontSize: 16, color: "#8b5cf6" }} /> };
  }
  if (role === "author") {
    return { color: "#3b82f6", icon: <ShieldOutlinedIcon sx={{ fontSize: 16, color: "#3b82f6" }} /> };
  }
  if (role === "brand_user") {
    return { color: "#10b981", icon: <PersonOutlineIcon sx={{ fontSize: 16, color: "#10b981" }} /> };
  }
  return { color: "#f59e0b", icon: <VisibilityOutlinedIcon sx={{ fontSize: 16, color: "#f59e0b" }} /> };
}

function normalizePermissionSelection(permissions = []) {
  let next = Array.from(new Set(permissions));
  if (next.includes("requests_timeline") && !next.includes("requests_panel")) {
    next.push("requests_panel");
  }
  if (!next.includes("requests_panel")) {
    next = next.filter((permission) => permission !== "requests_timeline");
  }
  return next;
}

function escapeCsvValue(value) {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function serializePermissionsPayload(source = {}) {
  return JSON.stringify({
    permissions: normalizePermissionSelection(source.permissions || ["all"]),
  });
}

function parsePermissionsPayload(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.permissions)) {
    throw new Error("Invalid permissions payload");
  }
  return normalizePermissionSelection(parsed.permissions);
}

const StatusSwitch = ({ active, onChange, label = "Active", isDark }) => (
  <Stack direction="row" spacing={1} alignItems="center">
    <Typography
      variant="caption"
      sx={{
        color: active
          ? isDark
            ? "#34d399"
            : "#059669"
          : isDark
            ? "#9ca3af"
            : "#6b7280",
        fontWeight: 600,
        opacity: active ? 1 : 0.6,
      }}
    >
      {active ? label : "Inactive"}
    </Typography>
    <Switch
      size="small"
      checked={active}
      onChange={onChange}
      sx={{
        width: 32,
        height: 18,
        padding: 0,
        display: "flex",
        "& .MuiSwitch-switchBase": {
          padding: "2px",
          "&.Mui-checked": {
            transform: "translateX(14px)",
            color: "#fff",
            "& + .MuiSwitch-track": {
              opacity: 1,
              backgroundColor: "#10b981",
            },
          },
        },
        "& .MuiSwitch-thumb": {
          width: 14,
          height: 14,
          boxShadow: "none",
        },
        "& .MuiSwitch-track": {
          borderRadius: 9,
          opacity: 1,
          backgroundColor: isDark ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.1)",
          boxSizing: "border-box",
        },
      }}
    />
  </Stack>
);

// Small reusable confirmation dialog, styled to match this file's existing
// Add/Edit dialogs exactly (same Dialog/DialogTitle/DialogContent/DialogActions
// shapes and button colors) — there's no prior ConfirmDialog precedent in the
// codebase (only native window.confirm), but the mode-switch/role-update
// flows need distinctly-labeled buttons a native confirm can't provide.
const ConfirmDialog = ({ open, title, description, confirmLabel = "Confirm", onConfirm, onCancel, isDark }) => (
  <Dialog
    open={open}
    onClose={onCancel}
    fullWidth
    maxWidth="xs"
    PaperProps={{ sx: { borderRadius: "20px", bgcolor: isDark ? "#1a1a1a" : "#fff" } }}
  >
    <DialogTitle sx={{ fontWeight: 700 }}>{title}</DialogTitle>
    <DialogContent>
      <Typography variant="body2" color="text.secondary">
        {description}
      </Typography>
    </DialogContent>
    <DialogActions sx={{ px: 3, pb: 2.5 }}>
      <Button onClick={onCancel}>Cancel</Button>
      <Button onClick={onConfirm} variant="contained" sx={{ bgcolor: "#10b981", "&:hover": { bgcolor: "#059669" } }}>
        {confirmLabel}
      </Button>
    </DialogActions>
  </Dialog>
);

const UserMobileCard = ({ user, onEdit, onDelete, onStatusToggle, isDark, roles = [] }) => (
  <Box
    sx={{
      p: 2,
      mb: 2,
      borderRadius: "16px",
      bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
      border: "1px solid",
      borderColor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
    }}
  >
    <Stack spacing={2}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="flex-start"
      >
        <Stack spacing={0.5}>
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 700, wordBreak: "break-all" }}
          >
            {user.email}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {getRoleTone(user.role).icon}
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                color: getRoleTone(user.role).color,
              }}
            >
              {getRoleLabel(user.role)}
            </Typography>
          </Stack>
        </Stack>
        <StatusSwitch
          active={user.status === "active"}
          onChange={() => onStatusToggle(user.email, user.status)}
          isDark={isDark}
        />
      </Stack>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 2,
          py: 1.5,
          borderTop: "1px solid",
          borderBottom: "1px solid",
          borderColor: isDark
            ? "rgba(255, 255, 255, 0.05)"
            : "rgba(0, 0, 0, 0.05)",
        }}
      >
        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ opacity: 0.5, fontWeight: 600 }}>
            Primary Brand
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {user.primary_brand_id || (isElevatedRole(user.role) ? "AUTO" : "N/A")}
          </Typography>
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ opacity: 0.5, fontWeight: 600 }}>
            All Brands
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {user.brand_memberships?.length > 0 ? (
              user.brand_memberships.map((m) => (
                <GlassChip
                  key={m.brand_id}
                  label={m.brand_id}
                  size="small"
                  isDark={isDark}
                />
              ))
            ) : (
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {isElevatedRole(user.role) ? "All Brands" : "N/A"}
              </Typography>
            )}
          </Box>
        </Stack>
        <Stack spacing={0.5} sx={{ gridColumn: "span 2" }}>
          <Typography variant="caption" sx={{ opacity: 0.5, fontWeight: 600 }}>
            Permissions
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {user.custom_role_id ? (
              <GlassChip
                label={`Role: ${roles.find((r) => r._id === user.custom_role_id)?.name || "Unknown role"}`}
                size="small"
                isDark={isDark}
              />
            ) : user.brand_memberships?.[0]?.permissions?.length > 0 ? (
              user.brand_memberships[0].permissions.map((p) => (
                <GlassChip key={p} label={p} size="small" isDark={isDark} />
              ))
            ) : (
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {summarizePermissions(user.role, user.brand_memberships?.[0]?.permissions || [])}
              </Typography>
            )}
          </Box>
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <IconButton
          size="small"
          onClick={() => onEdit(user)}
          sx={{
            bgcolor: isDark
              ? "rgba(255, 255, 255, 0.05)"
              : "rgba(0, 0, 0, 0.03)",
          }}
        >
          <EditIcon sx={{ fontSize: 18, color: "#3b82f6" }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={() => onDelete(user.email)}
          sx={{
            bgcolor: isDark
              ? "rgba(255, 255, 255, 0.05)"
              : "rgba(0, 0, 0, 0.03)",
          }}
        >
          <DeleteIcon sx={{ fontSize: 18, color: "#ef4444" }} />
        </IconButton>
      </Stack>
    </Stack>
  </Box>
);

const DomainMobileCard = ({ rule, onEdit, onDelete, isDark }) => (
  <Box
    sx={{
      p: 2,
      mb: 2,
      borderRadius: "16px",
      bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
      border: "1px solid",
      borderColor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
    }}
  >
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Stack spacing={0.5}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {rule.domain}
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {getRoleTone(rule.role).icon}
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                color: getRoleTone(rule.role).color,
              }}
            >
              {getRoleLabel(rule.role)}
            </Typography>
          </Stack>
        </Stack>
        <Chip
          size="small"
          label={rule.status}
          sx={{
            textTransform: "capitalize",
            fontWeight: 700,
            fontSize: "0.65rem",
            bgcolor:
              rule.status === "active"
                ? "rgba(16, 185, 129, 0.1)"
                : "rgba(239, 68, 68, 0.1)",
            color: rule.status === "active" ? "#10b981" : "#ef4444",
            border: "1px solid",
            borderColor:
              rule.status === "active"
                ? "rgba(16, 185, 129, 0.2)"
                : "rgba(239, 68, 68, 0.2)",
          }}
        />
      </Stack>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 2,
          py: 1.5,
          borderTop: "1px solid",
          borderBottom: "1px solid",
          borderColor: isDark
            ? "rgba(255, 255, 255, 0.05)"
            : "rgba(0, 0, 0, 0.05)",
        }}
      >
        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ opacity: 0.5, fontWeight: 600 }}>
            Primary Brand
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {rule.primary_brand_id || (isElevatedRole(rule.role) ? "AUTO" : "N/A")}
          </Typography>
        </Stack>
        <Stack spacing={0.5}>
          <Typography variant="caption" sx={{ opacity: 0.5, fontWeight: 600 }}>
            All Brands
          </Typography>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
            {rule.brand_ids?.length > 0 ? (
              rule.brand_ids.map((b) => (
                <GlassChip key={b} label={b} size="small" isDark={isDark} />
              ))
            ) : (
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {isElevatedRole(rule.role) ? "All Brands" : "N/A"}
              </Typography>
            )}
          </Box>
        </Stack>
        <Stack spacing={0.5} sx={{ gridColumn: "span 2" }}>
          <Typography variant="caption" sx={{ opacity: 0.5, fontWeight: 600 }}>
            Permissions
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {summarizePermissions(rule.role, rule.permissions || [])}
          </Typography>
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <IconButton
          size="small"
          onClick={() => onEdit(rule)}
          sx={{
            bgcolor: isDark
              ? "rgba(255, 255, 255, 0.05)"
              : "rgba(0, 0, 0, 0.03)",
          }}
        >
          <EditIcon sx={{ fontSize: 18, color: "#3b82f6" }} />
        </IconButton>
        <IconButton
          size="small"
          onClick={() => onDelete(rule.domain)}
          sx={{
            bgcolor: isDark
              ? "rgba(255, 255, 255, 0.05)"
              : "rgba(0, 0, 0, 0.03)",
          }}
        >
          <DeleteIcon sx={{ fontSize: 18, color: "#ef4444" }} />
        </IconButton>
      </Stack>
    </Stack>
  </Box>
);

const emptyForm = {
  name: "",
  email: "",
  role: "viewer",
  brand_ids: [],
  primary_brand_id: "",
  status: "active",
  permissions: ["all"],
  permission_mode: "manual",
  custom_role_id: "",
};

const emptyRoleForm = {
  name: "",
  description: "",
  permissions: [],
};

export default function AccessControlCard() {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userFormError, setUserFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [isEdit, setIsEdit] = useState(false);
  const [filterRole, setFilterRole] = useState("all");
  const [filterBrand, setFilterBrand] = useState("all");
  const [emailSearch, setEmailSearch] = useState("");
  const [knownBrands, setKnownBrands] = useState([]);
  const [domainRules, setDomainRules] = useState([]);
  const [domainDialogOpen, setDomainDialogOpen] = useState(false);
  const [isEditingDomainRule, setIsEditingDomainRule] = useState(false);
  const [domainForm, setDomainForm] = useState({
    domain: "",
    role: "viewer",
    brand_ids: [],
    primary_brand_id: "",
    permissions: ["all"],
    status: "active",
  });
  const [domainSaving, setDomainSaving] = useState(false);
  const userDialogRef = useRef(null);
  const domainDialogRef = useRef(null);

  // ---- Custom Roles state ----
  const [roles, setRoles] = useState([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [rolesError, setRolesError] = useState(null);
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [isEditingRole, setIsEditingRole] = useState(false);
  const [roleForm, setRoleForm] = useState(emptyRoleForm);
  const [editingRoleId, setEditingRoleId] = useState(null);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleFormError, setRoleFormError] = useState(null);
  const [roleDeleteBlockedMessage, setRoleDeleteBlockedMessage] = useState(null);
  // Generic confirm-dialog state, reused for: assign-role, switch-to-manual,
  // update-in-use-role, and delete-unused-role.
  const [confirmDialog, setConfirmDialog] = useState(null); // { title, description, confirmLabel, onConfirm }

  const availableBrands = useMemo(() => {
    const set = new Set(knownBrands);
    users.forEach((u) => {
      (u.brand_memberships || []).forEach((b) => {
        if (b.brand_id) set.add(b.brand_id.toUpperCase());
      });
    });
    return Array.from(set);
  }, [users, knownBrands]);

  const filterableBrands = useMemo(() => {
    const set = new Set();
    users.forEach((u) => {
      if (u.primary_brand_id) {
        set.add(normalizeBrandValue(u.primary_brand_id));
      }
      (u.brand_memberships || []).forEach((b) => {
        if (b.brand_id) {
          set.add(normalizeBrandValue(b.brand_id));
        }
      });
    });
    return Array.from(set).filter(Boolean).sort();
  }, [users]);

  async function loadUsers() {
    setLoading(true);
    const r = await adminListUsers();
    if (r.error) setError(r.data?.error || "Failed to load users");
    else {
      setUsers(r.data?.users || []);
      setError(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadDomainRules() {
    const r = await listDomainRules();
    if (!r.error) {
      setDomainRules(r.data?.rules || []);
    }
  }

  useEffect(() => {
    loadDomainRules();
  }, []);

  async function loadRoles() {
    setRolesLoading(true);
    const r = await listCustomRoles();
    if (r.error) setRolesError(r.data?.error || "Failed to load custom roles");
    else {
      setRoles(r.data?.roles || []);
      setRolesError(null);
    }
    setRolesLoading(false);
  }

  useEffect(() => {
    loadRoles();
  }, []);

  useEffect(() => {
    (async () => {
      const r = await listAuthorBrands();
      if (r.error) {
        console.warn("Failed to load brands", r);
        return;
      }
      const raw = r.data ?? r;
      const source = Array.isArray(raw?.brands)
        ? raw.brands
        : Array.isArray(raw)
          ? raw
          : [];
      const brands = source
        .map((b) =>
          (b.key || b.brand_id || b.name || b.toString()).toUpperCase(),
        )
        .filter(Boolean);
      setKnownBrands(brands);
    })();
  }, []);

  const filteredUsers = useMemo(() => {
    const normalizedSearch = emailSearch.trim().toLowerCase();
    const normalizedBrandFilter = normalizeBrandValue(filterBrand);

    return users.filter((u) => {
      const matchesRole = filterRole === "all" ? true : u.role === filterRole;
      const matchesEmail = normalizedSearch
        ? String(u.email || "").toLowerCase().includes(normalizedSearch)
        : true;
      const userBrands = new Set(
        [
          u.primary_brand_id,
          ...(u.brand_memberships || []).map((membership) => membership.brand_id),
        ]
          .map((brandId) => normalizeBrandValue(brandId))
          .filter(Boolean),
      );
      const matchesBrand =
        normalizedBrandFilter === "ALL"
          ? true
          : userBrands.has(normalizedBrandFilter);

      return matchesRole && matchesEmail && matchesBrand;
    });
  }, [users, filterRole, filterBrand, emailSearch]);

  async function writePermissionsToClipboard(source) {
    await navigator.clipboard.writeText(serializePermissionsPayload(source));
  }

  async function readPermissionsFromClipboard() {
    const raw = await navigator.clipboard.readText();
    return parsePermissionsPayload(raw);
  }

  function shouldInterceptPermissionShortcut(event, container) {
    if (!container || !container.contains(event.target)) return false;
    const tagName = event.target?.tagName;
    if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
      return false;
    }
    if (window.getSelection?.()?.toString()) {
      return false;
    }
    return (event.ctrlKey || event.metaKey) && !event.altKey;
  }

  useEffect(() => {
    if (!dialogOpen) return undefined;

    const handleKeyDown = async (event) => {
      if (!shouldInterceptPermissionShortcut(event, userDialogRef.current)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        try {
          await writePermissionsToClipboard(form);
        } catch (error) {
          console.warn("Failed to copy permissions", error);
        }
      }
      if (key === "v") {
        event.preventDefault();
        try {
          const permissions = await readPermissionsFromClipboard();
          handleFormChange("permissions", permissions);
        } catch (error) {
          console.warn("Failed to paste permissions", error);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dialogOpen, form]);

  useEffect(() => {
    if (!domainDialogOpen) return undefined;

    const handleKeyDown = async (event) => {
      if (!shouldInterceptPermissionShortcut(event, domainDialogRef.current)) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        try {
          await writePermissionsToClipboard(domainForm);
        } catch (error) {
          console.warn("Failed to copy domain permissions", error);
        }
      }
      if (key === "v") {
        event.preventDefault();
        try {
          const permissions = await readPermissionsFromClipboard();
          setDomainForm((prev) => ({ ...prev, permissions }));
        } catch (error) {
          console.warn("Failed to paste domain permissions", error);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [domainDialogOpen, domainForm]);

  function handleExportFilteredUsersCsv() {
    const rows = filteredUsers.map((user) => {
      const brandIds = (user.brand_memberships || [])
        .map((membership) => normalizeBrandValue(membership.brand_id))
        .filter(Boolean);
      const permissions = normalizePermissionSelection(
        user.brand_memberships?.[0]?.permissions || (isElevatedRole(user.role) ? ["all"] : []),
      );

      return {
        email: user.email || "",
        name: user.name || "",
        role: getRoleLabel(user.role),
        primary_brand: user.primary_brand_id || "",
        all_brands: isElevatedRole(user.role)
          ? Array.from(new Set([...brandIds, "ALL"])).join(" | ")
          : brandIds.join(" | "),
        permissions: permissions.join(" | "),
        status: user.status || "",
      };
    });

    const headers = [
      "Email",
      "Role",
      "Primary Brand",
      "All Brands",
      "Permissions",
      "Status",
    ];

    const csv = [
      headers.join(","),
      ...rows.map((row) =>
        [
          row.email,
          row.role,
          row.primary_brand,
          row.all_brands,
          row.permissions,
          row.status,
        ]
          .map(escapeCsvValue)
          .join(","),
      ),
    ].join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "access-control-users.csv";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function openNew() {
    setForm(emptyForm);
    setIsEdit(false);
    setUserFormError(null);
    setDialogOpen(true);
  }

  function openEdit(u) {
    setForm({
      name: u.name || "",
      email: u.email,
      role: u.role,
      brand_ids: (u.brand_memberships || []).map((b) => b.brand_id),
      primary_brand_id: u.primary_brand_id || "",
      status: u.status || "active",
      permissions: u.brand_memberships?.[0]?.permissions || ["all"],
      permission_mode: u.custom_role_id ? "role" : "manual",
      custom_role_id: u.custom_role_id || "",
    });
    setIsEdit(true);
    setUserFormError(null);
    setDialogOpen(true);
  }

  function handleFormChange(key, value) {
    setForm((prev) => {
      if (key === "brand_ids") {
        const nextBrandIds = Array.from(
          new Set((value || []).map((brandId) => normalizeBrandValue(brandId)).filter(Boolean)),
        );
        const currentPrimary = normalizeBrandValue(prev.primary_brand_id);
        const nextPrimary = nextBrandIds.length === 0
          ? ""
          : (currentPrimary && nextBrandIds.includes(currentPrimary) ? currentPrimary : nextBrandIds[0]);

        return {
          ...prev,
          brand_ids: nextBrandIds,
          primary_brand_id: nextPrimary,
        };
      }

      return {
        ...prev,
        [key]: key === "permissions" ? normalizePermissionSelection(value) : value,
      };
    });
  }

  function handlePermissionModeChange(nextMode) {
    if (nextMode === form.permission_mode) return;
    if (nextMode === "role") {
      setConfirmDialog({
        title: "Assign Custom Role?",
        description:
          "This user currently has manually assigned permissions. Assigning a Custom Role will replace those permissions with the permissions defined by the selected role.",
        confirmLabel: "Assign Role",
        onConfirm: () => {
          setForm((prev) => ({ ...prev, permission_mode: "role" }));
          setConfirmDialog(null);
        },
      });
    } else {
      const roleName = roles.find((r) => r._id === form.custom_role_id)?.name || "the assigned role";
      setConfirmDialog({
        title: "Switch to Manual Permissions?",
        description: `This user currently inherits permissions from the custom role "${roleName}". Switching to manual permissions will remove the role association and require permissions to be configured individually.`,
        confirmLabel: "Switch to Manual",
        onConfirm: () => {
          setForm((prev) => ({ ...prev, permission_mode: "manual", custom_role_id: "" }));
          setConfirmDialog(null);
        },
      });
    }
  }

  function buildUserPayload(source, statusOverride = null) {
    const role = source.role;
    const status = statusOverride ?? source.status ?? "active";
    const email = source.email;
    const normalizedPrimaryBrand = normalizeBrandValue(source.primary_brand_id);
    const normalizedBrandIds = Array.from(
      new Set((source.brand_ids || []).map((brandId) => normalizeBrandValue(brandId)).filter(Boolean)),
    );

    if (role === "super_admin") {
    return {
      name: (source.name || "").toString().trim(),
      email,
      role,
      brand_ids: [],
      primary_brand_id: "",
      permissions: ["all"],
      custom_role_id: null,
        status,
      };
    }

    const isRoleMode = source.permission_mode === "role";
    if (isRoleMode && !source.custom_role_id) {
      throw new Error("Select a custom role");
    }

    if (role === "brand_user") {
      const selectedBrand = normalizedPrimaryBrand || normalizedBrandIds[0] || "";
      if (!selectedBrand) {
        throw new Error("Brand is required");
      }
      return {
        name: (source.name || "").toString().trim(),
        email,
        role,
        brand_ids: [selectedBrand],
        primary_brand_id: selectedBrand,
        permissions: isRoleMode ? [] : normalizePermissionSelection(source.permissions || ["all"]),
        custom_role_id: isRoleMode ? source.custom_role_id : null,
        status,
      };
    }

    if (!normalizedPrimaryBrand) {
      throw new Error("Primary brand is required");
    }

    let brandIds = normalizedBrandIds;
    if (role === "viewer") {
      if (!brandIds.length) {
        throw new Error("Select at least one brand");
      }
      if (!brandIds.includes(normalizedPrimaryBrand)) {
        throw new Error("Primary brand must be one of the selected brands");
      }
    } else {
      brandIds = Array.from(new Set([...brandIds, normalizedPrimaryBrand]));
    }

    return {
      name: (source.name || "").toString().trim(),
      email,
      role,
      brand_ids: brandIds,
      primary_brand_id: normalizedPrimaryBrand,
      permissions:
        role === "author"
          ? ["all"]
          : isRoleMode
            ? []
            : normalizePermissionSelection(source.permissions || ["all"]),
      custom_role_id: role !== "author" && isRoleMode ? source.custom_role_id : null,
      status,
    };
  }

  async function handleSave() {
    if (!form.email) {
      setUserFormError("Email is required");
      return;
    }
    if (!isValidEmailAddress(form.email)) {
      setUserFormError("Enter a valid email address");
      return;
    }
    if (!isEdit) {
      const normalizedEmail = form.email.toString().trim().toLowerCase();
      const existingUser = users.some(
        (user) => (user.email || "").toString().trim().toLowerCase() === normalizedEmail,
      );
      if (existingUser) {
        setUserFormError("User with this email id already exists");
        return;
      }
    }

    setSaving(true);
    setUserFormError(null);
    let payload;
    try {
      payload = {
        ...buildUserPayload(form),
        create_only: !isEdit,
      };
    } catch (err) {
      setSaving(false);
      setUserFormError(err.message);
      return;
    }

    const r = await adminUpsertUser(payload);
    setSaving(false);
    if (r.error) {
      setUserFormError(r.data?.error || "Save failed");
      return;
    }
    setDialogOpen(false);
    setUserFormError(null);
    await loadUsers();
  }

  async function handleStatusToggle(email, currentStatus) {
    const nextStatus = currentStatus === "active" ? "suspended" : "active";
    const user = users.find((u) => u.email === email);
    if (!user) return;

    setSaving(true);
    let payload;
    try {
      payload = buildUserPayload({
        email: user.email,
        name: user.name || "",
        role: user.role,
        brand_ids: (user.brand_memberships || []).map((b) => b.brand_id),
        primary_brand_id: user.primary_brand_id,
        permissions: user.brand_memberships?.[0]?.permissions || ["all"],
        permission_mode: user.custom_role_id ? "role" : "manual",
        custom_role_id: user.custom_role_id || "",
        status: nextStatus,
      });
    } catch (err) {
      setSaving(false);
      setError(err.message);
      return;
    }

    const r = await adminUpsertUser(payload);
    setSaving(false);
    if (r.error) {
      setError(r.data?.error || "Failed to update status");
      return;
    }
    await loadUsers();
  }

  // ---- Custom Roles handlers ----
  function openNewRole() {
    setRoleForm(emptyRoleForm);
    setEditingRoleId(null);
    setIsEditingRole(false);
    setRoleFormError(null);
    setRoleDialogOpen(true);
  }

  function openEditRole(role) {
    setRoleForm({
      name: role.name || "",
      description: role.description || "",
      permissions: role.permissions || [],
    });
    setEditingRoleId(role._id);
    setIsEditingRole(true);
    setRoleFormError(null);
    setRoleDialogOpen(true);
  }

  function toggleRolePermission(permissionId) {
    setRoleForm((prev) => {
      const has = prev.permissions.includes(permissionId);
      return {
        ...prev,
        permissions: has
          ? prev.permissions.filter((p) => p !== permissionId)
          : [...prev.permissions, permissionId],
      };
    });
  }

  async function persistRole() {
    setRoleSaving(true);
    setRoleFormError(null);
    const payload = {
      name: roleForm.name.trim(),
      description: roleForm.description.trim(),
      permissions: roleForm.permissions,
    };

    const r = isEditingRole
      ? await updateCustomRole(editingRoleId, payload)
      : await createCustomRole(payload);

    setRoleSaving(false);
    if (r.error) {
      setRoleFormError(r.data?.error || "Save failed");
      return;
    }
    setRoleDialogOpen(false);
    setConfirmDialog(null);
    await loadRoles();
  }

  function handleSaveRole() {
    if (!roleForm.name.trim()) {
      setRoleFormError("Role name is required");
      return;
    }

    const existingRole = isEditingRole ? roles.find((r) => r._id === editingRoleId) : null;
    const assignedCount = existingRole?.assigned_user_count || 0;

    // Only prompt when there are affected users AND something actually
    // changed from the loaded values — not on every save.
    const changed =
      !existingRole ||
      existingRole.name !== roleForm.name.trim() ||
      (existingRole.description || "") !== roleForm.description.trim() ||
      JSON.stringify([...(existingRole.permissions || [])].sort()) !==
        JSON.stringify([...roleForm.permissions].sort());

    if (isEditingRole && assignedCount > 0 && changed) {
      setConfirmDialog({
        title: "Update Role?",
        description: `This role is assigned to ${assignedCount} user${assignedCount === 1 ? "" : "s"}. Changing its permissions will immediately change their effective access.`,
        confirmLabel: "Update Role",
        onConfirm: persistRole,
      });
      return;
    }

    persistRole();
  }

  function handleDeleteRole(role) {
    const assignedCount = role.assigned_user_count || 0;
    if (assignedCount > 0) {
      setRoleDeleteBlockedMessage(
        `"${role.name}" is currently assigned to ${assignedCount} user${assignedCount === 1 ? "" : "s"}. Reassign those users to another role or switch them to manual permissions before deleting this role.`,
      );
      return;
    }

    setConfirmDialog({
      title: "Delete Custom Role?",
      description: "This action cannot be undone.",
      confirmLabel: "Delete Role",
      onConfirm: async () => {
        const r = await deleteCustomRole(role._id);
        setConfirmDialog(null);
        if (r.error) {
          setRolesError(r.data?.error || "Failed to delete role");
          return;
        }
        await loadRoles();
      },
    });
  }

  const filteredDomainRules = useMemo(() => domainRules, [domainRules]);

  function openNewDomainRule() {
    setIsEditingDomainRule(false);
    setDomainForm({
      domain: "",
      role: "viewer",
      brand_ids: [],
      primary_brand_id: "",
      permissions: ["all"],
      status: "active",
    });
    setDomainDialogOpen(true);
  }

  function openEditDomainRule(rule) {
    setDomainForm({
      domain: rule.domain,
      role: rule.role,
      brand_ids: rule.brand_ids || [],
      primary_brand_id: rule.primary_brand_id || "",
      permissions: rule.permissions || ["all"],
      status: rule.status || "active",
    });
    setIsEditingDomainRule(true);
    setDomainDialogOpen(true);
  }

  function buildDomainRulePayload(source) {
    const role = source.role;
    const normalizedPrimaryBrand = normalizeBrandValue(source.primary_brand_id);
    const normalizedBrandIds = Array.from(
      new Set((source.brand_ids || []).map((brandId) => normalizeBrandValue(brandId)).filter(Boolean)),
    );

    if (role === "super_admin") {
      return {
        domain: source.domain.toLowerCase().trim(),
        role,
        brand_ids: [],
        primary_brand_id: "",
        permissions: ["all"],
        status: source.status,
      };
    }

    if (role === "brand_user") {
      const selectedBrand = normalizedPrimaryBrand || normalizedBrandIds[0] || "";
      if (!selectedBrand) {
        throw new Error("Brand is required");
      }
      return {
        domain: source.domain.toLowerCase().trim(),
        role,
        brand_ids: [selectedBrand],
        primary_brand_id: selectedBrand,
        permissions: normalizePermissionSelection(source.permissions || ["all"]),
        status: source.status,
      };
    }

    if (!normalizedPrimaryBrand) {
      throw new Error("Primary brand is required");
    }

    if (role === "viewer") {
      if (!normalizedBrandIds.length) {
        throw new Error("Select at least one brand");
      }
      if (!normalizedBrandIds.includes(normalizedPrimaryBrand)) {
        throw new Error("Primary brand must be one of the selected brands");
      }
    }

    return {
      ...source,
      domain: source.domain.toLowerCase().trim(),
      brand_ids: role === "author"
        ? Array.from(new Set([...normalizedBrandIds, normalizedPrimaryBrand]))
        : normalizedBrandIds,
      primary_brand_id: normalizedPrimaryBrand,
      permissions: role === "author" ? ["all"] : normalizePermissionSelection(source.permissions || ["all"]),
    };
  }

  async function handleSaveDomainRule() {
    if (!domainForm.domain) {
      setError("Domain is required");
      return;
    }

    setDomainSaving(true);
    let payload;
    try {
      payload = buildDomainRulePayload(domainForm);
    } catch (err) {
      setDomainSaving(false);
      setError(err.message);
      return;
    }

    const r = await upsertDomainRule(payload);
    setDomainSaving(false);
    if (r.error) {
      setError(r.data?.error || "Failed to save domain rule");
      return;
    }
    setDomainDialogOpen(false);
    setError(null);
    loadDomainRules();
  }

  async function handleDeleteDomainRule(domain) {
    if (!window.confirm(`Delete domain rule for ${domain}?`)) return;
    const r = await deleteDomainRule(domain);
    if (r.error) {
      setError(r.data?.error || "Failed to delete domain rule");
      return;
    }
    loadDomainRules();
  }

  async function handleDelete(email) {
    if (!window.confirm(`Delete user ${email}?`)) return;
    const r = await adminDeleteUser(email);
    if (r.error) {
      setError(r.data?.error || "Delete failed");
      return;
    }
    await loadUsers();
  }

  function renderChips(list = [], max = 2) {
    if (!list.length) return null;
    const head = list.slice(0, max);
    const tail = list.slice(max);
    return (
      <Stack direction="row" spacing={0.5} flexWrap="wrap" alignItems="center">
        {head.map((item) => (
          <GlassChip key={item} size="small" label={item} isDark={isDark} />
        ))}
        {tail.length > 0 && (
          <Tooltip title={tail.join(", ")}>
            <GlassChip size="small" label={`+${tail.length}`} isDark={isDark} />
          </Tooltip>
        )}
      </Stack>
    );
  }

  const containerSx = {
    bgcolor: isDark ? "rgba(18, 18, 18, 0.8)" : "rgba(255, 255, 255, 0.9)",
    backdropFilter: "blur(20px)",
    borderRadius: "24px",
    border: "1px solid",
    borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.05)",
    overflow: "hidden",
    boxShadow: isDark
      ? "0 8px 32px rgba(0, 0, 0, 0.4)"
      : "0 8px 32px rgba(0, 0, 0, 0.05)",
  };

  const tableHeaderSx = {
    "& th": {
      bgcolor: isDark ? "rgba(30, 30, 30, 0.95)" : "rgba(242, 242, 242, 0.95)",
      backdropFilter: "blur(10px)",
      color: isDark ? "rgba(255, 255, 255, 0.7)" : "rgba(0, 0, 0, 0.7)",
      fontSize: "0.75rem",
      fontWeight: 700,
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      borderBottom: "1px solid",
      borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)",
      py: 2.5,
      zIndex: 2,
    },
  };

  const tableRowSx = {
    transition: "background-color 0.2s",
    "& td": {
      borderBottom: "1px solid",
      borderColor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
      py: 2.5,
    },
    "&:hover": {
      bgcolor: isDark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.01)",
    },
  };

  const actionButtonSx = (color) => ({
    width: 36,
    height: 36,
    bgcolor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.03)",
    borderRadius: "10px",
    color: color === "error" ? "#ef4444" : isDark ? "#34d399" : "#10b981",
    transition: "all 0.2s",
    "&:hover": {
      bgcolor:
        color === "error"
          ? "rgba(239, 68, 68, 0.1)"
          : "rgba(16, 185, 129, 0.1)",
      transform: "scale(1.05)",
    },
  });

  const scrollbarSx = {
    "&::-webkit-scrollbar": {
      width: "6px",
      height: "6px",
    },
    "&::-webkit-scrollbar-track": {
      background: "transparent",
    },
    "&::-webkit-scrollbar-thumb": {
      background: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
      borderRadius: "10px",
    },
    "&::-webkit-scrollbar-thumb:hover": {
      background: isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)",
    },
  };

  return (
    <Box
      sx={{ p: 2, bgcolor: isDark ? "#000" : "#f8f9fa", minHeight: "100vh" }}
    >
      <Stack spacing={4}>
        {/* Header Section */}
        <Stack
          direction={{ xs: "column", sm: "row" }}
          justifyContent="space-between"
          alignItems="flex-start"
          spacing={2}
        >
          <Box>
            <Typography
              variant="h5"
              sx={{ fontWeight: 700, color: isDark ? "#fff" : "#000", mb: 0.5 }}
            >
              Access Control
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: isDark
                  ? "rgba(255, 255, 255, 0.5)"
                  : "rgba(0, 0, 0, 0.5)",
              }}
            >
              Manage who can sign in (author/viewer) and their brand access
            </Typography>
          </Box>
          <Stack direction="row" spacing={1.5} flexWrap="wrap">
            <Button
              variant="outlined"
              onClick={openNewRole}
              sx={{
                borderRadius: "12px",
                textTransform: "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.2)"
                  : "rgba(0,0,0,0.1)",
                color: isDark ? "#fff" : "#000",
                px: 2,
                "&:hover": {
                  borderColor: isDark ? "#fff" : "#000",
                  bgcolor: isDark
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(0,0,0,0.02)",
                },
              }}
            >
              Create Role
            </Button>
            <Button
              variant="outlined"
              onClick={openNewDomainRule}
              sx={{
                borderRadius: "12px",
                textTransform: "none",
                borderColor: isDark
                  ? "rgba(255,255,255,0.2)"
                  : "rgba(0,0,0,0.1)",
                color: isDark ? "#fff" : "#000",
                px: 2,
                "&:hover": {
                  borderColor: isDark ? "#fff" : "#000",
                  bgcolor: isDark
                    ? "rgba(255,255,255,0.05)"
                    : "rgba(0,0,0,0.02)",
                },
              }}
            >
              Add Domain Rule
            </Button>
            <Button
              variant="contained"
              onClick={openNew}
              startIcon={<AddCircleOutlineIcon />}
              sx={{
                borderRadius: "12px",
                textTransform: "none",
                bgcolor: "#10b981",
                px: 2,
                boxShadow: "0 4px 14px rgba(16, 185, 129, 0.4)",
                "&:hover": {
                  bgcolor: "#059669",
                  boxShadow: "0 6px 20px rgba(16, 185, 129, 0.5)",
                },
              }}
            >
              Add User
            </Button>
          </Stack>
        </Stack>

        {/* User Access Panel */}
        <Paper sx={containerSx}>
          <Box
            sx={{
              p: 3,
              borderBottom: "1px solid",
              borderColor: isDark
                ? "rgba(255, 255, 255, 0.05)"
                : "rgba(0, 0, 0, 0.05)",
            }}
          >
            <Stack
              direction={{ xs: "column", md: "row" }}
              spacing={2}
              alignItems={{ xs: "stretch", md: "center" }}
              justifyContent="space-between"
            >
              <Stack
                direction="row"
                spacing={2}
                alignItems="center"
                sx={{ flexWrap: "wrap", rowGap: 1, flexShrink: 0 }}
              >
              <FilterListIcon
                size="small"
                sx={{
                  color: isDark
                    ? "rgba(255, 255, 255, 0.4)"
                    : "rgba(0, 0, 0, 0.4)",
                }}
              />
              <Typography
                variant="body2"
                sx={{
                  color: isDark
                    ? "rgba(255, 255, 255, 0.6)"
                    : "rgba(0, 0, 0, 0.6)",
                  fontWeight: 500,
                }}
              >
                Filter by Role :
              </Typography>
              <Select
                size="small"
                value={filterRole}
                onChange={(e) => setFilterRole(e.target.value)}
                sx={{
                  minWidth: 100,
                  bgcolor: isDark
                    ? "rgba(255, 255, 255, 0.05)"
                    : "rgba(0, 0, 0, 0.02)",
                  borderRadius: "10px",
                  "& .MuiSelect-select": {
                    py: 0.7,
                    px: 1.5,
                    fontSize: "0.85rem",
                    fontWeight: 600,
                  },
                  "& fieldset": { border: "none" },
                }}
              >
                <MenuItem value="all">All</MenuItem>
                <MenuItem value="author">Author</MenuItem>
                <MenuItem value="viewer">Viewer</MenuItem>
                <MenuItem value="super_admin">Super Admin</MenuItem>
                <MenuItem value="brand_user">Brand User</MenuItem>
              </Select>
              </Stack>
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={1.5}
                alignItems={{ xs: "stretch", sm: "center" }}
                sx={{
                  width: { xs: "100%", md: "auto" },
                  flex: { xs: "1 1 auto", md: "0 1 auto" },
                  justifyContent: { md: "flex-end" },
                }}
              >
                <Select
                  size="small"
                  value={filterBrand}
                  onChange={(e) => setFilterBrand(e.target.value)}
                  sx={{
                    minWidth: { xs: "100%", sm: 140 },
                    width: { xs: "100%", md: 150 },
                    bgcolor: isDark
                      ? "rgba(255, 255, 255, 0.05)"
                      : "rgba(0, 0, 0, 0.02)",
                    borderRadius: "10px",
                    "& .MuiSelect-select": {
                      py: 0.7,
                      px: 1.5,
                      fontSize: "0.85rem",
                      fontWeight: 600,
                    },
                    "& fieldset": { border: "none" },
                  }}
                >
                  <MenuItem value="all">All Brands</MenuItem>
                  {filterableBrands.map((brand) => (
                    <MenuItem key={brand} value={brand}>
                      {brand}
                    </MenuItem>
                  ))}
                </Select>
                <TextField
                  size="small"
                  placeholder="Search by email"
                  value={emailSearch}
                  onChange={(event) => setEmailSearch(event.target.value)}
                  sx={{
                    minWidth: { xs: "100%", sm: 240 },
                    width: { xs: "100%", md: 280 },
                    flex: { xs: "1 1 auto", md: "0 0 auto" },
                    bgcolor: isDark
                      ? "rgba(255, 255, 255, 0.05)"
                      : "rgba(0, 0, 0, 0.02)",
                    borderRadius: "10px",
                    "& .MuiInputBase-root": {
                      borderRadius: "10px",
                    },
                    "& .MuiInputBase-input": {
                      py: 1,
                      fontSize: "0.85rem",
                      fontWeight: 500,
                    },
                    "& fieldset": { border: "none" },
                  }}
                />
                <Button
                  variant="outlined"
                  startIcon={<DownloadIcon sx={{ fontSize: 18 }} />}
                  onClick={handleExportFilteredUsersCsv}
                  sx={{
                    minWidth: { xs: "100%", sm: "auto" },
                    whiteSpace: "nowrap",
                    textTransform: "none",
                    borderRadius: "10px",
                    fontWeight: 600,
                    px: 1.75,
                    py: 0.9,
                    alignSelf: { xs: "stretch", md: "center" },
                  }}
                >
                  Export CSV
                </Button>
              </Stack>
            </Stack>
          </Box>

          <Box
            sx={{
              maxHeight: "500px",
              overflowY: "auto",
              position: "relative",
              ...scrollbarSx,
            }}
          >
            {error && (
              <Alert severity="error" sx={{ m: 2, borderRadius: "12px" }}>
                {error}
              </Alert>
            )}

            {isMobile ? (
              <Box sx={{ p: 2 }}>
                {filteredUsers.map((u) => (
                  <UserMobileCard
                    key={u.id || u.email}
                    user={u}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                    onStatusToggle={handleStatusToggle}
                    isDark={isDark}
                    roles={roles}
                  />
                ))}
                {!loading && filteredUsers.length === 0 && (
                  <Typography
                    variant="body2"
                    sx={{ textAlign: "center", py: 4, opacity: 0.5 }}
                  >
                    No users found
                  </Typography>
                )}
              </Box>
            ) : (
              <Table stickyHeader>
                <TableHead sx={tableHeaderSx}>
                  <TableRow>
                    <TableCell sx={{ pl: 4 }}>Email</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Primary Brand</TableCell>
                    <TableCell>All Brands</TableCell>
                    <TableCell>Permissions</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right" sx={{ pr: 4 }}>
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredUsers.map((u) => (
                    <TableRow key={u.id || u.email} sx={tableRowSx}>
                      <TableCell
                        sx={{
                          pl: 4,
                          fontWeight: 500,
                          color: isDark ? "#fff" : "#000",
                        }}
                      >
                        {u.email}
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} alignItems="center">
                          {getRoleTone(u.role).icon}
                          <Typography
                            variant="body2"
                            sx={{
                              fontWeight: 600,
                              color: getRoleTone(u.role).color,
                            }}
                          >
                            {getRoleLabel(u.role)}
                          </Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {u.primary_brand_id || "-"}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {renderChips(
                          (() => {
                            const ids = (u.brand_memberships || [])
                              .map((b) => b.brand_id)
                              .filter(Boolean);
                            if (isElevatedRole(u.role))
                              return [...new Set(ids), "ALL"];
                            return ids;
                          })(),
                          3,
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            color: isDark
                              ? "rgba(255,255,255,0.7)"
                              : "rgba(0,0,0,0.7)",
                            fontWeight: 500,
                          }}
                        >
                          {u.custom_role_id
                            ? `Role: ${roles.find((r) => r._id === u.custom_role_id)?.name || "Unknown role"}`
                            : summarizePermissions(
                                u.role,
                                u.brand_memberships?.[0]?.permissions || [],
                              )}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <StatusSwitch
                          active={u.status === "active"}
                          onChange={() => handleStatusToggle(u.email, u.status)}
                          isDark={isDark}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ pr: 4 }}>
                        <Stack
                          direction="row"
                          spacing={1}
                          justifyContent="flex-end"
                        >
                          <Tooltip title="Edit">
                            <IconButton
                              sx={actionButtonSx("primary")}
                              onClick={() => openEdit(u)}
                            >
                              <EditIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete">
                            <IconButton
                              sx={actionButtonSx("error")}
                              onClick={() => handleDelete(u.email)}
                            >
                              <DeleteIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!loading && filteredUsers.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        sx={{ textAlign: "center", py: 8, opacity: 0.5 }}
                      >
                        No users found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
            {loading && (
              <Box
                sx={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  bgcolor: isDark ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.4)",
                  zIndex: 1,
                }}
              >
                <CircularProgress
                  size={32}
                  thickness={5}
                  sx={{ color: "#10b981" }}
                />
              </Box>
            )}
          </Box>
        </Paper>

        {/* Domain Rules Panel */}
        <Paper sx={containerSx}>
          <Box
            sx={{
              p: 3,
              borderBottom: "1px solid",
              borderColor: isDark
                ? "rgba(255, 255, 255, 0.05)"
                : "rgba(0, 0, 0, 0.05)",
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <DomainIcon
                size="small"
                sx={{
                  color: isDark
                    ? "rgba(255, 255, 255, 0.4)"
                    : "rgba(0, 0, 0, 0.4)",
                }}
              />
              <Typography
                variant="subtitle1"
                sx={{ fontWeight: 700, color: isDark ? "#fff" : "#000" }}
              >
                Domain Rules :
              </Typography>
            </Stack>
          </Box>
          <Box
            sx={{
              maxHeight: "400px",
              overflowY: "auto",
              ...scrollbarSx,
            }}
          >
            {isMobile ? (
              <Box sx={{ p: 2 }}>
                {filteredDomainRules.map((r) => (
                  <DomainMobileCard
                    key={r._id || r.domain}
                    rule={r}
                    onEdit={openEditDomainRule}
                    onDelete={handleDeleteDomainRule}
                    isDark={isDark}
                  />
                ))}
                {!loading && filteredDomainRules.length === 0 && (
                  <Typography
                    variant="body2"
                    sx={{ textAlign: "center", py: 4, opacity: 0.5 }}
                  >
                    No domain rules found
                  </Typography>
                )}
              </Box>
            ) : (
              <Table stickyHeader>
                <TableHead sx={tableHeaderSx}>
                  <TableRow>
                    <TableCell sx={{ pl: 4 }}>Domain</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Primary Brand</TableCell>
                    <TableCell>All Brands</TableCell>
                    <TableCell>Permissions</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right" sx={{ pr: 4 }}>
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredDomainRules.map((r) => (
                    <TableRow key={r._id || r.domain} sx={tableRowSx}>
                      <TableCell
                        sx={{
                          pl: 4,
                          fontWeight: 500,
                          color: isDark ? "#fff" : "#000",
                        }}
                      >
                        {r.domain}
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            fontWeight: 600,
                            color:
                              getRoleTone(r.role).color,
                          }}
                        >
                          {getRoleLabel(r.role)}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {r.primary_brand_id}
                        </Typography>
                      </TableCell>
                      <TableCell>{renderChips(r.brand_ids || [], 2)}</TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            color: isDark
                              ? "rgba(255,255,255,0.7)"
                              : "rgba(0,0,0,0.7)",
                            fontWeight: 500,
                          }}
                        >
                          {summarizePermissions(r.role, r.permissions || [])}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <StatusSwitch
                          active={r.status === "active"}
                          onChange={() => {}}
                          isDark={isDark}
                        />
                      </TableCell>
                      <TableCell align="right" sx={{ pr: 4 }}>
                        <Stack
                          direction="row"
                          spacing={1}
                          justifyContent="flex-end"
                        >
                          <Tooltip title="Edit">
                            <IconButton
                              sx={actionButtonSx("primary")}
                              onClick={() => openEditDomainRule(r)}
                            >
                              <EditIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete">
                            <IconButton
                              sx={actionButtonSx("error")}
                              onClick={() => handleDeleteDomainRule(r.domain)}
                            >
                              <DeleteIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!loading && filteredDomainRules.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        sx={{ textAlign: "center", py: 8, opacity: 0.5 }}
                      >
                        No domain rules found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </Box>
        </Paper>

        {/* Custom Roles Panel */}
        <Paper sx={containerSx}>
          <Box
            sx={{
              p: 3,
              borderBottom: "1px solid",
              borderColor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <ShieldOutlinedIcon
                sx={{ color: isDark ? "rgba(255, 255, 255, 0.4)" : "rgba(0, 0, 0, 0.4)" }}
              />
              <Typography variant="subtitle1" sx={{ fontWeight: 700, color: isDark ? "#fff" : "#000" }}>
                Custom Roles :
              </Typography>
            </Stack>
          </Box>
          <Box sx={{ maxHeight: "400px", overflowY: "auto", ...scrollbarSx }}>
            {rolesError && (
              <Alert severity="error" sx={{ m: 2 }}>
                {rolesError}
              </Alert>
            )}
            {isMobile ? (
              <Box sx={{ p: 2 }}>
                {roles.map((role) => (
                  <Box
                    key={role._id}
                    sx={{
                      p: 2,
                      mb: 2,
                      borderRadius: "16px",
                      bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
                      border: "1px solid",
                      borderColor: isDark ? "rgba(255, 255, 255, 0.05)" : "rgba(0, 0, 0, 0.05)",
                    }}
                  >
                    <Stack spacing={1}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                        {role.name}
                      </Typography>
                      {role.description && (
                        <Typography variant="body2" color="text.secondary">
                          {role.description}
                        </Typography>
                      )}
                      <Stack direction="row" spacing={1}>
                        <Chip size="small" label={`${role.permissions?.length || 0} permissions`} />
                        <Chip size="small" label={`${role.assigned_user_count || 0} users`} />
                      </Stack>
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        <IconButton size="small" onClick={() => openEditRole(role)} sx={actionButtonSx("primary")}>
                          <EditIcon sx={{ fontSize: 18 }} />
                        </IconButton>
                        <IconButton size="small" onClick={() => handleDeleteRole(role)} sx={actionButtonSx("error")}>
                          <DeleteIcon sx={{ fontSize: 18 }} />
                        </IconButton>
                      </Stack>
                    </Stack>
                  </Box>
                ))}
                {!rolesLoading && roles.length === 0 && (
                  <Typography variant="body2" sx={{ textAlign: "center", py: 4, opacity: 0.5 }}>
                    No custom roles yet
                  </Typography>
                )}
              </Box>
            ) : (
              <Table stickyHeader>
                <TableHead sx={tableHeaderSx}>
                  <TableRow>
                    <TableCell sx={{ pl: 4 }}>Name</TableCell>
                    <TableCell>Description</TableCell>
                    <TableCell>Permissions</TableCell>
                    <TableCell>Assigned Users</TableCell>
                    <TableCell align="right" sx={{ pr: 4 }}>
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {roles.map((role) => (
                    <TableRow key={role._id} sx={tableRowSx}>
                      <TableCell sx={{ pl: 4, fontWeight: 600, color: isDark ? "#fff" : "#000" }}>
                        {role.name}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {role.description || "—"}
                        </Typography>
                      </TableCell>
                      <TableCell>{role.permissions?.length || 0} permissions</TableCell>
                      <TableCell>{role.assigned_user_count || 0} users</TableCell>
                      <TableCell align="right" sx={{ pr: 4 }}>
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Tooltip title="Edit">
                            <IconButton sx={actionButtonSx("primary")} onClick={() => openEditRole(role)}>
                              <EditIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Delete">
                            <IconButton sx={actionButtonSx("error")} onClick={() => handleDeleteRole(role)}>
                              <DeleteIcon sx={{ fontSize: 18 }} />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!rolesLoading && roles.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} sx={{ textAlign: "center", py: 8, opacity: 0.5 }}>
                        No custom roles yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            )}
          </Box>
        </Paper>
      </Stack>

      {/* Dialogs */}
      <Dialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setUserFormError(null);
        }}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          ref: userDialogRef,
          sx: { borderRadius: "20px", bgcolor: isDark ? "#1a1a1a" : "#fff" },
        }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>
          {isEdit ? "Edit User" : "Add New User"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            {userFormError && (
              <Alert severity="error" sx={{ borderRadius: "12px" }}>
                {userFormError}
              </Alert>
            )}
            <TextField
              label="User Name"
              fullWidth
              value={form.name}
              onChange={(e) => handleFormChange("name", e.target.value)}
            />
            <TextField
              label="Email Address"
              fullWidth
              value={form.email}
              onChange={(e) => handleFormChange("email", e.target.value)}
              disabled={isEdit}
            />
            <FormControl fullWidth>
              <InputLabel>Role</InputLabel>
              <Select
                label="Role"
                value={form.role}
                onChange={(e) => handleFormChange("role", e.target.value)}
                MenuProps={{
                  PaperProps: { sx: { zIndex: 1400 } },
                }}
              >
                {ROLE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {form.role === "viewer" && (
              <>
                <Autocomplete
                  multiple
                  freeSolo
                  options={availableBrands}
                  value={form.brand_ids}
                  onChange={(_, val) =>
                    handleFormChange(
                      "brand_ids",
                      val
                        .map((v) => v.toString().trim().toUpperCase())
                        .filter(Boolean),
                    )
                  }
                  slotProps={{
                    popper: { sx: { zIndex: 1400 } },
                  }}
                  ListboxProps={{
                    sx: { maxHeight: 250 },
                  }}
                  renderTags={(value, getTagProps) =>
                    value.map((option, index) => (
                      <Chip
                        variant="outlined"
                        label={option}
                        {...getTagProps({ index })}
                      />
                    ))
                  }
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Brands"
                      placeholder="Type and press Enter"
                      fullWidth
                    />
                  )}
                />
                <FormControl fullWidth>
                  <InputLabel>Primary Brand</InputLabel>
                  <Select
                    label="Primary Brand"
                    value={form.primary_brand_id}
                    disabled={(form.brand_ids || []).length === 0}
                    onChange={(e) =>
                      handleFormChange("primary_brand_id", e.target.value)
                    }
                    MenuProps={{
                      PaperProps: { sx: { zIndex: 1400 } },
                    }}
                  >
                    {(form.brand_ids || []).map((b) => (
                      <MenuItem key={b} value={b}>
                        {b}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography variant="caption" sx={{ fontWeight: 700, opacity: 0.7 }}>
                    ACCESS / PERMISSION MODE
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1}>
                  <Chip
                    label="Manual Permissions"
                    onClick={() => handlePermissionModeChange("manual")}
                    color={form.permission_mode === "manual" ? "primary" : "default"}
                    variant={form.permission_mode === "manual" ? "filled" : "outlined"}
                  />
                  <Chip
                    label="Custom Role"
                    onClick={() => handlePermissionModeChange("role")}
                    color={form.permission_mode === "role" ? "primary" : "default"}
                    variant={form.permission_mode === "role" ? "filled" : "outlined"}
                  />
                </Stack>

                {form.permission_mode === "role" ? (
                  <>
                    <FormControl fullWidth>
                      <InputLabel>Custom Role</InputLabel>
                      <Select
                        label="Custom Role"
                        value={form.custom_role_id}
                        onChange={(e) => handleFormChange("custom_role_id", e.target.value)}
                        MenuProps={{ PaperProps: { sx: { zIndex: 1400 } } }}
                      >
                        {roles.map((role) => (
                          <MenuItem key={role._id} value={role._id}>
                            {role.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Box>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                        Permissions inherited from{" "}
                        {roles.find((r) => r._id === form.custom_role_id)?.name || "this role"}. Permissions are
                        managed by the assigned custom role.
                      </Typography>
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                        {(roles.find((r) => r._id === form.custom_role_id)?.permissions || []).map((p) => (
                          <GlassChip key={p} label={p} isDark={isDark} />
                        ))}
                      </Box>
                    </Box>
                  </>
                ) : (
                  <>
                    <Autocomplete
                      multiple
                      options={PERMISSION_OPTIONS.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                      value={form.permissions.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                      onChange={(_, val) => {
                        const nestedPerms = form.permissions.filter(p => p.startsWith("product_conversion:") || p.startsWith("product_table_filters:"));
                        handleFormChange("permissions", [...val, ...nestedPerms]);
                      }}
                      slotProps={{
                        popper: {
                          sx: { zIndex: 1400 },
                          placement: "bottom-start",
                          modifiers: [
                            {
                              name: "flip",
                              enabled: false,
                            },
                          ],
                        },
                      }}
                      ListboxProps={{
                        sx: { maxHeight: 250 },
                      }}
                      renderTags={(value, getTagProps) =>
                        value.map((option, index) => (
                          <Chip
                            variant="outlined"
                            label={option}
                            {...getTagProps({ index })}
                          />
                        ))
                      }
                      renderInput={(params) => (
                        <TextField {...params} label="General Permissions" fullWidth />
                      )}
                    />

                    {form.permissions.includes("product_conversion") && (
                      <Box sx={{
                        p: 2,
                        borderRadius: "12px",
                        bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
                        border: "1px dashed",
                        borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)"
                      }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, mb: 1, display: 'block', opacity: 0.7 }}>
                          PRODUCT TABLE COLUMNS
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {COLUMN_PERMISSIONS.map((col) => {
                            const active = form.permissions.includes(col.id);
                            return (
                              <Chip
                                key={col.id}
                                label={col.label}
                                onClick={() => {
                                  let next = active
                                    ? form.permissions.filter(p => p !== col.id)
                                    : [...form.permissions, col.id];

                                  // Enforcement: If removing DRR/DOH results in none being selected,
                                  // auto-remove Inventory Analysis filter scope.
                                  const hasDrrDoh = next.some(p => p === "product_conversion:drr" || p === "product_conversion:doh");
                                  if (!hasDrrDoh) {
                                    next = next.filter(p => p !== "product_table_filters:inventory");
                                  }

                                  handleFormChange("permissions", next);
                                }}
                                color={active ? "primary" : "default"}
                                variant={active ? "filled" : "outlined"}
                                size="small"
                                sx={{ borderRadius: '8px' }}
                              />
                            );
                          })}
                        </Box>
                      </Box>
                    )}

                    {form.permissions.includes("product_table_filters") && (
                      <Box sx={{
                        p: 2,
                        borderRadius: "12px",
                        bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
                        border: "1px dashed",
                        borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)"
                      }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, mb: 1, display: 'block', opacity: 0.7 }}>
                          PRODUCT TABLE FILTERS
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {FILTER_PANEL_PERMISSIONS.map((f) => {
                            const active = form.permissions.includes(f.id);
                            const isInventory = f.id === "product_table_filters:inventory";
                            const hasDrrDoh = form.permissions.some(p => p === "product_conversion:drr" || p === "product_conversion:doh");
                            const disabled = isInventory && !hasDrrDoh;

                            return (
                              <Tooltip
                                key={f.id}
                                title={disabled ? "Requires DRR or DOH column access" : ""}
                                arrow
                              >
                                <span>
                                  <Chip
                                    label={f.label}
                                    onClick={() => {
                                      if (disabled) return;
                                      const next = active
                                        ? form.permissions.filter(p => p !== f.id)
                                        : [...form.permissions, f.id];
                                      handleFormChange("permissions", next);
                                    }}
                                    disabled={disabled}
                                    color={active ? "primary" : "default"}
                                    variant={active ? "filled" : "outlined"}
                                    size="small"
                                    sx={{ borderRadius: '8px', opacity: disabled ? 0.5 : 1 }}
                                  />
                                </span>
                              </Tooltip>
                            );
                          })}
                        </Box>
                      </Box>
                    )}
                  </>
                )}
              </>
            )}
            {form.role === "author" && (
              <Stack spacing={1.5}>
                <Autocomplete
                  freeSolo
                  options={availableBrands}
                  value={form.primary_brand_id}
                  onChange={(_, val) =>
                    handleFormChange(
                      "primary_brand_id",
                      (val || "").toString().trim().toUpperCase(),
                    )
                  }
                  slotProps={{
                    popper: {
                      sx: { zIndex: 1400 },
                      placement: "bottom-start",
                      modifiers: [
                        {
                          name: "flip",
                          enabled: false,
                        },
                      ],
                    },
                  }}
                  ListboxProps={{
                    sx: { maxHeight: 250 },
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Primary Brand (Required)"
                      required
                      fullWidth
                    />
                  )}
                />
                <Alert severity="info" sx={{ borderRadius: "12px" }}>
                  Authors have access to all brands and permissions.
                </Alert>
              </Stack>
            )}
            {form.role === "brand_user" && (
              <Stack spacing={2}>
                <FormControl fullWidth>
                  <InputLabel>Brand</InputLabel>
                  <Select
                    label="Brand"
                    value={form.primary_brand_id}
                    onChange={(e) =>
                      handleFormChange(
                        "primary_brand_id",
                        normalizeBrandValue(e.target.value),
                      )
                    }
                    MenuProps={{
                      PaperProps: { sx: { zIndex: 1400 } },
                    }}
                  >
                    {availableBrands.map((brand) => (
                      <MenuItem key={brand} value={brand}>
                        {brand}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Stack direction="row" spacing={1}>
                  <Chip
                    label="Manual Permissions"
                    onClick={() => handlePermissionModeChange("manual")}
                    color={form.permission_mode === "manual" ? "primary" : "default"}
                    variant={form.permission_mode === "manual" ? "filled" : "outlined"}
                  />
                  <Chip
                    label="Custom Role"
                    onClick={() => handlePermissionModeChange("role")}
                    color={form.permission_mode === "role" ? "primary" : "default"}
                    variant={form.permission_mode === "role" ? "filled" : "outlined"}
                  />
                </Stack>

                {form.permission_mode === "role" ? (
                  <>
                    <FormControl fullWidth>
                      <InputLabel>Custom Role</InputLabel>
                      <Select
                        label="Custom Role"
                        value={form.custom_role_id}
                        onChange={(e) => handleFormChange("custom_role_id", e.target.value)}
                        MenuProps={{ PaperProps: { sx: { zIndex: 1400 } } }}
                      >
                        {roles.map((role) => (
                          <MenuItem key={role._id} value={role._id}>
                            {role.name}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Box>
                      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
                        Permissions inherited from{" "}
                        {roles.find((r) => r._id === form.custom_role_id)?.name || "this role"}. Permissions are
                        managed by the assigned custom role.
                      </Typography>
                      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                        {(roles.find((r) => r._id === form.custom_role_id)?.permissions || []).map((p) => (
                          <GlassChip key={p} label={p} isDark={isDark} />
                        ))}
                      </Box>
                    </Box>
                  </>
                ) : (
                  <>
                    <Autocomplete
                      multiple
                      options={PERMISSION_OPTIONS.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                      value={form.permissions.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                      onChange={(_, val) => {
                        const nestedPerms = form.permissions.filter(p => p.startsWith("product_conversion:") || p.startsWith("product_table_filters:"));
                        handleFormChange("permissions", [...val, ...nestedPerms]);
                      }}
                      slotProps={{
                        popper: {
                          sx: { zIndex: 1400 },
                          placement: "bottom-start",
                          modifiers: [{ name: "flip", enabled: false }],
                        },
                      }}
                      ListboxProps={{
                        sx: { maxHeight: 250 },
                      }}
                      renderTags={(value, getTagProps) =>
                        value.map((option, index) => (
                          <Chip
                            variant="outlined"
                            label={option}
                            {...getTagProps({ index })}
                          />
                        ))
                      }
                      renderInput={(params) => (
                        <TextField {...params} label="General Permissions" fullWidth />
                      )}
                    />
                    {form.permissions.includes("product_conversion") && (
                      <Box sx={{
                        p: 2,
                        borderRadius: "12px",
                        bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
                        border: "1px dashed",
                        borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)"
                      }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, mb: 1, display: 'block', opacity: 0.7 }}>
                          PRODUCT TABLE COLUMNS
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {COLUMN_PERMISSIONS.map((col) => {
                            const active = form.permissions.includes(col.id);
                            return (
                              <Chip
                                key={col.id}
                                label={col.label}
                                onClick={() => {
                                  let next = active
                                    ? form.permissions.filter(p => p !== col.id)
                                    : [...form.permissions, col.id];

                                  const hasDrrDoh = next.some(p => p === "product_conversion:drr" || p === "product_conversion:doh");
                                  if (!hasDrrDoh) {
                                    next = next.filter(p => p !== "product_table_filters:inventory");
                                  }

                                  handleFormChange("permissions", next);
                                }}
                                color={active ? "primary" : "default"}
                                variant={active ? "filled" : "outlined"}
                                size="small"
                                sx={{ borderRadius: '8px' }}
                              />
                            );
                          })}
                        </Box>
                      </Box>
                    )}
                    {form.permissions.includes("product_table_filters") && (
                      <Box sx={{
                        p: 2,
                        borderRadius: "12px",
                        bgcolor: isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.02)",
                        border: "1px dashed",
                        borderColor: isDark ? "rgba(255, 255, 255, 0.1)" : "rgba(0, 0, 0, 0.1)"
                      }}>
                        <Typography variant="caption" sx={{ fontWeight: 700, mb: 1, display: 'block', opacity: 0.7 }}>
                          PRODUCT TABLE FILTERS
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                          {FILTER_PANEL_PERMISSIONS.map((f) => {
                            const active = form.permissions.includes(f.id);
                            const isInventory = f.id === "product_table_filters:inventory";
                            const hasDrrDoh = form.permissions.some(p => p === "product_conversion:drr" || p === "product_conversion:doh");
                            const disabled = isInventory && !hasDrrDoh;

                            return (
                              <Tooltip
                                key={f.id}
                                title={disabled ? "Requires DRR or DOH column access" : ""}
                                arrow
                              >
                                <span>
                                  <Chip
                                    label={f.label}
                                    onClick={() => {
                                      if (disabled) return;
                                      const next = active
                                        ? form.permissions.filter(p => p !== f.id)
                                        : [...form.permissions, f.id];
                                      handleFormChange("permissions", next);
                                    }}
                                    disabled={disabled}
                                    color={active ? "primary" : "default"}
                                    variant={active ? "filled" : "outlined"}
                                    size="small"
                                    sx={{ borderRadius: '8px', opacity: disabled ? 0.5 : 1 }}
                                  />
                                </span>
                              </Tooltip>
                            );
                          })}
                        </Box>
                      </Box>
                    )}
                  </>
                )}
              </Stack>
            )}
            {form.role === "super_admin" && (
              <Alert severity="info" sx={{ borderRadius: "12px" }}>
                Super Admin automatically receives all brands and all permissions.
              </Alert>
            )}
            <FormControl fullWidth>
              <InputLabel>Status</InputLabel>
              <Select
                label="Status"
                value={form.status}
                onChange={(e) => handleFormChange("status", e.target.value)}
                MenuProps={{
                  PaperProps: { sx: { zIndex: 1400 } },
                }}
              >
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="suspended">Suspended</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="caption" sx={{ opacity: 0.6 }}>
              Click anywhere in this dialog outside text fields, then use Ctrl/Cmd+C to copy permissions and Ctrl/Cmd+V to paste them.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button
            onClick={() => {
              setDialogOpen(false);
              setUserFormError(null);
            }}
            sx={{ textTransform: "none", fontWeight: 600 }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving}
            variant="contained"
            sx={{
              borderRadius: "10px",
              textTransform: "none",
              fontWeight: 600,
              bgcolor: "#10b981",
              "&:hover": { bgcolor: "#059669" },
            }}
          >
            {isEdit ? "Save Changes" : "Create User"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Domain Rule Dialog */}
      <Dialog
        open={domainDialogOpen}
        onClose={() => setDomainDialogOpen(false)}
        fullWidth
        maxWidth="sm"
        PaperProps={{
          ref: domainDialogRef,
          sx: { borderRadius: "20px", bgcolor: isDark ? "#1a1a1a" : "#fff" },
        }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>
          {isEditingDomainRule ? "Edit Domain Rule" : "Add Domain Rule"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <TextField
              label="Domain"
              fullWidth
              value={domainForm.domain}
              onChange={(e) =>
                setDomainForm((prev) => ({ ...prev, domain: e.target.value }))
              }
              helperText="Example: trytechit.co"
            />
            <FormControl fullWidth>
              <InputLabel>Role</InputLabel>
              <Select
                label="Role"
                value={domainForm.role}
                onChange={(e) =>
                  setDomainForm((prev) => ({ ...prev, role: e.target.value }))
                }
                MenuProps={{
                  PaperProps: { sx: { zIndex: 1400 } },
                }}
              >
                {ROLE_OPTIONS.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            {(domainForm.role === "author" || domainForm.role === "viewer") && (
              <>
            <Autocomplete
              multiple
              freeSolo
              options={availableBrands}
              value={domainForm.brand_ids}
              onChange={(_, val) =>
                setDomainForm((prev) => ({
                  ...prev,
                  brand_ids: val
                    .map((v) => v.toString().trim().toUpperCase())
                    .filter(Boolean),
                }))
              }
              slotProps={{
                popper: {
                  sx: { zIndex: 1400 },
                  placement: "bottom-start",
                  modifiers: [
                    {
                      name: "flip",
                      enabled: false,
                    },
                  ],
                },
              }}
              ListboxProps={{
                sx: { maxHeight: 250 },
              }}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    variant="outlined"
                    label={option}
                    {...getTagProps({ index })}
                  />
                ))
              }
              renderInput={(params) => (
                <TextField {...params} label="Brands" fullWidth />
              )}
            />
            <Autocomplete
              freeSolo
              options={
                domainForm.brand_ids.length
                  ? domainForm.brand_ids
                  : availableBrands
              }
              value={domainForm.primary_brand_id}
              onChange={(_, val) =>
                setDomainForm((prev) => ({
                  ...prev,
                  primary_brand_id: (val || "").toString().trim().toUpperCase(),
                }))
              }
              slotProps={{
                popper: {
                  sx: { zIndex: 1400 },
                  placement: "bottom-start",
                  modifiers: [
                    {
                      name: "flip",
                      enabled: false,
                    },
                  ],
                },
              }}
              ListboxProps={{
                sx: { maxHeight: 250 },
              }}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label="Primary Brand (Required)"
                  required
                  fullWidth
                />
              )}
            />
              </>
            )}
            {domainForm.role === "viewer" && (
                <Autocomplete
                  multiple
                  options={PERMISSION_OPTIONS.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                  value={domainForm.permissions.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                  onChange={(_, val) => {
                    const nestedPerms = domainForm.permissions.filter(p => p.startsWith("product_conversion:") || p.startsWith("product_table_filters:"));
                    setDomainForm((prev) => ({
                      ...prev,
                      permissions: normalizePermissionSelection([...val, ...nestedPerms]),
                    }));
                  }}
                slotProps={{
                  popper: {
                    sx: { zIndex: 1400 },
                    placement: "bottom-start",
                    modifiers: [
                      {
                        name: "flip",
                        enabled: false,
                      },
                    ],
                  },
                }}
                ListboxProps={{
                  sx: { maxHeight: 250 },
                }}
                renderTags={(value, getTagProps) =>
                  value.map((option, index) => (
                    <Chip
                      variant="outlined"
                      label={option}
                      {...getTagProps({ index })}
                    />
                  ))
                }
                renderInput={(params) => (
                  <TextField {...params} label="Permissions" fullWidth />
                )}
              />
            )}
            {domainForm.role === "brand_user" && (
              <>
                <FormControl fullWidth>
                  <InputLabel>Brand</InputLabel>
                  <Select
                    label="Brand"
                    value={domainForm.primary_brand_id}
                    onChange={(e) =>
                      setDomainForm((prev) => ({
                        ...prev,
                        primary_brand_id: normalizeBrandValue(e.target.value),
                      }))
                    }
                    MenuProps={{
                      PaperProps: { sx: { zIndex: 1400 } },
                    }}
                  >
                    {availableBrands.map((brand) => (
                      <MenuItem key={brand} value={brand}>
                        {brand}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                <Autocomplete
                  multiple
                  options={PERMISSION_OPTIONS.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                  value={domainForm.permissions.filter(p => !p.startsWith("product_conversion:") && !p.startsWith("product_table_filters:"))}
                  onChange={(_, val) => {
                    const nestedPerms = domainForm.permissions.filter(p => p.startsWith("product_conversion:") || p.startsWith("product_table_filters:"));
                    setDomainForm((prev) => ({
                      ...prev,
                      permissions: normalizePermissionSelection([...val, ...nestedPerms]),
                    }));
                  }}
                  slotProps={{
                    popper: {
                      sx: { zIndex: 1400 },
                      placement: "bottom-start",
                      modifiers: [{ name: "flip", enabled: false }],
                    },
                  }}
                  ListboxProps={{
                    sx: { maxHeight: 250 },
                  }}
                  renderTags={(value, getTagProps) =>
                    value.map((option, index) => (
                      <Chip
                        variant="outlined"
                        label={option}
                        {...getTagProps({ index })}
                      />
                    ))
                  }
                  renderInput={(params) => (
                    <TextField {...params} label="Permissions" fullWidth />
                  )}
                />
              </>
            )}
            {domainForm.role === "super_admin" && (
              <Alert severity="info" sx={{ borderRadius: "12px" }}>
                Super Admin domain rules automatically receive all brands and all permissions.
              </Alert>
            )}
            <FormControl fullWidth>
              <InputLabel>Status</InputLabel>
              <Select
                label="Status"
                value={domainForm.status}
                onChange={(e) =>
                  setDomainForm((prev) => ({ ...prev, status: e.target.value }))
                }
                MenuProps={{
                  PaperProps: { sx: { zIndex: 1400 } },
                }}
              >
                <MenuItem value="active">Active</MenuItem>
                <MenuItem value="suspended">Suspended</MenuItem>
              </Select>
            </FormControl>
            <Typography variant="caption" sx={{ opacity: 0.6 }}>
              Click anywhere in this dialog outside text fields, then use Ctrl/Cmd+C to copy permissions and Ctrl/Cmd+V to paste them.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button
            onClick={() => setDomainDialogOpen(false)}
            sx={{ textTransform: "none", fontWeight: 600 }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveDomainRule}
            disabled={domainSaving}
            variant="contained"
            sx={{
              borderRadius: "10px",
              textTransform: "none",
              fontWeight: 600,
              bgcolor: "#10b981",
              "&:hover": { bgcolor: "#059669" },
            }}
          >
            Save Rule
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create/Edit Custom Role */}
      <Dialog
        open={roleDialogOpen}
        onClose={() => {
          setRoleDialogOpen(false);
          setRoleFormError(null);
        }}
        fullWidth
        maxWidth="sm"
        PaperProps={{ sx: { borderRadius: "20px", bgcolor: isDark ? "#1a1a1a" : "#fff" } }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>
          {isEditingRole ? "Edit Custom Role" : "Create Custom Role"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            {roleFormError && <Alert severity="error">{roleFormError}</Alert>}
            <TextField
              label="Role Name"
              fullWidth
              value={roleForm.name}
              onChange={(e) => setRoleForm((prev) => ({ ...prev, name: e.target.value }))}
              required
            />
            <TextField
              label="Description"
              fullWidth
              multiline
              minRows={2}
              value={roleForm.description}
              onChange={(e) => setRoleForm((prev) => ({ ...prev, description: e.target.value }))}
            />

            {isEditingRole && (
              <Alert severity={(roles.find((r) => r._id === editingRoleId)?.assigned_user_count || 0) > 0 ? "warning" : "info"}>
                {(roles.find((r) => r._id === editingRoleId)?.assigned_user_count || 0) > 0
                  ? `This role is currently assigned to ${roles.find((r) => r._id === editingRoleId)?.assigned_user_count} user${roles.find((r) => r._id === editingRoleId)?.assigned_user_count === 1 ? "" : "s"}. Changes to this role's permissions will also change the permissions of those users.`
                  : "This role is not currently assigned to any users."}
              </Alert>
            )}

            <Stack spacing={2}>
              {PERMISSION_CATEGORIES.map((category) => (
                <Box key={category.label}>
                  <Typography
                    variant="caption"
                    sx={{
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)",
                    }}
                  >
                    {category.label}
                  </Typography>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, mt: 0.75 }}>
                    {category.permissions.map((permissionId) => {
                      const columnMeta = COLUMN_PERMISSIONS.find((p) => p.id === permissionId);
                      const filterMeta = FILTER_PANEL_PERMISSIONS.find((p) => p.id === permissionId);
                      const label = columnMeta?.label || filterMeta?.label || permissionId;
                      const active = roleForm.permissions.includes(permissionId);
                      return (
                        <Chip
                          key={permissionId}
                          label={label}
                          size="small"
                          color={active ? "primary" : "default"}
                          variant={active ? "filled" : "outlined"}
                          onClick={() => toggleRolePermission(permissionId)}
                          sx={{ cursor: "pointer" }}
                        />
                      );
                    })}
                  </Box>
                </Box>
              ))}
            </Stack>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            onClick={() => {
              setRoleDialogOpen(false);
              setRoleFormError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSaveRole}
            variant="contained"
            disabled={roleSaving}
            sx={{ borderRadius: "10px", textTransform: "none", fontWeight: 600, bgcolor: "#10b981", "&:hover": { bgcolor: "#059669" } }}
          >
            {roleSaving ? <CircularProgress size={18} sx={{ color: "#fff" }} /> : "Save Role"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Role delete blocked (in-use) message */}
      <Dialog
        open={!!roleDeleteBlockedMessage}
        onClose={() => setRoleDeleteBlockedMessage(null)}
        fullWidth
        maxWidth="xs"
        PaperProps={{ sx: { borderRadius: "20px", bgcolor: isDark ? "#1a1a1a" : "#fff" } }}
      >
        <DialogTitle sx={{ fontWeight: 700 }}>Cannot Delete Role</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            {roleDeleteBlockedMessage}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button onClick={() => setRoleDeleteBlockedMessage(null)} variant="contained" sx={{ bgcolor: "#10b981", "&:hover": { bgcolor: "#059669" } }}>
            OK
          </Button>
        </DialogActions>
      </Dialog>

      {/* Generic confirmation dialog — assign role / switch to manual / update
          in-use role / delete unused role */}
      <ConfirmDialog
        open={!!confirmDialog}
        title={confirmDialog?.title}
        description={confirmDialog?.description}
        confirmLabel={confirmDialog?.confirmLabel}
        onConfirm={() => confirmDialog?.onConfirm?.()}
        onCancel={() => setConfirmDialog(null)}
        isDark={isDark}
      />
    </Box>
  );
}
