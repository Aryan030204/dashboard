import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";

const InventoryTable = lazy(() => import("../components/InventoryTable.jsx"));
const InventoryOosTrend = lazy(() => import("../components/InventoryOosTrend.jsx"));

export default function InventoryRouteContainer({
  hasBrand,
  activeBrandKey,
  productTableStart,
  productTableEnd,
}) {
  // The product picked in the table, shown on the out-of-stock trend below it.
  const [selectedProduct, setSelectedProduct] = useState(null);

  useEffect(() => {
    setSelectedProduct(null);
  }, [activeBrandKey]);

  const handleSelectProduct = useCallback((row) => {
    setSelectedProduct(
      row && row.product_id
        ? { productId: String(row.product_id), title: row.landing_page_path || "" }
        : null,
    );
  }, []);

  if (!hasBrand) {
    return (
      <EmptyStateCard message="Select a brand to view inventory metrics." />
    );
  }

  return (
    <>
      <Suspense fallback={<SectionFallback count={1} height={280} />}>
        <InventoryTable
          brandKey={activeBrandKey}
          startDate={productTableStart}
          endDate={productTableEnd}
          selectedProductId={selectedProduct?.productId || null}
          onSelectProduct={handleSelectProduct}
        />
      </Suspense>
      <Suspense fallback={<SectionFallback count={1} height={320} />}>
        <InventoryOosTrend
          brandKey={activeBrandKey}
          selectedProduct={selectedProduct}
          onClearProduct={() => setSelectedProduct(null)}
        />
      </Suspense>
    </>
  );
}
