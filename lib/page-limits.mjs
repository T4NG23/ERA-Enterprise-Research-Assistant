import { SUBMISSION_TYPES } from "./submission-types.mjs";

const FULL_PAPER = SUBMISSION_TYPES[0];
const CAMERA_READY = SUBMISSION_TYPES[2];
const STUDENT_PAPER_COMPETITION = SUBMISSION_TYPES[5];

const MINIMUM_PAGES = "minimum_pages";
const MAXIMUM_PAGES = "maximum_pages";
const EXACT_PAGES = "exact_pages";
const PAGE_RANGE = "page_range";
const TOTAL_PDF = "total_pdf";
const CONTENT_EXCLUDING_REFERENCES = "content_excluding_references";
const MAX_PAGE_COUNT = 10_000;
const MAX_ID_CHARACTERS = 240;
const MAX_RULE_IDS = 64;
const MAX_RULE_ID_CHARACTERS = 240;
const MAX_SOURCE_BASIS_CHARACTERS = 4_000;

const COMMON_POLICY_FIELDS = Object.freeze([
  "id",
  "mode",
  "countScope",
  "ruleIds",
  "sourceBasis",
]);
const MODE_FIELDS = Object.freeze({
  [MINIMUM_PAGES]: Object.freeze(["minPages"]),
  [MAXIMUM_PAGES]: Object.freeze(["maxPages"]),
  [EXACT_PAGES]: Object.freeze(["exactPages"]),
  [PAGE_RANGE]: Object.freeze(["minPages", "maxPages"]),
});
const PAGE_POLICY_MODES = new Set(Object.keys(MODE_FIELDS));
const PAGE_COUNT_SCOPES = new Set([
  TOTAL_PDF,
  CONTENT_EXCLUDING_REFERENCES,
]);

function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value : null;
}

function boundedNonblankString(value, name, maximum) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${name} must not be blank.`);
  }
  if (normalized.length > maximum) {
    throw new RangeError(
      `${name} must be ${maximum.toLocaleString("en-US")} characters or less.`,
    );
  }
  return normalized;
}

function pageCount(value, name) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PAGE_COUNT
  ) {
    throw new RangeError(
      `${name} must be a whole number from 1 through ${MAX_PAGE_COUNT.toLocaleString("en-US")}.`,
    );
  }
  return value;
}

function normalizedRuleIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("ruleIds must be a nonempty array.");
  }
  if (value.length > MAX_RULE_IDS) {
    throw new RangeError(
      `ruleIds must contain no more than ${MAX_RULE_IDS} entries.`,
    );
  }
  const result = value.map((ruleId, index) =>
    boundedNonblankString(
      ruleId,
      `ruleIds[${index}]`,
      MAX_RULE_ID_CHARACTERS,
    ),
  );
  if (new Set(result).size !== result.length) {
    throw new TypeError("ruleIds must not contain duplicates.");
  }
  return Object.freeze(result);
}

/**
 * Strictly normalize an enforceable page policy.
 *
 * Unknown fields and mode-incompatible page fields are rejected so an
 * author-confirmed policy cannot silently acquire a second interpretation.
 */
export function normalizePagePolicy(value) {
  const record = plainRecord(value);
  if (!record) {
    throw new TypeError("The page policy must be a plain object.");
  }

  const mode =
    typeof record.mode === "string" ? record.mode : "";
  if (!PAGE_POLICY_MODES.has(mode)) {
    throw new TypeError(
      `mode must be one of: ${[...PAGE_POLICY_MODES].join(", ")}.`,
    );
  }
  if (
    typeof record.countScope !== "string" ||
    !PAGE_COUNT_SCOPES.has(record.countScope)
  ) {
    throw new TypeError(
      `countScope must be one of: ${[...PAGE_COUNT_SCOPES].join(", ")}.`,
    );
  }

  const modeFields = MODE_FIELDS[mode];
  const allowedFields = new Set([...COMMON_POLICY_FIELDS, ...modeFields]);
  const unknownFields = Object.keys(record).filter(
    (field) => !allowedFields.has(field),
  );
  if (unknownFields.length) {
    throw new TypeError(
      `The page policy contains unsupported ${unknownFields.length === 1 ? "field" : "fields"}: ${unknownFields.join(", ")}.`,
    );
  }
  const missingFields = [...COMMON_POLICY_FIELDS, ...modeFields].filter(
    (field) => !Object.hasOwn(record, field),
  );
  if (missingFields.length) {
    throw new TypeError(
      `The page policy is missing required ${missingFields.length === 1 ? "field" : "fields"}: ${missingFields.join(", ")}.`,
    );
  }

  const normalized = {
    id: boundedNonblankString(record.id, "id", MAX_ID_CHARACTERS),
    mode,
    countScope: record.countScope,
    ...(mode === MINIMUM_PAGES || mode === PAGE_RANGE
      ? { minPages: pageCount(record.minPages, "minPages") }
      : {}),
    ...(mode === MAXIMUM_PAGES || mode === PAGE_RANGE
      ? { maxPages: pageCount(record.maxPages, "maxPages") }
      : {}),
    ...(mode === EXACT_PAGES
      ? { exactPages: pageCount(record.exactPages, "exactPages") }
      : {}),
    ruleIds: normalizedRuleIds(record.ruleIds),
    sourceBasis: boundedNonblankString(
      record.sourceBasis,
      "sourceBasis",
      MAX_SOURCE_BASIS_CHARACTERS,
    ),
  };

  if (
    mode === PAGE_RANGE &&
    normalized.minPages >= normalized.maxPages
  ) {
    throw new RangeError(
      "A page_range policy requires minPages to be less than maxPages; use exact_pages when both bounds are equal.",
    );
  }

  return Object.freeze(normalized);
}

const IGARSS_FULL_PAPER_POLICY = normalizePagePolicy({
  id: "igarss-full-paper-four-content-pages",
  mode: MAXIMUM_PAGES,
  countScope: CONTENT_EXCLUDING_REFERENCES,
  maxPages: 4,
  ruleIds: ["igarss-pages-01"],
  sourceBasis:
    "IGARSS 2026 full papers contain no more than four content pages; references are excluded from the count.",
});

const IGARSS_STUDENT_POLICY = normalizePagePolicy({
  id: "igarss-student-paper-exactly-four-pages",
  mode: EXACT_PAGES,
  countScope: CONTENT_EXCLUDING_REFERENCES,
  exactPages: 4,
  ruleIds: ["igarss-pages-01", "igarss-spc-01"],
  sourceBasis:
    "The IGARSS 2026 Student Paper Competition requires one publish-ready two-column manuscript of exactly four pages.",
});

const PAGE_POLICIES = Object.freeze({
  "ieee-igarss-2026": Object.freeze({
    [FULL_PAPER]: IGARSS_FULL_PAPER_POLICY,
    [CAMERA_READY]: IGARSS_FULL_PAPER_POLICY,
    [STUDENT_PAPER_COMPETITION]: IGARSS_STUDENT_POLICY,
  }),
});

function validPageCount(value) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_PAGE_COUNT
  );
}

function unavailable(message = "The compiled PDF page count could not be verified.") {
  return Object.freeze({ status: "unavailable", message });
}

function pluralPages(value) {
  return value === 1 ? "page" : "pages";
}

function countScopeText(policy) {
  return policy.countScope === TOTAL_PDF
    ? "total PDF"
    : "content, excluding references";
}

export function pagePolicyTargetText(policy) {
  const normalized = normalizePagePolicy(policy);
  const scope = countScopeText(normalized);
  if (normalized.mode === MINIMUM_PAGES) {
    return `at least ${normalized.minPages} ${pluralPages(normalized.minPages)} of ${scope}`;
  }
  if (normalized.mode === MAXIMUM_PAGES) {
    return `no more than ${normalized.maxPages} ${pluralPages(normalized.maxPages)} of ${scope}`;
  }
  if (normalized.mode === EXACT_PAGES) {
    return `exactly ${normalized.exactPages} ${pluralPages(normalized.exactPages)} of ${scope}`;
  }
  return `between ${normalized.minPages} and ${normalized.maxPages} pages of ${scope}, inclusive`;
}

export function getSubmissionPagePolicy(profileId, submissionType) {
  if (typeof profileId !== "string" || typeof submissionType !== "string") {
    return null;
  }
  if (!Object.hasOwn(PAGE_POLICIES, profileId)) return null;
  const profilePolicies = PAGE_POLICIES[profileId];
  return Object.hasOwn(profilePolicies, submissionType)
    ? profilePolicies[submissionType]
    : null;
}

export function assessCompiledPageCount(policy, measurement) {
  let normalized;
  try {
    normalized = normalizePagePolicy(policy);
  } catch {
    return unavailable("The selected page-limit policy is invalid.");
  }

  const totalPages = measurement?.totalPages;
  const contentPages = measurement?.contentPages;
  if (!validPageCount(totalPages)) {
    return unavailable();
  }
  if (
    contentPages !== undefined &&
    contentPages !== null &&
    !validPageCount(contentPages)
  ) {
    return unavailable("The compiler returned an invalid content-page count.");
  }
  if (
    validPageCount(contentPages) &&
    contentPages > totalPages
  ) {
    return unavailable(
      "The compiler reported more content pages than total PDF pages.",
    );
  }
  if (
    normalized.countScope === CONTENT_EXCLUDING_REFERENCES &&
    !validPageCount(contentPages)
  ) {
    return unavailable(
      "The compiler measured the total PDF length but could not isolate content pages from the excluded references.",
    );
  }

  const measuredPages =
    normalized.countScope === TOTAL_PDF ? totalPages : contentPages;
  const measuredLabel =
    normalized.countScope === TOTAL_PDF
      ? `${measuredPages} total PDF ${pluralPages(measuredPages)}`
      : `${measuredPages} content ${pluralPages(measuredPages)}`;
  const target = pagePolicyTargetText(normalized);
  let passes = false;

  if (normalized.mode === MINIMUM_PAGES) {
    passes = measuredPages >= normalized.minPages;
  } else if (normalized.mode === MAXIMUM_PAGES) {
    passes = measuredPages <= normalized.maxPages;
  } else if (normalized.mode === EXACT_PAGES) {
    passes = measuredPages === normalized.exactPages;
  } else if (normalized.mode === PAGE_RANGE) {
    passes =
      measuredPages >= normalized.minPages &&
      measuredPages <= normalized.maxPages;
  }

  const totalContext =
    normalized.countScope === CONTENT_EXCLUDING_REFERENCES
      ? ` The PDF has ${totalPages} total ${pluralPages(totalPages)} including references.`
      : "";
  return Object.freeze({
    status: passes ? "pass" : "fail",
    message: passes
      ? `The compiled PDF has ${measuredLabel}, satisfying the requirement of ${target}.${totalContext}`
      : `The compiled PDF has ${measuredLabel}, which does not satisfy the requirement of ${target}.${totalContext}`,
  });
}

export function applyUncompiledPagePolicy(
  items,
  profileId,
  submissionType,
  policyOverride,
) {
  const policy =
    policyOverride === undefined
      ? getSubmissionPagePolicy(profileId, submissionType)
      : normalizePagePolicy(policyOverride);
  if (!policy) return { items: items.map((item) => ({ ...item })), ruleIds: [] };

  const ruleIds = new Set(policy.ruleIds);
  const changedRuleIds = [];
  const normalizedItems = items.map((item) => {
    if (!ruleIds.has(item.ruleId) || item.status !== "pass") {
      return { ...item };
    }
    changedRuleIds.push(item.ruleId);
    return {
      ...item,
      status: "review",
      evidence:
        "The generated source follows the requested length target, but an exact page count does not exist until the LaTeX is compiled.",
      action: `Compile the PDF and verify that it has ${pagePolicyTargetText(policy)}.`,
    };
  });

  return {
    items: normalizedItems,
    ruleIds: Object.freeze(changedRuleIds),
  };
}

export const SUBMISSION_PAGE_POLICIES = PAGE_POLICIES;
