import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export const CLOUD_ENVIRONMENT_KEYS = Object.freeze([
  "ORESOLVE_GENAI_API_KEY",
  "ORESOLVE_GENAI_BASE_URL",
  "ORESOLVE_GENAI_ENABLED",
  "ORESOLVE_GENAI_MAX_OUTPUT_TOKENS",
  "ORESOLVE_GENAI_MODEL",
  "ORESOLVE_GENAI_PROJECT_ID",
  "ORESOLVE_GENAI_REGION",
  "ORESOLVE_GENAI_TRANSPORT",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
]);

export const LOCAL_LLAMA_ENVIRONMENT_KEYS = Object.freeze([
  "SCHOLAR_FLOW_OLLAMA_BASE_URL",
  "SCHOLAR_FLOW_OLLAMA_MODEL",
  "SCHOLAR_FLOW_OLLAMA_CONTEXT_TOKENS",
  "SCHOLAR_FLOW_OLLAMA_MAX_OUTPUT_TOKENS",
  "SCHOLAR_FLOW_OLLAMA_VISION_ENABLED",
  "SCHOLAR_FLOW_LLAMA_BASE_URL",
  "SCHOLAR_FLOW_LLAMA_MODEL",
  "SCHOLAR_FLOW_LLAMA_MODEL_PATH",
  "SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS",
  "SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS",
  "SCHOLAR_FLOW_LLAMA_VISION_ENABLED",
]);

const PROVIDERS = new Set(["oci", "local_llama"]);
const SCHOLAR_FLOW_RUNTIME_KEYS = Object.freeze([
  "SCHOLAR_FLOW_AI_PROVIDER",
  "SCHOLAR_FLOW_MODE",
  "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET",
  "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET",
  "SCHOLAR_FLOW_LATEX_COMPILER_URL",
  "SCHOLAR_FLOW_LATEX_COMPILER_TOKEN",
  "TECTONIC_ONLY_CACHED",
]);

export function loadActiveEnvironmentFile() {
  if (!existsSync(".env.local")) return "";
  for (const key of [
    ...CLOUD_ENVIRONMENT_KEYS,
    ...LOCAL_LLAMA_ENVIRONMENT_KEYS,
    ...SCHOLAR_FLOW_RUNTIME_KEYS,
  ]) {
    delete process.env[key];
  }
  loadEnvFile(".env.local");
  return ".env.local";
}

export function selectedProvider(environment = process.env) {
  const provider =
    environment.SCHOLAR_FLOW_AI_PROVIDER?.trim().toLowerCase() ?? "";
  if (!PROVIDERS.has(provider)) {
    throw new Error(
      "SCHOLAR_FLOW_AI_PROVIDER must be explicitly set to oci or local_llama. Scholar Flow never chooses or falls back to a provider automatically.",
    );
  }
  return provider;
}

function withoutKeys(environment, keys) {
  const result = { ...environment };
  for (const key of keys) delete result[key];
  return result;
}

export function webChildEnvironment(
  environment = process.env,
  overrides = {},
) {
  const provider = selectedProvider(environment);
  const providerEnvironment =
    provider === "local_llama"
      ? withoutKeys(environment, CLOUD_ENVIRONMENT_KEYS)
      : withoutKeys(environment, LOCAL_LLAMA_ENVIRONMENT_KEYS);

  return {
    ...providerEnvironment,
    SCHOLAR_FLOW_AI_PROVIDER: provider,
    SCHOLAR_FLOW_MODE:
      provider === "local_llama" ? "offline" : "cloud",
    SCHOLAR_FLOW_LATEX_COMPILER_URL:
      "http://127.0.0.1:3101/compile",
    TECTONIC_ONLY_CACHED: "1",
    ...overrides,
  };
}

export function compilerChildEnvironment(
  environment = process.env,
  overrides = {},
) {
  let result = withoutKeys(environment, CLOUD_ENVIRONMENT_KEYS);
  result = withoutKeys(result, LOCAL_LLAMA_ENVIRONMENT_KEYS);
  delete result.SCHOLAR_FLOW_AI_PROVIDER;
  delete result.SCHOLAR_FLOW_MODE;
  delete result.SCHOLAR_FLOW_CORPUS_SIGNING_SECRET;

  return {
    ...result,
    HOST: "127.0.0.1",
    PORT: "3101",
    TECTONIC_ONLY_CACHED: "1",
    ...overrides,
  };
}

export function localModelChildEnvironment(
  environment = process.env,
  overrides = {},
) {
  if (selectedProvider(environment) !== "local_llama") {
    throw new Error(
      "The local model server can only be started while local_llama is selected.",
    );
  }

  let result = withoutKeys(environment, CLOUD_ENVIRONMENT_KEYS);
  for (const key of [
    "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET",
    "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET",
    "SCHOLAR_FLOW_LATEX_COMPILER_TOKEN",
  ]) {
    delete result[key];
  }

  return {
    ...result,
    ...overrides,
  };
}
