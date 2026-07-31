import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeVenueGuidelineExtraction,
  createConfirmedVenueContract,
  normalizeConfirmedVenueContract,
  normalizeVenueGuidelineProposal,
  publicationRulesFromVenueContract,
  VENUE_GUIDELINE_EXTRACTOR_VERSION,
  VENUE_TEMPLATE_OPTIONS,
  venueTemplateKeyIsSupported,
} from "../../lib/venue-guidelines.mjs";

const CONFIRMED_AT = "2026-07-28T15:04:05.123Z";
const SOURCE_HASH = "a".repeat(64);

function source(overrides = {}) {
  return {
    requestedUrl: "https://publisher.example.org/authors/guidelines",
    finalUrl: "https://publisher.example.org/authors/guidelines",
    retrievedAt: "2026-07-28T14:03:02Z",
    title: "Official author guidelines",
    contentType: "text/html",
    sha256: SOURCE_HASH,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    venue: "Example Conference 2027",
    publisher: "Example Scholarly Society",
    submissionType: "Full paper · Initial review",
    source: source(),
    model: "google.gemini-2.5-flash",
    ...overrides,
  };
}

function candidatePageLimit(mode, overrides = {}) {
  const pageFields =
    mode === "minimum_pages"
      ? { minPages: 3 }
      : mode === "maximum_pages"
        ? { maxPages: 8 }
        : mode === "exact_pages"
          ? { exactPages: 4 }
          : { minPages: 6, maxPages: 8 };
  return {
    mode,
    ...pageFields,
    countScope: "content_excluding_references",
    strength: "required",
    excerpt: "Full papers must contain six to eight pages, excluding references.",
    explanation: "The sentence states a mandatory content-page limit.",
    ...overrides,
  };
}

function extraction(mode = "page_range", overrides = {}) {
  return {
    pageLimit: candidatePageLimit(mode),
    template: {
      key: "ieee-conference",
      strength: "required",
      excerpt: "Use the IEEE conference template.",
      explanation: "The official instructions explicitly require IEEE format.",
    },
    rules: [
      {
        category: "layout",
        label: "Column layout",
        requirement: "Use two columns.",
        strength: "required",
        excerpt: "Manuscripts must use the two-column layout.",
      },
      {
        category: "anonymity",
        label: "Author metadata",
        requirement: "Remove author identities for initial review.",
        strength: "recommended",
        excerpt: "Authors should use anonymous initial-review files.",
      },
    ],
    unresolved: [
      "Confirm whether appendices count.",
      " confirm whether appendices count. ",
    ],
    ...overrides,
  };
}

function proposal(mode = "page_range", overrides = {}) {
  return normalizeVenueGuidelineProposal(
    extraction(mode, overrides.extraction),
    context(overrides.context),
  );
}

function pagePolicy(mode, overrides = {}) {
  const pageFields =
    mode === "minimum_pages"
      ? { minPages: 3 }
      : mode === "maximum_pages"
        ? { maxPages: 8 }
        : mode === "exact_pages"
          ? { exactPages: 4 }
          : { minPages: 6, maxPages: 8 };
  return {
    id: `imported-${mode}-${SOURCE_HASH.slice(0, 12)}`,
    mode,
    countScope: "content_excluding_references",
    ...pageFields,
    ruleIds: ["imported-pages-01"],
    sourceBasis: "Full papers must satisfy the confirmed page requirement.",
    ...overrides,
  };
}

function confirmedContract(mode = "page_range", overrides = {}) {
  return createConfirmedVenueContract({
    proposal: proposal(mode, overrides.proposal),
    templateKey: overrides.templateKey ?? "ieee-conference",
    pagePolicy:
      Object.hasOwn(overrides, "pagePolicy")
        ? overrides.pagePolicy
        : pagePolicy(mode),
    confirmedAt: overrides.confirmedAt ?? CONFIRMED_AT,
  });
}

test("canonicalizes only known model vocabulary aliases before strict validation", () => {
  for (const [alias, canonical] of [
    ["excluding_references", "content_excluding_references"],
    ["references_excluded", "content_excluding_references"],
    ["including_references", "total_pdf"],
    ["all_pages", "total_pdf"],
    ["not_specified", "unknown"],
    ["unspecified", "unknown"],
  ]) {
    const original = extraction("maximum_pages", {
      pageLimit: candidatePageLimit("maximum_pages", {
        countScope: alias,
      }),
    });
    const canonicalized = canonicalizeVenueGuidelineExtraction(original);
    assert.equal(canonicalized.pageLimit.countScope, canonical);
    assert.equal(original.pageLimit.countScope, alias);
    assert.doesNotThrow(() =>
      normalizeVenueGuidelineProposal(canonicalized, context()),
    );
  }

  const unsupported = extraction("maximum_pages", {
    pageLimit: candidatePageLimit("maximum_pages", {
      countScope: "main_body_only",
    }),
  });
  assert.equal(
    canonicalizeVenueGuidelineExtraction(unsupported),
    unsupported,
  );
  assert.throws(
    () => normalizeVenueGuidelineProposal(unsupported, context()),
    /countScope is not supported/,
  );
});

test("normalizes valid minimum maximum exact and range proposals", () => {
  for (const [mode, expected] of [
    ["minimum_pages", { minPages: 3, maxPages: null, exactPages: null }],
    ["maximum_pages", { minPages: null, maxPages: 8, exactPages: null }],
    ["exact_pages", { minPages: null, maxPages: null, exactPages: 4 }],
    ["page_range", { minPages: 6, maxPages: 8, exactPages: null }],
  ]) {
    const normalized = proposal(mode);
    assert.equal(normalized.version, 1);
    assert.equal(normalized.pageLimit.mode, mode);
    assert.equal(normalized.pageLimit.countScope, "content_excluding_references");
    assert.equal(normalized.pageLimit.strength, "required");
    assert.deepEqual(
      {
        minPages: normalized.pageLimit.minPages,
        maxPages: normalized.pageLimit.maxPages,
        exactPages: normalized.pageLimit.exactPages,
      },
      expected,
    );
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.pageLimit), true);
  }
});

test("keeps an unknown reference scope non-enforceable until a canonical scope is selected", () => {
  const unknown = proposal("maximum_pages", {
    extraction: {
      pageLimit: candidatePageLimit("maximum_pages", {
        countScope: "unknown",
      }),
    },
  });
  assert.equal(unknown.pageLimit.countScope, "unknown");

  const reviewOnly = createConfirmedVenueContract({
    proposal: unknown,
    templateKey: "generic-article",
    pagePolicy: null,
    confirmedAt: CONFIRMED_AT,
  });
  assert.equal(reviewOnly.pagePolicy, null);
  assert.equal(
    reviewOnly.rules.some((rule) => rule.id === "imported-pages-01"),
    false,
  );

  assert.throws(
    () =>
      createConfirmedVenueContract({
        proposal: unknown,
        templateKey: "generic-article",
        pagePolicy: pagePolicy("maximum_pages", { countScope: "unknown" }),
        confirmedAt: CONFIRMED_AT,
      }),
    /countScope must be one of/,
  );

  const selected = createConfirmedVenueContract({
    proposal: unknown,
    templateKey: "generic-article",
    pagePolicy: pagePolicy("maximum_pages", { countScope: "total_pdf" }),
    confirmedAt: CONFIRMED_AT,
  });
  assert.equal(selected.pagePolicy.countScope, "total_pdf");
  assert.equal(selected.rules[0].id, "imported-pages-01");
});

test("creates confirmed contracts for all four canonical page modes", () => {
  const expectations = {
    minimum_pages: "At least 3 content pages, excluding references",
    maximum_pages: "No more than 8 content pages, excluding references",
    exact_pages: "Exactly 4 content pages, excluding references",
    page_range: "6–8 content pages, excluding references",
  };

  for (const mode of Object.keys(expectations)) {
    const contract = confirmedContract(mode);
    assert.equal(contract.pagePolicy.mode, mode);
    assert.equal(contract.rules[0].id, "imported-pages-01");
    assert.equal(contract.rules[0].category, "page_limit");
    assert.equal(contract.rules[0].strength, "required");
    assert.equal(contract.rules[0].requirement, expectations[mode]);
    assert.equal(
      contract.rules[0].excerpt,
      contract.pagePolicy.mode === mode
        ? proposal(mode).pageLimit.excerpt
        : "",
    );
  }
});

test("binds the confirmed page policy to exactly one imported page rule", () => {
  const contract = confirmedContract("exact_pages");
  assert.deepEqual(contract.pagePolicy.ruleIds, ["imported-pages-01"]);
  assert.equal(
    contract.rules.filter((rule) => rule.id === "imported-pages-01").length,
    1,
  );

  assert.throws(
    () =>
      normalizeConfirmedVenueContract({
        ...contract,
        rules: contract.rules.filter(
          (rule) => rule.id !== "imported-pages-01",
        ),
      }),
    /must agree about page enforcement/,
  );
  assert.throws(
    () =>
      normalizeConfirmedVenueContract({
        ...contract,
        pagePolicy: null,
      }),
    /must agree about page enforcement/,
  );
  assert.throws(
    () =>
      normalizeConfirmedVenueContract({
        ...contract,
        rules: [...contract.rules, contract.rules[0]],
      }),
    /invalid or duplicated/,
  );
});

test("exposes and enforces only the exact template allowlist", () => {
  const expectedKeys = [
    "generic-article",
    "ieee-conference",
    "acm-sigconf-review",
    "acm-sigconf-final",
    "springer-lncs",
    "elsevier-article",
  ];
  assert.deepEqual(
    VENUE_TEMPLATE_OPTIONS.map((option) => option.key),
    expectedKeys,
  );
  assert.equal(Object.isFrozen(VENUE_TEMPLATE_OPTIONS), true);
  for (const option of VENUE_TEMPLATE_OPTIONS) {
    assert.equal(Object.isFrozen(option), true);
    assert.equal(venueTemplateKeyIsSupported(option.key), true);
    assert.doesNotThrow(() =>
      confirmedContract("exact_pages", { templateKey: option.key }),
    );
  }
  for (const value of [
    "",
    "IEEE-conference",
    "ieee-conference ",
    "custom-class",
    "article",
    null,
    1,
  ]) {
    assert.equal(venueTemplateKeyIsSupported(value), false, String(value));
  }
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(
        extraction("exact_pages", {
          template: {
            key: "custom-class",
            strength: "required",
            excerpt: "Use publisher.cls.",
            explanation: "An unsupported custom class was named.",
          },
        }),
        context(),
      ),
    /template\.key is not supported/,
  );
});

test("normalizes and validates source provenance without claiming verification", () => {
  const normalized = normalizeVenueGuidelineProposal(
    extraction("exact_pages"),
    context({
      source: source({
        requestedUrl: "https://publisher.example.org/authors/guidelines?track=main",
        finalUrl: "https://publisher.example.org/current-guidelines",
        contentType: "APPLICATION/PDF",
        sha256: "A".repeat(64),
      }),
    }),
  );

  assert.equal(
    normalized.source.requestedUrl,
    "https://publisher.example.org/authors/guidelines?track=main",
  );
  assert.equal(
    normalized.source.finalUrl,
    "https://publisher.example.org/current-guidelines",
  );
  assert.equal(normalized.source.contentType, "application/pdf");
  assert.equal(normalized.source.sha256, SOURCE_HASH);
  assert.equal(
    normalized.extractor.version,
    VENUE_GUIDELINE_EXTRACTOR_VERSION,
  );
  assert.equal(Object.isFrozen(normalized.source), true);
  assert.equal(Object.isFrozen(normalized.extractor), true);

  const contract = createConfirmedVenueContract({
    proposal: normalized,
    templateKey: "ieee-conference",
    pagePolicy: pagePolicy("exact_pages"),
    confirmedAt: CONFIRMED_AT,
  });
  assert.equal(contract.provenance, "author_confirmed");
  assert.match(contract.contractId, /^vc-[a-f0-9]{16}$/u);
  assert.notEqual(contract.contractId, `vc-${SOURCE_HASH.slice(0, 16)}`);
  assert.equal(contract.source.sha256, SOURCE_HASH);

  for (const invalidSource of [
    source({ requestedUrl: "file:///tmp/guidelines" }),
    source({ finalUrl: "https://user:secret@publisher.example.org/rules" }),
    source({ retrievedAt: "2026-07-28" }),
    source({ retrievedAt: "2026-13-28T14:03:02Z" }),
    source({ contentType: "application/octet-stream" }),
    source({ sha256: "not-a-digest" }),
  ]) {
    assert.throws(
      () =>
        normalizeVenueGuidelineProposal(extraction("exact_pages"), {
          ...context(),
          source: invalidSource,
        }),
      /source\./,
    );
  }
});

test("derives a deterministic contract label from the complete confirmed selection", () => {
  const baseline = confirmedContract("exact_pages");
  assert.equal(
    confirmedContract("exact_pages").contractId,
    baseline.contractId,
  );

  const variants = [
    confirmedContract("exact_pages", {
      templateKey: "generic-article",
    }),
    confirmedContract("exact_pages", {
      pagePolicy: pagePolicy("exact_pages", { exactPages: 5 }),
    }),
    confirmedContract("exact_pages", {
      confirmedAt: "2026-07-28T15:04:06.123Z",
    }),
    confirmedContract("exact_pages", {
      proposal: {
        context: {
          venue: "Example Conference 2027 · Workshop Track",
        },
      },
    }),
    confirmedContract("exact_pages", {
      proposal: {
        context: {
          source: source({ sha256: "b".repeat(64) }),
        },
      },
    }),
    confirmedContract("exact_pages", {
      proposal: {
        extraction: {
          rules: [
            {
              ...extraction("exact_pages").rules[0],
              requirement: "Use two columns and preserve the gutter.",
            },
          ],
        },
      },
    }),
  ];

  for (const variant of variants) {
    assert.match(variant.contractId, /^vc-[a-f0-9]{16}$/u);
    assert.notEqual(variant.contractId, baseline.contractId);
  }
});

test("rejects unknown fields at every proposal boundary", () => {
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(
        { ...extraction(), unexpected: true },
        context(),
      ),
    /extraction\.unexpected is not an accepted field/,
  );
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(extraction(), {
        ...context(),
        unexpected: true,
      }),
    /context\.unexpected is not an accepted field/,
  );
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(
        extraction(),
        context({ source: { ...source(), unexpected: true } }),
      ),
    /source\.unexpected is not an accepted field/,
  );
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(
        extraction("exact_pages", {
          pageLimit: {
            ...candidatePageLimit("exact_pages"),
            unexpected: true,
          },
        }),
        context(),
      ),
    /pageLimit\.unexpected is not an accepted field/,
  );
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(
        extraction("exact_pages", {
          template: {
            ...extraction("exact_pages").template,
            unexpected: true,
          },
        }),
        context(),
      ),
    /template\.unexpected is not an accepted field/,
  );
  assert.throws(
    () =>
      normalizeVenueGuidelineProposal(
        extraction("exact_pages", {
          rules: [
            {
              ...extraction("exact_pages").rules[0],
              unexpected: true,
            },
          ],
        }),
        context(),
      ),
    /rules\[0\]\.unexpected is not an accepted field/,
  );
});

test("rejects invalid mixed and conflicting candidate page bounds", () => {
  for (const [pageLimit, pattern] of [
    [
      candidatePageLimit("minimum_pages", { minPages: undefined }),
      /pageLimit\.minPages must be a whole page count/,
    ],
    [
      candidatePageLimit("maximum_pages", { maxPages: 0 }),
      /pageLimit\.maxPages must be a whole page count/,
    ],
    [
      candidatePageLimit("exact_pages", { exactPages: 4.5 }),
      /pageLimit\.exactPages must be a whole page count/,
    ],
    [
      candidatePageLimit("exact_pages", { minPages: 2 }),
      /pageLimit\.minPages does not belong to this mode/,
    ],
    [
      candidatePageLimit("page_range", { minPages: 9, maxPages: 8 }),
      /pageLimit\.minPages must not exceed maxPages/,
    ],
    [
      candidatePageLimit("maximum_pages", { countScope: "maybe" }),
      /pageLimit\.countScope is not supported/,
    ],
    [
      candidatePageLimit("maximum_pages", { strength: "optional" }),
      /pageLimit\.strength is not supported/,
    ],
  ]) {
    assert.throws(
      () =>
        normalizeVenueGuidelineProposal(
          extraction("exact_pages", { pageLimit }),
          context(),
        ),
      pattern,
    );
  }

  assert.throws(
    () =>
      createConfirmedVenueContract({
        proposal: proposal("page_range"),
        templateKey: "ieee-conference",
        pagePolicy: pagePolicy("page_range", {
          minPages: 8,
          maxPages: 8,
        }),
        confirmedAt: CONFIRMED_AT,
      }),
    /requires minPages to be less than maxPages/,
  );
});

test("strictly normalizes and deeply freezes confirmed venue contracts", () => {
  const created = confirmedContract("page_range");
  const normalized = normalizeConfirmedVenueContract({
    ...created,
    venue: ` ${created.venue} `,
    publisher: ` ${created.publisher} `,
    extractor: { ...created.extractor },
    source: { ...created.source },
    pagePolicy: {
      ...created.pagePolicy,
      ruleIds: [...created.pagePolicy.ruleIds],
    },
    rules: created.rules.map((rule) => ({ ...rule })),
    unresolved: [
      "Confirm whether appendices count.",
      "confirm whether appendices count.",
    ],
  });

  assert.equal(normalized.venue, created.venue);
  assert.equal(normalized.publisher, created.publisher);
  assert.deepEqual(normalized.unresolved, [
    "Confirm whether appendices count.",
  ]);
  for (const value of [
    normalized,
    normalized.source,
    normalized.extractor,
    normalized.pagePolicy,
    normalized.pagePolicy.ruleIds,
    normalized.rules,
    normalized.rules[0],
    normalized.unresolved,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }

  for (const [mutated, pattern] of [
    [{ ...created, unexpected: true }, /contract\.unexpected/],
    [{ ...created, version: 2 }, /contract\.version is not supported/],
    [{ ...created, contractId: "vc-invalid" }, /contract\.contractId is invalid/],
    [{ ...created, provenance: "verified" }, /must be author_confirmed/],
    [{ ...created, confirmedAt: "yesterday" }, /contract\.confirmedAt/],
    [
      {
        ...created,
        extractor: { ...created.extractor, version: "venue-guidelines-v2" },
      },
      /contract\.extractor\.version is not supported/,
    ],
    [{ ...created, templateKey: "custom-class" }, /templateKey is not supported/],
  ]) {
    assert.throws(() => normalizeConfirmedVenueContract(mutated), pattern);
  }
  assert.throws(
    () =>
      normalizeConfirmedVenueContract({
        ...created,
        extractor: { ...created.extractor, unexpected: true },
      }),
    /contract\.extractor\.unexpected is not an accepted field/,
  );
});

test("converts confirmed rules into traceable publication rules", () => {
  const contract = confirmedContract("maximum_pages");
  const rules = publicationRulesFromVenueContract(contract);

  assert.equal(rules.length, contract.rules.length);
  assert.deepEqual(rules[0], {
    id: "imported-pages-01",
    label: "Page limit",
    value: "No more than 8 content pages, excluding references",
    level: "required",
    detail:
      "No more than 8 content pages, excluding references Supporting excerpt from the retrieved official source: “Full papers must contain six to eight pages, excluding references.”",
  });
  const recommended = rules.find(
    (rule) => rule.id === "imported-rule-02",
  );
  assert.equal(recommended.level, "recommended");
  assert.match(
    recommended.detail,
    /Supporting excerpt from the retrieved official source: “Authors should use anonymous initial-review files\.”/,
  );

  assert.throws(
    () =>
      publicationRulesFromVenueContract({
        ...contract,
        provenance: "unconfirmed",
      }),
    /must be author_confirmed/,
  );
});
