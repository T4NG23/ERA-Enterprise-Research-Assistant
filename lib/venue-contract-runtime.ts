import "server-only";

import { resolveVenueContractSigningSecret } from "@/lib/venue-contract-secret.mjs";

function signingEnvironment() {
  return {
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET:
      process.env.SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET,
  };
}

export function venueContractSigningSecret() {
  return resolveVenueContractSigningSecret({
    ...signingEnvironment(),
  }).secret;
}

export function venueContractSigningHealth() {
  const resolved = resolveVenueContractSigningSecret(signingEnvironment());
  const usesDedicatedSecret = resolved.mode === "dedicated_secret";
  return {
    configured: resolved.status === "ready",
    mode: resolved.mode,
    stableAcrossModelChanges: usesDedicatedSecret,
    warning:
      resolved.status !== "ready"
        ? resolved.error
        : usesDedicatedSecret
          ? ""
          : "Offline mode requires a dedicated venue-contract signing secret.",
  };
}
