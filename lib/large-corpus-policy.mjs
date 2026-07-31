export const LARGE_CORPUS_ROLES = Object.freeze([
  "abstract",
  "introduction",
  "background",
  "related-work",
  "methods",
  "data",
  "experiments",
  "results",
  "findings",
  "synthesis",
  "discussion",
  "limitations",
  "conclusion",
  "acknowledgments",
  "references",
  "unclassified",
]);

const NON_SUBSTANTIVE_ROLES = new Set([
  "acknowledgments",
  "references",
  "unclassified",
]);

function frozenWeights(values) {
  return Object.freeze(
    LARGE_CORPUS_ROLES.map((role) =>
      Object.freeze({
        role,
        weight: values[role],
        substantive: !NON_SUBSTANTIVE_ROLES.has(role),
      }),
    ),
  );
}

export const LARGE_CORPUS_WEIGHTING_POLICIES = Object.freeze({
  "empirical-research-v1": frozenWeights({
    abstract: 12,
    introduction: 14,
    background: 12,
    "related-work": 14,
    methods: 36,
    data: 34,
    experiments: 38,
    results: 40,
    findings: 38,
    synthesis: 28,
    discussion: 30,
    limitations: 26,
    conclusion: 30,
    acknowledgments: 2,
    references: 1,
    unclassified: 0,
  }),
  "review-synthesis-v1": frozenWeights({
    abstract: 14,
    introduction: 16,
    background: 22,
    "related-work": 38,
    methods: 20,
    data: 14,
    experiments: 10,
    results: 28,
    findings: 38,
    synthesis: 40,
    discussion: 36,
    limitations: 28,
    conclusion: 34,
    acknowledgments: 2,
    references: 6,
    unclassified: 0,
  }),
});

export const LARGE_CORPUS_SELECTION_POLICY = Object.freeze({
  id: "source-and-substantive-role-seeds-v2",
  scope: "transparent-general-paper-heuristic-not-universal",
  sourceSeed: "best-ranked-chunk-per-nonempty-source",
  roleSeed:
    "best-ranked-meaningful-chunk-per-detected-substantive-role",
  ranking: "lexical-score-plus-primary-role-weight",
  budgetRule: "deduplicated-seeds-before-global-ranking-when-they-fit",
  renderOrder: "source-index-then-chunk-index",
});

export function weightingPolicyForSubmissionType(submissionType) {
  return /\breview\s+(?:article|paper)\b|\b(?:article|paper)\s+review\b/iu.test(
    typeof submissionType === "string" ? submissionType : "",
  )
    ? "review-synthesis-v1"
    : "empirical-research-v1";
}

export function roleWeightsForSubmissionType(submissionType) {
  return LARGE_CORPUS_WEIGHTING_POLICIES[
    weightingPolicyForSubmissionType(submissionType)
  ];
}
