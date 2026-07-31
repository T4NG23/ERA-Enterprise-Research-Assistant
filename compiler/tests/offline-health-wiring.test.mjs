import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const healthRouteSource = readFileSync(
  new URL("../../app/api/health/route.ts", import.meta.url),
  "utf8",
);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("health uses the explicit provider runtime and fails closed when invalid", () => {
  const getHandler = sourceBetween(
    healthRouteSource,
    "export async function GET()",
    "\n}",
  );
  assert.match(getHandler, /const selected = getAiProviderRuntime\(\)/u);
  assert.match(
    getHandler,
    /if \(selected\.provider === "invalid"\) \{/u,
  );
  assert.match(getHandler, /provider: "invalid"/u);
  assert.match(getHandler, /mode: "invalid"/u);
  assert.match(getHandler, /status: "invalid_config"/u);
  assert.ok(
    getHandler.indexOf('selected.provider === "invalid"') <
      getHandler.indexOf("verifyAiProviderAccess(selected)"),
  );
});

test("health reports truthful privacy modes and provider transports", () => {
  assert.match(
    healthRouteSource,
    /selected\.provider === "local_llama"\s+\? "isolated"\s+: "cloud_testing"/u,
  );
  assert.match(healthRouteSource, /"local_chat_completions"/u);
  assert.match(healthRouteSource, /"oci_responses"/u);
  assert.match(healthRouteSource, /"oci_chat"/u);
  assert.match(
    healthRouteSource,
    /contextTokens: selected\.config\.contextTokens/u,
  );
  assert.match(healthRouteSource, /vision: selected\.config\.vision/u);
  assert.match(healthRouteSource, /region: selected\.config\.region/u);
});

test("health does not probe an invalid or incomplete provider", () => {
  const getHandler = sourceBetween(
    healthRouteSource,
    "export async function GET()",
    "\n}",
  );
  const accessIndex = getHandler.indexOf(
    "const access = await verifyAiProviderAccess(selected)",
  );
  assert.ok(accessIndex > 0);
  for (const guard of [
    "selected.configurationError",
    '!selected.config.apiKey',
    '!selected.config.projectId',
  ]) {
    const guardIndex = getHandler.indexOf(guard);
    assert.ok(guardIndex >= 0, `Missing health guard: ${guard}`);
    assert.ok(guardIndex < accessIndex, `${guard} must precede the probe`);
  }
});

test("health has no direct provider-specific runtime probe", () => {
  assert.match(healthRouteSource, /verifyAiProviderAccess/u);
  assert.doesNotMatch(
    healthRouteSource,
    /getOfflineRuntimeConfig|getOciRuntimeConfig|verifyOfflineLlamaAccess|verifyOciAccess/u,
  );
});
