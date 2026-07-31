import "server-only";

import {
  getOfflineRuntimeConfig,
  type OfflineRuntimeConfig,
} from "@/lib/offline-runtime";
import {
  getOciRuntimeConfig,
  type OciRuntimeConfig,
} from "@/lib/oci-runtime";
import { selectAiProvider } from "@/lib/ai-provider-selection.mjs";
import { resolveVenueContractSigningSecret } from "@/lib/venue-contract-secret.mjs";

export type AiProviderId = "oci" | "local_llama";
export type AiProviderSelection = AiProviderId | "invalid";

export type ProviderEnvironment = Record<string, string | undefined>;

interface SigningRuntime {
  venueSigningSecret: string;
  corpusSigningSecret: string;
  venueSigningError: string;
  corpusSigningError: string;
}

interface ProviderRuntimeBase extends SigningRuntime {
  provider: AiProviderSelection;
  configurationError: string | null;
}

export interface LocalLlamaProviderRuntime extends ProviderRuntimeBase {
  provider: "local_llama";
  config: OfflineRuntimeConfig;
}

export interface OciProviderRuntime extends ProviderRuntimeBase {
  provider: "oci";
  config: OciRuntimeConfig;
}

export interface InvalidProviderRuntime extends ProviderRuntimeBase {
  provider: "invalid";
  config: null;
}

export type AiProviderRuntime =
  | LocalLlamaProviderRuntime
  | OciProviderRuntime
  | InvalidProviderRuntime;

const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 1_024;

function environmentValue(
  environment: ProviderEnvironment,
  key: string,
) {
  return environment[key]?.trim() ?? "";
}

function corpusSigningSecret(
  environment: ProviderEnvironment,
) {
  const secret = environmentValue(
    environment,
    "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET",
  );
  if (!secret) {
    return {
      secret: "",
      error:
        "Set SCHOLAR_FLOW_CORPUS_SIGNING_SECRET before processing a Large Corpus evidence packet.",
    };
  }
  const bytes = new TextEncoder().encode(secret).byteLength;
  if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
    return {
      secret: "",
      error:
        "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET must contain 32–1,024 UTF-8 bytes after trimming.",
    };
  }
  return { secret, error: "" };
}

export function getAiSigningRuntime(
  environment: ProviderEnvironment = process.env,
): SigningRuntime {
  const venue = resolveVenueContractSigningSecret(environment);
  const corpus = corpusSigningSecret(environment);
  const sameSecret =
    venue.secret &&
    corpus.secret &&
    venue.secret === corpus.secret;
  return Object.freeze({
    venueSigningSecret: sameSecret ? "" : venue.secret,
    corpusSigningSecret: sameSecret ? "" : corpus.secret,
    venueSigningError: sameSecret
      ? "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET and SCHOLAR_FLOW_CORPUS_SIGNING_SECRET must be different dedicated secrets."
      : venue.error,
    corpusSigningError: sameSecret
      ? "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET and SCHOLAR_FLOW_CORPUS_SIGNING_SECRET must be different dedicated secrets."
      : corpus.error,
  });
}

export function getAiProviderSelection(
  environment: ProviderEnvironment = process.env,
): AiProviderSelection {
  return selectAiProvider(environment).provider as AiProviderSelection;
}

export function getAiProviderRuntime(
  environment: ProviderEnvironment = process.env,
): AiProviderRuntime {
  const selection = selectAiProvider(environment) as {
    provider: AiProviderSelection;
    error: string;
  };
  const signing = getAiSigningRuntime(environment);
  if (selection.provider === "invalid") {
    return Object.freeze({
      provider: "invalid",
      config: null,
      configurationError: selection.error,
      ...signing,
    });
  }

  if (selection.provider === "local_llama") {
    const config = getOfflineRuntimeConfig(environment);
    return Object.freeze({
      provider: "local_llama",
      config,
      configurationError: config.configurationError,
      ...signing,
    });
  }

  const config = getOciRuntimeConfig(environment);
  return Object.freeze({
    provider: "oci",
    config,
    configurationError:
      !config.enabled
        ? "OCI is selected but ORESOLVE_GENAI_ENABLED disables it."
        : config.configurationError,
    ...signing,
  });
}
