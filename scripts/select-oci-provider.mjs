import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const destination = ".env.oci.local";
const frameworkEnvironment = ".env.local";
const disabledCloudBackup = ".env.cloud-disabled.backup";
const offlineEnvironment = ".env.offline.local";
const knownProviderTargets = new Set([
  destination,
  offlineEnvironment,
  disabledCloudBackup,
]);
const controlledKeys = new Set([
  "SCHOLAR_FLOW_AI_PROVIDER",
  "SCHOLAR_FLOW_MODE",
  "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET",
  "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET",
  "SCHOLAR_FLOW_LATEX_COMPILER_URL",
  "SCHOLAR_FLOW_LATEX_COMPILER_TOKEN",
  "TECTONIC_ONLY_CACHED",
  "ORESOLVE_GENAI_ENABLED",
]);

function secret() {
  return randomBytes(48).toString("base64url");
}

function valueFor(contents, key) {
  for (const line of contents.split(/\r?\n/gu)) {
    const match = line.match(
      /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u,
    );
    if (match?.[1] === key) return match[2].trim();
  }
  return "";
}

function withoutControlledKeys(contents) {
  return contents
    .split(/\r?\n/gu)
    .filter((line) => {
      const match = line.match(
        /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/u,
      );
      return !match || !controlledKeys.has(match[1]);
    })
    .join("\n")
    .replace(/\n*$/u, "");
}

function signingSecrets(sourceContents) {
  const offlineContents = existsSync(offlineEnvironment)
    ? readFileSync(offlineEnvironment, "utf8")
    : "";
  const venue =
    valueFor(sourceContents, "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET") ||
    valueFor(
      offlineContents,
      "SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET",
    ) ||
    secret();
  let corpus =
    valueFor(sourceContents, "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET") ||
    valueFor(offlineContents, "SCHOLAR_FLOW_CORPUS_SIGNING_SECRET") ||
    secret();
  if (corpus === venue) corpus = secret();
  return { venue, corpus };
}

function createOciEnvironment() {
  if (existsSync(destination)) {
    const existing = readFileSync(destination, "utf8");
    if (valueFor(existing, "SCHOLAR_FLOW_AI_PROVIDER") !== "oci") {
      throw new Error(
        `${destination} exists but does not explicitly select the oci provider.`,
      );
    }
    chmodSync(destination, 0o600);
    console.log(`${destination} already exists; credentials were not changed.`);
    return;
  }

  const sourcePath = existsSync(disabledCloudBackup)
    ? disabledCloudBackup
    : existsSync(frameworkEnvironment)
      ? valueFor(
          readFileSync(frameworkEnvironment, "utf8"),
          "SCHOLAR_FLOW_AI_PROVIDER",
        ) === "local_llama"
        ? ""
        : frameworkEnvironment
      : "";
  if (!sourcePath) {
    throw new Error(
      `No OCI configuration was found. Copy .env.oci.example to ${destination}, add the OCI values, and rerun this command.`,
    );
  }

  const sourceContents = readFileSync(sourcePath, "utf8");
  if (!valueFor(sourceContents, "ORESOLVE_GENAI_API_KEY")) {
    throw new Error(
      `${sourcePath} does not contain ORESOLVE_GENAI_API_KEY. Add it there, or copy .env.oci.example to ${destination} and configure that private file.`,
    );
  }
  const { venue, corpus } = signingSecrets(sourceContents);
  const contents = [
    withoutControlledKeys(sourceContents),
    "",
    "# Explicit Scholar Flow provider selection; no automatic fallback.",
    "SCHOLAR_FLOW_AI_PROVIDER=oci",
    "SCHOLAR_FLOW_MODE=cloud",
    "ORESOLVE_GENAI_ENABLED=true",
    `SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET=${venue}`,
    `SCHOLAR_FLOW_CORPUS_SIGNING_SECRET=${corpus}`,
    "SCHOLAR_FLOW_LATEX_COMPILER_URL=http://127.0.0.1:3101/compile",
    "TECTONIC_ONLY_CACHED=1",
    "",
  ].join("\n");
  writeFileSync(destination, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Created ${destination} from the preserved OCI configuration without printing credentials.`,
  );
}

function activateOciEnvironment() {
  let frameworkStatus = null;
  try {
    frameworkStatus = lstatSync(frameworkEnvironment);
  } catch {
    // A missing .env.local is activated below.
  }

  if (frameworkStatus?.isSymbolicLink()) {
    const currentTarget = readlinkSync(frameworkEnvironment);
    if (currentTarget === destination) {
      console.log(
        `${destination} is already active through ${frameworkEnvironment}.`,
      );
      return;
    }
    if (!knownProviderTargets.has(currentTarget)) {
      if (existsSync(disabledCloudBackup)) {
        throw new Error(
          `${frameworkEnvironment} points to an unknown target and ${disabledCloudBackup} already exists. Preserve it manually before selecting OCI.`,
        );
      }
      renameSync(frameworkEnvironment, disabledCloudBackup);
      console.log(
        `Preserved the prior ${frameworkEnvironment} as ${disabledCloudBackup}.`,
      );
    } else {
      unlinkSync(frameworkEnvironment);
    }
  } else if (frameworkStatus) {
    if (existsSync(disabledCloudBackup)) {
      throw new Error(
        `${frameworkEnvironment} is a regular file and ${disabledCloudBackup} already exists. Preserve the conflicting file manually before selecting OCI.`,
      );
    }
    renameSync(frameworkEnvironment, disabledCloudBackup);
    console.log(
      `Preserved the prior ${frameworkEnvironment} as ${disabledCloudBackup}.`,
    );
  }

  symlinkSync(destination, frameworkEnvironment);
  console.log(
    `Activated OCI testing through ${frameworkEnvironment}. Local Llama remains available through npm run provider:local.`,
  );
}

createOciEnvironment();
activateOciEnvironment();

console.log(
  "Selected OCI with no provider fallback. Research text and attachments submitted for generation will leave this machine for the configured OCI endpoint.",
);
