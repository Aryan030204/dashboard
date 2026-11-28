// How permissions are named and grouped in Access Control. Display only: what is stored and checked is always the
// permission ids (api-gateway/src/constants/permissions.js). Keep this file free of imports so `node --test` can load it.
//
// An "option" is what an admin ticks: a permission id, or a group key standing for several ids that are given and
// removed together.

const NAMES = {
  all: "All Access",
  overall_snapshot: "Summary Dashboard",
  requests_panel: "Requests (View & Raise)",
  requests_timeline: "Requests (View Timeline)",
  bundles_panel: "Bundles Dashboard",
  inventory_panel: "Inventory Dashboard",
  daily_funnel_panel: "Conversion Funnel Dashboard",
  intent_funnel_panel: "Intent Dashboard",
  dashboard_layout_customize: "KPI Layout Customise",
  sessions_drop_off_funnel: "CR Funnel KPI",
  rto_kpi: "RTO KPI on Summary",
  web_vitals: "Web Vitals KPI on Summary",
  web_vitals_panel: "Web Vitals Dashboard",
  pnl_panel: "P&L Dashboard",
  ads_panel: "Ads Dashboard",
  marketplace_panel: "Marketplace Dashboard",
  weekly_report_preview: "Weekly Reports Dashboard",
  ndd_sla_panel: "NDD SLA Dashboard",
  ndd_sla_upload: "NDD SLA Upload",
  daily_insight_view: "Daily Insight KPI on Summary",
  product_conversion: "Product Conversion Dashboard",
  product_filter: "Products Filter for Summary",
  utm_filter: "UTM Filter for Summary",
  product_utm_filter_sync: "Product UTM Filter for Summary",
  discount_filter: "Discount Filter for Summary",
  sales_channel_filter: "Sales Channel Filter for Summary",
  device_type_filter: "Device Filter for Summary",
  product_type_filter: "Product Type Filter for Summary",
  city_filter: "City Filter for Summary",
  utm_funnel_table: "UTM Funnel on Conversions Dashboard",
  "utm_funnel_table:utm_campaign_grain": "Campaign Level on Conversions",
  session_analytics: "Datum Session Logs",
  health_monitor_panel: "Datum API Monitor",
  intent_metrics: "Intent Metrics (retired)",

  // members of the groups below
  compare_mode: "Compare Mode on Summary",
  multiselectable_kpi_cards: "Trend Graph Multiselect KPI",
  payment_split_order: "Pay Split (O) Summary",
  payment_split_sales: "Pay Split (R) Summary",
  traffic_split: "Traffic Split Summary",
  ci_events: "CI KPI on Summary",
  "product_conversion:landing_page_path": "Landing Page",
  "product_conversion:sessions": "Sessions",
  "product_conversion:atc": "ATC",
  "product_conversion:atc_rate": "ATC Rate",
  "product_conversion:orders": "Orders",
  "product_conversion:sales": "Sales",
  "product_conversion:cvr": "CVR",
  "product_conversion:drr": "DRR",
  "product_conversion:doh": "DOH",
  product_table_filters: "All table filters",
  "product_table_filters:inventory": "Inventory Analysis filter",
  "product_table_filters:page_type": "Page Type filter",
  "product_table_filters:product_types": "Product Types filter",
  "product_table_filters:sort_filter": "Sort filter",
};

export const GROUPS = [
  {
    key: "group:summary_extras",
    label: "Summary Extras",
    members: [
      "compare_mode",
      "multiselectable_kpi_cards",
      "payment_split_order",
      "payment_split_sales",
      "traffic_split",
      "ci_events",
    ],
  },
  {
    key: "group:product_funnel",
    label: "Filters for Product Funnel",
    members: [
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
    ],
  },
];

// No longer offered. Anyone who already has one keeps it until it is removed.
export const RETIRED = ["intent_metrics"];

export const CATEGORIES = [
  {
    label: "Dashboard",
    options: [
      "overall_snapshot",
      "requests_panel",
      "requests_timeline",
      "bundles_panel",
      "inventory_panel",
      "daily_funnel_panel",
      "intent_funnel_panel",
      "product_conversion",
      "web_vitals_panel",
      "pnl_panel",
      "ads_panel",
      "marketplace_panel",
      "weekly_report_preview",
      "ndd_sla_panel",
      "ndd_sla_upload",
      "group:summary_extras",
      "dashboard_layout_customize",
      "sessions_drop_off_funnel",
      "rto_kpi",
      "web_vitals",
      "daily_insight_view",
    ],
  },
  {
    label: "Filters",
    options: [
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
  { label: "Product Funnel", options: ["group:product_funnel"] },
  { label: "Datum Admin", options: ["session_analytics", "health_monitor_panel"] },
  { label: "Other", options: ["all"] },
];

export const ALL_OPTIONS = CATEGORIES.flatMap((category) => category.options);

const groupByKey = new Map(GROUPS.map((group) => [group.key, group]));
const groupByMember = new Map(GROUPS.flatMap((group) => group.members.map((id) => [id, group])));

export const isGroup = (option) => groupByKey.has(option);

export const categoryOf = (option) =>
  CATEGORIES.find((category) => category.options.includes(option))?.label || "Other";

// "off" | "partial" | "full"; a plain permission is only off or full.
export function optionState(option, permissions = []) {
  const members = groupByKey.get(option)?.members || [option];
  const held = members.filter((id) => permissions.includes(id)).length;
  if (!held) return "off";
  return held === members.length ? "full" : "partial";
}

export function addOption(option, permissions = []) {
  const members = groupByKey.get(option)?.members || [option];
  return [...permissions, ...members.filter((id) => !permissions.includes(id))];
}

export function removeOption(option, permissions = []) {
  const members = groupByKey.get(option)?.members || [option];
  return permissions.filter((id) => !members.includes(id));
}

// One click: off or partial gives everything, full removes it.
export function toggleOption(option, permissions = []) {
  return optionState(option, permissions) === "full"
    ? removeOption(option, permissions)
    : addOption(option, permissions);
}

// The options a list of ids amounts to, in the order they first appear.
export function selectedOptions(permissions = []) {
  return [...new Set(permissions.map((id) => groupByMember.get(id)?.key || id))];
}

// What to show for an option; `permissions` decides whether a group is only partly held.
export function optionLabel(option, permissions) {
  const group = groupByKey.get(option);
  if (!group) return NAMES[option] || option;
  return permissions && optionState(option, permissions) === "partial" ? `${group.label} (partial)` : group.label;
}

// Tooltip text for a group: what it contains, or what is held of it when partial.
export function optionHint(option, permissions) {
  const group = groupByKey.get(option);
  if (!group) return "";
  const names = (ids) => ids.map((id) => NAMES[id] || id).join(", ");
  if (permissions && optionState(option, permissions) === "partial") {
    return `Has only: ${names(group.members.filter((id) => permissions.includes(id)))}`;
  }
  return `Includes: ${names(group.members)}`;
}

// The names for a list of ids, for read-only places such as the CSV export.
export const permissionNames = (permissions = []) =>
  selectedOptions(permissions).map((option) => optionLabel(option, permissions));
