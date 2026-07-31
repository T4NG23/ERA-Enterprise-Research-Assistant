import { normalizePagePolicy } from "./page-limits.mjs";

export const VENUE_GUIDELINE_EXTRACTOR_VERSION = "venue-guidelines-v1";

export const VENUE_TEMPLATE_OPTIONS = Object.freeze([
  Object.freeze({
    key: "generic-article",
    label: "Generic article fallback",
    description: "Standard article class; formatting remains author-reviewed.",
  }),
  Object.freeze({
    key: "ieee-conference",
    label: "IEEE conference",
    description: "IEEEtran with the conference option.",
  }),
  Object.freeze({
    key: "acm-sigconf-review",
    label: "ACM SIGCONF review",
    description: "ACM conference review source using the curated ACM contract.",
  }),
  Object.freeze({
    key: "acm-sigconf-final",
    label: "ACM SIGCONF final",
    description: "acmart with the sigconf option and final-paper restrictions.",
  }),
  Object.freeze({
    key: "springer-lncs",
    label: "Springer LNCS",
    description: "Springer Lecture Notes in Computer Science class.",
  }),
  Object.freeze({
    key: "elsevier-article",
    label: "Elsevier article",
    description: "Scholar Flow's elsarticle compiler fallback.",
  }),
]);

const TEMPLATE_KEYS = new Set(VENUE_TEMPLATE_OPTIONS.map((option) => option.key));
const PAGE_MODES = new Set([
  "minimum_pages",
  "maximum_pages",
  "exact_pages",
  "page_range",
]);
const PAGE_SCOPES = new Set([
  "total_pdf",
  "content_excluding_references",
  "unknown",
]);
const STRENGTHS = new Set(["required", "recommended", "ambiguous"]);
const RULE_STRENGTHS = new Set(["required", "recommended"]);
const RULE_CATEGORIES = new Set([
  "layout",
  "template",
  "anonymity",
  "abstract",
  "sections",
  "references",
  "figures",
  "file",
  "submission",
  "ethics",
  "other",
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const ISO_DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const CONTRACT_ID_PATTERN = /^vc-[a-f0-9]{16}$/u;
const EXTRACTOR_PAGE_SCOPE_ALIASES = Object.freeze({
  excluding_references: "content_excluding_references",
  references_excluded: "content_excluding_references",
  including_references: "total_pdf",
  all_pages: "total_pdf",
  not_specified: "unknown",
  unspecified: "unknown",
});
const FNV64_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const contractIdEncoder = new TextEncoder();

function canonicalLabelJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalLabelJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalLabelJson(value[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function deterministicContractLabel(value) {
  let hash = FNV64_OFFSET_BASIS;
  for (const byte of contractIdEncoder.encode(canonicalLabelJson(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * FNV64_PRIME);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Canonicalizes a deliberately tiny set of vocabulary aliases observed at the
 * model boundary. The strict proposal normalizer remains unchanged, so any
 * other misspelling, unknown field, or unsupported value still fails closed.
 */
export function canonicalizeVenueGuidelineExtraction(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return value;
  }
  const pageLimit = value.pageLimit;
  if (
    !pageLimit ||
    typeof pageLimit !== "object" ||
    Array.isArray(pageLimit) ||
    (Object.getPrototypeOf(pageLimit) !== Object.prototype &&
      Object.getPrototypeOf(pageLimit) !== null)
  ) {
    return value;
  }
  const scope = pageLimit.countScope;
  if (
    typeof scope !== "string" ||
    !Object.hasOwn(EXTRACTOR_PAGE_SCOPE_ALIASES, scope)
  ) {
    return value;
  }
  return {
    ...value,
    pageLimit: {
      ...pageLimit,
      countScope: EXTRACTOR_PAGE_SCOPE_ALIASES[scope],
    },
  };
}

function plainRecord(value, name, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  const record = value;
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new TypeError(`${name}.${unexpected} is not an accepted field.`);
  }
  return record;
}

function boundedString(
  value,
  name,
  maximum,
  { required = true, trim = true } = {},
) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const normalized = value.replaceAll(/\r\n?/gu, "\n");
  const result = trim ? normalized.trim() : normalized;
  if (required && !result) throw new TypeError(`${name} must not be blank.`);
  if (result.length > maximum) {
    throw new TypeError(
      `${name} must be ${maximum.toLocaleString("en-US")} characters or less.`,
    );
  }
  return result;
}

function boundedOptionalString(value, name, maximum) {
  if (value === null || value === undefined || value === "") return "";
  return boundedString(value, name, maximum, { required: false });
}

function boundedPageInteger(value, name, required) {
  if (!required && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new TypeError(`${name} must be a whole page count from 1 through 10,000.`);
  }
  return value;
}

function normalizeHttpUrl(value, name) {
  const text = boundedString(value, name, 2_000);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError(`${name} must be a valid HTTP or HTTPS URL.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new TypeError(`${name} must be an HTTP or HTTPS URL without credentials.`);
  }
  return url.href;
}

function normalizeSource(value, name = "source") {
  const source = plainRecord(value, name, [
    "requestedUrl",
    "finalUrl",
    "retrievedAt",
    "title",
    "contentType",
    "sha256",
  ]);
  const retrievedAt = boundedString(
    source.retrievedAt,
    `${name}.retrievedAt`,
    40,
  );
  if (!ISO_DATE_PATTERN.test(retrievedAt) || !Number.isFinite(Date.parse(retrievedAt))) {
    throw new TypeError(`${name}.retrievedAt must be an ISO-8601 UTC timestamp.`);
  }
  const sha256 = boundedString(source.sha256, `${name}.sha256`, 64).toLowerCase();
  if (!HASH_PATTERN.test(sha256)) {
    throw new TypeError(`${name}.sha256 must be a lowercase SHA-256 digest.`);
  }
  const contentType = boundedString(
    source.contentType,
    `${name}.contentType`,
    120,
  ).toLowerCase();
  if (!["text/html", "text/plain", "application/pdf"].includes(contentType)) {
    throw new TypeError(`${name}.contentType is not supported.`);
  }
  return Object.freeze({
    requestedUrl: normalizeHttpUrl(source.requestedUrl, `${name}.requestedUrl`),
    finalUrl: normalizeHttpUrl(source.finalUrl, `${name}.finalUrl`),
    retrievedAt,
    title: boundedOptionalString(source.title, `${name}.title`, 500),
    contentType,
    sha256,
  });
}

function normalizeCandidatePageLimit(value) {
  if (value === null || value === undefined) return null;
  const page = plainRecord(value, "pageLimit", [
    "mode",
    "minPages",
    "maxPages",
    "exactPages",
    "countScope",
    "strength",
    "excerpt",
    "explanation",
  ]);
  const mode = boundedString(page.mode, "pageLimit.mode", 40);
  if (!PAGE_MODES.has(mode)) {
    throw new TypeError("pageLimit.mode is not supported.");
  }
  const countScope = boundedString(
    page.countScope,
    "pageLimit.countScope",
    40,
  );
  if (!PAGE_SCOPES.has(countScope)) {
    throw new TypeError("pageLimit.countScope is not supported.");
  }
  const strength = boundedString(page.strength, "pageLimit.strength", 24);
  if (!STRENGTHS.has(strength)) {
    throw new TypeError("pageLimit.strength is not supported.");
  }

  const minRequired = mode === "minimum_pages" || mode === "page_range";
  const maxRequired = mode === "maximum_pages" || mode === "page_range";
  const exactRequired = mode === "exact_pages";
  const minPages = boundedPageInteger(
    page.minPages,
    "pageLimit.minPages",
    minRequired,
  );
  const maxPages = boundedPageInteger(
    page.maxPages,
    "pageLimit.maxPages",
    maxRequired,
  );
  const exactPages = boundedPageInteger(
    page.exactPages,
    "pageLimit.exactPages",
    exactRequired,
  );
  if (!minRequired && minPages !== null) {
    throw new TypeError("pageLimit.minPages does not belong to this mode.");
  }
  if (!maxRequired && maxPages !== null) {
    throw new TypeError("pageLimit.maxPages does not belong to this mode.");
  }
  if (!exactRequired && exactPages !== null) {
    throw new TypeError("pageLimit.exactPages does not belong to this mode.");
  }
  if (mode === "page_range" && minPages > maxPages) {
    throw new TypeError("pageLimit.minPages must not exceed maxPages.");
  }

  return Object.freeze({
    mode,
    minPages,
    maxPages,
    exactPages,
    countScope,
    strength,
    excerpt: boundedString(page.excerpt, "pageLimit.excerpt", 1_500),
    explanation: boundedString(
      page.explanation,
      "pageLimit.explanation",
      1_500,
    ),
  });
}

function normalizeTemplateCandidate(value) {
  if (value === null || value === undefined) return null;
  const template = plainRecord(value, "template", [
    "key",
    "strength",
    "excerpt",
    "explanation",
  ]);
  const key = boundedString(template.key, "template.key", 60);
  if (!TEMPLATE_KEYS.has(key)) {
    throw new TypeError("template.key is not supported.");
  }
  const strength = boundedString(template.strength, "template.strength", 24);
  if (!STRENGTHS.has(strength)) {
    throw new TypeError("template.strength is not supported.");
  }
  return Object.freeze({
    key,
    strength,
    excerpt: boundedString(template.excerpt, "template.excerpt", 1_500),
    explanation: boundedString(
      template.explanation,
      "template.explanation",
      1_500,
    ),
  });
}

function normalizeRules(value, name = "rules") {
  if (!Array.isArray(value) || value.length > 40) {
    throw new TypeError(`${name} must be an array with no more than 40 rules.`);
  }
  const rules = value.map((candidate, index) => {
    const rule = plainRecord(candidate, `${name}[${index}]`, [
      "category",
      "label",
      "requirement",
      "strength",
      "excerpt",
    ]);
    const category = boundedString(
      rule.category,
      `${name}[${index}].category`,
      40,
    );
    if (!RULE_CATEGORIES.has(category)) {
      throw new TypeError(`${name}[${index}].category is not supported.`);
    }
    const strength = boundedString(
      rule.strength,
      `${name}[${index}].strength`,
      24,
    );
    if (!RULE_STRENGTHS.has(strength)) {
      throw new TypeError(`${name}[${index}].strength is not supported.`);
    }
    return Object.freeze({
      id: `imported-rule-${String(index + 1).padStart(2, "0")}`,
      category,
      label: boundedString(rule.label, `${name}[${index}].label`, 180),
      requirement: boundedString(
        rule.requirement,
        `${name}[${index}].requirement`,
        2_000,
      ),
      strength,
      excerpt: boundedString(
        rule.excerpt,
        `${name}[${index}].excerpt`,
        1_500,
      ),
    });
  });
  return Object.freeze(rules);
}

function normalizeUnresolved(value, name = "unresolved") {
  if (!Array.isArray(value) || value.length > 30) {
    throw new TypeError(
      `${name} must be an array with no more than 30 items.`,
    );
  }
  const seen = new Set();
  const items = [];
  for (const [index, candidate] of value.entries()) {
    const item = boundedString(candidate, `${name}[${index}]`, 800);
    const folded = item.toLocaleLowerCase("en-US");
    if (!seen.has(folded)) {
      seen.add(folded);
      items.push(item);
    }
  }
  return Object.freeze(items);
}

export function normalizeVenueGuidelineProposal(value, context) {
  const candidate = plainRecord(value, "extraction", [
    "pageLimit",
    "template",
    "rules",
    "unresolved",
  ]);
  const proposalContext = plainRecord(context, "context", [
    "venue",
    "publisher",
    "submissionType",
    "source",
    "model",
  ]);
  return Object.freeze({
    version: 1,
    venue: boundedString(proposalContext.venue, "context.venue", 240),
    publisher: boundedOptionalString(
      proposalContext.publisher,
      "context.publisher",
      160,
    ),
    submissionType: boundedString(
      proposalContext.submissionType,
      "context.submissionType",
      120,
    ),
    source: normalizeSource(proposalContext.source),
    extractor: Object.freeze({
      model: boundedString(proposalContext.model, "context.model", 200),
      version: VENUE_GUIDELINE_EXTRACTOR_VERSION,
    }),
    pageLimit: normalizeCandidatePageLimit(candidate.pageLimit),
    template: normalizeTemplateCandidate(candidate.template),
    rules: normalizeRules(candidate.rules),
    unresolved: normalizeUnresolved(candidate.unresolved),
  });
}

function normalizeContractRules(value) {
  if (!Array.isArray(value) || value.length > 41) {
    throw new TypeError("contract.rules must contain no more than 41 rules.");
  }
  const seen = new Set();
  const rules = value.map((candidate, index) => {
    const rule = plainRecord(candidate, `contract.rules[${index}]`, [
      "id",
      "category",
      "label",
      "requirement",
      "strength",
      "excerpt",
    ]);
    const id = boundedString(rule.id, `contract.rules[${index}].id`, 100);
    if (!/^(?:imported-rule-\d{2}|imported-pages-01)$/u.test(id) || seen.has(id)) {
      throw new TypeError(`contract.rules[${index}].id is invalid or duplicated.`);
    }
    seen.add(id);
    const category = boundedString(
      rule.category,
      `contract.rules[${index}].category`,
      40,
    );
    if (![...RULE_CATEGORIES, "page_limit"].includes(category)) {
      throw new TypeError(`contract.rules[${index}].category is not supported.`);
    }
    const strength = boundedString(
      rule.strength,
      `contract.rules[${index}].strength`,
      24,
    );
    if (!RULE_STRENGTHS.has(strength)) {
      throw new TypeError(`contract.rules[${index}].strength is not supported.`);
    }
    return Object.freeze({
      id,
      category,
      label: boundedString(
        rule.label,
        `contract.rules[${index}].label`,
        180,
      ),
      requirement: boundedString(
        rule.requirement,
        `contract.rules[${index}].requirement`,
        2_000,
      ),
      strength,
      excerpt: boundedString(
        rule.excerpt,
        `contract.rules[${index}].excerpt`,
        1_500,
      ),
    });
  });
  return Object.freeze(rules);
}

export function normalizeConfirmedVenueContract(value) {
  const contract = plainRecord(value, "contract", [
    "version",
    "contractId",
    "provenance",
    "venue",
    "publisher",
    "submissionType",
    "confirmedAt",
    "source",
    "extractor",
    "templateKey",
    "pagePolicy",
    "rules",
    "unresolved",
  ]);
  if (contract.version !== 1) {
    throw new TypeError("contract.version is not supported.");
  }
  const contractId = boundedString(contract.contractId, "contract.contractId", 40);
  if (!CONTRACT_ID_PATTERN.test(contractId)) {
    throw new TypeError("contract.contractId is invalid.");
  }
  if (contract.provenance !== "author_confirmed") {
    throw new TypeError("contract.provenance must be author_confirmed.");
  }
  const confirmedAt = boundedString(
    contract.confirmedAt,
    "contract.confirmedAt",
    40,
  );
  if (!ISO_DATE_PATTERN.test(confirmedAt) || !Number.isFinite(Date.parse(confirmedAt))) {
    throw new TypeError("contract.confirmedAt must be an ISO-8601 UTC timestamp.");
  }
  const extractor = plainRecord(contract.extractor, "contract.extractor", [
    "model",
    "version",
  ]);
  if (extractor.version !== VENUE_GUIDELINE_EXTRACTOR_VERSION) {
    throw new TypeError("contract.extractor.version is not supported.");
  }
  const templateKey = boundedString(
    contract.templateKey,
    "contract.templateKey",
    60,
  );
  if (!TEMPLATE_KEYS.has(templateKey)) {
    throw new TypeError("contract.templateKey is not supported.");
  }
  const pagePolicy =
    contract.pagePolicy === null
      ? null
      : normalizePagePolicy(contract.pagePolicy);
  const rules = normalizeContractRules(contract.rules);
  const hasPageRule = rules.some((rule) => rule.id === "imported-pages-01");
  if (Boolean(pagePolicy) !== hasPageRule) {
    throw new TypeError(
      "contract.rules and contract.pagePolicy must agree about page enforcement.",
    );
  }
  return Object.freeze({
    version: 1,
    contractId,
    provenance: "author_confirmed",
    venue: boundedString(contract.venue, "contract.venue", 240),
    publisher: boundedOptionalString(
      contract.publisher,
      "contract.publisher",
      160,
    ),
    submissionType: boundedString(
      contract.submissionType,
      "contract.submissionType",
      120,
    ),
    confirmedAt,
    source: normalizeSource(contract.source, "contract.source"),
    extractor: Object.freeze({
      model: boundedString(extractor.model, "contract.extractor.model", 200),
      version: VENUE_GUIDELINE_EXTRACTOR_VERSION,
    }),
    templateKey,
    pagePolicy,
    rules,
    unresolved: normalizeUnresolved(contract.unresolved, "contract.unresolved"),
  });
}

function pageRequirementText(pagePolicy) {
  const scope =
    pagePolicy.countScope === "content_excluding_references"
      ? "content pages, excluding references"
      : "total PDF pages, including references";
  if (pagePolicy.mode === "exact_pages") {
    return `Exactly ${pagePolicy.exactPages} ${scope}`;
  }
  if (pagePolicy.mode === "minimum_pages") {
    return `At least ${pagePolicy.minPages} ${scope}`;
  }
  if (pagePolicy.mode === "maximum_pages") {
    return `No more than ${pagePolicy.maxPages} ${scope}`;
  }
  return `${pagePolicy.minPages}–${pagePolicy.maxPages} ${scope}`;
}

export function createConfirmedVenueContract({
  proposal,
  templateKey,
  pagePolicy,
  confirmedAt = new Date().toISOString(),
}) {
  const normalizedProposal = normalizeVenueGuidelineProposal(
    {
      pageLimit: proposal?.pageLimit,
      template: proposal?.template,
      rules: proposal?.rules?.map?.((rule) => ({
        category: rule.category,
        label: rule.label,
        requirement: rule.requirement,
        strength: rule.strength,
        excerpt: rule.excerpt,
      })),
      unresolved: proposal?.unresolved,
    },
    {
      venue: proposal?.venue,
      publisher: proposal?.publisher,
      submissionType: proposal?.submissionType,
      source: proposal?.source,
      model: proposal?.extractor?.model,
    },
  );
  const selectedTemplateKey = boundedString(
    templateKey,
    "templateKey",
    60,
  );
  if (!TEMPLATE_KEYS.has(selectedTemplateKey)) {
    throw new TypeError("templateKey is not supported.");
  }
  const normalizedPagePolicy =
    pagePolicy === null || pagePolicy === undefined
      ? null
      : normalizePagePolicy(pagePolicy);
  const rules = normalizedProposal.rules.map((rule) => ({ ...rule }));
  if (normalizedPagePolicy) {
    rules.unshift({
      id: "imported-pages-01",
      category: "page_limit",
      label: "Page limit",
      requirement: pageRequirementText(normalizedPagePolicy),
      strength: "required",
      excerpt:
        normalizedProposal.pageLimit?.excerpt ||
        normalizedPagePolicy.sourceBasis,
    });
  }
  const provisionalContract = normalizeConfirmedVenueContract({
    version: 1,
    contractId: "vc-0000000000000000",
    provenance: "author_confirmed",
    venue: normalizedProposal.venue,
    publisher: normalizedProposal.publisher,
    submissionType: normalizedProposal.submissionType,
    confirmedAt,
    source: normalizedProposal.source,
    extractor: normalizedProposal.extractor,
    templateKey: selectedTemplateKey,
    pagePolicy: normalizedPagePolicy,
    rules,
    unresolved: normalizedProposal.unresolved,
  });
  const {
    contractId: ignoredProvisionalContractId,
    ...contractDefiningFields
  } = provisionalContract;
  void ignoredProvisionalContractId;
  return normalizeConfirmedVenueContract({
    ...contractDefiningFields,
    contractId: `vc-${deterministicContractLabel(contractDefiningFields)}`,
  });
}

export function publicationRulesFromVenueContract(contract) {
  const normalized = normalizeConfirmedVenueContract(contract);
  return normalized.rules.map((rule) => ({
    id: rule.id,
    label: rule.label,
    value: rule.requirement,
    level: rule.strength === "required" ? "required" : "recommended",
    detail: `${rule.requirement} Supporting excerpt from the retrieved official source: “${rule.excerpt}”`,
  }));
}

export function venueTemplateKeyIsSupported(value) {
  return typeof value === "string" && TEMPLATE_KEYS.has(value);
}
