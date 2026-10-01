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
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const DRAWER_WIDTH = 260;

const AVATAR_COLORS = [
  "#F44336",
  "#E91E63",
  "#9C27B0",
  "#673AB7",
  "#3F51B5",
  "#2196F3",
  "#03A9F4",
  "#00BCD4",
  "#009688",
  "#4CAF50",
  "#8BC34A",
  "#CDDC39",
  "#FFEB3B",
  "#FFC107",
  "#FF9800",
  "#FF5722",
];

const getInitials = (name, email) => {
  const str = name || email || "U";
  return str.charAt(0).toUpperCase();
};

const getAvatarColor = (initial) => {
  const code = initial.charCodeAt(0);
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
};


const NAV_ITEMS = [
  {
    group: "main",
    items: [
      { id: "overall-snapshot", label: "Overall Snapshot", icon: LayoutGrid },
      { id: "dashboard", label: "Dashboard", icon: LayoutGrid },
      { id: "product-conversion", label: "Product Funnel", icon: Filter },
      { id: "daily-funnel", label: "Conversion Funnel", icon: Table2 },
      { id: "bundles", label: "Bundles", icon: Table2 },
      { id: "inventory", label: "Inventory", icon: Package },
      { id: "web-vitals", label: "Web Vitals", icon: Gauge },
      { id: "requests", label: "Requests", icon: ClipboardList },
    ],
  },
  {
    group: "admin",
    items: [
      { id: "access", label: "Access Control", icon: ShieldCheck },
      { id: "session-analytics", label: "Dashboard Sessions", icon: Activity },
      { id: "health-monitor", label: "Health Monitor", icon: HeartPulse },
      { id: "alerts", label: "Alerts", icon: Bell },
      {
        id: "traffic-split-config",
        label: "Configurations",
        icon: SlidersHorizontal,
      },
      { id: "tenant-setup", label: "Tenant Setup", icon: Store },
      { id: "client-settings", label: "Client Side Settings", icon: Settings },
      //      { id: 'notifications-log', label: 'Notifications/Alerts', icon: Bell },
    ],
  },
];

export default function Sidebar({
  open,
  onClose,
  activeTab,
  onTabChange,
  darkMode = false,
  user,
  onLogout,
  allowedTabs, // Array of tab IDs. If provided, specific filtering is applied.
}) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("md"));
  const initials = getInitials(user?.name, user?.email);
  const avatarColor = getAvatarColor(initials);
  const roleLabel = user?.isAuthor
    ? "Admin"
    : user?.role
      ? String(user.role).replace(/^author$/i, "Admin")
      : "Viewer";

  const filteredNavItems = useMemo(() => {
    let base = NAV_ITEMS;
    if (allowedTabs) {
      const set = new Set(allowedTabs);
      base = NAV_ITEMS.map((group) => ({
        ...group,
        items: group.items.filter((item) => set.has(item.id)),
      })).filter((group) => group.items.length > 0);
    }

    if (isMobile) {
      base = base
        .map((group) => ({
          ...group,
          items: group.items.filter((item) => item.id !== "tenant-setup"),
        }))
        .filter((group) => group.items.length > 0);
    }

    return base;
  }, [allowedTabs, isMobile]);

  const NavContent = () => (
    <div
      className={cn(
        "flex flex-col h-full bg-white dark:bg-zinc-950",
        !isMobile && "border-r border-zinc-200 dark:border-zinc-800",
      )}
    >
      <div className="px-6 py-6 flex items-center justify-between">
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

      {/* Navigation Items */}
      <nav className="flex-1 px-4 space-y-6 overflow-y-auto">
        {filteredNavItems.map((section, sIdx) => (
          <div key={section.group} className="space-y-1">
            {sIdx > 0 && (
              <div className="my-4 border-t border-zinc-100 dark:border-zinc-800" />
            )}
            {section.items.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;

              return (
                <button
                  key={item.id}
                  onClick={() => {
                    onTabChange(item.id);
                    if (isMobile) onClose();
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors text-sm font-medium",
                    isActive
                      ? "bg-black text-white dark:bg-white dark:text-black shadow-sm"
                      : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-900",
                  )}
                >
                  <Icon
                    size={18}
                    className={
                      isActive ? "text-white dark:text-black" : "text-zinc-400"
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
      <div className="p-4 border-t border-zinc-100 dark:border-zinc-800 space-y-4">
        <div className="flex items-center gap-3 px-2">
          <Avatar
            src={user?.avatar_url || user?.picture || ""}
            alt={user?.name || user?.email || "User"}
            sx={{
              width: 40,
              height: 40,
              borderRadius: "10px",
              bgcolor: avatarColor,
              color: "#fff",
              fontSize: "1rem",
              fontWeight: "bold",
            }}
          >
            {!user?.avatar_url && !user?.picture && initials}
          </Avatar>
          <div className="flex flex-col items-start text-left min-w-0">
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate w-full uppercase">
              {user?.name || user?.email?.split("@")[0] || "User"}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 capitalize">
              {roleLabel}
            </span>
          </div>
        </div>

        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 transition-colors"
        >
          <LogOut size={16} />
          Logout
        </button>

        {/*
        <div className="flex justify-center pt-1 pb-4">
          <img
            src="/brand-logo.jpg"
            alt="TechIt"
            className={cn(
              "h-9 w-auto object-contain opacity-70",
              darkMode && "invert hue-rotate-180 brightness-1.5"
            )}
          />
        </div>
*/}
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
