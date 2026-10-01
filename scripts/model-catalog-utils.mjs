export function omitEmptyProviders(providers) {
  return Object.fromEntries(Object.entries(providers).filter(([, models]) => models.length > 0));
}
