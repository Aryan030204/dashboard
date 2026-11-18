import dayjs from "dayjs";

export const DEFAULT_DATA_RESTRICTION_CONFIG = {
  enabled: true,
  periodDays: 31,
};

export function normalizeDataRestrictionConfig(config = {}) {
  const enabled =
    typeof config?.enabled === "boolean"
      ? config.enabled
      : DEFAULT_DATA_RESTRICTION_CONFIG.enabled;
  const parsedPeriod = Number.parseInt(String(config?.periodDays ?? ""), 10);
  const periodDays =
    Number.isFinite(parsedPeriod) && parsedPeriod > 0
      ? parsedPeriod
      : DEFAULT_DATA_RESTRICTION_CONFIG.periodDays;
  return { enabled, periodDays };
}

export function isRangeOverDataRestrictionPeriod(start, end, config = {}) {
  if (!start || !end) return false;
  const normalizedConfig = normalizeDataRestrictionConfig(config);
  if (!normalizedConfig.enabled) return false;
  const s = dayjs(start);
  const e = dayjs(end);
  if (!s.isValid() || !e.isValid()) return false;
  return (
    e.startOf("day").diff(s.startOf("day"), "day") + 1 >
    normalizedConfig.periodDays
  );
}

export function getDataRestrictionDescription(config = {}) {
  const normalizedConfig = normalizeDataRestrictionConfig(config);
  return `Unavailable for > ${normalizedConfig.periodDays} days`;
}

export function getDataRestrictionWarningText(config = {}) {
  const normalizedConfig = normalizeDataRestrictionConfig(config);
  return `UTM filters are unavailable for date ranges over ${normalizedConfig.periodDays} days`;
}

export function isRangeOver30DaysInclusive(start, end, config = {}) {
  return isRangeOverDataRestrictionPeriod(start, end, config);
}
