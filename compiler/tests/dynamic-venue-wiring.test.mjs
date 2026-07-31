import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  signVenueContractArtifact,
  verifyVenueContractArtifact,
} from "../../lib/venue-contract-artifact.mjs";
import {
  normalizeConfirmedVenueContract,
} from "../../lib/venue-guidelines.mjs";

const generateRouteSource = readFileSync(
  new URL("../../app/api/generate/route.ts", import.meta.url),
  "utf8",
);
const compileRouteSource = readFileSync(
  new URL("../../app/api/compile/route.ts", import.meta.url),
  "utf8",
);
const importRouteSource = readFileSync(
  new URL(
    "../../app/api/venue-guidelines/import/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const healthRouteSource = readFileSync(
  new URL("../../app/api/health/route.ts", import.meta.url),
  "utf8",
);
const contractRuntimeSource = readFileSync(
  new URL("../../lib/venue-contract-runtime.ts", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../../app/components/manuscript-workspace.tsx", import.meta.url),
  "utf8",
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function confirmedContract() {
  return normalizeConfirmedVenueContract({
    version: 1,
    contractId: "vc-1234567890abcdef",
    provenance: "author_confirmed",
    venue: "Example Conference 2027",
    publisher: "Example Scholarly Society",
    submissionType: "Full paper · Initial review",
    confirmedAt: "2027-01-02T03:04:05Z",
    source: {
      requestedUrl: "https://example.org/guidelines",
      finalUrl: "https://example.org/guidelines",
      retrievedAt: "2027-01-02T02:03:04Z",
      title: "Official author guidance",
      contentType: "text/html",
      sha256: "a".repeat(64),
    },
    extractor: {
      model: "scholar-flow-local",
      version: "venue-guidelines-v1",
    },
    templateKey: "generic-article",
    pagePolicy: null,
    rules: [],
    unresolved: ["Confirm whether appendices count."],
  });
}

test("confirmed venue contracts cannot cross a built-in publisher boundary", () => {
  const validation = sourceBetween(
    generateRouteSource,
    "if (\n    profile &&\n    confirmedVenueContract &&",
    "if (profile && confirmedVenueContract) {",
  );

  assert.match(validation, /profileId !== CUSTOM_PROFILE_ID/u);
  assert.match(
    validation,
    /confirmedVenueContract\.publisher !== profile\.publisher/u,
  );
  assert.match(
    validation,
    /does not match the selected publisher profile/u,
  );
});

test("confirmed venue rules replace venue-specific starter placeholders", () => {
  const override = sourceBetween(
    generateRouteSource,
    "function profileWithConfirmedVenueContract",
    "function errorResponse",
  );

  assert.match(
    override,
    /publisher: contract\.publisher \|\| profile\.publisher/u,
  );
  assert.match(
    override,
    /rule\.level !== "venue-specific"/u,
  );
  assert.match(override, /\.\.\.importedRules/u);
  assert.ok(
    override.indexOf('rule.level !== "venue-specific"') <
      override.indexOf("...importedRules"),
    "Publisher baselines must be filtered before exact venue rules are appended.",
  );
});

test("dynamic contracts enter the direct bridge only after the proxy explicitly permits it", () => {
  const bridge = sourceBetween(
    workspaceSource,
    "async function requestPdfCompilation",
    "function latexContractLabel",
  );

  const proxyRequest = bridge.indexOf('fetch("/api/compile"');
  const fallbackDecision = bridge.indexOf("shouldUseDirectPdfCompiler");
  const directRequest = bridge.indexOf(
    'fetch("http://127.0.0.1:3101/compile"',
  );
  assert.ok(proxyRequest >= 0);
  assert.ok(fallbackDecision > proxyRequest);
  assert.ok(directRequest > fallbackDecision);
  assert.doesNotMatch(bridge, /if \(payload\.venueContract\) return response/u);
  assert.match(bridge, /loopbackFallbackAllowed: body\.loopbackFallbackAllowed/u);
  assert.match(bridge, /body: JSON\.stringify\(compilerPayload\)/u);
  assert.match(
    bridge,
    /venueContract\s*\?\s*\{ \.\.\.staticPayload, venueContract, venueContractArtifact \}\s*:\s*staticPayload/u,
  );
  assert.match(
    bridge,
    /venueContractSigningConfigured !== true/u,
  );
});

test("the compile proxy forwards the authenticated raw contract instead of derived policy fields", () => {
  const upstream = sourceBetween(
    compileRouteSource,
    "const upstreamPayload = payload.venueContract",
    "const response = await fetch(compiler.url",
  );

  assert.match(upstream, /venueContract: submittedVenueContract!\.contract/u);
  assert.match(
    upstream,
    /venueContractArtifact: submittedVenueContract!\.artifact/u,
  );
  assert.doesNotMatch(upstream, /venueTemplateKey/u);
  assert.doesNotMatch(upstream, /pagePolicy:/u);
});

test("the compile proxy binds built-in publishers and preflights protocol v4 before dynamic compilation", () => {
  const validation = sourceBetween(
    compileRouteSource,
    "function validatePayload",
    "function clientIdentifier",
  );
  assert.match(validation, /publisherForProfile\(profileId\)/u);
  assert.match(
    validation,
    /venueContract\.publisher !== requiredPublisher/u,
  );

  const proxyCompile = sourceBetween(
    compileRouteSource,
    "const controller = new AbortController()",
    "} catch (error) {",
  );
  const preflight = proxyCompile.indexOf(
    "compilerSupportsSignedVenueContracts",
  );
  const compileRequest = proxyCompile.indexOf(
    "const response = await fetch(compiler.url",
  );
  assert.ok(preflight >= 0);
  assert.ok(compileRequest > preflight);
  assert.match(
    compileRouteSource,
    /supportsCompilerBridgeProtocol\(value, true\)/u,
  );
  assert.match(compileRouteSource, /"PDF_COMPILER_OUTDATED"/u);
  assert.match(
    compileRouteSource,
    /venueContractSigningConfigured === true/u,
  );
  assert.match(
    compileRouteSource,
    /x-scholar-flow-protocol-version/u,
  );
  assert.match(
    compileRouteSource,
    /x-scholar-flow-signed-dynamic-venue-contracts/u,
  );
});

test("the compile proxy uses own-property semantics for dynamic field presence", () => {
  const fields = sourceBetween(
    compileRouteSource,
    "function submittedVenueContractFields",
    "function decodeBase64",
  );
  assert.match(fields, /Object\.hasOwn\(record, "venueContract"\)/u);
  assert.match(
    fields,
    /Object\.hasOwn\(record, "venueContractArtifact"\)/u,
  );
  const validation = sourceBetween(
    compileRouteSource,
    "function validatePayload",
    "function clientIdentifier",
  );
  assert.match(validation, /hasVenueContract !== hasVenueContractArtifact/u);
  assert.match(compileRouteSource, /"VENUE_CONTRACT_PAIR_REQUIRED"/u);
});

test("normalization-equivalent contract tampering fails exact HMAC verification", async () => {
  const original = confirmedContract();
  const secret = "test-only-dynamic-venue-secret";
  const artifact = await signVenueContractArtifact({
    contract: original,
    secret,
  });
  const tampered = {
    ...original,
    unresolved: [
      ...original.unresolved,
      "confirm whether appendices count.",
    ],
  };
  const normalizedTampered = normalizeConfirmedVenueContract(tampered);

  assert.deepEqual(normalizedTampered, original);
  assert.equal(
    await verifyVenueContractArtifact({
      artifact,
      contract: normalizedTampered,
      secret,
    }),
    true,
    "This demonstrates why route verification must not normalize first.",
  );
  assert.equal(
    await verifyVenueContractArtifact({
      artifact,
      contract: tampered,
      secret,
    }),
    false,
  );
});

test("generation and compilation verify raw contracts before normalization", () => {
  const generationVerification = sourceBetween(
    generateRouteSource,
    "const parsed = JSON.parse(rawFields.venueContract);",
    "let profile = getPublicationProfile(profileId);",
  );
  assert.match(generationVerification, /contract: parsed/u);
  assert.ok(
    generationVerification.indexOf("verifyVenueContractArtifact") <
      generationVerification.indexOf(
        "normalizeConfirmedVenueContract(parsed)",
      ),
  );

  const compilePost = sourceBetween(
    compileRouteSource,
    "export async function POST",
    "let compiler: ReturnType<typeof compilerConfiguration>",
  );
  assert.match(
    compilePost,
    /contract: submittedVenueContract\.contract/u,
  );
  assert.ok(
    compilePost.indexOf("verifyVenueContractArtifact") <
      compilePost.indexOf("payload = validatePayload(rawPayload)"),
  );
});

test("guideline import rate-limit state is pruned and bounded", () => {
  const limiter = sourceBetween(
    importRouteSource,
    "function takeImportSlot",
    "async function parseMultipartFormData",
  );
  assert.match(limiter, /MAX_RATE_LIMIT_CLIENTS/u);
  assert.match(limiter, /importGuard\.requestsByClient\.delete\(key\)/u);
  assert.match(limiter, /"overflow-clients"/u);
});

test("health reports provider-neutral dedicated venue signing", () => {
  assert.match(
    contractRuntimeSource,
    /stableAcrossModelChanges: usesDedicatedSecret/u,
  );
  assert.match(
    contractRuntimeSource,
    /SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET/u,
  );
  assert.doesNotMatch(
    contractRuntimeSource,
    /ORESOLVE_GENAI_API_KEY/u,
  );
  assert.match(
    healthRouteSource,
    /const venueContractSigning = signingHealth\(/u,
  );
  assert.match(
    healthRouteSource,
    /selected\.venueSigningSecret/u,
  );
  assert.doesNotMatch(
    healthRouteSource,
    /ORESOLVE_GENAI_API_KEY.*venueSigning|venueContractSigningHealth/u,
  );
  assert.match(
    workspaceSource,
    /OCI cloud testing · Research materials leave this app/u,
  );
  assert.match(
    workspaceSource,
    /Local Ollama · No live publication web retrieval/u,
  );
  assert.match(
    workspaceSource,
    /health\.provider === "local_llama" && health\.mode === "isolated"/u,
  );
});
