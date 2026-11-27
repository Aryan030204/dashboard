// Display metadata for the sidebar: five headed buckets.
// It carries NO permission data:
// authorization stays with `allowedTabs` (derived from `accessibleTabs` in App.jsx).
// `icon` is a lucide-react icon NAME; Sidebar.jsx maps it to the component.
// Keep this file free of imports so `node --test` can load it.
// Parity with the original Sidebar is enforced by src/config/navigation.parity.node.test.js.

export const NAV_GROUPS = [
  {
    group: "overview",
    label: "Overview",
    items: [
      { id: "overall-snapshot", label: "Overall Snapshot", icon: "LayoutGrid" },
      { id: "dashboard", label: "Dashboard", icon: "LayoutGrid" },
    ],
  },
  {
    group: "funnels",
    label: "Funnels",
    items: [
      { id: "product-conversion", label: "Product Funnel", icon: "Filter" },
      { id: "daily-funnel", label: "Conversion Funnel", icon: "Table2" },
      { id: "intent-funnel", label: "Intent Funnel", icon: "Target" },
    ],
  },
  {
    group: "commerce",
    label: "Commerce",
    items: [
      { id: "bundles", label: "Bundles", icon: "Table2" },
      { id: "inventory", label: "Inventory", icon: "Package" },
      { id: "pnl", label: "P&L", icon: "Wallet" },
      { id: "ads", label: "Ads", icon: "Megaphone" },
    ],
  },
  {
    group: "performance-ops",
    label: "Performance & Ops",
    items: [
      { id: "web-vitals", label: "Web Vitals", icon: "Gauge" },
      { id: "requests", label: "Requests", icon: "ClipboardList" },
      { id: "weekly-reports", label: "Weekly Reports", icon: "Presentation" },
      { id: "ndd-sla", label: "NDD / SLA", icon: "Truck" },
    ],
  },
  {
    group: "admin",
    label: "Admin",
    items: [
      { id: "access", label: "Access Control", icon: "ShieldCheck" },
      { id: "session-analytics", label: "Dashboard Sessions", icon: "Activity" },
      { id: "health-monitor", label: "Health Monitor", icon: "HeartPulse" },
      { id: "alerts", label: "Alerts", icon: "Bell" },
      { id: "traffic-split-config", label: "Configurations", icon: "SlidersHorizontal" },
      { id: "tenant-setup", label: "Tenant Setup", icon: "Store" },
      { id: "client-settings", label: "Client Side Settings", icon: "Settings" },
    ],
  },
];

// Same filtering the Sidebar always did:
//  1. when `allowedTabs` is provided, keep only those ids and drop empty groups;
//  2. on mobile, hide only "tenant-setup" and drop empty groups.
export function filterNavGroups(groups, { allowedTabs, isMobile } = {}) {
  let base = groups;
  if (allowedTabs) {
    const set = new Set(allowedTabs);
    base = groups
      .map((group) => ({ ...group, items: group.items.filter((item) => set.has(item.id)) }))
      .filter((group) => group.items.length > 0);
  }
  if (isMobile) {
    base = base
      .map((group) => ({ ...group, items: group.items.filter((item) => item.id !== "tenant-setup") }))
      .filter((group) => group.items.length > 0);
  }
  return base;
}

// Breadcrumb = current page title only (no section labels).
const EXTRA_TITLES = { "notifications-log": "Notifications" };
export function getPageTitle(tabId) {
  for (const g of NAV_GROUPS) {
    const hit = g.items.find((i) => i.id === tabId);
    if (hit) return hit.label;
  }
  return EXTRA_TITLES[tabId] || "";
}
