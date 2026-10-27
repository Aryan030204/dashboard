import { Suspense, lazy } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const AdsPage = lazy(() => import("../pages/Ads/AdsPage.jsx"));

export default function AdsRouteContainer({ hasBrand, activeBrandKey }) {
  if (!hasBrand) {
    return <EmptyStateCard message="Select a brand to view ad performance." />;
  }

  return (
    <Suspense fallback={<SectionFallback count={3} height={220} />}>
      <AdsPage brandKey={activeBrandKey} />
    </Suspense>
  );
}
