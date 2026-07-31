import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import ts from "typescript";

const offlineRuntimeSource = readFileSync(
  new URL("../../lib/offline-runtime.ts", import.meta.url),
  "utf8",
);
const executableSource = offlineRuntimeSource.replace(
  /^import "server-only";\s*/u,
  "",
);
const transpiledSource = ts.transpileModule(executableSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "offline-runtime.ts",
}).outputText;
const offlineRuntime = await import(
  `data:text/javascript;base64,${Buffer.from(transpiledSource).toString("base64")}`
);

const {
  OFFLINE_RUNTIME_DEFAULTS,
  getOfflineRuntimeConfig,
  getScholarFlowMode,
  verifyOfflineLlamaAccess,
} = offlineRuntime;

const VENUE_SECRET = "v".repeat(48);
const CORPUS_SECRET = "c".repeat(48);

function validEnvironment(overrides = {}) {
  return {
    SCHOLAR_FLOW_MODE: "offline",
    ORESOLVE_GENAI_ENABLED: "false",
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: VENUE_SECRET,
    SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: CORPUS_SECRET,
    ...overrides,
  };
}

test("defaults to a fully local offline mode", () => {
  const environment = validEnvironment();
  delete environment.SCHOLAR_FLOW_MODE;

  assert.equal(getScholarFlowMode(environment), "offline");
  const config = getOfflineRuntimeConfig(environment);
  assert.equal(config.mode, "offline");
  assert.equal(config.enabled, true);
  assert.equal(config.configurationError, null);
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.model, "llama3.2");
  assert.equal(config.contextTokens, 32_768);
  assert.equal(config.maxOutputTokens, 8_192);
  assert.equal(config.vision, false);
  assert.equal(config.venueSigningSecret, VENUE_SECRET);
  assert.equal(config.corpusSigningSecret, CORPUS_SECRET);
  assert.deepEqual(OFFLINE_RUNTIME_DEFAULTS, {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "llama3.2",
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    vision: false,
  });
});

test("uses Ollama settings while retaining legacy local-setting compatibility", () => {
  const config = getOfflineRuntimeConfig(
    validEnvironment({
      SCHOLAR_FLOW_OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
      SCHOLAR_FLOW_OLLAMA_MODEL: "qwen2.5:7b",
      SCHOLAR_FLOW_OLLAMA_CONTEXT_TOKENS: "65536",
      SCHOLAR_FLOW_OLLAMA_MAX_OUTPUT_TOKENS: "8192",
      SCHOLAR_FLOW_OLLAMA_VISION_ENABLED: "true",
    }),
  );
  assert.equal(config.configurationError, null);
  assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.model, "qwen2.5:7b");
  assert.equal(config.contextTokens, 65_536);
  assert.equal(config.maxOutputTokens, 8_192);
  assert.equal(config.vision, true);

  const conflicting = getOfflineRuntimeConfig(
    validEnvironment({
      SCHOLAR_FLOW_OLLAMA_MODEL: "qwen2.5:7b",
      SCHOLAR_FLOW_LLAMA_MODEL: "legacy-model",
    }),
  );
  assert.match(conflicting.configurationError, /conflicting values/u);
});

test("rejects every mode other than the offline default", () => {
  assert.equal(getScholarFlowMode({ SCHOLAR_FLOW_MODE: "cloud" }), "invalid");
  assert.equal(getScholarFlowMode({ SCHOLAR_FLOW_MODE: "OFFLINE" }), "offline");
  assert.equal(getScholarFlowMode({ SCHOLAR_FLOW_MODE: "hybrid" }), "invalid");

  const cloudConfig = getOfflineRuntimeConfig({
    SCHOLAR_FLOW_MODE: "cloud",
  });
  assert.equal(cloudConfig.enabled, false);
  assert.match(cloudConfig.configurationError, /Cloud mode is not supported/u);

  const invalid = getOfflineRuntimeConfig({
    ...validEnvironment(),
    SCHOLAR_FLOW_MODE: "hybrid",
  });
  assert.equal(invalid.enabled, false);
  assert.match(invalid.configurationError, /must be offline or omitted/u);
});

test("accepts only canonical loopback OpenAI-compatible base URLs", () => {
  for (const [baseUrl, expected] of [
    ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/v1"],
    ["http://localhost:8080/v1/", "http://localhost:8080/v1"],
    ["http://[::1]:8080/v1", "http://[::1]:8080/v1"],
  ]) {
    const config = getOfflineRuntimeConfig(
      validEnvironment({ SCHOLAR_FLOW_LLAMA_BASE_URL: baseUrl }),
    );
    assert.equal(config.configurationError, null, baseUrl);
    assert.equal(config.baseUrl, expected);
  }

  for (const baseUrl of [
    "https://[::1]:8443/v1",
    "https://example.com/v1",
    "http://127.0.0.1:8080/v2",
    "http://user:pass@127.0.0.1:8080/v1",
    "http://127.0.0.1:8080/v1?remote=true",
    "http://127.0.0.1:8080/v1#fragment",
    "http://127.1:8080/v1",
    "http://2130706433:8080/v1",
    "http://0x7f000001:8080/v1",
    "http://localhost.:8080/v1",
    "file:///v1",
  ]) {
    const config = getOfflineRuntimeConfig(
      validEnvironment({ SCHOLAR_FLOW_LLAMA_BASE_URL: baseUrl }),
    );
    assert.match(config.configurationError, /LLAMA_BASE_URL/u, baseUrl);
  }
});

test("rejects cloud credentials endpoints and enabled OCI in offline mode", () => {
  for (const [name, value] of [
    ["ORESOLVE_GENAI_API_KEY", "oci-secret"],
    ["ORESOLVE_GENAI_PROJECT_ID", "ocid1.generativeaiproject.example"],
    [
      "ORESOLVE_GENAI_BASE_URL",
      "https://inference.generativeai.us-ashburn-1.oci.oraclecloud.com/openai/v1",
    ],
    ["OPENAI_API_KEY", "openai-secret"],
    ["GOOGLE_API_KEY", "google-secret"],
    ["HF_TOKEN", "hugging-face-secret"],
  ]) {
    const config = getOfflineRuntimeConfig(
      validEnvironment({ [name]: value }),
    );
    assert.match(config.configurationError, new RegExp(name, "u"), name);
    assert.doesNotMatch(config.configurationError, new RegExp(value, "u"));
  }

  const enabled = getOfflineRuntimeConfig(
    validEnvironment({ ORESOLVE_GENAI_ENABLED: "true" }),
  );
  assert.match(enabled.configurationError, /must not enable OCI/u);

  const malformed = getOfflineRuntimeConfig(
    validEnvironment({ ORESOLVE_GENAI_ENABLED: "sometimes" }),
  );
  assert.match(malformed.configurationError, /must be false/u);

  const disabledMetadata = getOfflineRuntimeConfig(
    validEnvironment({
      ORESOLVE_GENAI_ENABLED: "off",
      ORESOLVE_GENAI_REGION: "us-ashburn-1",
      ORESOLVE_GENAI_MODEL: "google.gemini-2.5-flash",
    }),
  );
  assert.equal(disabledMetadata.configurationError, null);
});

test("requires two distinct bounded dedicated signing secrets", () => {
  for (const overrides of [
    { SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "" },
    { SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: "" },
    { SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "short" },
    {
      SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: "é".repeat(513),
    },
    {
      SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: VENUE_SECRET,
      SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: VENUE_SECRET,
    },
  ]) {
    const config = getOfflineRuntimeConfig(validEnvironment(overrides));
    assert.match(config.configurationError, /SIGNING_SECRET/u);
  }

  const multibyte = getOfflineRuntimeConfig(
    validEnvironment({
      SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "é".repeat(16),
      SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: "ø".repeat(16),
    }),
  );
  assert.equal(multibyte.configurationError, null);
});

test("strictly validates context output and vision configuration", () => {
  const config = getOfflineRuntimeConfig(
    validEnvironment({
      SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS: "65536",
      SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS: "8192",
      SCHOLAR_FLOW_LLAMA_VISION_ENABLED: "true",
      SCHOLAR_FLOW_LLAMA_MODEL: "local/model-v1",
    }),
  );
  assert.equal(config.configurationError, null);
  assert.equal(config.contextTokens, 65_536);
  assert.equal(config.maxOutputTokens, 8_192);
  assert.equal(config.vision, true);
  assert.equal(config.model, "local/model-v1");

  for (const overrides of [
    { SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS: "8191" },
    { SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS: "not-a-number" },
    { SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS: "0" },
    {
      SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS: "8192",
      SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS: "8192",
    },
    { SCHOLAR_FLOW_LLAMA_VISION_ENABLED: "maybe" },
    { SCHOLAR_FLOW_LLAMA_MODEL: "unsafe model name" },
  ]) {
    const invalid = getOfflineRuntimeConfig(validEnvironment(overrides));
    assert.ok(invalid.configurationError, JSON.stringify(overrides));
  }
});

test("probes only the configured loopback models endpoint", async () => {
  const config = getOfflineRuntimeConfig(validEnvironment());
  const calls = [];
  const result = await verifyOfflineLlamaAccess(
    config,
    async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ id: "llama3.2", object: "model" }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );

  assert.equal(result.ready, true);
  assert.equal(result.status, "ready");
  assert.equal(result.capabilities.localOnly, true);
  assert.equal(result.capabilities.cloudRequests, false);
  assert.equal(result.capabilities.modelListed, true);
  assert.equal(result.capabilities.visionVerified, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, "http://127.0.0.1:11434/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].init.headers, { Accept: "application/json" });
  assert.doesNotMatch(JSON.stringify(result), /v{32}|c{32}/u);
});

test("fails closed for forged remote configs and malformed local responses", async () => {
  const config = getOfflineRuntimeConfig(validEnvironment());
  let calls = 0;
  const forged = await verifyOfflineLlamaAccess(
    { ...config, baseUrl: "https://example.com/v1" },
    async () => {
      calls += 1;
      throw new Error("must not run");
    },
  );
  assert.equal(forged.status, "invalid_config");
  assert.equal(calls, 0);

  const missingModel = await verifyOfflineLlamaAccess(
    config,
    async () =>
      new Response(JSON.stringify({ data: [{ id: "other-model" }] }), {
        status: 200,
      }),
  );
  assert.equal(missingModel.status, "model_unavailable");
  assert.equal(missingModel.ready, false);

  const malformed = await verifyOfflineLlamaAccess(
    config,
    async () => new Response('{"data":"not-an-array"}', { status: 200 }),
  );
  assert.equal(malformed.status, "invalid_response");

  const unavailable = await verifyOfflineLlamaAccess(config, async () => {
    throw new Error("connection refused");
  });
  assert.equal(unavailable.status, "unavailable");
  assert.doesNotMatch(unavailable.message, /connection refused/u);
});
