import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import { Stack } from "@mui/material";
import { EmptyStateCard, SectionFallback } from "./shared/RouteUi.jsx";
import { PageHeader } from "../components/datum/index.js";

const InventorySnapshot = lazy(() => import("../components/InventorySnapshot.jsx"));
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
    <Stack spacing={2.5}>
      <PageHeader
        title="Inventory"
        description="Stock-outs, sales velocity and days on hand per SKU"
      />
      <Suspense fallback={<SectionFallback count={1} height={320} />}>
        <InventorySnapshot key={activeBrandKey} brandKey={activeBrandKey} />
      </Suspense>
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
          onSelectProduct={setSelectedProduct}
          onClearProduct={() => setSelectedProduct(null)}
        />
      </Suspense>
    </Stack>
  );
}
