import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";

const environmentFile = ".env.ollama.local";
const activeEnvironmentFile = ".env.local";
const requestedModel = (process.argv[2] ?? "llama3.2").trim();

if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(requestedModel)) {
  throw new Error(
    "Provide an Ollama model name containing only safe model-identifier characters, for example: npm run ollama:setup -- llama3.2",
  );
}

function secret() {
  return randomBytes(48).toString("base64url");
}

function statusFor(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

const environmentStatus = statusFor(environmentFile);
if (!environmentStatus) {
  const contents = [
    "# Private Scholar Flow configuration for a local Ollama server.",
    "# This file is ignored by Git. Keep it on this computer.",
    "SCHOLAR_FLOW_AI_PROVIDER=local_llama",
    "SCHOLAR_FLOW_MODE=offline",
    "SCHOLAR_FLOW_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1",
    `SCHOLAR_FLOW_OLLAMA_MODEL=${requestedModel}`,
    "SCHOLAR_FLOW_OLLAMA_CONTEXT_TOKENS=32768",
    "SCHOLAR_FLOW_OLLAMA_MAX_OUTPUT_TOKENS=8192",
    "SCHOLAR_FLOW_OLLAMA_VISION_ENABLED=false",
    "ORESOLVE_GENAI_ENABLED=false",
    `SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET=${secret()}`,
    `SCHOLAR_FLOW_CORPUS_SIGNING_SECRET=${secret()}`,
    "SCHOLAR_FLOW_LATEX_COMPILER_URL=http://127.0.0.1:3101/compile",
    "TECTONIC_ONLY_CACHED=1",
    "",
  ].join("\n");
  writeFileSync(environmentFile, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Created ${environmentFile} for the local ${requestedModel} Ollama model.`);
} else {
  if (!environmentStatus.isFile() || environmentStatus.isSymbolicLink()) {
    throw new Error(
      `${environmentFile} must be a regular private file. Refusing to follow or overwrite another path.`,
    );
  }
  chmodSync(environmentFile, 0o600);
  console.log(`${environmentFile} already exists; its model and secrets were left unchanged.`);
}

const activeEnvironmentStatus = statusFor(activeEnvironmentFile);
if (!activeEnvironmentStatus) {
  symlinkSync(environmentFile, activeEnvironmentFile);
  console.log(`Activated ${environmentFile} through ${activeEnvironmentFile}.`);
} else {
  const isActiveLink =
    activeEnvironmentStatus.isSymbolicLink() &&
    readlinkSync(activeEnvironmentFile) === environmentFile;
  if (!isActiveLink) {
    throw new Error(
      `${activeEnvironmentFile} already exists and was not changed. Move it aside yourself, then rerun ollama:setup.`,
    );
  }
  console.log(`${activeEnvironmentFile} already points to ${environmentFile}.`);
}

console.log(
  "Next: make sure Ollama is running, install the selected model with `ollama pull <model>`, then run `npm run ollama:check`.",
);
