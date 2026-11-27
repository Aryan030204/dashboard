import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Box,
  Drawer,
  IconButton,
  useTheme,
  useMediaQuery,
  Avatar,
} from "@mui/material";
import {
  LayoutGrid,
  Activity,
  HeartPulse,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  Table2,
  Bell,
  LogOut,
  Filter,
  Package,
  ClipboardList,
  Gauge,
  Settings,
  Target,
  Wallet,
  Megaphone,
  Presentation,
  Truck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { NAV_GROUPS, filterNavGroups } from "@/config/navigation";

const DRAWER_WIDTH = 260;

const getInitials = (name, email) => {
  const str = name || email || "U";
  return str.charAt(0).toUpperCase();
};

// Display metadata lives in src/config/navigation.js (same 2 groups/items/order as before).
const ICONS = {
  LayoutGrid,
  Activity,
  HeartPulse,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  Table2,
  Bell,
  Filter,
  Package,
  ClipboardList,
  Gauge,
  Settings,
  Target,
  Wallet,
  Megaphone,
  Presentation,
  Truck,
};
const NAV_ITEMS = NAV_GROUPS.map((group) => ({
  ...group,
  items: group.items.map((item) => ({ ...item, icon: ICONS[item.icon] })),
}));

export default function Sidebar({
  open,
  onClose,
  activeTab,
  onTabChange,
  darkMode = false,
  user,
  onLogout,
  allowedTabs, // Array of tab IDs. If provided, specific filtering is applied.
  brandKey = "", // Display only (read-only tenant card). Brand switching is unchanged and lives where it always did.
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const initials = getInitials(user?.name, user?.email);
  const roleLabel = user?.isAuthor
    ? "Admin"
    : user?.role
      ? String(user.role).replace(/^author$/i, "Admin")
      : "Viewer";

  const filteredNavItems = useMemo(
    () => filterNavGroups(NAV_ITEMS, { allowedTabs, isMobile }),
    [allowedTabs, isMobile],
  );
  const tenantLabel = String(brandKey || "").trim().toUpperCase();
  const tenantInitials = tenantLabel.replace(/[^A-Z0-9]/g, "").slice(0, 2);

  const NavContent = () => (
    <div
      className={cn(
        "flex flex-col h-full bg-[var(--dz-side)]",
        !isMobile && "border-r border-[var(--dz-line)]",
      )}
    >
      <div className="px-5 pt-5 pb-3 flex items-center justify-between">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <img
              src="/brand-logo-dark.png"
              alt="Datum"
              className={cn(
                "h-20 w-30",
                darkMode && "invert hue-rotate-180 brightness-1.2",
              )}
            />
          </div>
        </div>
      </div>

      {/* Read-only tenant card: shows the active brand. It is NOT a switcher. */}
      {tenantLabel ? (
        <div
          className="mx-3 mb-2 flex items-center gap-2.5 rounded-[10px] border border-[var(--dz-line)] bg-[var(--dz-panel)] px-2.5 py-2 shadow-[var(--dz-shadow)]"
          aria-label={`Active tenant ${tenantLabel}`}
        >
          <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-[var(--dz-accent-soft)] text-[12px] font-bold text-[var(--dz-accent)]">
            {tenantInitials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-[var(--dz-text)]">{tenantLabel}</span>
            <span className="block text-[11.5px] text-[var(--dz-muted)]">Tenant</span>
          </span>
        </div>
      ) : null}

      {/* Navigation Items */}
      <nav aria-label="Main" className="flex-1 px-3 space-y-5 overflow-y-auto pt-2">
        {filteredNavItems.map((section) => (
          <div key={section.group} role="group" aria-label={section.label} className="space-y-0.5">
            <p className="px-2.5 pb-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--dz-muted)]">
              {section.label}
            </p>
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => {
                    onTabChange(item.id);
                    if (isMobile) onClose();
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-2.5 min-h-[34px] rounded-lg transition-colors text-[13.5px] text-left",
                    isActive
                      ? "bg-[var(--dz-accent-soft)] text-[var(--dz-accent)] font-semibold"
                      : "font-medium text-[var(--dz-text-2)] hover:text-[var(--dz-text)] hover:bg-[var(--dz-hover)]",
                  )}
                >
                  <Icon
                    size={16}
                    className={
                      isActive ? "text-[var(--dz-accent)]" : "text-[var(--dz-muted)]"
                    }
                  />
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* User Profile Section */}
      <div className="p-4 border-t border-[var(--dz-line)] space-y-3">
        <div className="flex items-center gap-3 px-1">
          <Avatar
            src={user?.avatar_url || user?.picture || ""}
            alt={user?.name || user?.email || "User"}
            sx={{
              width: 32,
              height: 32,
              bgcolor: "var(--dz-sunk)",
              color: "var(--dz-text)",
              border: "1px solid var(--dz-line-2)",
              fontSize: "0.75rem",
              fontWeight: 600,
            }}
          >
            {!user?.avatar_url && !user?.picture && initials}
          </Avatar>
          <div className="flex flex-col items-start text-left min-w-0">
            <span className="text-[13px] font-semibold text-[var(--dz-text)] truncate w-full">
              {user?.name || user?.email?.split("@")[0] || "User"}
            </span>
            <span className="text-xs text-[var(--dz-muted)] capitalize">
              {roleLabel}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-[13px] font-medium text-[var(--dz-bad)] hover:bg-[var(--dz-bad-bg)] transition-colors"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer
        variant="temporary"
        open={open}
        onClose={onClose}
        ModalProps={{ keepMounted: true }}
        sx={{
          "& .MuiDrawer-paper": {
            width: DRAWER_WIDTH,
            boxSizing: "border-box",
            borderRight: "none",
          },
        }}
      >
        <NavContent />
      </Drawer>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={isMobile ? false : { x: -DRAWER_WIDTH }}
          animate={{ x: 0 }}
          exit={{ x: -DRAWER_WIDTH }}
          transition={{
            type: "spring",
            stiffness: 260,
            damping: 30,
          }}
          style={{
            width: DRAWER_WIDTH,
            height: "100vh",
            position: "fixed",
            left: 0,
            top: 0,
            zIndex: 1200,
          }}
        >
          <Box
            component="nav"
            sx={{
              width: "100%",
              height: "100%",
            }}
          >
            <NavContent />
          </Box>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
