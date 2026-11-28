// Navigation parity: src/config/navigation.js must reproduce the ORIGINAL Sidebar navigation
// (groups, items, order, labels, icons, gating and the mobile rule) exactly.
// BASELINE below is a verbatim copy of the original Sidebar.jsx NAV_ITEMS (icon names instead of components)
// and ORIGINAL_FILTER is a verbatim copy of its original filter logic.
// Run with: node --test src/config/navigation.parity.node.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { NAV_GROUPS, filterNavGroups, getPageTitle } from "./navigation.js";

const BASELINE = [
  { group: "overview", title: "Overview", items: [
    ["overall-snapshot", "Overall Snapshot", "LayoutGrid"],
    ["dashboard", "Dashboard", "LayoutGrid"],
  ] },
  { group: "funnels", title: "Funnels", items: [
    ["product-conversion", "Product Funnel", "Filter"],
    ["daily-funnel", "Conversion Funnel", "Table2"],
    ["intent-funnel", "Intent Funnel", "Target"],
  ] },
  { group: "commerce", title: "Commerce", items: [
    ["bundles", "Bundles", "Table2"],
    ["inventory", "Inventory", "Package"],
    ["pnl", "P&L", "Wallet"],
    ["ads", "Ads", "Megaphone"],
    ["marketplace-history", "Marketplace history", "Tags"],
  ] },
  { group: "performance-ops", title: "Performance & Ops", items: [
    ["web-vitals", "Web Vitals", "Gauge"],
    ["requests", "Requests", "ClipboardList"],
    ["weekly-reports", "Weekly Reports", "Presentation"],
    ["ndd-sla", "NDD / SLA", "Truck"],
  ] },
  { group: "admin", title: "Admin", items: [
    ["access", "Access Control", "ShieldCheck"],
    ["session-analytics", "Dashboard Sessions", "Activity"],
    ["health-monitor", "Health Monitor", "HeartPulse"],
    ["alerts", "Alerts", "Bell"],
    ["traffic-split-config", "Configurations", "SlidersHorizontal"],
    ["tenant-setup", "Tenant Setup", "Store"],
    ["client-settings", "Client Side Settings", "Settings"],
  ] },
].map((g) => ({ group: g.group, label: g.title, items: g.items.map(([id, label, icon]) => ({ id, label, icon })) }));

// Verbatim original logic from Sidebar.jsx (filteredNavItems).
function ORIGINAL_FILTER(NAV_ITEMS, allowedTabs, isMobile) {
  let base = NAV_ITEMS;
  if (allowedTabs) {
    const set = new Set(allowedTabs);
    base = NAV_ITEMS.map((group) => ({ ...group, items: group.items.filter((item) => set.has(item.id)) })).filter(
      (group) => group.items.length > 0,
    );
  }
  if (isMobile) {
    base = base
      .map((group) => ({ ...group, items: group.items.filter((item) => item.id !== "tenant-setup") }))
      .filter((group) => group.items.length > 0);
  }
  return base;
}

test("five headed buckets, in order", () => {
  assert.deepEqual(NAV_GROUPS.map((g) => g.label), [
    "Overview", "Funnels", "Commerce", "Performance & Ops", "Admin",
  ]);
});

test("items, order, labels and icons per bucket", () => {
  assert.deepEqual(NAV_GROUPS, BASELINE);
});

// accessibleTabs fixtures as produced by App.jsx (null = author = no filtering).
const FIXTURES = {
  author: null,
  dashboardOnly: ["dashboard"],
  partialViewer: ["overall-snapshot", "dashboard", "daily-funnel", "bundles", "ads"],
  withAdminGroupItems: ["dashboard", "session-analytics", "health-monitor"],
  everythingNonAuthorCanSee: ["overall-snapshot", "dashboard", "session-analytics", "daily-funnel", "intent-funnel", "requests", "bundles", "inventory", "web-vitals", "pnl", "ads", "health-monitor", "weekly-reports", "ndd-sla"],
  unknownIdsIgnored: ["dashboard", "not-a-tab"],
  empty: [],
};

for (const [name, allowedTabs] of Object.entries(FIXTURES)) {
  for (const isMobile of [false, true]) {
    test(`filter parity: ${name} / ${isMobile ? "mobile" : "desktop"}`, () => {
      assert.deepEqual(
        filterNavGroups(NAV_GROUPS, { allowedTabs, isMobile }),
        ORIGINAL_FILTER(BASELINE, allowedTabs, isMobile),
      );
    });
  }
}

test("mobile hides only tenant-setup (client-settings stays listed)", () => {
  const ids = filterNavGroups(NAV_GROUPS, { allowedTabs: null, isMobile: true }).flatMap((g) => g.items.map((i) => i.id));
  assert.ok(!ids.includes("tenant-setup"));
  assert.ok(ids.includes("client-settings"));
});

test("config carries no permission data", () => {
  for (const g of NAV_GROUPS) for (const i of g.items) assert.deepEqual(Object.keys(i).sort(), ["icon", "id", "label"]);
});

test("breadcrumb is the page title only", () => {
  assert.equal(getPageTitle("pnl"), "P&L");
  assert.equal(getPageTitle("ndd-sla"), "NDD / SLA");
  assert.equal(getPageTitle("notifications-log"), "Notifications");
  assert.equal(getPageTitle("nope"), "");
});
