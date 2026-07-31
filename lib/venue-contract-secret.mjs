export const VENUE_CONTRACT_SECRET_MIN_BYTES = 32;
export const VENUE_CONTRACT_SECRET_MAX_BYTES = 1_024;

const encoder = new TextEncoder();

function boundedSecret(value) {
  const secret = typeof value === "string" ? value.trim() : "";
  if (!secret) return { secret: "", bytes: 0, valid: false };
  const bytes = encoder.encode(secret).byteLength;
  return {
    secret,
    bytes,
    valid:
      bytes >= VENUE_CONTRACT_SECRET_MIN_BYTES &&
      bytes <= VENUE_CONTRACT_SECRET_MAX_BYTES,
  };
}

/**
 * Resolves the server-only venue-contract HMAC secret without silently
 * downgrading an explicitly configured but invalid dedicated secret.
 */
export function resolveVenueContractSigningSecret(environment) {
  const dedicated = boundedSecret(
    environment?.SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET,
  );
  if (dedicated.secret) {
    if (!dedicated.valid) {
      return Object.freeze({
        status: "invalid",
        mode: "invalid_dedicated_secret",
        secret: "",
        error: `SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET must be ${VENUE_CONTRACT_SECRET_MIN_BYTES}–${VENUE_CONTRACT_SECRET_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes after trimming.`,
      });
    }
    return Object.freeze({
      status: "ready",
      mode: "dedicated_secret",
      secret: dedicated.secret,
      error: "",
    });
  }

  return Object.freeze({
    status: "missing",
    mode: "none",
    secret: "",
    error:
      "Set SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET before creating or compiling signed venue contracts. Cloud API keys are never used as signing material.",
  });
}
