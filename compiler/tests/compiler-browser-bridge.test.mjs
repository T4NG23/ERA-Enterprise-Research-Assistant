import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  isLoopbackHostname,
  parseCompilerPageCount,
  permitsLoopbackCompilerFallback,
  shouldUseDirectCompilerSmoke,
  shouldUseDirectPdfCompiler,
  supportsCompilerBridgeProtocol,
} from "../../lib/compiler-browser-bridge.mjs";

const workspaceSource = readFileSync(
  new URL("../../app/components/manuscript-workspace.tsx", import.meta.url),
  "utf8",
);
const smokeComponentSource = readFileSync(
  new URL("../../app/components/compiler-smoke-test.tsx", import.meta.url),
  "utf8",
);
const compileRouteSource = readFileSync(
  new URL("../../app/api/compile/route.ts", import.meta.url),
  "utf8",
);
const smokeRouteSource = readFileSync(
  new URL("../../app/api/compile/smoke/route.ts", import.meta.url),
  "utf8",
);
const compilerServerSource = readFileSync(
  new URL("../server.mjs", import.meta.url),
  "utf8",
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("recognizes only exact loopback hostnames including bracketed IPv6", () => {
  for (const hostname of [
    "localhost",
    "LOCALHOST",
    "127.0.0.1",
    "::1",
    "[::1]",
  ]) {
    assert.equal(isLoopbackHostname(hostname), true, hostname);
  }
  for (const hostname of [
    "",
    "localhost.example",
    "127.0.0.2",
    "[::2]",
    " localhost",
    "localhost ",
    null,
    undefined,
  ]) {
    assert.equal(isLoopbackHostname(hostname), false, String(hostname));
  }
});

test("permits direct fallback only for a tokenless local default", () => {
  const base = {
    requestHostname: "localhost",
    configuredUrl: "",
    token: "",
  };
  assert.equal(permitsLoopbackCompilerFallback(base), true);
  assert.equal(
    permitsLoopbackCompilerFallback({
      ...base,
      requestHostname: "[::1]",
    }),
    true,
  );
  assert.equal(
    permitsLoopbackCompilerFallback({ ...base, token: "private-token" }),
    false,
  );
  assert.equal(
    permitsLoopbackCompilerFallback({
      ...base,
      configuredUrl: "http://127.0.0.1:3101/compile",
    }),
    false,
  );
  assert.equal(
    permitsLoopbackCompilerFallback({
      ...base,
      requestHostname: "scholar-flow.example",
    }),
    false,
  );
});

test("paper fallback accepts only a matching unavailable response", () => {
  const base = {
    browserHostname: "localhost",
    loopbackFallbackAllowed: true,
  };
  assert.equal(
    shouldUseDirectPdfCompiler({
      ...base,
      status: 502,
      code: "PDF_COMPILER_UNAVAILABLE",
    }),
    true,
  );
  assert.equal(
    shouldUseDirectPdfCompiler({
      ...base,
      browserHostname: "[::1]",
      status: 504,
      code: "PDF_COMPILER_TIMEOUT",
    }),
    false,
  );

  for (const input of [
    { ...base, status: 502, code: "PDF_COMPILER_TIMEOUT" },
    { ...base, status: 504, code: "PDF_COMPILER_UNAVAILABLE" },
    { ...base, status: 500, code: "PDF_COMPILER_UNAVAILABLE" },
    {
      ...base,
      status: 502,
      code: "PDF_COMPILER_UNAVAILABLE",
      loopbackFallbackAllowed: false,
    },
    {
      ...base,
      browserHostname: "scholar-flow.example",
      status: 502,
      code: "PDF_COMPILER_UNAVAILABLE",
    },
  ]) {
    assert.equal(shouldUseDirectPdfCompiler(input), false);
  }
});

test("smoke fallback requires its exact local-unavailable response", () => {
  const base = {
    browserHostname: "127.0.0.1",
    code: "LOCAL_COMPILER_UNAVAILABLE",
    loopbackFallbackAllowed: true,
  };
  assert.equal(shouldUseDirectCompilerSmoke(base), true);
  assert.equal(
    shouldUseDirectCompilerSmoke({ ...base, browserHostname: "[::1]" }),
    true,
  );
  assert.equal(
    shouldUseDirectCompilerSmoke({
      ...base,
      code: "PDF_COMPILER_UNAVAILABLE",
    }),
    false,
  );
  assert.equal(
    shouldUseDirectCompilerSmoke({
      ...base,
      loopbackFallbackAllowed: false,
    }),
    false,
  );
});

test("accepts only the current compiler bridge health contract", () => {
  assert.equal(
    supportsCompilerBridgeProtocol(
      {
        protocolVersion: 4,
        submissionAwareContracts: true,
        pageCountHeaders: true,
        signedDynamicVenueContracts: true,
      },
      true,
    ),
    true,
  );
  for (const [value, responseOk] of [
    [
      {
        protocolVersion: 3,
        submissionAwareContracts: true,
        pageCountHeaders: true,
        signedDynamicVenueContracts: true,
      },
      true,
    ],
    [
      {
        protocolVersion: 4,
        submissionAwareContracts: false,
        pageCountHeaders: true,
        signedDynamicVenueContracts: true,
      },
      true,
    ],
    [
      {
        protocolVersion: 4,
        submissionAwareContracts: true,
        pageCountHeaders: false,
        signedDynamicVenueContracts: true,
      },
      true,
    ],
    [
      {
        protocolVersion: 4,
        submissionAwareContracts: true,
        pageCountHeaders: true,
        signedDynamicVenueContracts: true,
      },
      false,
    ],
    [
      {
        protocolVersion: 4,
        submissionAwareContracts: true,
        pageCountHeaders: true,
        signedDynamicVenueContracts: false,
      },
      true,
    ],
    [null, true],
    [[], true],
  ]) {
    assert.equal(supportsCompilerBridgeProtocol(value, responseOk), false);
  }
});

test("accepts only bounded canonical compiler page-count headers", () => {
  for (const [value, expected] of [
    ["1", 1],
    ["4", 4],
    ["10000", 10_000],
    ["0", null],
    ["10001", null],
    ["04", null],
    ["4.0", null],
    [" 4", null],
    ["4 ", null],
    ["pages=4", null],
    ["", null],
    [null, null],
    [4, null],
  ]) {
    assert.equal(parseCompilerPageCount(value), expected, String(value));
  }
});

test("browser bridges keep direct requests credential-free and fixed to loopback", () => {
  const paperBridge = sourceBetween(
    workspaceSource,
    "async function requestPdfCompilation",
    "function latexContractLabel",
  );
  const smokeBridge = sourceBetween(
    smokeComponentSource,
    "async function requestDirectLoopbackSmoke",
    "export default function CompilerSmokeTest",
  );

  for (const [bridge, endpoint] of [
    [paperBridge, "compile"],
    [smokeBridge, "smoke"],
  ]) {
    assert.match(bridge, /http:\/\/127\.0\.0\.1:3101\/health/);
    assert.match(bridge, new RegExp(`http:\\/\\/127\\.0\\.0\\.1:3101\\/${endpoint}`));
    assert.match(bridge, /credentials: "omit"/);
    assert.match(bridge, /mode: "cors"/);
    assert.match(bridge, /redirect: "error"/);
    assert.match(bridge, /referrerPolicy: "no-referrer"/);
    assert.doesNotMatch(bridge, /Authorization/i);
    assert.doesNotMatch(bridge, /credentials:\s*["']include["']/);
  }
});

test("API routes derive fallback permission through the shared helper", () => {
  for (const source of [compileRouteSource, smokeRouteSource]) {
    assert.match(source, /permitsLoopbackCompilerFallback\(\{/);
    assert.match(source, /configuredUrl: configuredUrl \?\? ""/);
    assert.match(source, /\btoken,/);
    assert.match(source, /compiler\.usesLocalDefault/);
  }

  const timeoutBranch = sourceBetween(
    compileRouteSource,
    '"The PDF compiler did not finish within 55 seconds."',
    '"The private PDF compiler could not be reached."',
  );
  assert.match(timeoutBranch, /"PDF_COMPILER_TIMEOUT"/);
  assert.doesNotMatch(timeoutBranch, /loopbackFallbackAllowed: true/);
});

test("local compiler owns CORS, token, and publication-contract enforcement", () => {
  assert.match(
    compilerServerSource,
    /if \(token \|\| !isLoopbackHost\(host\) \|\| typeof origin !== "string"\)/,
  );
  assert.match(
    compilerServerSource,
    /request\.method === "POST" && request\.url === "\/smoke"/,
  );
  assert.match(
    compilerServerSource,
    /if \(!localCorsOrigin \|\| token \|\| !isLoopbackHost\(host\)\)/,
  );
  assert.match(compilerServerSource, /publicationLatexContractIssues\(/);
  assert.match(
    compilerServerSource,
    /Access-Control-Allow-Headers", "Content-Type"/,
  );
  assert.match(
    compilerServerSource,
    /Access-Control-Expose-Headers"[\s\S]*X-Scholar-Flow-Total-Pages, X-Scholar-Flow-Content-Pages/,
  );
  assert.match(
    compilerServerSource,
    /X-Scholar-Flow-Protocol-Version, X-Scholar-Flow-Signed-Dynamic-Venue-Contracts/u,
  );
});

test("compiled page measurements are validated before the browser downloads a PDF", () => {
  assert.match(
    compileRouteSource,
    /parseCompilerPageCount\(\s*response\.headers\.get\("x-scholar-flow-total-pages"\)/,
  );
  assert.match(
    compileRouteSource,
    /"X-Scholar-Flow-Total-Pages": String\(totalPageCount\)/,
  );
  assert.match(
    compileRouteSource,
    /"X-Scholar-Flow-Content-Pages": String\(contentPageCount\)/,
  );

  const compileUi = sourceBetween(
    workspaceSource,
    "async function compilePdf()",
    "\n  return (\n",
  );
  const assessmentIndex = compileUi.indexOf("assessCompiledPageCount");
  const blockedIndex = compileUi.indexOf("The download was blocked.");
  const downloadIndex = compileUi.indexOf("saveBlob(");
  assert.ok(assessmentIndex >= 0);
  assert.ok(blockedIndex > assessmentIndex);
  assert.ok(downloadIndex > blockedIndex);
  assert.match(
    compileUi,
    /response\.headers\.get\("x-scholar-flow-content-pages"\)/,
  );
});
