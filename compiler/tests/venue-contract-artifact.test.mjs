import assert from "node:assert/strict";
import test from "node:test";

import {
  signVenueContractArtifact,
  VENUE_CONTRACT_ARTIFACT_VERSION,
  verifyVenueContractArtifact,
} from "../../lib/venue-contract-artifact.mjs";

const SECRET = "test-only-venue-contract-secret-0123456789";

function contract(overrides = {}) {
  return {
    version: 1,
    provenance: "author_confirmed",
    publisher: "Example Scholarly Society",
    targetVenue: "Example Conference 2027",
    submissionType: "Full paper · Initial review",
    source: {
      url: "https://example.invalid/author-guide",
      guidanceSha256: "a".repeat(64),
      capturedAt: "2027-01-10",
    },
    templateContractKey: "ieee-conference",
    pagePolicy: {
      id: "example-four-page-maximum",
      mode: "maximum_content_pages",
      maxPages: 4,
      referencesExcluded: true,
      ruleIds: ["venue-pages-a1b2c3"],
    },
    rules: [
      {
        id: "venue-pages-a1b2c3",
        label: "Length",
        value: "No more than four content pages.",
        level: "venue-specific",
      },
    ],
    ...overrides,
  };
}

async function signed(value = contract(), secret = SECRET) {
  return signVenueContractArtifact({ contract: value, secret });
}

async function verifies(artifact, value = contract(), secret = SECRET) {
  return verifyVenueContractArtifact({
    artifact,
    contract: value,
    secret,
  });
}

test("signs a durable compact versioned token with no time fields", async () => {
  const artifact = await signed();
  assert.equal(VENUE_CONTRACT_ARTIFACT_VERSION, 1);
  assert.match(artifact, /^1\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(artifact.split(".").length, 2);
  assert.equal(await verifies(artifact), true);
});

test("is deterministic and recursively canonicalizes object key order", async () => {
  const original = contract();
  const first = await signed(original);
  const reordered = {
    rules: original.rules.map((rule) => ({
      level: rule.level,
      value: rule.value,
      label: rule.label,
      id: rule.id,
    })),
    pagePolicy: {
      ruleIds: [...original.pagePolicy.ruleIds],
      referencesExcluded: original.pagePolicy.referencesExcluded,
      maxPages: original.pagePolicy.maxPages,
      mode: original.pagePolicy.mode,
      id: original.pagePolicy.id,
    },
    templateContractKey: original.templateContractKey,
    source: {
      capturedAt: original.source.capturedAt,
      guidanceSha256: original.source.guidanceSha256,
      url: original.source.url,
    },
    submissionType: original.submissionType,
    targetVenue: original.targetVenue,
    publisher: original.publisher,
    provenance: original.provenance,
    version: original.version,
  };

  assert.equal(await signed(reordered), first);
  assert.equal(await verifies(first, reordered), true);
});

test("binds every top-level and nested contract field", async (t) => {
  const original = contract();
  const artifact = await signed(original);
  const cases = [
    ["version", { version: 2 }],
    ["provenance", { provenance: "curated" }],
    ["publisher", { publisher: `${original.publisher} Press` }],
    ["venue", { targetVenue: `${original.targetVenue} Workshop` }],
    ["submission type", { submissionType: "Camera-ready / final paper" }],
    ["template", { templateContractKey: "article" }],
    [
      "source",
      { source: { ...original.source, capturedAt: "2027-01-11" } },
    ],
    [
      "page policy",
      {
        pagePolicy: {
          ...original.pagePolicy,
          maxPages: original.pagePolicy.maxPages + 1,
        },
      },
    ],
    [
      "rule value",
      {
        rules: [
          {
            ...original.rules[0],
            value: `${original.rules[0].value} References excluded.`,
          },
        ],
      },
    ],
    ["added field", { newlyConfirmed: true }],
  ];

  for (const [name, override] of cases) {
    await t.test(name, async () => {
      assert.equal(
        await verifies(artifact, contract(override)),
        false,
      );
    });
  }
});

test("preserves string bytes rather than silently normalizing them", async () => {
  const original = contract({
    notes: "Line one\r\nLine two",
  });
  const artifact = await signed(original);
  assert.equal(
    await verifies(
      artifact,
      contract({
        notes: "Line one\nLine two",
      }),
    ),
    false,
  );
});

test("rejects JSON values and containers that canonical JSON would omit or rewrite", async (t) => {
  const cases = [
    ["undefined", { omitted: undefined }],
    ["function", { omitted: () => true }],
    ["bigint", { omitted: 1n }],
    ["symbol value", { omitted: Symbol("value") }],
    ["non-finite number", { omitted: Number.NaN }],
    ["infinity", { omitted: Number.POSITIVE_INFINITY }],
    ["date object", { omitted: new Date("2027-01-01T00:00:00Z") }],
    ["map object", { omitted: new Map([["rule", "value"]]) }],
  ];

  for (const [name, override] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => signed(contract(override)),
        /JSON|finite|plain/u,
      );
    });
  }
});

test("rejects sparse, accessor, symbol-keyed, hidden, and named array data", async (t) => {
  const sparse = [];
  sparse.length = 1;

  const accessor = {};
  Object.defineProperty(accessor, "rule", {
    enumerable: true,
    get() {
      return "must not run";
    },
  });

  const hidden = { visible: true };
  Object.defineProperty(hidden, "hidden", {
    enumerable: false,
    value: "must not disappear",
  });

  const symbolKeyed = { visible: true };
  symbolKeyed[Symbol("hidden")] = "must not disappear";

  const namedArray = ["rule"];
  namedArray.source = "must not disappear";

  const outOfRangeNumericArray = ["rule"];
  outOfRangeNumericArray["4294967295"] = "must not disappear";

  const cases = [
    ["sparse array", sparse],
    ["accessor property", accessor],
    ["non-enumerable property", hidden],
    ["symbol-keyed property", symbolKeyed],
    ["named array property", namedArray],
    ["out-of-range numeric array property", outOfRangeNumericArray],
  ];
  for (const [name, value] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => signed(contract({ suspicious: value })),
        /array|data properties|symbol|JSON/u,
      );
    });
  }
});

test("rejects circular data, excessive depth, keys, arrays, and serialized text", async (t) => {
  const circular = { label: "cycle" };
  circular.self = circular;

  let deeplyNested = "leaf";
  for (let index = 0; index < 40; index += 1) {
    deeplyNested = { child: deeplyNested };
  }

  const tooManyKeys = {};
  for (let index = 0; index < 4_100; index += 1) {
    tooManyKeys[`rule-${index}`] = index;
  }

  const cases = [
    ["circular", circular, /circular/u],
    ["depth", deeplyNested, /deeply/u],
    ["keys", tooManyKeys, /object keys|JSON values/u],
    ["array items", Array.from({ length: 4_100 }, (_, index) => index), /array items/u],
    ["serialized characters", "x".repeat(100_001), /canonical JSON limit/u],
  ];
  for (const [name, value, pattern] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => signed(contract({ boundedValue: value })),
        pattern,
      );
    });
  }
});

test("requires a plain contract and exact sign/verify input fields", async () => {
  await assert.rejects(
    () => signVenueContractArtifact({ contract: [], secret: SECRET }),
    /contract must be a JSON object/u,
  );
  await assert.rejects(
    () =>
      signVenueContractArtifact({
        contract: contract(),
        secret: SECRET,
        expiresAt: 123,
      }),
    /must contain exactly/u,
  );

  const artifact = await signed();
  assert.equal(
    await verifyVenueContractArtifact({
      artifact,
      contract: contract(),
      secret: SECRET,
      ignored: true,
    }),
    false,
  );
});

test("enforces secret bounds without trimming or transforming the secret", async () => {
  await assert.rejects(
    () => signed(contract(), ""),
    /secret must be a non-empty string/u,
  );
  await assert.rejects(
    () => signed(contract(), "x".repeat(16_385)),
    /secret must be a non-empty string/u,
  );

  const artifact = await signed(contract(), " secret ");
  assert.equal(await verifies(artifact, contract(), " secret "), true);
  assert.equal(await verifies(artifact, contract(), "secret"), false);
});

test("returns false for malformed, noncanonical, wrong-version, or tampered artifacts", async () => {
  const artifact = await signed();
  const last = artifact.at(-1);
  const changedLast = last === "A" ? "B" : "A";
  const signature = artifact.slice(2);
  const noncanonicalLastCharacter =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".at(
      ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(
        signature.at(-1),
      ) +
        1) %
        64,
    );

  assert.equal(await verifies(`${artifact.slice(0, -1)}${changedLast}`), false);
  assert.equal(await verifies(`2.${signature}`), false);
  assert.equal(await verifies(`${artifact}.extra`), false);
  assert.equal(await verifies(`1.${signature.slice(0, -1)}${noncanonicalLastCharacter}`), false);
  assert.equal(await verifies(""), false);
  assert.equal(await verifies(null), false);
});
