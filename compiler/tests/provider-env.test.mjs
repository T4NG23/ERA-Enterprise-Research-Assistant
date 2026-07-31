import assert from "node:assert/strict";
import test from "node:test";

import {
  compilerChildEnvironment,
  localModelChildEnvironment,
  selectedProvider,
  webChildEnvironment,
} from "../../scripts/provider-env.mjs";

test("provider selection is explicit and never inferred from credentials", () => {
  assert.throws(
    () => selectedProvider({ ORESOLVE_GENAI_API_KEY: "cloud-key" }),
    /must be explicitly set to oci or local_llama/u,
  );
  assert.throws(
    () =>
      selectedProvider({
        SCHOLAR_FLOW_AI_PROVIDER: "automatic",
      }),
    /must be explicitly set to oci or local_llama/u,
  );
});

test("local_llama web children lose cloud credentials without losing local settings", () => {
  const environment = webChildEnvironment({
    SCHOLAR_FLOW_AI_PROVIDER: "local_llama",
    ORESOLVE_GENAI_API_KEY: "must-not-survive",
    OPENAI_API_KEY: "must-not-survive-either",
    SCHOLAR_FLOW_LLAMA_BASE_URL: "http://127.0.0.1:8080/v1",
    SCHOLAR_FLOW_LLAMA_MODEL: "local-model",
  });

  assert.equal(environment.SCHOLAR_FLOW_AI_PROVIDER, "local_llama");
  assert.equal(environment.SCHOLAR_FLOW_MODE, "offline");
  assert.equal(
    environment.SCHOLAR_FLOW_LLAMA_BASE_URL,
    "http://127.0.0.1:8080/v1",
  );
  assert.equal(environment.SCHOLAR_FLOW_LLAMA_MODEL, "local-model");
  assert.equal(environment.ORESOLVE_GENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
});

test("OCI web children retain OCI only while compiler children receive no model credential", () => {
  const source = {
    SCHOLAR_FLOW_AI_PROVIDER: "oci",
    ORESOLVE_GENAI_API_KEY: "server-only-cloud-key",
    ORESOLVE_GENAI_MODEL: "google.gemini-2.5-flash",
    SCHOLAR_FLOW_LLAMA_BASE_URL: "http://127.0.0.1:8080/v1",
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "g".repeat(48),
    SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: "c".repeat(48),
  };
  const web = webChildEnvironment(source);
  const compiler = compilerChildEnvironment(source);

  assert.equal(web.SCHOLAR_FLOW_AI_PROVIDER, "oci");
  assert.equal(web.SCHOLAR_FLOW_MODE, "cloud");
  assert.equal(web.ORESOLVE_GENAI_API_KEY, "server-only-cloud-key");
  assert.equal(web.SCHOLAR_FLOW_LLAMA_BASE_URL, undefined);
  assert.equal(compiler.ORESOLVE_GENAI_API_KEY, undefined);
  assert.equal(compiler.SCHOLAR_FLOW_LLAMA_BASE_URL, undefined);
  assert.equal(compiler.SCHOLAR_FLOW_CORPUS_SIGNING_SECRET, undefined);
  assert.equal(
    compiler.SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET,
    "g".repeat(48),
  );
  assert.equal(compiler.HOST, "127.0.0.1");
  assert.equal(compiler.TECTONIC_ONLY_CACHED, "1");
});

test("the local model process receives no cloud or application secrets", () => {
  const environment = localModelChildEnvironment({
    SCHOLAR_FLOW_AI_PROVIDER: "local_llama",
    SCHOLAR_FLOW_LLAMA_MODEL_PATH: "/models/llama.gguf",
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "g".repeat(48),
    SCHOLAR_FLOW_CORPUS_SIGNING_SECRET: "c".repeat(48),
    SCHOLAR_FLOW_LATEX_COMPILER_TOKEN: "compiler-secret",
    ORESOLVE_GENAI_API_KEY: "oci-secret",
    HF_TOKEN: "download-secret",
    PATH: "/usr/bin",
  });

  assert.equal(environment.SCHOLAR_FLOW_LLAMA_MODEL_PATH, "/models/llama.gguf");
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET, undefined);
  assert.equal(environment.SCHOLAR_FLOW_CORPUS_SIGNING_SECRET, undefined);
  assert.equal(environment.SCHOLAR_FLOW_LATEX_COMPILER_TOKEN, undefined);
  assert.equal(environment.ORESOLVE_GENAI_API_KEY, undefined);
  assert.equal(environment.HF_TOKEN, undefined);
});

test("the local model launcher uses the bounded 16 GB llama.cpp profile", async () => {
  const { readFile } = await import("node:fs/promises");
  const launcher = await readFile(
    new URL("../../scripts/llama-serve.mjs", import.meta.url),
    "utf8",
  );

  for (const required of [
    '"--parallel"',
    '"--flash-attn"',
    '"--cache-type-k"',
    '"--cache-type-v"',
    '"q8_0"',
    '"--offline"',
  ]) {
    assert.match(launcher, new RegExp(required, "u"));
  }
  assert.match(launcher, /spawn\("llama-server", args/u);
  assert.match(launcher, /localModelChildEnvironment\(process\.env\)/u);
});
