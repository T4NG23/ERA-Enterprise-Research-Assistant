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

const destination = ".env.offline.local";
const frameworkEnvironment = ".env.local";
const disabledCloudBackup = ".env.cloud-disabled.backup";
const ociEnvironment = ".env.oci.local";

function secret() {
  return randomBytes(48).toString("base64url");
}

if (!existsSync(destination)) {
  const contents = [
    "# Scholar Flow closed-isolation configuration.",
    "# This file is ignored by Git. Keep it server-only.",
    "SCHOLAR_FLOW_AI_PROVIDER=local_llama",
    "SCHOLAR_FLOW_MODE=offline",
    "SCHOLAR_FLOW_LLAMA_BASE_URL=http://127.0.0.1:8080/v1",
    "SCHOLAR_FLOW_LLAMA_MODEL=scholar-flow-local",
    "SCHOLAR_FLOW_LLAMA_MODEL_PATH=",
    "SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS=32768",
    "SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS=8192",
    "SCHOLAR_FLOW_LLAMA_VISION_ENABLED=false",
    `SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET=${secret()}`,
    `SCHOLAR_FLOW_CORPUS_SIGNING_SECRET=${secret()}`,
    "SCHOLAR_FLOW_LATEX_COMPILER_URL=http://127.0.0.1:3101/compile",
    "TECTONIC_ONLY_CACHED=1",
    "",
  ].join("\n");

  writeFileSync(destination, contents, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(`Created ${destination} with private local signing secrets.`);
} else {
  const contents = readFileSync(destination, "utf8");
  const providerMatch = contents.match(
    /^\s*SCHOLAR_FLOW_AI_PROVIDER\s*=(.*)$/mu,
  );
  const provider = providerMatch?.[1]?.trim() ?? "";
  if (provider && provider !== "local_llama") {
    throw new Error(
      `${destination} exists but selects a provider other than local_llama.`,
    );
  }
  if (!provider) {
    writeFileSync(
      destination,
      `${contents.replace(/\n*$/u, "")}\nSCHOLAR_FLOW_AI_PROVIDER=local_llama\n`,
      {
        encoding: "utf8",
        flag: "w",
        mode: 0o600,
      },
    );
    console.log(
      `Added the explicit local_llama selector to ${destination}; existing secrets were preserved.`,
    );
  } else {
    chmodSync(destination, 0o600);
    console.log(`${destination} already exists; no secrets were changed.`);
  }
}

let frameworkEnvironmentExists = false;
try {
  frameworkEnvironmentExists = lstatSync(frameworkEnvironment).isFile() ||
    lstatSync(frameworkEnvironment).isSymbolicLink();
} catch {
  // A missing .env.local is activated below.
}

const alreadyActivated =
  frameworkEnvironmentExists &&
  lstatSync(frameworkEnvironment).isSymbolicLink() &&
  readlinkSync(frameworkEnvironment) === destination;

if (!alreadyActivated) {
  if (frameworkEnvironmentExists) {
    const frameworkStatus = lstatSync(frameworkEnvironment);
    const currentTarget = frameworkStatus.isSymbolicLink()
      ? readlinkSync(frameworkEnvironment)
      : "";
    if (
      frameworkStatus.isSymbolicLink() &&
      currentTarget === ociEnvironment
    ) {
      unlinkSync(frameworkEnvironment);
    } else {
      if (existsSync(disabledCloudBackup)) {
        throw new Error(
          `${frameworkEnvironment} is not a known Scholar Flow provider link and ${disabledCloudBackup} already exists. Preserve the conflicting file manually, then rerun this setup.`,
        );
      }
      renameSync(frameworkEnvironment, disabledCloudBackup);
      console.log(
        `Preserved the prior ${frameworkEnvironment} as ${disabledCloudBackup}.`,
      );
    }
  }
  symlinkSync(destination, frameworkEnvironment);
  console.log(
    `Activated ${destination} through ${frameworkEnvironment} for vinext.`,
  );
}

console.log(
  "Selected local_llama with no provider fallback. OCI credentials are stripped from the web process in this mode. Model weights are not downloaded automatically; start llama-server on 127.0.0.1:8080 with alias scholar-flow-local.",
);
