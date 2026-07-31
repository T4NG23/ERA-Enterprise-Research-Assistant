import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

const environmentFile = ".env.local";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

if (!existsSync(environmentFile)) {
  throw new Error(
    "No .env.local file was found. Run `npm run ollama:setup -- <exact-model-name>` first.",
  );
}

loadEnvFile(environmentFile);

const baseUrl =
  process.env.SCHOLAR_FLOW_OLLAMA_BASE_URL?.trim() ||
  process.env.SCHOLAR_FLOW_LLAMA_BASE_URL?.trim() ||
  "http://127.0.0.1:11434/v1";
const model =
  process.env.SCHOLAR_FLOW_OLLAMA_MODEL?.trim() ||
  process.env.SCHOLAR_FLOW_LLAMA_MODEL?.trim() ||
  "llama3.2";

let url;
try {
  url = new URL(baseUrl);
} catch {
  throw new Error(
    "The configured Ollama base URL is invalid. Use an exact loopback URL ending in /v1, such as http://127.0.0.1:11434/v1.",
  );
}

const hostname = url.hostname.toLowerCase().replace(/^\[([^\]]+)\]$/u, "$1");
if (
  url.protocol !== "http:" ||
  !LOOPBACK_HOSTS.has(hostname) ||
  url.pathname.replace(/\/+$/u, "") !== "/v1" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash
) {
  throw new Error(
    "The configured Ollama base URL must be an exact loopback HTTP URL ending in /v1.",
  );
}

let response;
try {
  response = await fetch(`${url.origin}/v1/models`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
} catch {
  throw new Error(
    `Could not reach Ollama at ${url.origin}. Start Ollama, then retry this check.`,
  );
}

if (!response.ok) {
  throw new Error(
    `Ollama returned HTTP ${response.status} while listing local models.`,
  );
}

let body;
try {
  body = await response.json();
} catch {
  throw new Error("Ollama returned an unreadable model list.");
}

const models = Array.isArray(body?.data)
  ? body.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
  : [];
if (!models.includes(model)) {
  throw new Error(
    `Ollama is running but does not list ${model}. Run \`ollama list\`, then either pull that model or update ${environmentFile} to an exact installed model name.`,
  );
}

console.log(`Ollama is ready at ${url.origin} with model ${model}.`);
