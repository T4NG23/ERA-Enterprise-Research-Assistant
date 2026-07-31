import {
  LARGE_CORPUS_ROLES,
  LARGE_CORPUS_SELECTION_POLICY,
  LARGE_CORPUS_WEIGHTING_POLICIES,
  roleWeightsForSubmissionType,
  weightingPolicyForSubmissionType,
} from "./large-corpus-policy.mjs";

const LIMITS = Object.freeze({
  maxSourceDocuments: 12,
  maxFileNameChars: 120,
  maxSourceDocumentChars: 4_000_000,
  maxTotalSourceChars: 5_000_000,
  maxTitleChars: 300,
  maxTargetVenueChars: 240,
  maxManuscriptChars: 160_000,
  maxSubmissionTypeChars: 120,
  minPacketChars: 1_024,
  maxPacketChars: 220_000,
  defaultPacketChars: 60_000,
  minChunkChars: 512,
  maxChunkChars: 12_000,
  defaultChunkChars: 3_200,
  defaultOverlapChars: 320,
  maxQueryKeywords: 96,
});

const INPUT_KEYS = new Set([
  "sourceDocuments",
  "title",
  "targetVenue",
  "manuscript",
  "submissionType",
  "maxPacketChars",
  "chunkChars",
  "overlapChars",
]);
const SOURCE_KEYS = new Set(["fileName", "text"]);
const MIN_PARTIAL_CHARS = 96;
const TOKEN_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}_-]{1,47}/gu;

const STOP_WORDS = new Set([
  "all",
  "and",
  "any",
  "are",
  "around",
  "as",
  "at",
  "about",
  "after",
  "again",
  "against",
  "also",
  "among",
  "another",
  "based",
  "be",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "during",
  "each",
  "either",
  "else",
  "few",
  "for",
  "from",
  "had",
  "has",
  "have",
  "here",
  "how",
  "if",
  "in",
  "is",
  "it",
  "its",
  "into",
  "just",
  "may",
  "might",
  "more",
  "most",
  "must",
  "neither",
  "no",
  "nor",
  "not",
  "of",
  "off",
  "on",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "over",
  "paper",
  "per",
  "same",
  "shall",
  "should",
  "show",
  "shows",
  "so",
  "some",
  "such",
  "study",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "toward",
  "through",
  "under",
  "up",
  "upon",
  "us",
  "use",
  "used",
  "using",
  "very",
  "via",
  "was",
  "we",
  "well",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "you",
  "your",
]);

const SECTION_ROLES = Object.freeze([
  { role: "abstract", aliases: ["abstract"] },
  { role: "introduction", aliases: ["introduction", "overview"] },
  {
    role: "background",
    aliases: ["background", "preliminaries", "theoretical background"],
  },
  {
    role: "related-work",
    aliases: [
      "related work",
      "literature review",
      "literature survey",
      "prior work",
    ],
  },
  {
    role: "methods",
    aliases: [
      "methods",
      "method",
      "methodology",
      "materials and methods",
      "proposed method",
      "proposed approach",
      "research design",
    ],
  },
  {
    role: "data",
    aliases: ["data", "dataset", "datasets", "study data", "data sources"],
  },
  {
    role: "experiments",
    aliases: [
      "experiments",
      "experimental setup",
      "experiment setup",
      "experimental design",
    ],
  },
  {
    role: "results",
    aliases: [
      "results",
      "empirical results",
      "evaluation results",
      "main results",
      "key results",
    ],
  },
  { role: "findings", aliases: ["findings", "key findings"] },
  {
    role: "synthesis",
    aliases: [
      "synthesis",
      "evidence synthesis",
      "thematic synthesis",
      "qualitative synthesis",
      "quantitative synthesis",
    ],
  },
  {
    role: "discussion",
    aliases: ["discussion", "general discussion", "results and discussion"],
  },
  {
    role: "limitations",
    aliases: ["limitations", "threats to validity", "study limitations"],
  },
  {
    role: "conclusion",
    aliases: ["conclusion", "conclusions", "concluding remarks"],
  },
  {
    role: "acknowledgments",
    aliases: [
      "acknowledgment",
      "acknowledgments",
      "acknowledgement",
      "acknowledgements",
    ],
  },
  { role: "references", aliases: ["references", "bibliography"] },
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, path) {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`${path}.${unexpected} is not an accepted field.`);
  }
}

function boundedString(value, path, maximum, allowBlank = true) {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  if (value.length > maximum) {
    throw new Error(`${path} must be ${maximum.toLocaleString("en-US")} characters or less.`);
  }
  if (!allowBlank && !value.trim()) {
    throw new Error(`${path} must not be blank.`);
  }
  return value;
}

function integerOption(value, name, fallback, minimum, maximum) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${minimum.toLocaleString("en-US")} through ${maximum.toLocaleString("en-US")}.`);
  }
  return resolved;
}

function validateSources(value) {
  if (!Array.isArray(value)) {
    throw new Error("sourceDocuments must be an array.");
  }
  if (value.length > LIMITS.maxSourceDocuments) {
    throw new Error(`sourceDocuments may contain no more than ${LIMITS.maxSourceDocuments} documents.`);
  }

  const seenNames = new Set();
  const sources = [];
  let totalCharacters = 0;
  for (const [index, source] of value.entries()) {
    const path = `sourceDocuments[${index}]`;
    if (!isRecord(source)) {
      throw new Error(`${path} must be an object.`);
    }
    assertOnlyKeys(source, SOURCE_KEYS, path);
    const fileName = boundedString(
      source.fileName,
      `${path}.fileName`,
      LIMITS.maxFileNameChars,
      false,
    );
    if (fileName !== fileName.trim()) {
      throw new Error(`${path}.fileName must not have surrounding whitespace.`);
    }
    if (/[\u0000-\u001f\u007f/\\]/u.test(fileName)) {
      throw new Error(`${path}.fileName must be a plain filename without control characters or path separators.`);
    }
    const foldedName = fileName.toLowerCase();
    if (seenNames.has(foldedName)) {
      throw new Error(`Duplicate source document filename: ${fileName}.`);
    }
    seenNames.add(foldedName);

    const text = boundedString(
      source.text,
      `${path}.text`,
      LIMITS.maxSourceDocumentChars,
    );
    totalCharacters += text.length;
    if (totalCharacters > LIMITS.maxTotalSourceChars) {
      throw new Error(`Source document text may total no more than ${LIMITS.maxTotalSourceChars.toLocaleString("en-US")} characters.`);
    }
    sources.push({ fileName, text });
  }
  return sources;
}

function tokenize(value) {
  const normalized = value.normalize("NFKC").toLowerCase();
  const matches = normalized.match(TOKEN_PATTERN) ?? [];
  return matches.filter((token) => !STOP_WORDS.has(token));
}

function queryKeywords(title, targetVenue, manuscript) {
  const weights = new Map();
  const addUnique = (value, weight) => {
    for (const token of new Set(tokenize(value))) {
      weights.set(token, (weights.get(token) ?? 0) + weight);
    }
  };
  addUnique(title, 12);
  addUnique(targetVenue, 7);

  const manuscriptCounts = new Map();
  for (const token of tokenize(manuscript)) {
    manuscriptCounts.set(token, (manuscriptCounts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of manuscriptCounts) {
    weights.set(token, (weights.get(token) ?? 0) + Math.min(count, 5));
  }

  return [...weights]
    .map(([token, weight]) => ({ token, weight }))
    .sort((left, right) => right.weight - left.weight || left.token.localeCompare(right.token, "en-US"))
    .slice(0, LIMITS.maxQueryKeywords);
}

function plausibleExplicitHeading(
  raw,
  heading,
  { trustedSyntax = false, numericDelimiter = "" } = {},
) {
  if (
    !heading ||
    heading.length > 160 ||
    /(?:\.\s*){3,}/u.test(raw) ||
    /[=<>{}\[\]]/u.test(heading) ||
    /[,;:=()[\]]\s*$/u.test(heading)
  ) {
    return false;
  }
  if (
    !trustedSyntax &&
    (numericDelimiter === "." ||
      !/^\p{Lu}/u.test(heading) ||
      /^\p{Lu}\s/u.test(heading) ||
      /\s+\d{1,3}$/u.test(heading))
  ) {
    return false;
  }

  const visible = heading.replaceAll(/\s/gu, "");
  const letterCount = (heading.match(/\p{L}/gu) ?? []).length;
  const words = heading.match(/\p{L}[\p{L}\p{M}'’/-]*/gu) ?? [];
  if (!visible.length || letterCount < 4 || letterCount / visible.length < 0.55) {
    return false;
  }
  return !(
    words.length <= 4 &&
    words.every((word) => [...word].length <= 3)
  );
}

function normalizedHeading(line) {
  const raw = line.trim();
  if (!raw || raw.length > 180) return null;

  const latex = raw.match(
    /^\\(section|subsection|subsubsection)\*?\{\s*([^}]*)\s*\}\s*$/iu,
  );
  const markdown = raw.match(/^(#{1,6})\s+(.+)$/u);
  const arabic = raw.match(
    /^(\d{1,2}(?:\.\d{1,3})*)([.)]?)\s+(.+)$/u,
  );
  const roman = raw.match(/^([ivxlcdm]+)[.)]\s+(.+)$/iu);
  const headingSource =
    latex?.[2] ?? markdown?.[2] ?? arabic?.[3] ?? roman?.[2] ?? raw;
  const heading = headingSource.replace(/[.:\s]+$/u, "").trim();
  if (!heading) return null;

  const level = latex
    ? { section: 1, subsection: 2, subsubsection: 3 }[
        latex[1].toLocaleLowerCase("en-US")
      ]
    : markdown
      ? markdown[1].length
      : arabic
        ? arabic[1].split(".").length
        : 1;
  const explicit = Boolean(latex || markdown || arabic || roman);

  return {
    heading,
    normalized: heading.normalize("NFKC").toLowerCase(),
    explicit,
    level,
    plausible:
      !explicit ||
      plausibleExplicitHeading(raw, heading, {
        trustedSyntax: Boolean(latex || markdown),
        numericDelimiter: arabic?.[2] ?? "",
      }),
  };
}

function sectionRoleForHeading(normalized) {
  for (const definition of SECTION_ROLES) {
    if (definition.aliases.some((alias) => normalized === alias)) {
      return definition.role;
    }
  }
  for (const definition of SECTION_ROLES) {
    if (
      definition.aliases.some(
        (alias) =>
          normalized.startsWith(`${alias}:`) ||
          normalized.startsWith(`${alias} -`) ||
          normalized.startsWith(`${alias} –`) ||
          normalized.startsWith(`${alias} —`),
      )
    ) {
      return definition.role;
    }
  }
  return null;
}

function detectedSections(text) {
  const headings = [];
  const roleStack = new Map();
  let lineStart = 0;

  while (lineStart < text.length) {
    let lineEnd = lineStart;
    while (
      lineEnd < text.length &&
      text[lineEnd] !== "\r" &&
      text[lineEnd] !== "\n"
    ) {
      lineEnd += 1;
    }

    const parsed = normalizedHeading(text.slice(lineStart, lineEnd));
    const directRole = parsed
      ? sectionRoleForHeading(parsed.normalized)
      : null;
    if (parsed && (directRole || (parsed.explicit && parsed.plausible))) {
      for (const level of [...roleStack.keys()]) {
        if (level >= parsed.level) roleStack.delete(level);
      }
      const inheritedRole = [...roleStack.entries()]
        .filter(([level]) => level < parsed.level)
        .sort(([left], [right]) => right - left)[0]?.[1];
      const role = directRole ?? inheritedRole ?? "unclassified";
      headings.push({
        role,
        roleBasis: directRole
          ? "direct"
          : inheritedRole
            ? "inherited"
            : "unclassified",
        heading: parsed.heading,
        detectedHeading: true,
        startChar: lineStart,
      });
      roleStack.set(parsed.level, role);
    }

    if (lineEnd >= text.length) break;
    lineStart =
      text[lineEnd] === "\r" && text[lineEnd + 1] === "\n"
        ? lineEnd + 2
        : lineEnd + 1;
  }

  if (!headings.length && text.length) {
    headings.push({
      role: "unclassified",
      roleBasis: "unclassified",
      heading: "",
      detectedHeading: false,
      startChar: 0,
    });
  } else if (headings.length && headings[0].startChar > 0) {
    headings.unshift({
      role: "unclassified",
      roleBasis: "preface",
      heading: "",
      detectedHeading: false,
      startChar: 0,
    });
  }

  return headings.map((heading, index) => ({
    ...heading,
    endChar: headings[index + 1]?.startChar ?? text.length,
  }));
}

function lexicalScore(text, keywords) {
  const keywordByToken = new Map(keywords.map((keyword) => [keyword.token, keyword]));
  const counts = new Map();
  for (const token of tokenize(text)) {
    if (keywordByToken.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const matchedKeywords = keywords
    .filter(({ token }) => counts.has(token))
    .map(({ token }) => token);
  let score = 0;
  for (const { token, weight } of keywords) {
    const count = counts.get(token) ?? 0;
    score += weight * Math.min(count, 3);
  }

  return {
    lexicalScore: score,
    matchedKeywords,
  };
}

function sectionMembershipsForRange(sections, startChar, endChar, startIndex = 0) {
  const memberships = [];
  for (let index = startIndex; index < sections.length; index += 1) {
    const section = sections[index];
    if (section.startChar >= endChar) break;
    const overlapCharacters =
      Math.min(endChar, section.endChar) -
      Math.max(startChar, section.startChar);
    if (overlapCharacters <= 0) continue;
    memberships.push({
      ...section,
      overlapCharacters,
    });
  }
  return memberships;
}

function meaningfulSectionMembership(membership, rangeLength) {
  const sectionLength = membership.endChar - membership.startChar;
  const requiredCharacters = Math.min(
    96,
    sectionLength,
    Math.max(1, Math.ceil(rangeLength * 0.25)),
  );
  return membership.overlapCharacters >= requiredCharacters;
}

function scoredRange(
  source,
  startChar,
  endChar,
  keywords,
  sections,
  weightsByRole,
  membershipStartIndex = 0,
) {
  const text = source.text.slice(startChar, endChar);
  const lexical = lexicalScore(text, keywords);
  const sectionMemberships = sectionMembershipsForRange(
    sections,
    startChar,
    endChar,
    membershipStartIndex,
  );
  const primarySection = sectionMemberships
    .slice()
    .sort(
      (left, right) =>
        right.overlapCharacters - left.overlapCharacters ||
        left.startChar - right.startChar,
    )[0];
  const sectionRoles = [
    ...new Set(
      sectionMemberships
        .filter((membership) =>
          meaningfulSectionMembership(membership, endChar - startChar),
        )
        .map((section) => section.role),
    ),
  ];
  if (!sectionRoles.length) {
    sectionRoles.push(primarySection?.role ?? "unclassified");
  }
  const sectionAnchors = [
    ...new Set(
      sections
        .filter(
          (section) =>
            section.startChar >= startChar && section.startChar < endChar,
        )
        .map((section) => section.role),
    ),
  ];
  const primaryRole = primarySection?.role ?? "unclassified";
  const roleWeight = weightsByRole.get(primaryRole) ?? 0;

  return {
    score: lexical.lexicalScore + roleWeight,
    lexicalScore: lexical.lexicalScore,
    roleWeight,
    matchedKeywords: lexical.matchedKeywords,
    sectionAnchors,
    sectionRole: primaryRole,
    sectionHeading: primarySection?.heading ?? "",
    sectionRoleBasis: primarySection?.roleBasis ?? "unclassified",
    sectionRoleWeight:
      weightsByRole.get(primaryRole) ?? 0,
    sectionRoles,
    sectionMemberships,
  };
}

function chunksForSource(
  source,
  sourceIndex,
  chunkChars,
  overlapChars,
  keywords,
  weightsByRole,
) {
  const sections = detectedSections(source.text);
  if (!source.text.length) return { chunks: [], sections };
  const step = chunkChars - overlapChars;
  const chunks = [];
  let membershipStartIndex = 0;
  for (let startChar = 0; startChar < source.text.length; startChar += step) {
    const endChar = Math.min(source.text.length, startChar + chunkChars);
    while (
      membershipStartIndex < sections.length &&
      sections[membershipStartIndex].endChar <= startChar
    ) {
      membershipStartIndex += 1;
    }
    const scored = scoredRange(
      source,
      startChar,
      endChar,
      keywords,
      sections,
      weightsByRole,
      membershipStartIndex,
    );
    chunks.push({
      sourceIndex,
      chunkIndex: chunks.length,
      startChar,
      endChar,
      ...scored,
    });
    if (endChar === source.text.length) break;
  }
  for (const chunk of chunks) chunk.sourceChunkCount = chunks.length;
  return { chunks, sections };
}

function compareCandidates(left, right) {
  return (
    right.score - left.score ||
    right.roleWeight - left.roleWeight ||
    right.lexicalScore - left.lexicalScore ||
    right.matchedKeywords.length - left.matchedKeywords.length ||
    right.sectionAnchors.length - left.sectionAnchors.length ||
    left.sourceIndex - right.sourceIndex ||
    left.chunkIndex - right.chunkIndex
  );
}

function candidatePriority(candidates, sourceCount, roleWeights) {
  const rankedBySource = Array.from({ length: sourceCount }, () => []);
  for (const candidate of candidates) rankedBySource[candidate.sourceIndex].push(candidate);
  for (const ranked of rankedBySource) ranked.sort(compareCandidates);

  const sourceSeeds = rankedBySource
    .filter((ranked) => ranked.length)
    .map((ranked) => ranked[0]);
  const roleSeeds = roleWeights
    .filter(({ substantive }) => substantive)
    .map(({ role }) =>
      candidates
        .filter((candidate) => candidate.sectionRoles.includes(role))
        .sort(compareCandidates)[0],
    )
    .filter(Boolean);
  const seeds = [...new Set([...sourceSeeds, ...roleSeeds])];
  seeds.sort(compareCandidates);
  const seeded = new Set(seeds);
  const remaining = candidates.filter((candidate) => !seeded.has(candidate)).sort(compareCandidates);
  return {
    priority: [...seeds, ...remaining],
    seeded,
  };
}

function chunkId(candidate) {
  return `source-${String(candidate.sourceIndex + 1).padStart(2, "0")}-chunk-${String(candidate.chunkIndex + 1).padStart(4, "0")}`;
}

function selectedChunk(
  candidate,
  source,
  textLength,
  keywords,
  sections,
  weightsByRole,
) {
  const text = source.text.slice(candidate.startChar, candidate.startChar + textLength);
  const partial = textLength < candidate.endChar - candidate.startChar;
  const scored = partial
    ? scoredRange(
        source,
        candidate.startChar,
        candidate.startChar + text.length,
        keywords,
        sections,
        weightsByRole,
      )
    : candidate;
  return {
    id: chunkId(candidate),
    fileName: source.fileName,
    sourceIndex: candidate.sourceIndex,
    chunkIndex: candidate.chunkIndex,
    sourceChunkCount: candidate.sourceChunkCount,
    startChar: candidate.startChar,
    endChar: candidate.startChar + text.length,
    score: scored.score,
    lexicalScore: scored.lexicalScore,
    roleWeight: scored.roleWeight,
    matchedKeywords: [...scored.matchedKeywords],
    sectionAnchors: [...scored.sectionAnchors],
    sectionRole: scored.sectionRole,
    sectionHeading: scored.sectionHeading,
    sectionRoleBasis: scored.sectionRoleBasis,
    sectionRoleWeight: scored.sectionRoleWeight,
    sectionRoles: [...scored.sectionRoles],
    partial,
    text,
  };
}

function renderChunk(chunk) {
  const header = `<<<EVIDENCE id=${chunk.id} file=${JSON.stringify(chunk.fileName)} source=${chunk.sourceIndex + 1} chunk=${chunk.chunkIndex + 1}/${chunk.sourceChunkCount} chars=${chunk.startChar}-${chunk.endChar} role=${chunk.sectionRole} heading=${JSON.stringify(chunk.sectionHeading)} score=${chunk.score}${chunk.partial ? " partial=true" : ""}>>>`;
  const canonicalText = chunk.text.replaceAll(/\r\n?/gu, "\n");
  return `${header}\n${canonicalText}\n<<<END EVIDENCE id=${chunk.id}>>>`;
}

function largestPartial(
  candidate,
  source,
  keywords,
  sections,
  weightsByRole,
  availableCharacters,
) {
  const fullLength = candidate.endChar - candidate.startChar;
  if (fullLength <= MIN_PARTIAL_CHARS) return null;
  let low = MIN_PARTIAL_CHARS;
  let high = fullLength - 1;
  let best = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const chunk = selectedChunk(
      candidate,
      source,
      middle,
      keywords,
      sections,
      weightsByRole,
    );
    const block = renderChunk(chunk);
    if (block.length <= availableCharacters) {
      best = { chunk, block };
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function mapRecordsForSources(sources, sourceAnalyses) {
  return sources.map((source, sourceIndex) => {
    const analysis = sourceAnalyses[sourceIndex];
    const sections = analysis.sections.length
      ? analysis.sections
      : source.text.length
        ? [
            {
              role: "unclassified",
              roleBasis: "unclassified",
              heading: "",
              detectedHeading: false,
              startChar: 0,
              endChar: source.text.length,
            },
          ]
        : [];
    return {
      sourceIndex,
      fileName: source.fileName,
      chunkCount: analysis.chunks.length,
      sections: sections.map((section) => {
        const overlapping = analysis.chunks.filter(
          (chunk) =>
            chunk.startChar < section.endChar &&
            chunk.endChar > section.startChar,
        );
        return {
          ...section,
          firstChunk: overlapping[0]?.chunkIndex ?? null,
          lastChunk: overlapping.at(-1)?.chunkIndex ?? null,
        };
      }),
    };
  });
}

function coveredCharacters(chunks, startChar, endChar) {
  const intervals = chunks
    .map((chunk) => [
      Math.max(startChar, chunk.startChar),
      Math.min(endChar, chunk.endChar),
    ])
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  if (!intervals.length) return 0;

  let covered = 0;
  let [currentStart, currentEnd] = intervals[0];
  for (const [start, end] of intervals.slice(1)) {
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
      continue;
    }
    covered += currentEnd - currentStart;
    currentStart = start;
    currentEnd = end;
  }
  return covered + currentEnd - currentStart;
}

function mapRecordCoverage(record, selected) {
  const selectedChunks = selected.filter(
    (chunk) => chunk.sourceIndex === record.sourceIndex,
  );
  const totalCharacters = record.endChar - record.startChar;
  const selectedCharacters = coveredCharacters(
    selectedChunks,
    record.startChar,
    record.endChar,
  );
  const state =
    selectedCharacters === 0
      ? "omitted"
      : selectedCharacters >= totalCharacters
        ? "selected"
        : "partial";
  return { selectedCharacters, totalCharacters, state };
}

function corpusMapRenderer(records, strategy, weightingPolicy, maxPacketChars) {
  if (!records.some((source) => source.chunkCount > 0)) {
    return () => "";
  }

  const header = `<<<CORPUS MAP strategy=${strategy} weightingPolicy=${weightingPolicy}>>>`;
  const footer = "<<<END CORPUS MAP>>>";
  const note =
    "Map states describe unique source-character inclusion only. Roles may be direct, inherited by a lower-level heading, or unclassified. PARTIAL and OMITTED prose was not fully supplied to the model.";
  const full = (selected) => {
    const lines = [header, note];
    for (const source of records) {
      lines.push(
        `SOURCE ${source.sourceIndex + 1} file=${JSON.stringify(source.fileName)} chunks=${source.chunkCount}`,
      );
      for (const section of source.sections) {
        const coverage = mapRecordCoverage(
          { ...section, sourceIndex: source.sourceIndex },
          selected,
        );
        const selectedLabel = {
          selected: "[SELECTED]",
          partial: "[PARTIAL ]",
          omitted: "[OMITTED ]",
        }[coverage.state];
        const chunkRange =
          section.firstChunk === null
            ? "none"
            : `${section.firstChunk + 1}-${section.lastChunk + 1}`;
        const selectedWidth = String(coverage.totalCharacters).length;
        const selectedCharacters = String(
          coverage.selectedCharacters,
        ).padStart(selectedWidth, "0");
        lines.push(
          `- ${selectedLabel} role=${section.role} basis=${section.roleBasis} heading=${JSON.stringify(section.heading)} chars=${section.startChar}-${section.endChar} selectedChars=${selectedCharacters}/${coverage.totalCharacters} chunks=${chunkRange}`,
        );
      }
    }
    lines.push(footer);
    return lines.join("\n");
  };
  const compact = (selected) => {
    const lines = [
      header,
      "S=selected; P=partial; O=omitted. Roles may be direct, inherited, or unclassified. Tokens preserve detected transition order.",
    ];
    for (const source of records) {
      const transitions = source.sections.map((section) => {
        const coverage = mapRecordCoverage(
          { ...section, sourceIndex: source.sourceIndex },
          selected,
        );
        const state = { selected: "S", partial: "P", omitted: "O" }[
          coverage.state
        ];
        const chunkRange =
          section.firstChunk === null
            ? "none"
            : `${section.firstChunk + 1}-${section.lastChunk + 1}`;
        return `${state}:${section.role}:${section.roleBasis}@${chunkRange}`;
      });
      lines.push(
        `S${source.sourceIndex + 1} ${JSON.stringify(source.fileName)} ${transitions.join(";") || "no-text"}`,
      );
    }
    lines.push(footer);
    return lines.join("\n");
  };
  const summary = (selected) => {
    const lines = [
      header,
      "S=selected; P=partial; O=omitted. Detailed transitions and role bases were compacted to preserve evidence budget.",
    ];
    const detectedRoles = new Set();
    for (const source of records) {
      for (const section of source.sections) detectedRoles.add(section.role);
      lines.push(
        `S${source.sourceIndex + 1} ${JSON.stringify(source.fileName)} chunks=${source.chunkCount}`,
      );
    }
    lines.push(
      `ROLES ${LARGE_CORPUS_ROLES.filter((role) => detectedRoles.has(role))
        .map((role) => {
          const roleStates = records.flatMap((source) =>
            source.sections.some(
              (section) =>
                section.role === role &&
                mapRecordCoverage(
                  { ...section, sourceIndex: source.sourceIndex },
                  selected,
                ).state === "selected",
            )
              ? ["selected"]
              : source.sections.some(
                    (section) =>
                      section.role === role &&
                      mapRecordCoverage(
                        { ...section, sourceIndex: source.sourceIndex },
                        selected,
                      ).state === "partial",
                  )
                ? ["partial"]
                : [],
          );
          const state = roleStates.includes("selected")
            ? "S"
            : roleStates.includes("partial")
              ? "P"
              : "O";
          return `${state}:${role}`;
        })
        .join(";")}`,
    );
    lines.push(footer);
    return lines.join("\n");
  };

  const mapLimit = Math.min(
    12_000,
    Math.max(256, Math.floor(maxPacketChars * 0.4)),
  );
  if (full([]).length <= mapLimit) return full;
  if (compact([]).length <= mapLimit) return compact;
  if (summary([]).length <= mapLimit) return summary;

  return () => "";
}

/**
 * Build a deterministic, provenance-preserving evidence packet from bounded text
 * sources. Character offsets are zero-based, half-open JavaScript string offsets.
 */
export function buildLargeCorpusEvidencePacket(input) {
  if (!isRecord(input)) {
    throw new Error("large corpus input must be an object.");
  }
  assertOnlyKeys(input, INPUT_KEYS, "largeCorpus");

  const sources = validateSources(input.sourceDocuments);
  const title = boundedString(input.title, "title", LIMITS.maxTitleChars);
  const targetVenue = boundedString(
    input.targetVenue,
    "targetVenue",
    LIMITS.maxTargetVenueChars,
  );
  const manuscript = boundedString(
    input.manuscript,
    "manuscript",
    LIMITS.maxManuscriptChars,
  );
  const submissionType = boundedString(
    input.submissionType ?? "",
    "submissionType",
    LIMITS.maxSubmissionTypeChars,
  );
  const maxPacketChars = integerOption(
    input.maxPacketChars,
    "maxPacketChars",
    LIMITS.defaultPacketChars,
    LIMITS.minPacketChars,
    LIMITS.maxPacketChars,
  );
  const chunkChars = integerOption(
    input.chunkChars,
    "chunkChars",
    LIMITS.defaultChunkChars,
    LIMITS.minChunkChars,
    LIMITS.maxChunkChars,
  );
  const maximumOverlap = Math.min(2_000, Math.floor(chunkChars / 2));
  const overlapChars = integerOption(
    input.overlapChars,
    "overlapChars",
    Math.min(LIMITS.defaultOverlapChars, maximumOverlap),
    0,
    maximumOverlap,
  );

  const keywords = queryKeywords(title, targetVenue, manuscript);
  const weightingPolicy = weightingPolicyForSubmissionType(submissionType);
  const roleWeights = roleWeightsForSubmissionType(submissionType);
  const weightsByRole = new Map(
    roleWeights.map(({ role, weight }) => [role, weight]),
  );
  const sourceAnalyses = sources.map((source, sourceIndex) =>
    chunksForSource(
      source,
      sourceIndex,
      chunkChars,
      overlapChars,
      keywords,
      weightsByRole,
    ),
  );
  const candidates = sourceAnalyses.flatMap(({ chunks }) => chunks);
  const mapRenderer = corpusMapRenderer(
    mapRecordsForSources(sources, sourceAnalyses),
    "lexical-section-balanced-v2",
    weightingPolicy,
    maxPacketChars,
  );
  const reservedMapText = mapRenderer([]);
  const evidenceBudget =
    maxPacketChars -
    reservedMapText.length -
    (reservedMapText && candidates.length ? 2 : 0);
  const { priority, seeded } = candidatePriority(
    candidates,
    sources.length,
    roleWeights,
  );
  const selected = [];
  const skipped = [];
  let packetCharacters = 0;

  for (const candidate of priority) {
    const source = sources[candidate.sourceIndex];
    const sections = sourceAnalyses[candidate.sourceIndex].sections;
    const chunk = selectedChunk(
      candidate,
      source,
      candidate.endChar - candidate.startChar,
      keywords,
      sections,
      weightsByRole,
    );
    const block = renderChunk(chunk);
    const separatorLength = selected.length ? 2 : 0;
    if (packetCharacters + separatorLength + block.length <= evidenceBudget) {
      selected.push(chunk);
      packetCharacters += separatorLength + block.length;
    } else {
      skipped.push(candidate);
    }
  }

  if (skipped.length) {
    const representedSources = new Set(
      selected.map((chunk) => chunk.sourceIndex),
    );
    const representedRoles = new Set(
      selected.flatMap((chunk) => chunk.sectionRoles),
    );
    const partialCandidate =
      skipped.find(
        (candidate) =>
          seeded.has(candidate) &&
          (!representedSources.has(candidate.sourceIndex) ||
            candidate.sectionRoles.some(
              (role) =>
                roleWeights.find((entry) => entry.role === role)?.substantive &&
                !representedRoles.has(role),
            )),
      ) ??
      skipped.find(
        (candidate) => !representedSources.has(candidate.sourceIndex),
      ) ??
      skipped.find((candidate) =>
        candidate.sectionRoles.some(
          (role) =>
            roleWeights.find((entry) => entry.role === role)?.substantive &&
            !representedRoles.has(role),
        ),
      ) ??
      skipped[0];
    const separatorLength = selected.length ? 2 : 0;
    const available = evidenceBudget - packetCharacters - separatorLength;
    const partial = largestPartial(
      partialCandidate,
      sources[partialCandidate.sourceIndex],
      keywords,
      sourceAnalyses[partialCandidate.sourceIndex].sections,
      weightsByRole,
      available,
    );
    if (partial) {
      selected.push(partial.chunk);
      packetCharacters += separatorLength + partial.block.length;
    }
  }

  selected.sort(
    (left, right) =>
      left.sourceIndex - right.sourceIndex ||
      left.chunkIndex - right.chunkIndex,
  );
  const blocks = selected.map(renderChunk);
  const mapText = mapRenderer(selected);
  const packetText = [mapText, ...blocks].filter(Boolean).join("\n\n");
  const totalSourceCharacters = sources.reduce((sum, source) => sum + source.text.length, 0);

  const sourceCoverage = sources.map((source, sourceIndex) => {
    const sourceCandidates = candidates.filter((candidate) => candidate.sourceIndex === sourceIndex);
    const sourceSelections = selected.filter((chunk) => chunk.sourceIndex === sourceIndex);
    return {
      fileName: source.fileName,
      characters: source.text.length,
      chunks: sourceCandidates.length,
      selectedChunks: sourceSelections.length,
      selectedCharacters: coveredCharacters(
        sourceSelections,
        0,
        source.text.length,
      ),
    };
  });
  const selectedEvidenceCharacters = sourceCoverage.reduce(
    (sum, source) => sum + source.selectedCharacters,
    0,
  );
  const roleCoverage = roleWeights
    .map(({ role, weight, substantive }) => {
      const headingRecords = sourceAnalyses.flatMap(({ sections }, sourceIndex) =>
        sections
          .filter(
            (section) =>
              section.role === role && section.detectedHeading === true,
          )
          .map((section) => ({ ...section, sourceIndex })),
      );
      const detectedCandidates = candidates.filter((candidate) =>
        candidate.sectionRoles.includes(role),
      );
      const selectedChunks = selected.filter((chunk) =>
        chunk.sectionRoles.includes(role),
      );
      const selectedCharacters = sources.reduce(
        (sum, _source, sourceIndex) => {
          const sourceChunks = selectedChunks.filter(
            (chunk) => chunk.sourceIndex === sourceIndex,
          );
          return (
            sum +
            sourceAnalyses[sourceIndex].sections
              .filter((section) => section.role === role)
              .reduce(
                (sectionSum, section) =>
                  sectionSum +
                  coveredCharacters(
                    sourceChunks,
                    section.startChar,
                    section.endChar,
                  ),
                0,
              )
          );
        },
        0,
      );

      return {
        role,
        weight,
        substantive,
        headingCount: headingRecords.length,
        detectedSources: new Set(
          detectedCandidates.map(({ sourceIndex }) => sourceIndex),
        ).size,
        selectedSources: new Set(
          selectedChunks.map(({ sourceIndex }) => sourceIndex),
        ).size,
        detectedChunks: detectedCandidates.length,
        selectedChunks: selectedChunks.length,
        selectedCharacters,
      };
    });

  return {
    packetText,
    chunks: selected,
    coverage: {
      enabled: true,
      strategy: "lexical-section-balanced-v2",
      weightingPolicy,
      selectionPolicy: LARGE_CORPUS_SELECTION_POLICY,
      roleWeights,
      roleCoverage,
      mapCharacters: mapText.length,
      sourceCount: sources.length,
      totalCharacters: totalSourceCharacters,
      totalChunks: candidates.length,
      selectedChunks: selected.length,
      selectedCharacters: selectedEvidenceCharacters,
      omittedChunks: candidates.length - selected.length,
      packetCharacters: packetText.length,
      sources: sourceCoverage,
    },
  };
}

export const LARGE_CORPUS_LIMITS = LIMITS;
export {
  LARGE_CORPUS_ROLES,
  LARGE_CORPUS_SELECTION_POLICY,
  LARGE_CORPUS_WEIGHTING_POLICIES,
};
