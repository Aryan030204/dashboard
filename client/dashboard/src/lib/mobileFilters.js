// Rules for the phone filter sheet, which collects choices and applies them together. Keep this file free of imports
// so `node --test` can load it.

const toList = (value) => (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean);
const productIds = (product) => toList(product).map((item) => item?.id).filter(Boolean);

// What a filter amounts to, so that "", [] and "All products" all mean "not set".
const comparable = {
  product: (value) => productIds(value),
  utm: (value) => ["source", "medium", "campaign", "term", "content"].map((field) => [...toList(value?.[field])].sort()),
  salesChannel: (value) => [...toList(value)].sort(),
  city: (value) => [...toList(value)].sort(),
  deviceType: (value) => [...toList(value)].sort(),
  productType: (value) => [...toList(value)].sort(),
  discountCode: (value) => value || "",
};

// Applying one filter can clear others (App.jsx), so only the changed ones are sent, and the discount code, which
// clears everything else, goes last. Returns the changed keys in the order to apply them.
export function changedFilters(next, current) {
  return Object.keys(comparable).filter(
    (key) => JSON.stringify(comparable[key](next[key])) !== JSON.stringify(comparable[key](current[key])),
  );
}

// The same lock-out rules as the desktop filter bar, worked out from the choices on screen: sales channel, device
// type, city, discount code and product type each exclude every other filter; product and UTM exclude each other
// (except UTM source, for users allowed to combine them).
export function blockedFilters(selection, { canSync = false } = {}) {
  const has = {
    product: productIds(selection.product).length > 0,
    source: toList(selection.utm?.source).length > 0,
    otherUtm: ["medium", "campaign", "term", "content"].some((field) => toList(selection.utm?.[field]).length > 0),
    salesChannel: toList(selection.salesChannel).length > 0,
    city: toList(selection.city).length > 0,
    deviceType: toList(selection.deviceType).length > 0,
    productType: toList(selection.productType).length > 0,
    discountCode: !!selection.discountCode,
  };
  const exclusive = ["salesChannel", "deviceType", "city", "discountCode", "productType"];
  const anyExclusive = exclusive.some((key) => has[key]);
  const hasUtm = has.source || has.otherUtm;
  const group = (own) => exclusive.some((key) => key !== own && has[key]) || has.product || hasUtm;

  return {
    product: anyExclusive || (canSync ? has.otherUtm : hasUtm),
    utm: anyExclusive || (!canSync && has.product),
    utmMediumCampaign: anyExclusive || has.product,
    ...Object.fromEntries(exclusive.map((key) => [key, group(key)])),
  };
}
