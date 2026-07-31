import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  getPublicationLatexContract,
  getSubmissionLatexContract,
  publicationLatexContractIssues,
} from "../publication-template.mjs";
import {
  SUBMISSION_TYPES,
  isSubmissionTypeAllowed,
  submissionTypesForProfile,
} from "../../lib/submission-types.mjs";

const FULL = "Full paper · Initial review";
const SHORT = "Short paper · Initial review";
const FINAL = "Camera-ready / final paper";

const PROFILE_IDS = Object.freeze([
  "ieee-igarss-2026",
  "acm-sigconf",
  "springer-lncs",
  "elsevier-research-article",
  "custom-publication",
]);

function sorted(values) {
  return [...values].sort();
}

function acmLatex(options = "") {
  const classOptions = options ? `[${options}]` : "";
  return String.raw`\documentclass${classOptions}{acmart}
\title{Synthetic ACM paper}
\begin{document}
\maketitle
\begin{abstract}Synthetic abstract.\end{abstract}
\section{Introduction}Synthetic body.
\end{document}`;
}

function acmIssues(options, contract) {
  return publicationLatexContractIssues(
    acmLatex(options),
    contract,
    "ACM submission",
  );
}

test("resolves a submission contract for every allowed registry pair", () => {
  for (const profileId of PROFILE_IDS) {
    const submissionTypes = submissionTypesForProfile(profileId);
    assert.ok(submissionTypes.length > 0, profileId);

    for (const submissionType of submissionTypes) {
      assert.ok(
        getSubmissionLatexContract(profileId, submissionType),
        `${profileId}: ${submissionType}`,
      );
    }
  }
});

test("fails closed for incompatible, unknown, and malformed pairs", () => {
  for (const profileId of PROFILE_IDS) {
    for (const submissionType of SUBMISSION_TYPES) {
      if (isSubmissionTypeAllowed(profileId, submissionType)) continue;
      assert.equal(
        getSubmissionLatexContract(profileId, submissionType),
        undefined,
        `${profileId}: ${submissionType}`,
      );
    }
  }

  for (const [profileId, submissionType] of [
    ["unknown", FULL],
    ["toString", FULL],
    ["__proto__", FULL],
    ["", FULL],
    ["acm-sigconf", "Unknown workflow"],
    ["acm-sigconf", ` ${FULL}`],
    ["acm-sigconf", FULL.toLowerCase()],
    [null, FULL],
    ["acm-sigconf", null],
    [undefined, FINAL],
    ["acm-sigconf", undefined],
  ]) {
    assert.equal(
      getSubmissionLatexContract(profileId, submissionType),
      undefined,
      `${String(profileId)}: ${String(submissionType)}`,
    );
  }
});

test("keeps ACM initial contracts class-only while retaining base safety bans", () => {
  for (const submissionType of [FULL, SHORT]) {
    const contract = getSubmissionLatexContract("acm-sigconf", submissionType);
    assert.equal(contract.documentClass, "acmart", submissionType);
    assert.deepEqual(contract.requiredOptions, [], submissionType);
    assert.deepEqual(
      sorted(contract.forbiddenOptions),
      ["authordraft", "nonacm"],
      submissionType,
    );
  }

  const baseContract = getPublicationLatexContract("acm-sigconf");
  assert.deepEqual(sorted(baseContract.forbiddenOptions), ["authordraft", "nonacm"]);
});

test("allows ACM initial-review options to follow the exact venue", () => {
  for (const submissionType of [FULL, SHORT]) {
    const contract = getSubmissionLatexContract("acm-sigconf", submissionType);
    assert.deepEqual(
      acmIssues("sigconf,review,anonymous", contract),
      [],
      submissionType,
    );
    assert.deepEqual(acmIssues("", contract), [], submissionType);
  }
});

test("requires sigconf and bans non-production options for ACM final papers", () => {
  const contract = getSubmissionLatexContract("acm-sigconf", FINAL);
  assert.equal(contract.documentClass, "acmart");
  assert.deepEqual(contract.requiredOptions, ["sigconf"]);
  assert.deepEqual(sorted(contract.forbiddenOptions), [
    "anonymous",
    "authordraft",
    "manuscript",
    "nonacm",
    "review",
  ]);

  assert.deepEqual(acmIssues("sigconf", contract), []);
  assert.ok(acmIssues("", contract).length > 0);
  assert.ok(acmIssues("review", contract).length > 0);
  assert.ok(acmIssues("sigconf=false", contract).length > 0);
});

test("rejects each enabled forbidden ACM final option", () => {
  const contract = getSubmissionLatexContract("acm-sigconf", FINAL);

  for (const option of contract.forbiddenOptions) {
    for (const enabledForm of [option, `${option}=true`]) {
      const issues = acmIssues(`sigconf,${enabledForm}`, contract);
      assert.ok(issues.length > 0, enabledForm);
      assert.match(issues.join("\n"), new RegExp(option, "i"), enabledForm);
    }
  }
});

test("treats explicit false ACM options as disabled", () => {
  const finalContract = getSubmissionLatexContract("acm-sigconf", FINAL);
  const disabledOptions = finalContract.forbiddenOptions
    .map((option) => `${option}=false`)
    .join(",");

  assert.deepEqual(acmIssues(`sigconf,${disabledOptions}`, finalContract), []);

  const baseContract = getPublicationLatexContract("acm-sigconf");
  assert.deepEqual(
    acmIssues("authordraft=false,nonacm=false", baseContract),
    [],
  );
});

test("requires a country in every declared ACM affiliation", () => {
  const contract = getSubmissionLatexContract("acm-sigconf", FINAL);
  const missingCountry = acmLatex("sigconf").replace(
    "\\title{Synthetic ACM paper}",
    String.raw`\title{Synthetic ACM paper}
\author{Synthetic Author}
\affiliation{\institution{Synthetic Institution}}`,
  );
  const complete = missingCountry.replace(
    "\\institution{Synthetic Institution}",
    String.raw`\institution{Synthetic Institution}\country{United States}`,
  );

  assert.match(
    publicationLatexContractIssues(missingCountry, contract).join("\n"),
    /every \\affiliation declaration.*\\country/s,
  );
  assert.deepEqual(publicationLatexContractIssues(complete, contract), []);
});

test("freezes submission contracts and both option registries", () => {
  const contract = getSubmissionLatexContract("acm-sigconf", FINAL);

  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.requiredOptions), true);
  assert.equal(Object.isFrozen(contract.forbiddenOptions), true);
  assert.throws(() => contract.requiredOptions.push("review"), TypeError);
  assert.throws(() => contract.forbiddenOptions.splice(0, 1), TypeError);
});

test("packages the shared workflow contract dependencies in the compiler image", () => {
  const dockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );

  assert.match(
    dockerfile,
    /^COPY compiler\/publication-template\.mjs \.\/publication-template\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /^COPY lib\/submission-types\.mjs \/opt\/lib\/submission-types\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /^COPY lib\/page-limits\.mjs \/opt\/lib\/page-limits\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /^COPY lib\/venue-contract-artifact\.mjs \/opt\/lib\/venue-contract-artifact\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /^COPY lib\/venue-contract-secret\.mjs \/opt\/lib\/venue-contract-secret\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /^COPY lib\/venue-guidelines\.mjs \/opt\/lib\/venue-guidelines\.mjs$/m,
  );
  assert.match(
    dockerfile,
    /^COPY compiler\/pdf-page-count\.mjs \.\/pdf-page-count\.mjs$/m,
  );
});

test("warms publisher email metadata dependencies in offline fixtures", () => {
  const acmFixture = readFileSync(new URL("../fixtures/20-acmart.tex", import.meta.url), "utf8");
  const lncsFixture = readFileSync(new URL("../fixtures/30-llncs.tex", import.meta.url), "utf8");

  assert.match(acmFixture, /\\email\{/);
  assert.match(acmFixture, /\\country\{/);
  assert.match(lncsFixture, /\\email\{/);
  assert.match(lncsFixture, /\\authorrunning\{/);
});
