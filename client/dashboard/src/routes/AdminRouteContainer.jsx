import { Suspense, lazy } from "react";
import { Box, Stack } from "@mui/material";
import { motion } from "framer-motion";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const MotionDiv = motion.div;

const AccessControlCard = lazy(() => import("../components/AccessControlCard.jsx"));
const TrafficSplitConfigPanel = lazy(
  () => import("../components/TrafficSplitConfigPanel.jsx"),
);
const AlertsAdmin = lazy(() => import("../components/AlertsAdmin.jsx"));
const NotificationsLog = lazy(() => import("../components/NotificationsLog.jsx"));
const TenantSetupForm = lazy(() => import("../components/TenantSetupForm.jsx"));
const LogsPanel = lazy(() => import("../components/LogsPanel.jsx"));
const ClientSideSettingsForm = lazy(
  () => import("../components/ClientSideSettingsForm.jsx"),
);

export default function AdminRouteContainer({
  tab,
  direction,
  pageVariants,
  isMobile,
  hasBrand,
  authorBrands,
  authorBrandKey,
  darkMode,
  trafficSplitRules,
  setTrafficSplitRules,
}) {
  if (tab === "access") {
    return (
      <Suspense fallback={<SectionFallback count={2} />}>
        <Stack spacing={{ xs: 2, md: 3 }}>
          <AccessControlCard />
        </Stack>
      </Suspense>
    );
  }

  if (tab === "traffic-split-config") {
    if (!hasBrand) {
      return (
        <EmptyStateCard message="Select a brand to configure traffic split mapping." />
      );
    }

    return (
      <Suspense fallback={<SectionFallback count={1} height={220} />}>
        <Stack spacing={{ xs: 2, md: 3 }}>
          <TrafficSplitConfigPanel
            rules={trafficSplitRules}
            onAddRule={(rule) => setTrafficSplitRules((prev) => [...prev, rule])}
            onRemoveRule={(id) =>
              setTrafficSplitRules((prev) => prev.filter((r) => r.id !== id))
            }
            onClearRules={() => setTrafficSplitRules([])}
          />
        </Stack>
      </Suspense>
    );
  }

  if (tab === "alerts") {
    if (!authorBrands.length) {
      return (
        <EmptyStateCard message="Add at least one brand to start configuring alerts." />
      );
    }

    return (
      <Suspense fallback={<SectionFallback />}>
        <AlertsAdmin brands={authorBrands} defaultBrandKey={authorBrandKey} />
      </Suspense>
    );
  }

  if (tab === "notifications-log") {
    return (
      <Suspense fallback={<SectionFallback />}>
        <NotificationsLog darkMode={darkMode === "dark"} />
      </Suspense>
    );
  }

  if (tab === "tenant-setup" && !isMobile) {
    return (
      <MotionDiv
        key="tenant-setup"
        custom={direction}
        variants={pageVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ width: "100%" }}
      >
        <Suspense fallback={<SectionFallback count={1} />}>
          <Stack spacing={2}>
            <TenantSetupForm onOnboard={(data) => console.log("Onboard:", data)} />
            <LogsPanel />
          </Stack>
        </Suspense>
      </MotionDiv>
    );
  }

  if (tab === "client-settings" && !isMobile) {
    return (
      <MotionDiv
        key="client-settings"
        custom={direction}
        variants={pageVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        style={{ width: "100%" }}
      >
        <Suspense fallback={<SectionFallback count={1} />}>
          <ClientSideSettingsForm />
        </Suspense>
      </MotionDiv>
    );
  }

  return <Box />;
}
