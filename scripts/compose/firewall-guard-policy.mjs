export function canRemoveBrowserBridgeGuard({ networkExists, inspectionSucceeded, endpoints }) {
  if (!inspectionSucceeded) return false;
  if (!networkExists) return true;
  if (!Array.isArray(endpoints)) return false;
  return endpoints.every((endpoint) => endpoint.running === false);
}
