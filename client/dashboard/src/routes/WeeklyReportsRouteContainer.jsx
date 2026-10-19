import { Suspense, lazy } from "react";
import { SectionFallback } from "./shared/RouteUi.jsx";

const WeeklyReportsPanel = lazy(() => import("../components/weekly-reports/WeeklyReportsPanel.jsx"));

// The panel has its own brand dropdown (admins: every brand, others: their memberships), so it
// does not depend on the header's global brand selector, which is hidden on this tab.
export default function WeeklyReportsRouteContainer({ brands, brandsLoading, activeBrandKey, canManage }) {
  return (
    <Suspense fallback={<SectionFallback count={2} height={200} />}>
      <WeeklyReportsPanel
        brands={brands}
        brandsLoading={brandsLoading}
        initialBrandKey={activeBrandKey}
        canManage={Boolean(canManage)}
      />
    </Suspense>
  );
}
