import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { selectAiProvider } from "../../lib/ai-provider-selection.mjs";

const providerRuntimeSource = readFileSync(
  new URL("../../lib/ai-provider-runtime.ts", import.meta.url),
  "utf8",
);
const providerServerSource = readFileSync(
  new URL("../../lib/ai-provider-server.ts", import.meta.url),
  "utf8",
);
const generateRouteSource = readFileSync(
  new URL("../../app/api/generate/route.ts", import.meta.url),
  "utf8",
);
const guidelineRouteSource = readFileSync(
  new URL(
    "../../app/api/venue-guidelines/import/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const corpusRouteSource = readFileSync(
  new URL("../../app/api/corpus/analyze/route.ts", import.meta.url),
  "utf8",
);
const guidelineConfirmRouteSource = readFileSync(
  new URL(
    "../../app/api/venue-guidelines/confirm/route.ts",
    import.meta.url,
  ),
  "utf8",
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("the provider discriminator is required and is never inferred", () => {
  for (const environment of [
    {},
    { ORESOLVE_GENAI_API_KEY: "cloud-key" },
    { SCHOLAR_FLOW_LLAMA_MODEL: "local-model" },
    { SCHOLAR_FLOW_MODE: "offline" },
    { SCHOLAR_FLOW_MODE: "cloud" },
    { SCHOLAR_FLOW_AI_PROVIDER: "auto" },
    { SCHOLAR_FLOW_AI_PROVIDER: "OCI_OR_LOCAL" },
  ]) {
    assert.equal(
      selectAiProvider(environment).provider,
      "invalid",
      JSON.stringify(environment),
    );
  }
});

test("the deprecated mode only rejects contradictions", () => {
  assert.equal(
    selectAiProvider({ SCHOLAR_FLOW_AI_PROVIDER: "oci" }).provider,
    "oci",
  );
  assert.equal(
    selectAiProvider({
      SCHOLAR_FLOW_AI_PROVIDER: "oci",
      SCHOLAR_FLOW_MODE: "cloud",
    }).provider,
    "oci",
  );
  assert.equal(
    selectAiProvider({
      SCHOLAR_FLOW_AI_PROVIDER: "local_llama",
      SCHOLAR_FLOW_MODE: "offline",
    }).provider,
    "local_llama",
  );

  for (const environment of [
    {
      SCHOLAR_FLOW_AI_PROVIDER: "oci",
      SCHOLAR_FLOW_MODE: "offline",
    },
    {
      SCHOLAR_FLOW_AI_PROVIDER: "local_llama",
      SCHOLAR_FLOW_MODE: "cloud",
    },
    {
      SCHOLAR_FLOW_AI_PROVIDER: "oci",
      SCHOLAR_FLOW_MODE: "automatic",
    },
  ]) {
    const selected = selectAiProvider(environment);
    assert.equal(selected.provider, "invalid");
    assert.match(selected.error, /SCHOLAR_FLOW_MODE/u);
  }
});

test("provider runtime constructs only the explicitly selected configuration", () => {
  const runtimeFactory = sourceBetween(
    providerRuntimeSource,
    "export function getAiProviderRuntime",
    "\n}",
  );
  assert.match(runtimeFactory, /selectAiProvider\(environment\)/u);
  assert.match(
    runtimeFactory,
    /if \(selection\.provider === "local_llama"\) \{\s+const config = getOfflineRuntimeConfig\(environment\)/u,
  );
  assert.match(
    runtimeFactory,
    /const config = getOciRuntimeConfig\(environment\)/u,
  );
  assert.match(
    runtimeFactory,
    /if \(selection\.provider === "invalid"\) \{/u,
  );
  assert.doesNotMatch(runtimeFactory, /catch|fallback/iu);
});

test("generation and guideline dispatch call exactly one selected backend", () => {
  const generationDispatch = sourceBetween(
    providerServerSource,
    "export async function generatePaperWithProvider",
    "export async function extractVenueGuidelinesWithProvider",
  );
  assert.match(
    generationDispatch,
    /selected\.provider === "local_llama"\s+\? generateWithLocalLlama/u,
  );
  assert.match(generationDispatch, /: generateWithOci/u);
  assert.doesNotMatch(generationDispatch, /catch|fallback/iu);

  const guidelineDispatch = sourceBetween(
    providerServerSource,
    "export async function extractVenueGuidelinesWithProvider",
    "export async function verifyAiProviderAccess",
  );
  assert.match(
    guidelineDispatch,
    /selected\.provider === "local_llama"\s+\? extractVenueGuidelinesWithLocalLlama/u,
  );
  assert.match(
    guidelineDispatch,
    /: extractVenueGuidelinesWithOci/u,
  );
  assert.doesNotMatch(guidelineDispatch, /catch|fallback/iu);

  assert.match(generateRouteSource, /generatePaperWithProvider\(/u);
  assert.doesNotMatch(
    generateRouteSource,
    /generateWithLocalLlama\(|generateWithOci\(/u,
  );
  assert.match(
    guidelineRouteSource,
    /extractVenueGuidelinesWithProvider\(/u,
  );
  assert.doesNotMatch(
    guidelineRouteSource,
    /extractVenueGuidelinesWithLocalLlama\(|extractVenueGuidelinesWithOci\(/u,
  );
});

test("invalid provider configuration is rejected before backend dispatch", () => {
  const guard = sourceBetween(
    providerServerSource,
    "function configuredRuntime",
    "export async function generatePaperWithProvider",
  );
  assert.match(
    guard,
    /runtime\.provider === "invalid" \|\| runtime\.configurationError/u,
  );
  assert.match(guard, /throw new AiProviderConfigurationError/u);
  assert.doesNotMatch(guard, /generateWith|extractVenue/u);
});

test("deterministic signing routes validate the selector without probing a model", () => {
  for (const routeSource of [
    corpusRouteSource,
    guidelineConfirmRouteSource,
  ]) {
    assert.match(routeSource, /getAiProviderSelection\(\)/u);
    assert.match(routeSource, /getAiSigningRuntime\(\)/u);
    assert.doesNotMatch(
      routeSource,
      /getOfflineRuntimeConfig|getOciRuntimeConfig|verifyAiProviderAccess/u,
    );
  }
});

test("the local 16 GB profile serializes generation and bounds corpus evidence", () => {
  assert.match(
    generateRouteSource,
    /MAX_CONCURRENT_LOCAL_GENERATIONS = 1/u,
  );
  assert.match(
    generateRouteSource,
    /provider === "local_llama"\s+\? MAX_CONCURRENT_LOCAL_GENERATIONS/u,
  );
  assert.match(
    generateRouteSource,
    /LOCAL_MAX_COMBINED_EVIDENCE_CHARACTERS = 32_000/u,
  );
  assert.match(
    corpusRouteSource,
    /LOCAL_MAX_PACKET_CHARACTERS = 20_000/u,
  );
  assert.match(
    corpusRouteSource,
    /LOCAL_MIN_PACKET_CHARACTERS = 12_000/u,
  );
  assert.match(
    corpusRouteSource,
    /providerSelection === "local_llama"/u,
  );
});
