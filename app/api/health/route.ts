import { NextResponse } from "next/server";

import { getAiProviderRuntime } from "@/lib/ai-provider-runtime";
import { verifyAiProviderAccess } from "@/lib/ai-provider-server";
import { publicationProfiles } from "@/lib/publication-profiles";

export const runtime = "edge";

function signingHealth(secret: string, error: string) {
  const configured = Boolean(secret);
  const invalid =
    !configured &&
    /must (?:be|contain)|must be different/iu.test(error);
  return {
    configured,
    mode: configured
      ? "dedicated_secret"
      : invalid
        ? "invalid_dedicated_secret"
        : "none",
    stableAcrossModelChanges: true,
    warning: configured ? "" : error,
  };
}

function response(body: Record<string, unknown>) {
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET() {
  const selected = getAiProviderRuntime();
  const venueContractSigning = signingHealth(
    selected.venueSigningSecret,
    selected.venueSigningError,
  );
  const corpusSigning = signingHealth(
    selected.corpusSigningSecret,
    selected.corpusSigningError,
  );

  if (selected.provider === "invalid") {
    return response({
      provider: "invalid",
      mode: "invalid",
      configured: false,
      ready: false,
      status: "invalid_config",
      message:
        selected.configurationError ||
        "SCHOLAR_FLOW_AI_PROVIDER is not configured.",
      model: "AI backend",
      transport: null,
      profiles: publicationProfiles.length,
      venueContractSigning,
      corpusSigning,
    });
  }

  const mode =
    selected.provider === "local_llama"
      ? "isolated"
      : "cloud_testing";
  const transport =
    selected.provider === "local_llama"
      ? "local_chat_completions"
      : selected.config.transport === "responses"
        ? "oci_responses"
        : "oci_chat";
  const common = {
    provider: selected.provider,
    mode,
    model: selected.config.model,
    maxOutputTokens: selected.config.maxOutputTokens,
    transport,
    profiles: publicationProfiles.length,
    venueContractSigning,
    corpusSigning,
    ...(selected.provider === "local_llama"
      ? {
          contextTokens: selected.config.contextTokens,
          vision: selected.config.vision,
          baseUrl: selected.config.baseUrl,
          region: "local",
        }
      : {
          region: selected.config.region,
        }),
  };

  if (selected.configurationError) {
    return response({
      ...common,
      configured: false,
      ready: false,
      status: "invalid_config",
      message: selected.configurationError,
    });
  }

  if (selected.provider === "oci" && !selected.config.apiKey) {
    return response({
      ...common,
      configured: false,
      ready: false,
      status: "missing",
      message:
        "Set ORESOLVE_GENAI_API_KEY for the explicitly selected OCI provider, then restart Scholar Flow.",
    });
  }

  if (
    selected.provider === "oci" &&
    selected.config.transport === "responses" &&
    !selected.config.projectId
  ) {
    return response({
      ...common,
      configured: false,
      ready: false,
      status: "project_required",
      message:
        "OCI Responses mode requires ORESOLVE_GENAI_PROJECT_ID for OCI Files access.",
    });
  }

  const access = await verifyAiProviderAccess(selected);
  return response({
    ...common,
    configured: true,
    ...access,
  });
}
