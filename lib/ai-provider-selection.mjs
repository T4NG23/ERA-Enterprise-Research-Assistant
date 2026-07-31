const PROVIDERS = new Set(["oci", "local_llama"]);
const LEGACY_MODES = new Set(["", "offline", "cloud"]);

function environmentValue(environment, key) {
  return typeof environment?.[key] === "string"
    ? environment[key].trim()
    : "";
}

/**
 * Selects one provider from the explicit SCHOLAR_FLOW_AI_PROVIDER
 * discriminator. SCHOLAR_FLOW_MODE is retained only to reject stale,
 * contradictory configurations; it never selects a provider.
 */
export function selectAiProvider(environment = {}) {
  const selected = environmentValue(
    environment,
    "SCHOLAR_FLOW_AI_PROVIDER",
  ).toLowerCase();
  if (!PROVIDERS.has(selected)) {
    return Object.freeze({
      provider: "invalid",
      error: selected
        ? "SCHOLAR_FLOW_AI_PROVIDER must be exactly oci or local_llama."
        : "SCHOLAR_FLOW_AI_PROVIDER is required and must be exactly oci or local_llama.",
    });
  }

  const legacyMode = environmentValue(
    environment,
    "SCHOLAR_FLOW_MODE",
  ).toLowerCase();
  if (!LEGACY_MODES.has(legacyMode)) {
    return Object.freeze({
      provider: "invalid",
      error:
        "Deprecated SCHOLAR_FLOW_MODE must be blank, offline, or cloud. SCHOLAR_FLOW_AI_PROVIDER is the only provider selector.",
    });
  }
  if (
    (selected === "oci" && legacyMode === "offline") ||
    (selected === "local_llama" && legacyMode === "cloud")
  ) {
    return Object.freeze({
      provider: "invalid",
      error:
        "SCHOLAR_FLOW_MODE conflicts with SCHOLAR_FLOW_AI_PROVIDER. Remove SCHOLAR_FLOW_MODE or make the deprecated value consistent.",
    });
  }

  return Object.freeze({ provider: selected, error: "" });
}
