import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyUncompiledPagePolicy,
  assessCompiledPageCount,
  getSubmissionPagePolicy,
  normalizePagePolicy,
  pagePolicyTargetText,
} from "../../lib/page-limits.mjs";

const FULL = "Full paper · Initial review";
const SPC = "Student Paper Competition";
const ociServerSource = readFileSync(
  new URL("../../lib/oci-server.ts", import.meta.url),
  "utf8",
);
const compilerServerSource = readFileSync(
  new URL("../server.mjs", import.meta.url),
  "utf8",
);

function policy(mode, overrides = {}) {
  const pageFields =
    mode === "minimum_pages"
      ? { minPages: 3 }
      : mode === "maximum_pages"
        ? { maxPages: 5 }
        : mode === "exact_pages"
          ? { exactPages: 4 }
          : { minPages: 3, maxPages: 5 };
  return {
    id: `test-${mode}`,
    mode,
    countScope: "total_pdf",
    ...pageFields,
    ruleIds: ["pages-01"],
    sourceBasis: "Synthetic page-policy test.",
    ...overrides,
  };
}

test("strictly normalizes every canonical page-policy mode", () => {
  for (const [mode, expected] of [
    ["minimum_pages", { minPages: 3 }],
    ["maximum_pages", { maxPages: 5 }],
    ["exact_pages", { exactPages: 4 }],
    ["page_range", { minPages: 3, maxPages: 5 }],
  ]) {
    const normalized = normalizePagePolicy(
      policy(mode, {
        id: "  policy-id  ",
        ruleIds: [" pages-01 "],
        sourceBasis: "  Source sentence.  ",
      }),
    );
    assert.equal(normalized.mode, mode);
    assert.equal(normalized.id, "policy-id");
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(expected).map((key) => [key, normalized[key]]),
      ),
      expected,
    );
    assert.deepEqual(normalized.ruleIds, ["pages-01"]);
    assert.equal(normalized.sourceBasis, "Source sentence.");
    assert.equal(Object.isFrozen(normalized), true);
    assert.equal(Object.isFrozen(normalized.ruleIds), true);
  }
});

test("rejects non-objects unknown modes scopes fields and missing fields", () => {
  for (const value of [
    null,
    [],
    "policy",
    new Date(),
  ]) {
    assert.throws(() => normalizePagePolicy(value), /plain object/);
  }
  assert.throws(
    () => normalizePagePolicy(policy("unsupported")),
    /mode must be one of/,
  );
  assert.throws(
    () =>
      normalizePagePolicy(
        policy("maximum_pages", { countScope: "all_pages" }),
      ),
    /countScope must be one of/,
  );
  assert.throws(
    () =>
      normalizePagePolicy({
        ...policy("maximum_pages"),
        exactPages: 5,
      }),
    /unsupported field.*exactPages/,
  );
  const missing = policy("exact_pages");
  delete missing.exactPages;
  assert.throws(
    () => normalizePagePolicy(missing),
    /missing required field.*exactPages/,
  );
});

test("rejects mixed invalid and noncanonical page bounds", () => {
  for (const value of [0, -1, 1.5, "4", 10_001, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => normalizePagePolicy(policy("exact_pages", { exactPages: value })),
      /exactPages must be a whole number from 1 through 10,000/,
      String(value),
    );
  }
  assert.throws(
    () =>
      normalizePagePolicy(
        policy("page_range", { minPages: 6, maxPages: 5 }),
      ),
    /minPages to be less than maxPages/,
  );
  assert.throws(
    () =>
      normalizePagePolicy(
        policy("page_range", { minPages: 5, maxPages: 5 }),
      ),
    /use exact_pages/,
  );
});

test("strictly validates policy identity provenance and rule IDs", () => {
  assert.throws(
    () => normalizePagePolicy(policy("maximum_pages", { id: " " })),
    /id must not be blank/,
  );
  assert.throws(
    () =>
      normalizePagePolicy(
        policy("maximum_pages", { sourceBasis: " " }),
      ),
    /sourceBasis must not be blank/,
  );
  assert.throws(
    () => normalizePagePolicy(policy("maximum_pages", { ruleIds: [] })),
    /ruleIds must be a nonempty array/,
  );
  assert.throws(
    () =>
      normalizePagePolicy(
        policy("maximum_pages", { ruleIds: ["same", " same "] }),
      ),
    /must not contain duplicates/,
  );
  assert.throws(
    () =>
      normalizePagePolicy(
        policy("maximum_pages", { ruleIds: ["valid", 2] }),
      ),
    /ruleIds\[1\] must be a string/,
  );
});

test("renders deterministic target text for every mode and count scope", () => {
  assert.equal(
    pagePolicyTargetText(policy("minimum_pages", { minPages: 1 })),
    "at least 1 page of total PDF",
  );
  assert.equal(
    pagePolicyTargetText(
      policy("maximum_pages", {
        maxPages: 4,
        countScope: "content_excluding_references",
      }),
    ),
    "no more than 4 pages of content, excluding references",
  );
  assert.equal(
    pagePolicyTargetText(policy("exact_pages", { exactPages: 3 })),
    "exactly 3 pages of total PDF",
  );
  assert.equal(
    pagePolicyTargetText(
      policy("page_range", {
        minPages: 6,
        maxPages: 8,
        countScope: "content_excluding_references",
      }),
    ),
    "between 6 and 8 pages of content, excluding references, inclusive",
  );
});

test("resolves canonical IGARSS policies only for supported workflows", () => {
  const full = getSubmissionPagePolicy("ieee-igarss-2026", FULL);
  const student = getSubmissionPagePolicy("ieee-igarss-2026", SPC);

  assert.equal(full.mode, "maximum_pages");
  assert.equal(full.maxPages, 4);
  assert.equal(full.countScope, "content_excluding_references");
  assert.equal(student.mode, "exact_pages");
  assert.equal(student.exactPages, 4);
  assert.equal(student.countScope, "content_excluding_references");
  assert.equal(Object.isFrozen(full), true);

  for (const pair of [
    ["acm-sigconf", FULL],
    ["springer-lncs", FULL],
    ["ieee-igarss-2026", "Short paper · Initial review"],
    ["unknown", FULL],
    [null, FULL],
  ]) {
    assert.equal(getSubmissionPagePolicy(...pair), null);
  }
});

test("assesses minimum page boundaries using total PDF pages", () => {
  const minimum = policy("minimum_pages", { minPages: 3 });
  assert.equal(
    assessCompiledPageCount(minimum, { totalPages: 2 }).status,
    "fail",
  );
  assert.equal(
    assessCompiledPageCount(minimum, { totalPages: 3 }).status,
    "pass",
  );
  assert.equal(
    assessCompiledPageCount(minimum, { totalPages: 7 }).status,
    "pass",
  );
});

test("assesses maximum page boundaries using total PDF pages", () => {
  const maximum = policy("maximum_pages", { maxPages: 5 });
  assert.equal(
    assessCompiledPageCount(maximum, { totalPages: 4 }).status,
    "pass",
  );
  assert.equal(
    assessCompiledPageCount(maximum, { totalPages: 5 }).status,
    "pass",
  );
  assert.equal(
    assessCompiledPageCount(maximum, { totalPages: 6 }).status,
    "fail",
  );
});

test("assesses exact page boundaries using total PDF pages", () => {
  const exact = policy("exact_pages", { exactPages: 4 });
  assert.equal(
    assessCompiledPageCount(exact, { totalPages: 3 }).status,
    "fail",
  );
  assert.equal(
    assessCompiledPageCount(exact, { totalPages: 4 }).status,
    "pass",
  );
  assert.equal(
    assessCompiledPageCount(exact, { totalPages: 5 }).status,
    "fail",
  );
});

test("assesses inclusive page-range boundaries using total PDF pages", () => {
  const range = policy("page_range", { minPages: 3, maxPages: 5 });
  for (const [totalPages, expected] of [
    [2, "fail"],
    [3, "pass"],
    [4, "pass"],
    [5, "pass"],
    [6, "fail"],
  ]) {
    assert.equal(
      assessCompiledPageCount(range, { totalPages }).status,
      expected,
      String(totalPages),
    );
  }
});

test("uses content pages only when the policy excludes references", () => {
  const exact = policy("exact_pages", {
    exactPages: 4,
    countScope: "content_excluding_references",
  });
  const pass = assessCompiledPageCount(exact, {
    totalPages: 6,
    contentPages: 4,
  });
  assert.equal(pass.status, "pass");
  assert.match(pass.message, /6 total pages including references/);
  assert.equal(
    assessCompiledPageCount(exact, {
      totalPages: 6,
      contentPages: 5,
    }).status,
    "fail",
  );

  const total = policy("exact_pages", {
    exactPages: 6,
    countScope: "total_pdf",
  });
  assert.equal(
    assessCompiledPageCount(total, {
      totalPages: 6,
      contentPages: 4,
    }).status,
    "pass",
  );
});

test("never passes missing invalid or impossible measurements", () => {
  const contentPolicy = policy("exact_pages", {
    exactPages: 4,
    countScope: "content_excluding_references",
  });
  for (const measurement of [
    null,
    {},
    { totalPages: 4 },
    { contentPages: 4 },
    { totalPages: 0, contentPages: 4 },
    { totalPages: 4, contentPages: 0 },
    { totalPages: 4.5, contentPages: 4 },
    { totalPages: 4, contentPages: "4" },
    { totalPages: 4, contentPages: 5 },
    { totalPages: 10_001, contentPages: 4 },
  ]) {
    assert.equal(
      assessCompiledPageCount(contentPolicy, measurement).status,
      "unavailable",
      JSON.stringify(measurement),
    );
  }

  const totalPolicy = policy("maximum_pages");
  assert.equal(
    assessCompiledPageCount(totalPolicy, { totalPages: 4 }).status,
    "pass",
  );
  assert.equal(
    assessCompiledPageCount(totalPolicy, {
      totalPages: 4,
      contentPages: 5,
    }).status,
    "unavailable",
  );
  assert.equal(
    assessCompiledPageCount({ mode: "invalid" }, { totalPages: 4 }).status,
    "unavailable",
  );
});

test("downgrades only matching model passes until a PDF is compiled", () => {
  const items = [
    {
      ruleId: "pages-01",
      status: "pass",
      evidence: "Model estimate",
      action: "",
    },
    {
      ruleId: "pages-review",
      status: "review",
      evidence: "Already needs review",
      action: "Review it.",
    },
    {
      ruleId: "other-rule",
      status: "pass",
      evidence: "Verified separately",
      action: "",
    },
  ];
  const result = applyUncompiledPagePolicy(
    items,
    "custom-publication",
    "Review article",
    policy("page_range", { minPages: 3, maxPages: 5 }),
  );

  assert.deepEqual(result.ruleIds, ["pages-01"]);
  assert.equal(result.items[0].status, "review");
  assert.match(result.items[0].action, /between 3 and 5 pages/);
  assert.deepEqual(result.items[1], items[1]);
  assert.deepEqual(result.items[2], items[2]);
  assert.deepEqual(items[0], {
    ruleId: "pages-01",
    status: "pass",
    evidence: "Model estimate",
    action: "",
  });
});

test("uses static policy by default and a strict override when supplied", () => {
  const items = [
    {
      ruleId: "igarss-pages-01",
      status: "pass",
      evidence: "Model estimate",
      action: "",
    },
  ];
  const staticResult = applyUncompiledPagePolicy(
    items,
    "ieee-igarss-2026",
    FULL,
  );
  assert.deepEqual(staticResult.ruleIds, ["igarss-pages-01"]);
  assert.match(staticResult.items[0].action, /no more than 4 pages/);

  const override = policy("minimum_pages", {
    minPages: 2,
    ruleIds: ["minimum-01"],
  });
  const overrideResult = applyUncompiledPagePolicy(
    [
      ...items,
      {
        ruleId: "minimum-01",
        status: "pass",
        evidence: "Model estimate",
        action: "",
      },
    ],
    "ieee-igarss-2026",
    FULL,
    override,
  );
  assert.deepEqual(overrideResult.ruleIds, ["minimum-01"]);
  assert.equal(overrideResult.items[0].status, "pass");
  assert.equal(overrideResult.items[1].status, "review");

  assert.throws(
    () =>
      applyUncompiledPagePolicy(items, "unknown", "unknown", {
        ...override,
        maxPages: 8,
      }),
    /unsupported field.*maxPages/,
  );
});

test("wires the trusted page policy into generation and real compiler measurement", () => {
  assert.match(
    ociServerSource,
    /PAGE_CONTRACT_JSON is trusted application configuration/,
  );
  assert.match(ociServerSource, /applyUncompiledPagePolicy\(/);
  assert.match(
    compilerServerSource,
    /getSubmissionPagePolicy\(payload\.profileId, payload\.submissionType\)/,
  );
  assert.match(compilerServerSource, /buildContentPageAuditLatex\(latex\)/);
  assert.match(compilerServerSource, /X-Scholar-Flow-Content-Pages/);
});
