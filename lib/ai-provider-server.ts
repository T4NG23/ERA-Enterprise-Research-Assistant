import "server-only";

import type {
  AiProviderRuntime,
  LocalLlamaProviderRuntime,
  OciProviderRuntime,
} from "@/lib/ai-provider-runtime";
import {
  generateWithLocalLlama,
  generateWithOci,
  type GeneratePaperProviderInput,
} from "@/lib/oci-server";
import {
  extractVenueGuidelinesWithLocalLlama,
  extractVenueGuidelinesWithOci,
  type ExtractVenueGuidelinesProviderInput,
} from "@/lib/venue-guideline-extractor";
import {
  verifyOfflineLlamaAccess,
} from "@/lib/offline-runtime";
import {
  verifyOciAccess,
} from "@/lib/oci-runtime";

export class AiProviderConfigurationError extends Error {
  readonly code = "AI_PROVIDER_INVALID_CONFIGURATION";
  readonly httpStatus = 503;

  constructor(message: string) {
    super(message);
    this.name = "AiProviderConfigurationError";
  }
}
function configuredRuntime(
  runtime: AiProviderRuntime,
): LocalLlamaProviderRuntime | OciProviderRuntime {
  if (runtime.provider === "invalid" || runtime.configurationError) {
    throw new AiProviderConfigurationError(
      runtime.configurationError ||
        "SCHOLAR_FLOW_AI_PROVIDER is not configured.",
    );
  }
  return runtime;
}

export async function generatePaperWithProvider(
  runtime: AiProviderRuntime,
  input: GeneratePaperProviderInput,
) {
  const selected = configuredRuntime(runtime);
  return selected.provider === "local_llama"
    ? generateWithLocalLlama({
        ...input,
        config: selected.config,
      })
    : generateWithOci({
        ...input,
        config: selected.config,
      });
}

export async function extractVenueGuidelinesWithProvider(
  runtime: AiProviderRuntime,
  input: ExtractVenueGuidelinesProviderInput,
) {
  const selected = configuredRuntime(runtime);
  return selected.provider === "local_llama"
    ? extractVenueGuidelinesWithLocalLlama({
        ...input,
        config: selected.config,
      })
    : extractVenueGuidelinesWithOci({
        ...input,
        config: selected.config,
      });
}

export async function verifyAiProviderAccess(
  runtime: AiProviderRuntime,
) {
  const selected = configuredRuntime(runtime);
  return selected.provider === "local_llama"
    ? verifyOfflineLlamaAccess(selected.config)
    : verifyOciAccess(selected.config);
}
