import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveVenueContractSigningSecret,
  VENUE_CONTRACT_SECRET_MAX_BYTES,
  VENUE_CONTRACT_SECRET_MIN_BYTES,
} from "../../lib/venue-contract-secret.mjs";

test("accepts only bounded UTF-8 signing key material", () => {
  for (const secret of [
    "a".repeat(VENUE_CONTRACT_SECRET_MIN_BYTES),
    "é".repeat(VENUE_CONTRACT_SECRET_MIN_BYTES / 2),
    "z".repeat(VENUE_CONTRACT_SECRET_MAX_BYTES),
  ]) {
    const resolved = resolveVenueContractSigningSecret({
      SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: ` ${secret} `,
      ORESOLVE_GENAI_API_KEY: "f".repeat(64),
    });
    assert.equal(resolved.status, "ready");
    assert.equal(resolved.mode, "dedicated_secret");
    assert.equal(resolved.secret, secret);
  }

  for (const secret of [
    "a".repeat(VENUE_CONTRACT_SECRET_MIN_BYTES - 1),
    "é".repeat(VENUE_CONTRACT_SECRET_MAX_BYTES / 2 + 1),
    "z".repeat(VENUE_CONTRACT_SECRET_MAX_BYTES + 1),
  ]) {
    const resolved = resolveVenueContractSigningSecret({
      SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: secret,
      ORESOLVE_GENAI_API_KEY: "f".repeat(64),
    });
    assert.equal(resolved.status, "invalid");
    assert.equal(resolved.mode, "invalid_dedicated_secret");
    assert.equal(resolved.secret, "");
    assert.match(resolved.error, /32–1,024 UTF-8 bytes/u);
  }
});

test("never falls back past an invalid explicit dedicated secret", () => {
  const resolved = resolveVenueContractSigningSecret({
    SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET: "x",
    ORESOLVE_GENAI_API_KEY: "f".repeat(64),
  });
  assert.equal(resolved.status, "invalid");
  assert.equal(resolved.mode, "invalid_dedicated_secret");
  assert.equal(resolved.secret, "");
});

test("never treats a cloud API key as signing material", () => {
  for (const environment of [
    {
      SCHOLAR_FLOW_MODE: "offline",
      ORESOLVE_GENAI_API_KEY: "o".repeat(64),
    },
    {
      SCHOLAR_FLOW_MODE: "cloud",
      ORESOLVE_GENAI_API_KEY: "o".repeat(64),
    },
    {
      ORESOLVE_GENAI_API_KEY: "short",
    },
    {},
  ]) {
    const resolved = resolveVenueContractSigningSecret(environment);
    assert.equal(resolved.status, "missing");
    assert.equal(resolved.mode, "none");
    assert.equal(resolved.secret, "");
    assert.match(resolved.error, /Cloud API keys are never used/u);
  }
});
