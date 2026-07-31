export const SUBMISSION_TYPES = Object.freeze([
  "Full paper · Initial review",
  "Short paper · Initial review",
  "Camera-ready / final paper",
  "Journal research article",
  "Review article",
  "Student Paper Competition",
]);

const EMPTY_SUBMISSION_TYPES = Object.freeze([]);

const PROFILE_PUBLISHERS = Object.freeze({
  "ieee-igarss-2026": "IEEE",
  "acm-sigconf": "Association for Computing Machinery",
  "springer-lncs": "Springer Nature",
  "elsevier-research-article": "Elsevier",
  // A custom contract is deliberately author-defined and has no fixed family.
  "custom-publication": "",
});

const PROFILE_SUBMISSION_TYPES = Object.freeze({
  "ieee-igarss-2026": Object.freeze([
    SUBMISSION_TYPES[0],
    SUBMISSION_TYPES[2],
    SUBMISSION_TYPES[5],
  ]),
  "acm-sigconf": Object.freeze([
    SUBMISSION_TYPES[0],
    SUBMISSION_TYPES[1],
    SUBMISSION_TYPES[2],
  ]),
  "springer-lncs": Object.freeze([
    SUBMISSION_TYPES[0],
    SUBMISSION_TYPES[1],
    SUBMISSION_TYPES[2],
  ]),
  "elsevier-research-article": Object.freeze([SUBMISSION_TYPES[3]]),
  "custom-publication": Object.freeze(SUBMISSION_TYPES.slice(0, -1)),
});

const PROFILE_RULE_SUBMISSION_TYPES = Object.freeze({
  "ieee-igarss-2026": Object.freeze({
    "igarss-spc-01": Object.freeze([SUBMISSION_TYPES[5]]),
  }),
});

export function submissionTypesForProfile(profileId) {
  if (
    typeof profileId !== "string" ||
    !Object.hasOwn(PROFILE_SUBMISSION_TYPES, profileId)
  ) {
    return EMPTY_SUBMISSION_TYPES;
  }
  return PROFILE_SUBMISSION_TYPES[profileId];
}

export function defaultSubmissionTypeForProfile(profileId) {
  return submissionTypesForProfile(profileId)[0] ?? "";
}

export function isSubmissionTypeAllowed(profileId, value) {
  return (
    typeof value === "string" &&
    submissionTypesForProfile(profileId).includes(value)
  );
}

export function publisherForProfile(profileId) {
  if (
    typeof profileId !== "string" ||
    !Object.hasOwn(PROFILE_PUBLISHERS, profileId)
  ) {
    return undefined;
  }
  return PROFILE_PUBLISHERS[profileId];
}

export function isRuleApplicableToSubmission(
  profileId,
  ruleId,
  submissionType,
) {
  if (!isSubmissionTypeAllowed(profileId, submissionType)) return false;
  if (typeof ruleId !== "string" || !ruleId) return false;
  const restrictions = PROFILE_RULE_SUBMISSION_TYPES[profileId];
  if (!restrictions || !Object.hasOwn(restrictions, ruleId)) return true;
  return restrictions[ruleId].includes(submissionType);
}
