import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SUBMISSION_TYPES,
  defaultSubmissionTypeForProfile,
  isRuleApplicableToSubmission,
  isSubmissionTypeAllowed,
  publisherForProfile,
  submissionTypesForProfile,
} from "../../lib/submission-types.mjs";

const FULL = "Full paper · Initial review";
const SHORT = "Short paper · Initial review";
const FINAL = "Camera-ready / final paper";
const JOURNAL = "Journal research article";
const REVIEW = "Review article";
const SPC = "Student Paper Competition";

const expectedByProfile = Object.freeze({
  "ieee-igarss-2026": Object.freeze([FULL, FINAL, SPC]),
  "acm-sigconf": Object.freeze([FULL, SHORT, FINAL]),
  "springer-lncs": Object.freeze([FULL, SHORT, FINAL]),
  "elsevier-research-article": Object.freeze([JOURNAL]),
  "custom-publication": Object.freeze([FULL, SHORT, FINAL, JOURNAL, REVIEW]),
});

test("every checked-in publication profile has at least one workflow", () => {
  const profileSource = readFileSync(
    new URL("../../lib/publication-profiles.ts", import.meta.url),
    "utf8",
  );
  const builtInProfileIds = Array.from(
    profileSource.matchAll(/^ {4}id: "([^"]+)",$/gm),
    (match) => match[1],
  );
  const customProfileId = profileSource.match(
    /^export const CUSTOM_PROFILE_ID = "([^"]+)";$/m,
  )?.[1];

  assert.ok(builtInProfileIds.length > 0);
  assert.ok(customProfileId);
  for (const profileId of [...builtInProfileIds, customProfileId]) {
    assert.ok(
      submissionTypesForProfile(profileId).length > 0,
      `${profileId} must declare at least one compatible submission type`,
    );
  }
});

test("exports the complete submission-type vocabulary in UI order", () => {
  assert.deepEqual(SUBMISSION_TYPES, [
    FULL,
    SHORT,
    FINAL,
    JOURNAL,
    REVIEW,
    SPC,
  ]);
  assert.equal(Object.isFrozen(SUBMISSION_TYPES), true);
});

test("returns the exact allowed types and default for every current profile", () => {
  for (const [profileId, expected] of Object.entries(expectedByProfile)) {
    const actual = submissionTypesForProfile(profileId);
    assert.deepEqual(actual, expected, profileId);
    assert.equal(Object.isFrozen(actual), true, profileId);
    assert.equal(defaultSubmissionTypeForProfile(profileId), expected[0], profileId);

    for (const type of SUBMISSION_TYPES) {
      assert.equal(
        isSubmissionTypeAllowed(profileId, type),
        expected.includes(type),
        `${profileId}: ${type}`,
      );
    }
  }
});

test("custom publications allow every global type except the IGARSS contest", () => {
  assert.deepEqual(
    submissionTypesForProfile("custom-publication"),
    SUBMISSION_TYPES.filter((type) => type !== SPC),
  );
  assert.equal(isSubmissionTypeAllowed("custom-publication", SPC), false);
});

test("binds built-in profile IDs to their exact publisher while leaving custom flexible", () => {
  assert.equal(publisherForProfile("ieee-igarss-2026"), "IEEE");
  assert.equal(
    publisherForProfile("acm-sigconf"),
    "Association for Computing Machinery",
  );
  assert.equal(publisherForProfile("springer-lncs"), "Springer Nature");
  assert.equal(publisherForProfile("elsevier-research-article"), "Elsevier");
  assert.equal(publisherForProfile("custom-publication"), "");
  for (const profileId of ["unknown", "toString", "__proto__", "", null]) {
    assert.equal(publisherForProfile(profileId), undefined);
  }
});

test("returned registries cannot be mutated", () => {
  const ieeeTypes = submissionTypesForProfile("ieee-igarss-2026");
  assert.throws(() => SUBMISSION_TYPES.push("Other"), TypeError);
  assert.throws(() => ieeeTypes.splice(0, 1), TypeError);
  assert.deepEqual(submissionTypesForProfile("ieee-igarss-2026"), [
    FULL,
    FINAL,
    SPC,
  ]);
});

test("unknown and malformed profile IDs fail closed", () => {
  for (const profileId of ["unknown", "toString", "__proto__", "", null]) {
    const types = submissionTypesForProfile(profileId);
    assert.deepEqual(types, []);
    assert.equal(Object.isFrozen(types), true);
    assert.equal(defaultSubmissionTypeForProfile(profileId), "");
    assert.equal(isSubmissionTypeAllowed(profileId, FULL), false);
  }
});

test("matching is exact and rejects malformed submission values", () => {
  assert.equal(
    isSubmissionTypeAllowed("ieee-igarss-2026", ` ${FULL}`),
    false,
  );
  assert.equal(isSubmissionTypeAllowed("ieee-igarss-2026", FULL.toLowerCase()), false);
  assert.equal(isSubmissionTypeAllowed("ieee-igarss-2026", null), false);
  assert.equal(isSubmissionTypeAllowed("ieee-igarss-2026", undefined), false);
});

test("submission-specific rules use deterministic workflow applicability", () => {
  assert.equal(
    isRuleApplicableToSubmission("ieee-igarss-2026", "igarss-spc-01", SPC),
    true,
  );
  assert.equal(
    isRuleApplicableToSubmission("ieee-igarss-2026", "igarss-spc-01", FULL),
    false,
  );
  assert.equal(
    isRuleApplicableToSubmission("ieee-igarss-2026", "igarss-layout-01", FULL),
    true,
  );
  assert.equal(
    isRuleApplicableToSubmission("acm-sigconf", "acm-review-01", FINAL),
    true,
    "unresolved starter-profile rules remain applicable for human review",
  );
  assert.equal(
    isRuleApplicableToSubmission("unknown", "some-rule", FULL),
    false,
  );
});
