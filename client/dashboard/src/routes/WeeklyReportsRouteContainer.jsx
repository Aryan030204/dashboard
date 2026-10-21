import { Suspense, lazy } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const WeeklyReportsPage = lazy(() => import("../pages/WeeklyReports/WeeklyReportsPage.jsx"));

export default function WeeklyReportsRouteContainer({ hasBrand, activeBrandKey, isManager }) {
  if (!hasBrand) {
    return <EmptyStateCard message="Select a brand to view weekly reports." />;
  }

  return (
    <Suspense fallback={<SectionFallback count={2} height={220} />}>
      <WeeklyReportsPage brandKey={activeBrandKey} isManager={isManager} />
    </Suspense>
  );
}
