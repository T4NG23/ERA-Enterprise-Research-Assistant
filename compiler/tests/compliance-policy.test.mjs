import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProfileCompliancePolicy,
  applySubmissionApplicabilityPolicy,
  deterministicProfileWarnings,
  mergeWarnings,
} from "../../lib/compliance-policy.mjs";

function profile(overrides = {}) {
  return {
    id: "starter-profile",
    confidence: "starter",
    status: "active",
    edition: "Current test edition",
    template: {
      latex: {
        documentClass: "acmart",
        classBasis: "publisher-template",
      },
    },
    rules: [
      { id: "venue-pass", level: "venue-specific" },
      { id: "publisher-pass", level: "required" },
      { id: "venue-fail", level: "venue-specific" },
      { id: "venue-review", level: "venue-specific" },
      { id: "venue-na", level: "venue-specific" },
    ],
    ...overrides,
  };
}

test("downgrades only starter-profile venue-specific passes", () => {
  const items = [
    {
      ruleId: "venue-pass",
      label: "Venue pass",
      status: "pass",
      evidence: "The draft appears to satisfy the supplied requirement.",
      action: "Keep the existing author action.",
    },
    {
      ruleId: "publisher-pass",
      label: "Publisher pass",
      status: "pass",
      evidence: "The publisher-level template is present.",
      action: "",
    },
    {
      ruleId: "venue-fail",
      label: "Venue failure",
      status: "fail",
      evidence: "The supplied maximum is exceeded.",
      action: "Shorten the paper.",
    },
    {
      ruleId: "venue-review",
      label: "Venue review",
      status: "review",
      evidence: "Evidence is incomplete.",
      action: "Confirm the review mode.",
    },
    {
      ruleId: "venue-na",
      label: "Venue not applicable",
      status: "not_applicable",
      evidence: "This track does not use the requirement.",
      action: "",
    },
  ];
  const original = structuredClone(items);

  const result = applyProfileCompliancePolicy(items, profile());

  assert.deepEqual(
    result.items.map((item) => item.ruleId),
    items.map((item) => item.ruleId),
    "the profile policy must preserve model/profile order",
  );
  assert.deepEqual(
    result.items.map((item) => item.status),
    ["review", "pass", "fail", "review", "not_applicable"],
  );
  assert.deepEqual(
    result.items.map((item) => item.evidence),
    items.map((item) => item.evidence),
    "grounded evidence must not be rewritten",
  );
  assert.match(
    result.items[0].action,
    /^Keep the existing author action\. Confirm this venue-specific rule's wording/,
  );
  assert.deepEqual(result.downgradedRuleIds, ["venue-pass"]);
  assert.equal(Object.isFrozen(result.downgradedRuleIds), true);
  assert.deepEqual(items, original, "normalization must not mutate model output");
});

test("does not downgrade a verified profile's venue-specific pass", () => {
  const items = [
    {
      ruleId: "venue-pass",
      label: "Verified venue rule",
      status: "pass",
      evidence: "Verified evidence.",
      action: "No action.",
    },
  ];
  const verifiedProfile = profile({
    confidence: "verified",
    rules: [{ id: "venue-pass", level: "venue-specific" }],
  });

  const result = applyProfileCompliancePolicy(items, verifiedProfile);

  assert.deepEqual(result.items, items);
  assert.deepEqual(result.downgradedRuleIds, []);
});

test("marks a contest-only rule not applicable outside its workflow", () => {
  const items = [
    {
      ruleId: "igarss-layout-01",
      label: "Layout",
      status: "pass",
      evidence: "Two columns are present.",
      action: "",
    },
    {
      ruleId: "igarss-spc-01",
      label: "Student Paper Contest",
      status: "fail",
      evidence: "The advisor attestation is missing.",
      action: "Attach it.",
    },
  ];
  const result = applySubmissionApplicabilityPolicy(
    items,
    { id: "ieee-igarss-2026" },
    "Full paper · Initial review",
  );

  assert.deepEqual(result.items[0], items[0]);
  assert.deepEqual(result.items[1], {
    ...items[1],
    status: "not_applicable",
    evidence:
      "This rule does not apply to the selected Full paper · Initial review workflow.",
    action: "",
  });
  assert.deepEqual(result.notApplicableRuleIds, ["igarss-spc-01"]);
  assert.deepEqual(items[1], {
    ruleId: "igarss-spc-01",
    label: "Student Paper Contest",
    status: "fail",
    evidence: "The advisor attestation is missing.",
    action: "Attach it.",
  });
});

test("keeps the contest rule active for the contest workflow", () => {
  const items = [
    {
      ruleId: "igarss-spc-01",
      status: "review",
      evidence: "Advisor evidence needs review.",
      action: "Confirm eligibility.",
    },
  ];
  const result = applySubmissionApplicabilityPolicy(
    items,
    { id: "ieee-igarss-2026" },
    "Student Paper Competition",
  );

  assert.deepEqual(result.items, items);
  assert.deepEqual(result.notApplicableRuleIds, []);
});

test("keeps the verification suffix intact within the action limit", () => {
  const actionLimit = 8_000;
  const result = applyProfileCompliancePolicy(
    [
      {
        ruleId: "venue-pass",
        status: "pass",
        evidence: "Evidence remains unchanged.",
        action: "A".repeat(actionLimit),
      },
    ],
    profile({ rules: [{ id: "venue-pass", level: "venue-specific" }] }),
    actionLimit,
  );

  assert.ok(result.items[0].action.length <= actionLimit);
  assert.match(
    result.items[0].action,
    /current official source before treating it as passed\.$/,
  );
  assert.equal(result.items[0].evidence, "Evidence remains unchanged.");
});

test("preserves an existing verification suffix when a later limit is smaller", () => {
  const first = applyProfileCompliancePolicy(
    [{ ruleId: "venue-pass", status: "pass", evidence: "", action: "Review this." }],
    profile({ rules: [{ id: "venue-pass", level: "venue-specific" }] }),
  );
  const repeated = applyProfileCompliancePolicy(
    [{ ...first.items[0], status: "pass" }],
    profile({ rules: [{ id: "venue-pass", level: "venue-specific" }] }),
    180,
  );

  assert.ok(repeated.items[0].action.length <= 180);
  assert.match(
    repeated.items[0].action,
    /current official source before treating it as passed\.$/,
  );
});

test("emits deterministic starter, downgrade, closed, and fallback warnings", () => {
  const warnings = deterministicProfileWarnings(
    profile({
      status: "closed",
      edition: "2026 test cycle",
      template: {
        latex: {
          documentClass: "article",
          classBasis: "compiler-fallback",
        },
      },
    }),
    ["venue-one", "venue-two"],
  );

  assert.equal(warnings.length, 4);
  assert.match(warnings[0], /starter profile/);
  assert.match(warnings[1], /kept 2 model-reported venue-specific checks at review/);
  assert.match(warnings[2], /closed archival profile/);
  assert.match(warnings[2], /2026 test cycle/);
  assert.match(warnings[3], /article document class is a compiler fallback/);
});

test("emits no deterministic warning for an active verified publisher template", () => {
  assert.deepEqual(
    deterministicProfileWarnings(
      profile({
        confidence: "verified",
        status: "active",
      }),
      [],
    ),
    [],
  );
});

test("retains application warnings ahead of a full model-warning budget", () => {
  const applicationWarnings = [
    "Starter provenance warning",
    "Closed-profile warning",
    "Compiler fallback warning",
    "Repair warning",
  ];
  const modelWarnings = Array.from(
    { length: 100 },
    (_, index) => `Model warning ${index + 1}`,
  );

  const merged = mergeWarnings(applicationWarnings, modelWarnings, 100);

  assert.equal(merged.length, 100);
  assert.deepEqual(merged.slice(0, 4), applicationWarnings);
  assert.equal(merged[4], "Model warning 1");
  assert.equal(merged.at(-1), "Model warning 96");
  assert.doesNotMatch(merged.join("\n"), /Model warning 97(?:\n|$)/);
});

test("deduplicates case and whitespace stably while enforcing item and count limits", () => {
  const merged = mergeWarnings(
    ["  Keep   This\nWarning  ", "SECOND warning"],
    [
      "keep this warning",
      " second   WARNING ",
      "123456789",
      "1234567 duplicate after truncation",
      "not reached",
    ],
    3,
    7,
  );

  assert.deepEqual(merged, ["Keep Th", "SECOND", "1234567"]);
  assert.ok(merged.every((warning) => warning.length <= 7));
});

test("ignores blank and non-string warnings without disturbing stable order", () => {
  assert.deepEqual(
    mergeWarnings(
      ["Application one", "  ", null],
      [undefined, "Model one", "APPLICATION ONE", "Model two"],
      10,
      5_000,
    ),
    ["Application one", "Model one", "Model two"],
  );
});
