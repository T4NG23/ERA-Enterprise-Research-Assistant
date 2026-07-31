import { readFileSync } from "node:fs";

const checks = [
  {
    file: "lib/ai-provider-selection.mjs",
    required: [
      /SCHOLAR_FLOW_AI_PROVIDER is required and must be exactly/u,
      /PROVIDERS\s*=\s*new Set\(\["oci", "local_llama"\]\)/u,
      /if \(!PROVIDERS\.has\(selected\)\)/u,
      /provider: "invalid"/u,
    ],
    forbidden: [
      /ORESOLVE_GENAI_API_KEY[^]*\?\s*"oci"/u,
      /SCHOLAR_FLOW_LLAMA_BASE_URL[^]*\?\s*"local_llama"/u,
    ],
  },
  {
    file: "lib/ai-provider-server.ts",
    required: [
      /selected\.provider === "local_llama"\s*\?\s*generateWithLocalLlama/u,
      /:\s*generateWithOci/u,
      /selected\.provider === "local_llama"\s*\?\s*extractVenueGuidelinesWithLocalLlama/u,
      /:\s*extractVenueGuidelinesWithOci/u,
    ],
    forbidden: [
      /catch\s*\([^)]*\)\s*\{[^}]*generateWith/u,
      /catch\s*\([^)]*\)\s*\{[^}]*extractVenue/u,
    ],
  },
  {
    file: "app/api/generate/route.ts",
    required: [
      /getAiProviderRuntime/u,
      /generatePaperWithProvider\(providerRuntime,/u,
    ],
    forbidden: [
      /\bgenerateWithOci\(/u,
      /\bgenerateWithLocalLlama\(/u,
    ],
  },
  {
    file: "app/api/venue-guidelines/import/route.ts",
    required: [
      /getAiProviderRuntime/u,
      /extractVenueGuidelinesWithProvider\(/u,
    ],
    forbidden: [
      /\bextractVenueGuidelinesWithOci\(/u,
      /\bextractVenueGuidelinesWithLocalLlama\(/u,
    ],
  },
  {
    file: "lib/local-llama-client.mjs",
    required: [
      /\/v1\/chat\/completions/u,
      /redirect:\s*"error"/u,
      /credentials:\s*"omit"/u,
      /new Set\(\["127\.0\.0\.1", "localhost", "::1"\]\)/u,
      /url\.protocol !== "http:"/u,
    ],
    forbidden: [
      /Authorization/u,
      /api\.openai\.com/iu,
      /oraclecloud\.com/iu,
    ],
  },
  {
    file: "scripts/provider-env.mjs",
    required: [
      /provider === "local_llama"\s*\?\s*withoutKeys\(environment, CLOUD_ENVIRONMENT_KEYS\)/u,
      /:\s*withoutKeys\(environment, LOCAL_LLAMA_ENVIRONMENT_KEYS\)/u,
      /result = withoutKeys\(result, LOCAL_LLAMA_ENVIRONMENT_KEYS\)/u,
      /delete result\.SCHOLAR_FLOW_CORPUS_SIGNING_SECRET/u,
    ],
    forbidden: [],
  },
];

const failures = [];
for (const check of checks) {
  const source = readFileSync(check.file, "utf8");
  for (const pattern of check.required) {
    if (!pattern.test(source)) {
      failures.push(`${check.file} is missing required invariant ${pattern}.`);
    }
  }
  for (const pattern of check.forbidden) {
    if (pattern.test(source)) {
      failures.push(`${check.file} violates invariant ${pattern}.`);
    }
  }
}

if (failures.length) {
  console.error("Provider-boundary audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    "Provider-boundary audit passed: selection is explicit, generation has one dispatcher with no fallback, the local Ollama-compatible endpoint is loopback-only, and the compiler receives no model credential.",
  );
  console.log(
    "This application audit is not an OS network boundary. Enforce outbound-network denial around a local deployment when hard zero egress is required.",
  );
}
