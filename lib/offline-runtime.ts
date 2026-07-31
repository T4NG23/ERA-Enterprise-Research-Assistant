import "server-only";

export type ScholarFlowMode = "offline" | "invalid";

export interface OfflineRuntimeConfig {
  mode: "offline";
  enabled: boolean;
  configurationError: string | null;
  baseUrl: string;
  model: string;
  contextTokens: number;
  maxOutputTokens: number;
  vision: boolean;
  venueSigningSecret: string;
  corpusSigningSecret: string;
}

export type OfflineReadinessStatus =
  | "ready"
  | "invalid_config"
  | "unavailable"
  | "invalid_response"
  | "model_unavailable";

export interface OfflineLlamaCapabilities {
  localOnly: true;
  cloudRequests: false;
  openAiCompatible: true;
  chatCompletions: true;
  modelDiscovery: true;
  modelListed: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  visionConfigured: boolean;
  visionVerified: false;
}

export interface OfflineLlamaAccessResult {
  ready: boolean;
  status: OfflineReadinessStatus;
  message: string;
  capabilities: OfflineLlamaCapabilities;
}

type OfflineEnvironment = Record<string, string | undefined>;
type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_LLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LLAMA_MODEL = "llama3.2";
const DEFAULT_CONTEXT_TOKENS = 32_768;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const MIN_CONTEXT_TOKENS = 8_192;
const MAX_CONTEXT_TOKENS = 1_048_576;
const MIN_OUTPUT_TOKENS = 1_024;
const MAX_OUTPUT_TOKENS = 65_536;
const MIN_SIGNING_SECRET_BYTES = 32;
const MAX_SIGNING_SECRET_BYTES = 1_024;
const MAX_MODEL_CHARACTERS = 200;
const MAX_MODELS_RESPONSE_BYTES = 64 * 1024;
const MAX_DISCOVERED_MODELS = 256;
const LLAMA_HEALTH_TIMEOUT_MS = 5_000;

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const FORBIDDEN_CLOUD_CONFIGURATION = Object.freeze([
  "ORESOLVE_GENAI_API_KEY",
  "ORESOLVE_GENAI_PROJECT_ID",
  "ORESOLVE_GENAI_BASE_URL",
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
] as const);

function environmentValue(
  environment: OfflineEnvironment,
  key: string,
) {
  return environment[key]?.trim() ?? "";
}

/**
 * Ollama is the supported local runtime for this handoff. The older LLAMA
 * variables remain accepted so an existing local configuration keeps working.
 */
function aliasedEnvironmentValue(
  environment: OfflineEnvironment,
  ollamaKey: string,
  legacyLlamaKey: string,
) {
  const ollamaValue = environmentValue(environment, ollamaKey);
  const legacyLlamaValue = environmentValue(environment, legacyLlamaKey);
  return {
    value: ollamaValue || legacyLlamaValue,
    name: ollamaValue ? ollamaKey : legacyLlamaValue ? legacyLlamaKey : ollamaKey,
    error:
      ollamaValue &&
      legacyLlamaValue &&
      ollamaValue !== legacyLlamaValue
        ? `Configure either ${ollamaKey} or the legacy ${legacyLlamaKey}, not conflicting values for both.`
        : "",
  };
}

export function getScholarFlowMode(
  environment: OfflineEnvironment = process.env,
): ScholarFlowMode {
  const value = environmentValue(environment, "SCHOLAR_FLOW_MODE").toLowerCase();
  if (!value || value === "offline") return "offline";
  return "invalid";
}

function normalizeLoopbackBaseUrl(value: string, name: string) {
  const authorityMatch = value.match(
    /^https?:\/\/([^/?#]+)(?:[/?#]|$)/iu,
  );
  const rawAuthority = authorityMatch?.[1] ?? "";
  const rawHostMatch = rawAuthority.startsWith("[")
    ? rawAuthority.match(/^\[([^\]]+)\](?::\d{1,5})?$/u)
    : rawAuthority.match(/^([^:]+)(?::\d{1,5})?$/u);
  const rawHostname = rawHostMatch?.[1]?.toLowerCase() ?? "";

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return {
      value,
      error:
        `${name} must be a valid loopback HTTP URL ending in /v1.`,
    };
  }

  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[([^\]]+)\]$/u, "$1");
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTNAMES.has(rawHostname) ||
    !LOOPBACK_HOSTNAMES.has(hostname) ||
    normalizedPath !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return {
      value,
      error:
        `${name} must use http:// with exact host 127.0.0.1, localhost, or ::1, no credentials/query/fragment, and path /v1.`,
    };
  }

  url.pathname = "/v1";
  return { value: url.toString().replace(/\/$/u, ""), error: "" };
}

function boundedInteger(
  rawValue: string,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
) {
  if (!rawValue) return { value: fallback, error: "" };
  if (!/^[1-9]\d*$/u.test(rawValue)) {
    return {
      value: Number.NaN,
      error: `${name} must be a base-10 integer from ${minimum.toLocaleString("en-US")} through ${maximum.toLocaleString("en-US")}.`,
    };
  }
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return {
      value,
      error: `${name} must be a base-10 integer from ${minimum.toLocaleString("en-US")} through ${maximum.toLocaleString("en-US")}.`,
    };
  }
  return { value, error: "" };
}

function booleanValue(rawValue: string, fallback: boolean, name: string) {
  if (!rawValue) return { value: fallback, error: "" };
  const normalized = rawValue.toLowerCase();
  if (TRUE_VALUES.has(normalized)) return { value: true, error: "" };
  if (FALSE_VALUES.has(normalized)) return { value: false, error: "" };
  return {
    value: fallback,
    error: `${name} must be true or false.`,
  };
}

function signingSecret(rawValue: string, name: string) {
  if (!rawValue) {
    return {
      value: "",
      error: `${name} is required in offline mode and must contain ${MIN_SIGNING_SECRET_BYTES}–${MAX_SIGNING_SECRET_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
    };
  }
  const byteLength = new TextEncoder().encode(rawValue).byteLength;
  if (
    byteLength < MIN_SIGNING_SECRET_BYTES ||
    byteLength > MAX_SIGNING_SECRET_BYTES
  ) {
    return {
      value: "",
      error: `${name} must contain ${MIN_SIGNING_SECRET_BYTES}–${MAX_SIGNING_SECRET_BYTES.toLocaleString("en-US")} UTF-8 bytes after trimming.`,
    };
  }
  return { value: rawValue, error: "" };
}

function offlineCloudConfigurationErrors(environment: OfflineEnvironment) {
  const errors: string[] = [];
  const enabledValue = environmentValue(
    environment,
    "ORESOLVE_GENAI_ENABLED",
  ).toLowerCase();
  if (TRUE_VALUES.has(enabledValue)) {
    errors.push(
      "ORESOLVE_GENAI_ENABLED must not enable OCI while SCHOLAR_FLOW_MODE is offline.",
    );
  } else if (enabledValue && !FALSE_VALUES.has(enabledValue)) {
    errors.push(
      "ORESOLVE_GENAI_ENABLED must be false, 0, no, or off in offline mode.",
    );
  }

  const configuredCloudKeys = FORBIDDEN_CLOUD_CONFIGURATION.filter((key) =>
    Boolean(environmentValue(environment, key)),
  );
  if (configuredCloudKeys.length) {
    errors.push(
      `Offline mode rejects cloud credentials and endpoints. Clear: ${configuredCloudKeys.join(", ")}.`,
    );
  }
  return errors;
}

export function getOfflineRuntimeConfig(
  environment: OfflineEnvironment = process.env,
): OfflineRuntimeConfig {
  const mode = getScholarFlowMode(environment);
  const baseUrlSetting = aliasedEnvironmentValue(
    environment,
    "SCHOLAR_FLOW_OLLAMA_BASE_URL",
    "SCHOLAR_FLOW_LLAMA_BASE_URL",
  );
  const modelSetting = aliasedEnvironmentValue(
    environment,
    "SCHOLAR_FLOW_OLLAMA_MODEL",
    "SCHOLAR_FLOW_LLAMA_MODEL",
  );
  const contextSetting = aliasedEnvironmentValue(
    environment,
    "SCHOLAR_FLOW_OLLAMA_CONTEXT_TOKENS",
    "SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS",
  );
  const outputSetting = aliasedEnvironmentValue(
    environment,
    "SCHOLAR_FLOW_OLLAMA_MAX_OUTPUT_TOKENS",
    "SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS",
  );
  const visionSetting = aliasedEnvironmentValue(
    environment,
    "SCHOLAR_FLOW_OLLAMA_VISION_ENABLED",
    "SCHOLAR_FLOW_LLAMA_VISION_ENABLED",
  );
  const baseUrlResult = normalizeLoopbackBaseUrl(
    baseUrlSetting.value || DEFAULT_LLAMA_BASE_URL,
    baseUrlSetting.name,
  );
  const model = modelSetting.value || DEFAULT_LLAMA_MODEL;
  const contextResult = boundedInteger(
    contextSetting.value,
    DEFAULT_CONTEXT_TOKENS,
    MIN_CONTEXT_TOKENS,
    MAX_CONTEXT_TOKENS,
    contextSetting.name,
  );
  const outputResult = boundedInteger(
    outputSetting.value,
    DEFAULT_MAX_OUTPUT_TOKENS,
    MIN_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
    outputSetting.name,
  );
  const visionResult = booleanValue(
    visionSetting.value,
    false,
    visionSetting.name,
  );
  const venueSecretResult = signingSecret(
    environmentValue(
      environment,
      "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET",
    ),
    "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET",
  );
  const corpusSecretResult = signingSecret(
    environmentValue(environment, "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET"),
    "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET",
  );

  const errors: string[] = [];
  if (mode === "invalid") {
    errors.push(
      "SCHOLAR_FLOW_MODE must be offline or omitted. Cloud mode is not supported by this build.",
    );
  }
  if (mode === "offline") {
    for (const setting of [
      baseUrlSetting,
      modelSetting,
      contextSetting,
      outputSetting,
      visionSetting,
    ]) {
      if (setting.error) errors.push(setting.error);
    }
    errors.push(...offlineCloudConfigurationErrors(environment));
    if (baseUrlResult.error) errors.push(baseUrlResult.error);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model) ||
      model.length > MAX_MODEL_CHARACTERS
    ) {
      errors.push(
        `${modelSetting.name} must contain 1–200 safe model-identifier characters.`,
      );
    }
    if (contextResult.error) errors.push(contextResult.error);
    if (outputResult.error) errors.push(outputResult.error);
    if (
      Number.isSafeInteger(contextResult.value) &&
      Number.isSafeInteger(outputResult.value) &&
      outputResult.value >= contextResult.value
    ) {
      errors.push(
        "SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS must be smaller than SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS.",
      );
    }
    if (visionResult.error) errors.push(visionResult.error);
    if (venueSecretResult.error) errors.push(venueSecretResult.error);
    if (corpusSecretResult.error) errors.push(corpusSecretResult.error);
    if (
      venueSecretResult.value &&
      corpusSecretResult.value &&
      venueSecretResult.value === corpusSecretResult.value
    ) {
      errors.push(
        "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET and SCHOLAR_FLOW_CORPUS_SIGNING_SECRET must be different dedicated secrets.",
      );
    }
  }

  return Object.freeze({
    mode: "offline",
    enabled: mode === "offline",
    configurationError: errors.length ? errors.join(" ") : null,
    baseUrl: baseUrlResult.value,
    model,
    contextTokens: contextResult.value,
    maxOutputTokens: outputResult.value,
    vision: visionResult.value,
    venueSigningSecret: venueSecretResult.value,
    corpusSigningSecret: corpusSecretResult.value,
  });
}

function capabilities(
  config: OfflineRuntimeConfig,
  modelListed: boolean,
): OfflineLlamaCapabilities {
  return {
    localOnly: true,
    cloudRequests: false,
    openAiCompatible: true,
    chatCompletions: true,
    modelDiscovery: true,
    modelListed,
    contextTokens: config.contextTokens,
    maxOutputTokens: config.maxOutputTokens,
    visionConfigured: config.vision,
    visionVerified: false,
  };
}

async function boundedResponseText(response: Response) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_MODELS_RESPONSE_BYTES)
  ) {
    throw new Error("The local model-list response is too large.");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_MODELS_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("The local model-list response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function discoveredModelIds(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length > MAX_DISCOVERED_MODELS) return null;

  const identifiers: string[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const id = (entry as { id?: unknown }).id;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(id)
    ) {
      return null;
    }
    identifiers.push(id);
  }
  return identifiers;
}

export async function verifyOfflineLlamaAccess(
  config: OfflineRuntimeConfig,
  fetchImpl: FetchImplementation = fetch,
): Promise<OfflineLlamaAccessResult> {
  const baseCapabilities = capabilities(config, false);
  const verifiedBaseUrl = normalizeLoopbackBaseUrl(
    config.baseUrl,
    "SCHOLAR_FLOW_OLLAMA_BASE_URL",
  );
  if (
    !config.enabled ||
    config.configurationError ||
    verifiedBaseUrl.error ||
    verifiedBaseUrl.value !== config.baseUrl
  ) {
    return {
      ready: false,
      status: "invalid_config",
      message:
        config.configurationError ||
        verifiedBaseUrl.error ||
        (verifiedBaseUrl.value !== config.baseUrl
          ? "The Ollama base URL is not in canonical loopback form."
          : "Offline runtime is disabled. Set SCHOLAR_FLOW_MODE=offline or omit it."),
      capabilities: baseCapabilities,
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(LLAMA_HEALTH_TIMEOUT_MS),
    });
  } catch {
    return {
      ready: false,
      status: "unavailable",
      message:
        `Ollama could not be reached at ${config.baseUrl}. Start Ollama and keep its OpenAI-compatible server bound to loopback.`,
      capabilities: baseCapabilities,
    };
  }

  if (!response.ok) {
    await response.body?.cancel();
    return {
      ready: false,
      status: "unavailable",
      message:
        `Ollama returned HTTP ${response.status} from its loopback model-discovery endpoint.`,
      capabilities: baseCapabilities,
    };
  }

  let modelIds: string[] | null = null;
  try {
    const text = await boundedResponseText(response);
    modelIds = discoveredModelIds(JSON.parse(text));
  } catch {
    // The fixed response below does not expose local-server response content.
  }
  if (!modelIds) {
    return {
      ready: false,
      status: "invalid_response",
      message:
        "Ollama did not return a bounded OpenAI-compatible model list.",
      capabilities: baseCapabilities,
    };
  }
  if (!modelIds.includes(config.model)) {
    return {
      ready: false,
      status: "model_unavailable",
      message:
        `Ollama is reachable but does not list the configured model (${config.model}). Run ollama list, then update SCHOLAR_FLOW_OLLAMA_MODEL to an exact installed model name.`,
      capabilities: baseCapabilities,
    };
  }

  return {
    ready: true,
    status: "ready",
    message:
      `Ollama model ${config.model} is available through the loopback OpenAI-compatible endpoint. No cloud readiness request was made. ${config.vision ? "Vision is enabled by configuration but not verified by this lightweight probe." : "Vision is disabled by configuration."}`,
    capabilities: capabilities(config, true),
  };
}

export const OFFLINE_RUNTIME_DEFAULTS = Object.freeze({
  baseUrl: DEFAULT_LLAMA_BASE_URL,
  model: DEFAULT_LLAMA_MODEL,
  contextTokens: DEFAULT_CONTEXT_TOKENS,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  vision: false,
});
