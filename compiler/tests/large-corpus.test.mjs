import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLargeCorpusEvidencePacket,
  LARGE_CORPUS_LIMITS,
  LARGE_CORPUS_ROLES,
  LARGE_CORPUS_SELECTION_POLICY,
  LARGE_CORPUS_WEIGHTING_POLICIES,
} from "../../lib/large-corpus.mjs";

function input(overrides = {}) {
  return {
    sourceDocuments: [],
    title: "",
    targetVenue: "",
    manuscript: "",
    ...overrides,
  };
}

function roleEntry(result, role) {
  return result.coverage.roleCoverage.find((entry) => entry.role === role);
}

test("builds an exact bounded v2 evidence packet with section provenance", () => {
  const text =
    `${"alpha ".repeat(100)}\nMethods\n` +
    `${"coastal segmentation evidence ".repeat(40)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "methods.txt", text }],
      title: "Coastal segmentation",
      targetVenue: "IGARSS",
      manuscript: "Domain adaptation experiment",
      maxPacketChars: 5_000,
      chunkChars: 512,
      overlapChars: 128,
    }),
  );

  assert.ok(result.packetText.length > 0);
  assert.ok(result.packetText.length <= 5_000);
  assert.equal(result.coverage.packetCharacters, result.packetText.length);
  assert.equal(result.coverage.strategy, "lexical-section-balanced-v2");
  assert.equal(result.coverage.weightingPolicy, "empirical-research-v1");
  assert.equal(
    result.coverage.selectionPolicy,
    LARGE_CORPUS_SELECTION_POLICY,
  );
  assert.equal(result.coverage.roleWeights, LARGE_CORPUS_WEIGHTING_POLICIES["empirical-research-v1"]);
  assert.ok(result.coverage.mapCharacters > 0);
  assert.match(result.packetText, /^<<<CORPUS MAP /u);
  assert.ok(result.chunks.length > 1);
  for (const chunk of result.chunks) {
    assert.equal(chunk.fileName, "methods.txt");
    assert.match(chunk.id, /^source-01-chunk-\d{4}$/u);
    assert.equal(chunk.text, text.slice(chunk.startChar, chunk.endChar));
    assert.ok(chunk.endChar > chunk.startChar);
    assert.match(result.packetText, new RegExp(`id=${chunk.id}`));
    assert.equal(typeof chunk.sectionRole, "string");
    assert.equal(typeof chunk.sectionHeading, "string");
    assert.equal(chunk.score, chunk.lexicalScore + chunk.roleWeight);
  }
  assert.equal(roleEntry(result, "methods").headingCount, 1);
});

test("uses fixed overlapping chunks and preserves exact JavaScript offsets", () => {
  const text = "x".repeat(900);
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "overlap.txt", text }],
      maxPacketChars: 10_000,
      chunkChars: 512,
      overlapChars: 128,
    }),
  );

  assert.deepEqual(
    result.chunks.map(({ startChar, endChar }) => [startChar, endChar]),
    [
      [0, 512],
      [384, 896],
      [768, 900],
    ],
  );
  assert.equal(result.chunks[0].endChar - result.chunks[1].startChar, 128);
  assert.equal(result.chunks[1].endChar - result.chunks[2].startChar, 128);
  assert.equal(result.coverage.totalCharacters, 900);
  assert.equal(result.coverage.selectedCharacters, 900);
  assert.equal(result.coverage.sources[0].selectedCharacters, 900);
  assert.equal(result.coverage.totalChunks, 3);
  assert.equal(result.coverage.selectedChunks, 3);
  assert.equal(result.coverage.omittedChunks, 0);
});

test("propagates detected section roles and exact headings to following chunks", () => {
  const text =
    `# Introduction\r\n${"intro evidence ".repeat(70)}\r\n` +
    `\\section{Methods}\r\n${"method detail ".repeat(110)}\r\n` +
    `III. Results\r\n${"result evidence ".repeat(90)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "sections.tex", text }],
      maxPacketChars: 20_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );

  assert.deepEqual(
    result.coverage.roleCoverage
      .filter(({ headingCount }) => headingCount > 0)
      .map(({ role }) => role),
    ["introduction", "methods", "results"],
  );
  for (const role of ["introduction", "methods", "results"]) {
    const chunks = result.chunks.filter((chunk) => chunk.sectionRole === role);
    assert.ok(chunks.length >= 2, role);
    assert.ok(chunks.every((chunk) => chunk.sectionRoles.includes(role)), role);
  }
  assert.equal(
    result.chunks.find((chunk) => chunk.sectionRole === "methods").sectionHeading,
    "Methods",
  );
  assert.equal(
    result.chunks.find((chunk) => chunk.sectionRole === "results").sectionHeading,
    "Results",
  );
  for (const chunk of result.chunks) {
    assert.equal(chunk.text, text.slice(chunk.startChar, chunk.endChar));
  }
});

test("does not impose conventional section order and renders selected chunks in source order", () => {
  const text =
    `Results\n${"result first ".repeat(60)}\n` +
    `Methods\n${"method second ".repeat(60)}\n` +
    `Introduction\n${"intro last ".repeat(60)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "unusual-order.md", text }],
      maxPacketChars: 10_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );

  assert.deepEqual(
    result.chunks.map(({ chunkIndex }) => chunkIndex),
    result.chunks.map(({ chunkIndex }) => chunkIndex).slice().sort((a, b) => a - b),
  );
  const firstByRole = Object.fromEntries(
    ["results", "methods", "introduction"].map((role) => [
      role,
      result.chunks.findIndex((chunk) => chunk.sectionRole === role),
    ]),
  );
  assert.ok(firstByRole.results >= 0);
  assert.ok(firstByRole.methods > firstByRole.results);
  assert.ok(firstByRole.introduction > firstByRole.methods);
  const renderedIds = result.chunks.map((chunk) =>
    result.packetText.indexOf(`id=${chunk.id}`),
  );
  assert.deepEqual(renderedIds, renderedIds.slice().sort((a, b) => a - b));
});

test("uses explicit heading hierarchy without letting an introduction label consume later nonstandard sections", () => {
  const text =
    `1 Introduction\n${"intro framing ".repeat(45)}\n` +
    `1.1 Motivation\n${"intro motivation ".repeat(45)}\n` +
    `2 Specialized Construction\n${"construction detail ".repeat(45)}\n` +
    `2.1 Proof Outline\n${"proof detail ".repeat(45)}\n` +
    `3 Results\n${"result evidence ".repeat(45)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "nonstandard.md", text }],
      maxPacketChars: 12_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );
  const map = result.packetText.slice(0, result.coverage.mapCharacters);

  assert.match(map, /heading="Specialized Construction"/u);
  assert.match(map, /heading="Proof Outline"/u);
  assert.match(
    map,
    /role=unclassified basis=unclassified heading="Specialized Construction"/u,
  );
  assert.match(
    map,
    /role=unclassified basis=inherited heading="Proof Outline"/u,
  );
  assert.ok(
    result.chunks.some(
      (chunk) =>
        chunk.sectionHeading === "Motivation" &&
        chunk.sectionRole === "introduction",
    ),
  );
  assert.ok(
    result.chunks.some(
      (chunk) =>
        chunk.sectionHeading === "Specialized Construction" &&
        chunk.sectionRole === "unclassified",
    ),
  );
  assert.ok(
    result.chunks.some(
      (chunk) =>
        chunk.sectionHeading === "Proof Outline" &&
        chunk.sectionRole === "unclassified",
    ),
  );
  assert.ok(
    result.chunks.some(
      (chunk) =>
        chunk.sectionHeading === "Results" &&
        chunk.sectionRole === "results",
    ),
  );
});

test("does not treat numbered equations, prose, or dotted contents entries as section transitions", () => {
  const text =
    `1 Methods\n${"method framing ".repeat(30)}\n` +
    `2 V n exp\n${"equation context ".repeat(30)}\n` +
    `3.16. Writing the martingale in the form\n${"proof prose ".repeat(30)}\n` +
    `4 depending on whether the displacement\n${"more prose ".repeat(30)}\n` +
    `5.1 Contents entry . . . . . . . . . 42\n${"closing prose ".repeat(30)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "false-headings.txt", text }],
      maxPacketChars: 8_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );
  const map = result.packetText.slice(0, result.coverage.mapCharacters);

  assert.equal(roleEntry(result, "methods").headingCount, 1);
  assert.doesNotMatch(map, /heading="V n exp"/u);
  assert.doesNotMatch(map, /heading="Writing the martingale/u);
  assert.doesNotMatch(map, /heading="depending on whether/u);
  assert.doesNotMatch(map, /heading="Contents entry/u);
  assert.ok(
    result.chunks.every((chunk) => chunk.sectionRole === "methods"),
  );
});

test("does not award a role bonus or breadth membership for a two-character boundary overlap", () => {
  const introductionPrefix = `Introduction\n${"i".repeat(496)}\n`;
  assert.equal(introductionPrefix.length, 510);
  const text = `${introductionPrefix}Methods\n${"method evidence ".repeat(60)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "boundary.txt", text }],
      maxPacketChars: 5_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );
  const first = result.chunks.find((chunk) => chunk.chunkIndex === 0);
  const second = result.chunks.find((chunk) => chunk.chunkIndex === 1);

  assert.equal(first.sectionRole, "introduction");
  assert.equal(first.roleWeight, 14);
  assert.deepEqual(first.sectionRoles, ["introduction"]);
  assert.equal(second.sectionRole, "methods");
  assert.equal(second.roleWeight, 36);
  assert.ok(second.sectionRoles.includes("methods"));
  assert.equal(roleEntry(result, "methods").detectedChunks, 2);
});

test("maps the unclassified preface and reports partial section coverage with exact unique characters", () => {
  const text =
    `${"title abstract material ".repeat(80)}\n` +
    `Methods\n${"method evidence ".repeat(400)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "partial-map.txt", text }],
      title: "method evidence",
      maxPacketChars: 1_600,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );
  const map = result.packetText.slice(0, result.coverage.mapCharacters);

  assert.match(
    map,
    /role=unclassified basis=preface heading="" chars=0-/u,
  );
  assert.match(map, /\[PARTIAL \]/u);
  assert.match(map, /selectedChars=\d+\/\d+/u);
  assert.ok(
    result.coverage.selectedCharacters <=
      result.coverage.sources[0].characters,
  );
});

test("prepends a bounded map that preserves transitions and labels omitted roles", () => {
  const text =
    `Results\n${"result evidence ".repeat(55)}\n` +
    `Methods\n${"method evidence ".repeat(55)}\n` +
    `Introduction\n${"intro evidence ".repeat(55)}\n` +
    `References\n${"reference entry ".repeat(55)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "mapped.md", text }],
      maxPacketChars: 1_600,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );
  const map = result.packetText.slice(0, result.coverage.mapCharacters);

  assert.match(map, /^<<<CORPUS MAP /u);
  assert.match(map, /mapped\.md/u);
  assert.ok(map.indexOf("results") < map.indexOf("methods"));
  assert.ok(map.indexOf("methods") < map.indexOf("introduction"));
  assert.ok(map.indexOf("introduction") < map.indexOf("references"));
  assert.match(map, /(?:\[OMITTED \]|O:)/u);
  assert.ok(result.coverage.mapCharacters < result.packetText.length);
  assert.ok(result.packetText.length <= 1_600);
});

test("seeds every detected substantive role before global ranking when budget fits", () => {
  const text = [
    ["Abstract", "abstract content "],
    ["Introduction", "intro content "],
    ["Methods", "method content "],
    ["Results", "result content "],
    ["Discussion", "discussion content "],
    ["Conclusion", "conclusion content "],
  ]
    .map(([heading, body]) => `${heading}\n${body.repeat(45)}`)
    .join("\n");
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "balanced.md", text }],
      title: "result result result",
      maxPacketChars: 8_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );

  assert.deepEqual(
    result.coverage.roleCoverage
      .filter(({ headingCount }) => headingCount > 0)
      .map(({ role }) => role),
    [
      "abstract",
      "introduction",
      "methods",
      "results",
      "discussion",
      "conclusion",
    ],
  );
  for (const role of result.coverage.roleCoverage.filter(
    ({ headingCount }) => headingCount > 0,
  )) {
    assert.equal(role.substantive, true);
    assert.ok(role.selectedChunks >= 1, role.role);
    assert.ok(role.selectedCharacters > 0, role.role);
  }
});

test("seeds every nonempty source before repeat chunks when budget fits", () => {
  const sourceDocuments = [
    { fileName: "high.txt", text: "coastal ".repeat(100) },
    { fileName: "second.txt", text: "neutral ".repeat(100) },
    { fileName: "third.txt", text: "background material ".repeat(45) },
  ];
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments,
      title: "coastal",
      maxPacketChars: 5_000,
      chunkChars: 512,
      overlapChars: 128,
    }),
  );

  assert.ok(
    result.coverage.sources.every((source) => source.selectedChunks >= 1),
  );
  assert.deepEqual(
    new Set(result.chunks.map((chunk) => chunk.fileName)),
    new Set(sourceDocuments.map((source) => source.fileName)),
  );
  assert.deepEqual(
    result.chunks.map(({ sourceIndex, chunkIndex }) => [sourceIndex, chunkIndex]),
    result.chunks
      .map(({ sourceIndex, chunkIndex }) => [sourceIndex, chunkIndex])
      .slice()
      .sort(
        (left, right) =>
          left[0] - right[0] || left[1] - right[1],
      ),
  );
});

test("chooses fixed empirical or review weighting without claiming universality", () => {
  const text =
    `Methods\n${"method detail ".repeat(60)}\n` +
    `Literature Review\n${"synthesis evidence ".repeat(60)}\n` +
    `Discussion\n${"interpretation ".repeat(60)}`;
  const empirical = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "policy.md", text }],
      submissionType: "Full paper · Initial review",
      maxPacketChars: 8_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );
  const review = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "policy.md", text }],
      submissionType: "Systematic Review Article",
      maxPacketChars: 8_000,
      chunkChars: 512,
      overlapChars: 0,
    }),
  );

  assert.equal(empirical.coverage.weightingPolicy, "empirical-research-v1");
  assert.equal(review.coverage.weightingPolicy, "review-synthesis-v1");
  assert.equal(roleEntry(empirical, "methods").weight, 36);
  assert.equal(roleEntry(empirical, "related-work").weight, 14);
  assert.equal(roleEntry(review, "methods").weight, 20);
  assert.equal(roleEntry(review, "related-work").weight, 38);
  assert.equal(
    empirical.coverage.selectionPolicy.scope,
    "transparent-general-paper-heuristic-not-universal",
  );
  assert.ok(Object.isFrozen(LARGE_CORPUS_ROLES));
  assert.ok(Object.isFrozen(LARGE_CORPUS_WEIGHTING_POLICIES));
  assert.ok(Object.isFrozen(empirical.coverage.roleWeights));
  assert.ok(
    empirical.coverage.roleWeights.every((entry) => Object.isFrozen(entry)),
  );
  assert.ok(Object.isFrozen(empirical.coverage.selectionPolicy));
});

test("combines lexical relevance with role weight deterministically", () => {
  const text =
    `${"irrelevant filler ".repeat(32).slice(0, 512)}` +
    `Coastal segmentation for IGARSS uses domain adaptation.` +
    `${" evidence".repeat(70)}`;
  const value = input({
    sourceDocuments: [{ fileName: "ranked.txt", text }],
    title: "Coastal Segmentation",
    targetVenue: "IEEE IGARSS",
    manuscript: "domain adaptation domain adaptation",
    maxPacketChars: 3_000,
    chunkChars: 512,
    overlapChars: 0,
  });
  const first = buildLargeCorpusEvidencePacket(value);
  const second = buildLargeCorpusEvidencePacket(value);
  const mostRelevant = first.chunks
    .slice()
    .sort((left, right) => right.lexicalScore - left.lexicalScore)[0];

  assert.deepEqual(first, second);
  assert.deepEqual(mostRelevant.matchedKeywords, [
    "coastal",
    "segmentation",
    "igarss",
    "adaptation",
    "domain",
  ]);
  assert.ok(mostRelevant.lexicalScore > 0);
  assert.ok(
    first.chunks.every(
      (chunk) =>
        !chunk.matchedKeywords.includes("and") &&
        !chunk.matchedKeywords.includes("the") &&
        !chunk.matchedKeywords.includes("not"),
    ),
  );
});

test("partially includes a seed when a full chunk exceeds the packet budget", () => {
  const text = `Methods\n${"large-corpus evidence ".repeat(300)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "large.txt", text }],
      title: "large corpus evidence",
      maxPacketChars: 1_024,
      chunkChars: 12_000,
      overlapChars: 0,
    }),
  );

  assert.equal(result.chunks.length, 1);
  assert.equal(result.chunks[0].partial, true);
  assert.equal(result.chunks[0].sectionRole, "methods");
  assert.ok(result.chunks[0].text.length >= 96);
  assert.equal(result.chunks[0].text, text.slice(0, result.chunks[0].endChar));
  assert.ok(result.packetText.length <= 1_024);
  assert.equal(result.coverage.packetCharacters, result.packetText.length);
  assert.ok(result.coverage.selectedCharacters < result.coverage.totalCharacters);
});

test("preserves source offsets while canonicalizing packet line endings for multipart transport", () => {
  const text = `Abstract\r\n${"evidence ".repeat(80)}`;
  const result = buildLargeCorpusEvidencePacket(
    input({
      sourceDocuments: [{ fileName: "windows.txt", text }],
      maxPacketChars: 4_000,
      chunkChars: 512,
      overlapChars: 128,
    }),
  );

  for (const chunk of result.chunks) {
    assert.equal(chunk.text, text.slice(chunk.startChar, chunk.endChar));
  }
  assert.ok(result.chunks.some((chunk) => chunk.text.includes("\r\n")));
  assert.doesNotMatch(result.packetText, /\r/u);
  assert.match(result.packetText, /Abstract\n/u);
  assert.equal(result.coverage.packetCharacters, result.packetText.length);
  assert.equal(result.chunks[0].sectionHeading, "Abstract");
});

test("returns explicit v2 zero coverage for empty and blank sources", () => {
  const empty = buildLargeCorpusEvidencePacket(input());
  assert.equal(empty.packetText, "");
  assert.deepEqual(empty.chunks, []);
  assert.equal(empty.coverage.strategy, "lexical-section-balanced-v2");
  assert.equal(empty.coverage.weightingPolicy, "empirical-research-v1");
  assert.equal(empty.coverage.mapCharacters, 0);
  assert.deepEqual(
    empty.coverage.roleCoverage.map(({ role }) => role),
    LARGE_CORPUS_ROLES,
  );
  assert.ok(
    empty.coverage.roleCoverage.every(
      (role) =>
        role.headingCount === 0 &&
        role.detectedSources === 0 &&
        role.selectedSources === 0 &&
        role.detectedChunks === 0 &&
        role.selectedChunks === 0 &&
        role.selectedCharacters === 0,
    ),
  );
  assert.equal(empty.coverage.sourceCount, 0);
  assert.equal(empty.coverage.totalCharacters, 0);
  assert.equal(empty.coverage.totalChunks, 0);
  assert.equal(empty.coverage.selectedChunks, 0);
  assert.equal(empty.coverage.selectedCharacters, 0);
  assert.equal(empty.coverage.omittedChunks, 0);
  assert.equal(empty.coverage.packetCharacters, 0);
  assert.deepEqual(empty.coverage.sources, []);

  const blankSource = buildLargeCorpusEvidencePacket(
    input({ sourceDocuments: [{ fileName: "empty.txt", text: "" }] }),
  );
  assert.deepEqual(blankSource.coverage.sources[0], {
    fileName: "empty.txt",
    characters: 0,
    chunks: 0,
    selectedChunks: 0,
    selectedCharacters: 0,
  });
});

test("applies safe defaults and strict configuration limits", () => {
  const defaults = buildLargeCorpusEvidencePacket(input());
  assert.equal(defaults.coverage.packetCharacters, 0);
  assert.equal(LARGE_CORPUS_LIMITS.defaultPacketChars, 60_000);
  assert.equal(LARGE_CORPUS_LIMITS.maxPacketChars, 220_000);
  assert.equal(LARGE_CORPUS_LIMITS.maxSourceDocumentChars, 4_000_000);
  assert.equal(LARGE_CORPUS_LIMITS.maxTotalSourceChars, 5_000_000);
  assert.equal(LARGE_CORPUS_LIMITS.maxSubmissionTypeChars, 120);
  assert.equal(LARGE_CORPUS_LIMITS.defaultChunkChars, 3_200);
  assert.equal(LARGE_CORPUS_LIMITS.defaultOverlapChars, 320);

  const endpoints = buildLargeCorpusEvidencePacket(
    input({
      maxPacketChars: LARGE_CORPUS_LIMITS.maxPacketChars,
      chunkChars: LARGE_CORPUS_LIMITS.minChunkChars,
      overlapChars: LARGE_CORPUS_LIMITS.minChunkChars / 2,
    }),
  );
  assert.equal(endpoints.coverage.strategy, "lexical-section-balanced-v2");

  for (const maxPacketChars of [1_023, 220_001, 1.5, "60000"]) {
    assert.throws(
      () => buildLargeCorpusEvidencePacket(input({ maxPacketChars })),
      /maxPacketChars must be an integer/u,
    );
  }
  for (const chunkChars of [511, 12_001, 1.5, "3200"]) {
    assert.throws(
      () => buildLargeCorpusEvidencePacket(input({ chunkChars })),
      /chunkChars must be an integer/u,
    );
  }
  for (const overlapChars of [-1, 257, 1.5, "128"]) {
    assert.throws(
      () =>
        buildLargeCorpusEvidencePacket(
          input({ chunkChars: 512, overlapChars }),
        ),
      /overlapChars must be an integer/u,
    );
  }
});

test("strictly validates input, source documents, filenames, and text bounds", () => {
  assert.throws(
    () => buildLargeCorpusEvidencePacket(null),
    /input must be an object/u,
  );
  assert.throws(
    () => buildLargeCorpusEvidencePacket(input({ unexpected: true })),
    /unexpected is not an accepted field/u,
  );
  assert.throws(
    () => buildLargeCorpusEvidencePacket(input({ sourceDocuments: "no" })),
    /sourceDocuments must be an array/u,
  );
  assert.throws(
    () => buildLargeCorpusEvidencePacket(input({ sourceDocuments: [null] })),
    /sourceDocuments\[0\] must be an object/u,
  );
  assert.throws(
    () =>
      buildLargeCorpusEvidencePacket(
        input({
          sourceDocuments: Array.from({ length: 13 }, (_, index) => ({
            fileName: `${index}.txt`,
            text: "x",
          })),
        }),
      ),
    /no more than 12 documents/u,
  );

  const runName = (fileName) =>
    buildLargeCorpusEvidencePacket(
      input({ sourceDocuments: [{ fileName, text: "evidence" }] }),
    );
  assert.throws(() => runName(4), /fileName must be a string/u);
  assert.throws(() => runName("   "), /fileName must not be blank/u);
  assert.throws(() => runName(" file.txt"), /surrounding whitespace/u);
  assert.throws(() => runName("folder/file.txt"), /plain filename/u);
  assert.throws(() => runName("folder\\file.txt"), /plain filename/u);
  assert.throws(() => runName(`bad\nfile.txt`), /plain filename/u);
  assert.throws(
    () =>
      buildLargeCorpusEvidencePacket(
        input({
          sourceDocuments: [
            { fileName: "Evidence.TXT", text: "one" },
            { fileName: "evidence.txt", text: "two" },
          ],
        }),
      ),
    /Duplicate source document filename/u,
  );
  assert.throws(
    () =>
      buildLargeCorpusEvidencePacket(
        input({
          sourceDocuments: [
            { fileName: "large.txt", text: "x".repeat(4_000_001) },
          ],
        }),
      ),
    /4,000,000 characters or less/u,
  );
  assert.throws(
    () =>
      buildLargeCorpusEvidencePacket(
        input({
          sourceDocuments: [
            { fileName: "one.txt", text: "a".repeat(4_000_000) },
            { fileName: "two.txt", text: "b".repeat(1_000_000) },
            { fileName: "three.txt", text: "c" },
          ],
        }),
      ),
    /total no more than 5,000,000 characters/u,
  );
});

test("strictly bounds every query field including optional submission type", () => {
  for (const [field, maximum] of [
    ["title", 300],
    ["targetVenue", 240],
    ["manuscript", 160_000],
    ["submissionType", 120],
  ]) {
    assert.throws(
      () => buildLargeCorpusEvidencePacket(input({ [field]: 42 })),
      new RegExp(`${field} must be a string`, "u"),
    );
    assert.throws(
      () =>
        buildLargeCorpusEvidencePacket(
          input({ [field]: "x".repeat(maximum + 1) }),
        ),
      new RegExp(
        `${maximum.toLocaleString("en-US")} characters or less`,
        "u",
      ),
    );
  }
});
