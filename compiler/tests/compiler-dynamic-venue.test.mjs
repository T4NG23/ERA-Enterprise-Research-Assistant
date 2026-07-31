import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { signVenueContractArtifact } from "../../lib/venue-contract-artifact.mjs";

const SERVER_PATH = fileURLToPath(new URL("../server.mjs", import.meta.url));
const DEDICATED_SECRET =
  "compiler-dynamic-venue-dedicated-secret-0123456789";
const OCI_FALLBACK_SECRET =
  "compiler-dynamic-venue-oci-fallback-secret-0123456789";
const SUBMISSION_TYPE = "Full paper · Initial review";
const LATEX = String.raw`\documentclass{article}
\begin{document}
\title{Signed Dynamic Venue Test}
\author{Test Author}
\maketitle
\begin{abstract}
An isolated compiler fixture for signed dynamic venue contracts.
\end{abstract}
Signed venue contracts are checked before compilation.
\end{document}
`;

function confirmedContract(overrides = {}) {
  return {
    version: 1,
    contractId: "vc-0123456789abcdef",
    provenance: "author_confirmed",
    venue: "Example Conference 2027",
    publisher: "Example Scholarly Society",
    submissionType: SUBMISSION_TYPE,
    confirmedAt: "2026-07-28T15:04:05.123Z",
    source: {
      requestedUrl: "https://publisher.example.org/authors/guidelines",
      finalUrl: "https://publisher.example.org/authors/guidelines",
      retrievedAt: "2026-07-28T14:03:02Z",
      title: "Official author guidelines",
      contentType: "text/html",
      sha256: "a".repeat(64),
    },
    extractor: {
      model: "test-only-extractor",
      version: "venue-guidelines-v1",
    },
    templateKey: "generic-article",
    pagePolicy: {
      id: "example-exactly-one-page",
      mode: "exact_pages",
      countScope: "total_pdf",
      exactPages: 1,
      ruleIds: ["imported-pages-01"],
      sourceBasis: "The test fixture requires exactly one page.",
    },
    rules: [
      {
        id: "imported-pages-01",
        category: "page_limit",
        label: "Page limit",
        requirement: "Exactly one total PDF page.",
        strength: "required",
        excerpt: "Papers must contain exactly one page.",
      },
    ],
    unresolved: ["Confirm the fictional copyright form."],
    ...overrides,
  };
}

function compilePayload(contract, artifact, overrides = {}) {
  return {
    latex: LATEX,
    title: "Signed Dynamic Venue Test",
    profileId: "custom-publication",
    submissionType: SUBMISSION_TYPE,
    assets: [],
    venueContract: contract,
    venueContractArtifact: artifact,
    ...overrides,
  };
}

async function unusedPort() {
  const candidate = net.createServer();
  candidate.unref();
  await new Promise((resolve, reject) => {
    candidate.once("error", reject);
    candidate.listen(0, "127.0.0.1", resolve);
  });
  const address = candidate.address();
  const port =
    address && typeof address === "object" ? address.port : null;
  await new Promise((resolve, reject) => {
    candidate.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("Could not reserve a compiler test port.");
  return port;
}

async function startCompiler(environment = {}) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "scholar-flow-compiler-test-"),
  );
  const mockCompiler = path.join(directory, "mock-tectonic.mjs");
  await writeFile(
    mockCompiler,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const outputIndex = process.argv.indexOf("--outdir");
const outputDirectory = process.argv[outputIndex + 1];
const inputName = process.argv.at(-1);
const stem = path.basename(inputName, ".tex");
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(path.join(outputDirectory, stem + ".pdf"), "%PDF-1.4\\n%%EOF\\n");
writeFileSync(path.join(outputDirectory, stem + ".log"), "Output written on " + stem + ".pdf (1 page, 15 bytes).\\n");
`,
    { encoding: "utf8", mode: 0o700 },
  );
  await chmod(mockCompiler, 0o700);
  const port = await unusedPort();
  const env = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    TECTONIC_BIN: mockCompiler,
    TECTONIC_CACHE_DIR: path.join(directory, "cache"),
    TECTONIC_ONLY_CACHED: "1",
    COMPILER_MAX_CONCURRENCY: "2",
  };
  delete env.SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET;
  delete env.ORESOLVE_GENAI_API_KEY;
  Object.assign(env, environment);

  const child = spawn(process.execPath, [SERVER_PATH], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout.on("data", (chunk) => {
    diagnostics += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk.toString("utf8");
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Compiler test server exited before startup: ${diagnostics}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return {
          baseUrl,
          child,
          directory,
          diagnostics: () => diagnostics,
        };
      }
    } catch {
      // The child has not bound its port yet.
    }
    await delay(20);
  }
  child.kill("SIGTERM");
  throw new Error(`Compiler test server did not start: ${diagnostics}`);
}

async function stopCompiler(instance) {
  if (instance.child.exitCode === null) {
    instance.child.kill("SIGTERM");
    await Promise.race([once(instance.child, "exit"), delay(2_000)]);
  }
  await rm(instance.directory, { recursive: true, force: true });
}

async function postCompile(baseUrl, body) {
  return fetch(`${baseUrl}/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function errorCode(response) {
  const body = await response.json();
  return body?.error?.code;
}

test("protocol v4 compiles an exactly signed raw dynamic venue contract", async (t) => {
  const compiler = await startCompiler({
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: DEDICATED_SECRET,
    ORESOLVE_GENAI_API_KEY: OCI_FALLBACK_SECRET,
  });
  t.after(() => stopCompiler(compiler));

  const healthResponse = await fetch(`${compiler.baseUrl}/health`);
  const health = await healthResponse.json();
  assert.equal(health.protocolVersion, 4);
  assert.equal(health.signedDynamicVenueContracts, true);
  assert.equal(health.venueContractSigningConfigured, true);
  assert.equal(health.venueContractSigningStatus, "ready");
  assert.equal(health.submissionAwareContracts, true);
  assert.equal(health.pageCountHeaders, true);

  const contract = confirmedContract();
  const artifact = await signVenueContractArtifact({
    contract,
    secret: DEDICATED_SECRET,
  });
  const response = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, artifact),
  );
  assert.equal(
    response.status,
    200,
    `${await response.clone().text()}\n${compiler.diagnostics()}`,
  );
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("x-scholar-flow-total-pages"), "1");
  assert.equal(response.headers.get("x-scholar-flow-protocol-version"), "4");
  assert.equal(
    response.headers.get(
      "x-scholar-flow-signed-dynamic-venue-contracts",
    ),
    "true",
  );
  assert.match(Buffer.from(await response.arrayBuffer()).toString(), /^%PDF-/u);

  const preflight = await fetch(`${compiler.baseUrl}/compile`, {
    method: "OPTIONS",
    headers: {
      Origin: "http://localhost:3000",
      "Access-Control-Request-Method": "POST",
    },
  });
  assert.equal(preflight.status, 204);
  const exposedHeaders =
    preflight.headers.get("access-control-expose-headers") ?? "";
  assert.match(exposedHeaders, /X-Scholar-Flow-Protocol-Version/u);
  assert.match(
    exposedHeaders,
    /X-Scholar-Flow-Signed-Dynamic-Venue-Contracts/u,
  );

  const fallbackArtifact = await signVenueContractArtifact({
    contract,
    secret: OCI_FALLBACK_SECRET,
  });
  const fallbackWhileDedicatedIsSet = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, fallbackArtifact),
  );
  assert.equal(fallbackWhileDedicatedIsSet.status, 422);
  assert.equal(
    await errorCode(fallbackWhileDedicatedIsSet),
    "VENUE_CONTRACT_INVALID",
  );
});

test("dynamic venue verification rejects tampering, partial pairs, and legacy derived fields", async (t) => {
  const compiler = await startCompiler({
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: DEDICATED_SECRET,
  });
  t.after(() => stopCompiler(compiler));
  const contract = confirmedContract();
  const artifact = await signVenueContractArtifact({
    contract,
    secret: DEDICATED_SECRET,
  });

  const normalizationEquivalentTamper = {
    ...contract,
    unresolved: [
      ...contract.unresolved,
      " confirm the fictional copyright form. ",
    ],
  };
  const tampered = await postCompile(
    compiler.baseUrl,
    compilePayload(normalizationEquivalentTamper, artifact),
  );
  assert.equal(tampered.status, 422);
  assert.equal(await errorCode(tampered), "VENUE_CONTRACT_INVALID");

  const missingArtifact = await postCompile(compiler.baseUrl, {
    ...compilePayload(contract, artifact),
    venueContractArtifact: undefined,
  });
  assert.equal(missingArtifact.status, 422);
  assert.equal(
    await errorCode(missingArtifact),
    "VENUE_CONTRACT_PAIR_REQUIRED",
  );

  const mixed = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, artifact, {
      venueTemplateKey: contract.templateKey,
      pagePolicy: contract.pagePolicy,
    }),
  );
  assert.equal(mixed.status, 422);
  assert.equal(await errorCode(mixed), "VENUE_CONTRACT_FIELDS_MIXED");

  const builtInPublisherMismatch = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, artifact, {
      profileId: "ieee-igarss-2026",
    }),
  );
  assert.equal(builtInPublisherMismatch.status, 422);
  assert.equal(
    await errorCode(builtInPublisherMismatch),
    "VENUE_CONTRACT_PUBLISHER_MISMATCH",
  );

  const legacyDerivedOnly = await postCompile(compiler.baseUrl, {
    latex: LATEX,
    title: "Legacy Derived Dynamic Venue Test",
    profileId: "custom-publication",
    submissionType: SUBMISSION_TYPE,
    assets: [],
    venueTemplateKey: contract.templateKey,
    pagePolicy: contract.pagePolicy,
  });
  assert.equal(legacyDerivedOnly.status, 422);
  assert.equal(
    await errorCode(legacyDerivedOnly),
    "UNTRUSTED_DYNAMIC_VENUE_FIELDS",
  );
});

test("dynamic compilation fails closed without either signing secret", async (t) => {
  const compiler = await startCompiler();
  t.after(() => stopCompiler(compiler));
  const health = await (await fetch(`${compiler.baseUrl}/health`)).json();
  assert.equal(health.venueContractSigningConfigured, false);

  const contract = confirmedContract();
  const artifact = await signVenueContractArtifact({
    contract,
    secret: DEDICATED_SECRET,
  });
  const response = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, artifact),
  );
  assert.equal(response.status, 503);
  assert.equal(
    await errorCode(response),
    "VENUE_CONTRACT_SIGNING_UNAVAILABLE",
  );
});

test("an invalid dedicated secret fails configuration without OCI fallback", async (t) => {
  const compiler = await startCompiler({
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "x",
    ORESOLVE_GENAI_API_KEY: OCI_FALLBACK_SECRET,
  });
  t.after(() => stopCompiler(compiler));
  const health = await (await fetch(`${compiler.baseUrl}/health`)).json();
  assert.equal(health.venueContractSigningConfigured, false);
  assert.equal(health.venueContractSigningStatus, "invalid");

  const contract = confirmedContract();
  const fallbackArtifact = await signVenueContractArtifact({
    contract,
    secret: OCI_FALLBACK_SECRET,
  });
  const response = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, fallbackArtifact),
  );
  assert.equal(response.status, 503);
  assert.equal(
    await errorCode(response),
    "VENUE_CONTRACT_SIGNING_INVALID",
  );
});

test("cloud API keys cannot verify signed contracts and static compilation remains unchanged", async (t) => {
  const compiler = await startCompiler({
    SCHOLAR_FLOW_MODE: "cloud",
    ORESOLVE_GENAI_API_KEY: OCI_FALLBACK_SECRET,
  });
  t.after(() => stopCompiler(compiler));
  const contract = confirmedContract();
  const artifact = await signVenueContractArtifact({
    contract,
    secret: OCI_FALLBACK_SECRET,
  });

  const dynamicResponse = await postCompile(
    compiler.baseUrl,
    compilePayload(contract, artifact),
  );
  assert.equal(dynamicResponse.status, 503);
  assert.equal(
    await errorCode(dynamicResponse),
    "VENUE_CONTRACT_SIGNING_UNAVAILABLE",
  );

  const staticResponse = await postCompile(compiler.baseUrl, {
    latex: LATEX,
    title: "Static Publication Test",
    profileId: "custom-publication",
    submissionType: SUBMISSION_TYPE,
    assets: [],
  });
  assert.equal(staticResponse.status, 200, await staticResponse.clone().text());
  assert.equal(
    staticResponse.headers.get("x-scholar-flow-total-pages"),
    "1",
  );
});
