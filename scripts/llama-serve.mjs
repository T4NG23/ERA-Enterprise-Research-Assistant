import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  loadActiveEnvironmentFile,
  localModelChildEnvironment,
  selectedProvider,
} from "./provider-env.mjs";

process.on("uncaughtException", (error) => {
  const message =
    error instanceof Error
      ? error.message
      : "The local llama.cpp server could not be started.";
  process.stderr.write(`Scholar Flow local Llama setup: ${message}\n`);
  process.exitCode = 1;
});

loadActiveEnvironmentFile();
if (selectedProvider(process.env) !== "local_llama") {
  throw new Error(
    "Select the private local provider with npm run provider:local before starting llama.cpp.",
  );
}

const modelPath = process.env.SCHOLAR_FLOW_LLAMA_MODEL_PATH?.trim() ?? "";
if (!modelPath) {
  throw new Error(
    "Set SCHOLAR_FLOW_LLAMA_MODEL_PATH in .env.offline.local to an absolute local GGUF model path.",
  );
}
if (!path.isAbsolute(modelPath) || !existsSync(modelPath)) {
  throw new Error(
    "SCHOLAR_FLOW_LLAMA_MODEL_PATH must point to an existing absolute local GGUF file.",
  );
}

const rawBaseUrl =
  process.env.SCHOLAR_FLOW_LLAMA_BASE_URL?.trim() ??
  "http://127.0.0.1:8080/v1";
let baseUrl;
try {
  baseUrl = new URL(rawBaseUrl);
} catch {
  throw new Error(
    "SCHOLAR_FLOW_LLAMA_BASE_URL must be a valid loopback URL ending in /v1.",
  );
}
const hostname = baseUrl.hostname
  .toLowerCase()
  .replace(/^\[([^\]]+)\]$/u, "$1");
if (
  baseUrl.protocol !== "http:" ||
  !new Set(["127.0.0.1", "::1", "localhost"]).has(hostname) ||
  baseUrl.pathname.replace(/\/+$/u, "") !== "/v1" ||
  baseUrl.username ||
  baseUrl.password ||
  baseUrl.search ||
  baseUrl.hash
) {
  throw new Error(
    "SCHOLAR_FLOW_LLAMA_BASE_URL must use exact loopback HTTP with path /v1 and no credentials, query, or fragment.",
  );
}

const alias =
  process.env.SCHOLAR_FLOW_LLAMA_MODEL?.trim() ?? "scholar-flow-local";
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(alias)) {
  throw new Error("SCHOLAR_FLOW_LLAMA_MODEL is not a safe model alias.");
}
const contextTokens = Number(
  process.env.SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS ?? "32768",
);
if (
  !Number.isSafeInteger(contextTokens) ||
  contextTokens < 8_192 ||
  contextTokens > 1_048_576
) {
  throw new Error(
    "SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS must be an integer from 8192 through 1048576.",
  );
}

const args = [
  "--model",
  modelPath,
  "--host",
  hostname,
  "--port",
  baseUrl.port || "80",
  "--alias",
  alias,
  "--ctx-size",
  String(contextTokens),
  "--parallel",
  "1",
  "--flash-attn",
  "on",
  "--cache-type-k",
  "q8_0",
  "--cache-type-v",
  "q8_0",
  "--offline",
];

const child = spawn("llama-server", args, {
  env: localModelChildEnvironment(process.env),
  stdio: "inherit",
});

console.log(
  `Starting the private ${alias} llama.cpp server on ${baseUrl.origin} with one slot, Q8 KV cache, and ${contextTokens.toLocaleString("en-US")} context tokens.`,
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const result = await Promise.race([
  once(child, "exit").then(([code, signal]) => ({
    code: typeof code === "number" ? code : signal ? 1 : 0,
    error: null,
  })),
  once(child, "error").then(([error]) => ({ code: 1, error })),
]);

if (result.error?.code === "ENOENT") {
  throw new Error(
    "llama-server was not found on PATH. Install llama.cpp, then rerun npm run llama:serve.",
  );
}
if (result.error) throw result.error;
process.exitCode = result.code;
