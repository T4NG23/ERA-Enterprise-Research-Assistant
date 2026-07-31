import { isSubmissionTypeAllowed } from "../lib/submission-types.mjs";

const freezeContract = (contract) =>
  Object.freeze({
    ...contract,
    requiredOptions: Object.freeze([...contract.requiredOptions]),
    forbiddenOptions: Object.freeze([...(contract.forbiddenOptions ?? [])]),
  });

export const PUBLICATION_LATEX_CONTRACTS = Object.freeze({
  "ieee-igarss-2026": freezeContract({
    documentClass: "IEEEtran",
    requiredOptions: ["conference"],
    forbiddenOptions: [],
    wrapper: "maketitle",
    classBasis: "publisher-template",
  }),
  "acm-sigconf": freezeContract({
    documentClass: "acmart",
    requiredOptions: [],
    forbiddenOptions: ["authordraft", "nonacm"],
    wrapper: "maketitle",
    classBasis: "publisher-template",
  }),
  "springer-lncs": freezeContract({
    documentClass: "llncs",
    requiredOptions: [],
    forbiddenOptions: [],
    wrapper: "maketitle",
    classBasis: "publisher-template",
  }),
  "elsevier-research-article": freezeContract({
    documentClass: "elsarticle",
    requiredOptions: [],
    forbiddenOptions: [],
    wrapper: "frontmatter",
    classBasis: "compiler-fallback",
  }),
  "custom-publication": freezeContract({
    documentClass: "article",
    requiredOptions: [],
    forbiddenOptions: [],
    wrapper: "maketitle",
    classBasis: "compiler-fallback",
  }),
});

export const VENUE_TEMPLATE_CONTRACTS = Object.freeze({
  "generic-article": PUBLICATION_LATEX_CONTRACTS["custom-publication"],
  "ieee-conference": PUBLICATION_LATEX_CONTRACTS["ieee-igarss-2026"],
  "acm-sigconf-review": PUBLICATION_LATEX_CONTRACTS["acm-sigconf"],
  "acm-sigconf-final": freezeContract({
    documentClass: "acmart",
    requiredOptions: ["sigconf"],
    forbiddenOptions: [
      "manuscript",
      "review",
      "anonymous",
      "authordraft",
      "nonacm",
    ],
    wrapper: "maketitle",
    classBasis: "publisher-template",
  }),
  "springer-lncs": PUBLICATION_LATEX_CONTRACTS["springer-lncs"],
  "elsevier-article": PUBLICATION_LATEX_CONTRACTS[
    "elsevier-research-article"
  ],
});

const SUBMISSION_LATEX_CONTRACT_OVERRIDES = Object.freeze({
  "acm-sigconf": Object.freeze({
    "Camera-ready / final paper": freezeContract({
      documentClass: "acmart",
      requiredOptions: ["sigconf"],
      forbiddenOptions: [
        "manuscript",
        "review",
        "anonymous",
        "authordraft",
        "nonacm",
      ],
      wrapper: "maketitle",
      classBasis: "publisher-template",
    }),
  }),
});

export function getPublicationLatexContract(profileId) {
  return PUBLICATION_LATEX_CONTRACTS[profileId];
}

export function getVenueTemplateContract(templateKey) {
  return typeof templateKey === "string"
    ? VENUE_TEMPLATE_CONTRACTS[templateKey]
    : undefined;
}

export function getSubmissionLatexContract(profileId, submissionType) {
  if (!isSubmissionTypeAllowed(profileId, submissionType)) return undefined;
  return (
    SUBMISSION_LATEX_CONTRACT_OVERRIDES[profileId]?.[submissionType] ??
    getPublicationLatexContract(profileId)
  );
}

function maskRange(source, start, end) {
  return `${source.slice(0, start)}${source
    .slice(start, end)
    .replace(/[^\n]/g, " ")}${source.slice(end)}`;
}

function stripComments(source) {
  return source
    .replaceAll(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") continue;
        let slashes = 0;
        for (
          let cursor = index - 1;
          cursor >= 0 && line[cursor] === "\\";
          cursor -= 1
        ) {
          slashes += 1;
        }
        if (slashes % 2 === 0) {
          return `${line.slice(0, index)}${" ".repeat(line.length - index)}`;
        }
      }
      return line;
    })
    .join("\n");
}

function isRealCommand(source, index) {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 0;
}

function maskLiteralEnvironments(source) {
  const beginPattern = /\\begin\s*\{\s*(verbatim\*?|lstlisting)\s*\}/gi;
  let result = source;
  let searchFrom = 0;
  while (searchFrom < result.length) {
    beginPattern.lastIndex = searchFrom;
    const begin = beginPattern.exec(result);
    if (!begin) break;
    if (!isRealCommand(result, begin.index)) {
      searchFrom = beginPattern.lastIndex;
      continue;
    }
    const environment = begin[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const endPattern = new RegExp(
      `\\\\end\\s*\\{\\s*${environment}\\s*\\}`,
      "gi",
    );
    endPattern.lastIndex = beginPattern.lastIndex;
    const end = endPattern.exec(result);
    const endIndex = end ? endPattern.lastIndex : result.length;
    result = maskRange(result, begin.index, endIndex);
    searchFrom = endIndex;
  }
  return result;
}

function maskInlineLiterals(source) {
  const patterns = [
    /\\verb\*?([^\sA-Za-z\r\n])[^\r\n]*?\1/g,
    /\\lstinline(?:\s*\[[^\]\r\n]*\])?\s*([^\sA-Za-z\r\n])[^\r\n]*?\1/g,
  ];
  let result = source;
  for (const pattern of patterns) {
    const matches = Array.from(result.matchAll(pattern)).reverse();
    for (const match of matches) {
      const index = match.index ?? -1;
      if (index >= 0 && isRealCommand(result, index)) {
        result = maskRange(result, index, index + match[0].length);
      }
    }
  }
  return result;
}

function balancedGroupEnd(source, start, open, close) {
  if (source[start] !== open) return -1;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (!isRealCommand(source, index) && source[index] === "\\") continue;
    if (source[index] === open && isRealCommand(source, index)) depth += 1;
    if (source[index] === close && isRealCommand(source, index)) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function maskCommandDefinitions(source) {
  const definitionPattern =
    /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\b/g;
  let result = source;
  const matches = Array.from(result.matchAll(definitionPattern)).reverse();
  for (const match of matches) {
    const start = match.index ?? -1;
    if (start < 0 || !isRealCommand(result, start)) continue;
    let cursor = skipWhitespace(result, start + match[0].length);
    if (result[cursor] === "{") {
      cursor = balancedGroupEnd(result, cursor, "{", "}");
    } else if (result[cursor] === "\\") {
      cursor += 1;
      while (/[A-Za-z@]/.test(result[cursor] ?? "")) cursor += 1;
    }
    if (cursor < 0) continue;
    cursor = skipWhitespace(result, cursor);
    for (let optional = 0; optional < 2 && result[cursor] === "["; optional += 1) {
      cursor = balancedGroupEnd(result, cursor, "[", "]");
      if (cursor < 0) break;
      cursor = skipWhitespace(result, cursor);
    }
    if (cursor < 0 || result[cursor] !== "{") continue;
    const end = balancedGroupEnd(result, cursor, "{", "}");
    if (end > cursor) result = maskRange(result, start, end);
  }
  return result;
}

function inspectionSource(latex) {
  return maskCommandDefinitions(
    maskInlineLiterals(maskLiteralEnvironments(stripComments(latex))),
  );
}

function commandMatches(source, command) {
  const pattern = new RegExp(`\\\\${command}\\b`, "g");
  return Array.from(source.matchAll(pattern)).filter((match) =>
    isRealCommand(source, match.index ?? -1),
  );
}

function commandGroupContents(source, command) {
  return commandMatches(source, command).flatMap((match) => {
    const start = match.index ?? -1;
    if (start < 0) return [];
    const groupStart = skipWhitespace(source, start + match[0].length);
    if (source[groupStart] !== "{") return [];
    const groupEnd = balancedGroupEnd(source, groupStart, "{", "}");
    return groupEnd > groupStart
      ? [source.slice(groupStart + 1, groupEnd - 1)]
      : [];
  });
}

function environmentMatches(source, command, environment) {
  const pattern = new RegExp(
    `\\\\${command}\\s*\\{\\s*${environment.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}\\s*\\}`,
    "g",
  );
  return Array.from(source.matchAll(pattern)).filter((match) =>
    isRealCommand(source, match.index ?? -1),
  );
}

function environmentRange(source, environment) {
  const begins = environmentMatches(source, "begin", environment);
  const ends = environmentMatches(source, "end", environment);
  if (begins.length !== 1 || ends.length !== 1) return null;
  const start = begins[0].index ?? -1;
  const contentStart = start + begins[0][0].length;
  const contentEnd = ends[0].index ?? -1;
  const end = contentEnd + ends[0][0].length;
  if (start < 0 || contentEnd < contentStart) return null;
  return { start, contentStart, contentEnd, end };
}

export function inspectLatexEnvironment(latex, environment) {
  if (
    typeof latex !== "string" ||
    typeof environment !== "string" ||
    !/^[A-Za-z@*]{1,64}$/.test(environment)
  ) {
    return Object.freeze({
      beginCount: 0,
      endCount: 0,
      range: null,
    });
  }
  const source = inspectionSource(latex);
  const begins = environmentMatches(source, "begin", environment);
  const ends = environmentMatches(source, "end", environment);
  const range =
    begins.length === 1 && ends.length === 1
      ? environmentRange(source, environment)
      : null;
  return Object.freeze({
    beginCount: begins.length,
    endCount: ends.length,
    range: range ? Object.freeze({ ...range }) : null,
  });
}

function expectedDeclaration(contract) {
  const options = contract.requiredOptions.length
    ? `[${contract.requiredOptions.join(",")}]`
    : "";
  return `\\documentclass${options}{${contract.documentClass}}`;
}

function optionIsEnabled(actualOptions, option) {
  return actualOptions.some((actual) => {
    const normalized = actual.replaceAll(/\s+/g, "").toLowerCase();
    const expected = option.toLowerCase();
    return (
      normalized === expected ||
      normalized === `${expected}=true` ||
      normalized === `format=${expected}`
    );
  });
}

export function publicationLatexContractIssues(
  latex,
  contract,
  profileName = "The selected publication",
) {
  const issues = [];
  if (typeof latex !== "string" || !contract) {
    return ["A valid publication LaTeX contract is required."];
  }

  const source = inspectionSource(latex);
  const classPattern =
    /\\documentclass(?:\s*\[([a-zA-Z0-9,=._ -]{0,240})\])?\s*\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}/g;
  const classMatches = Array.from(source.matchAll(classPattern)).filter((match) =>
    isRealCommand(source, match.index ?? -1),
  );
  if (classMatches.length !== 1) {
    issues.push("The generated LaTeX must contain exactly one plain document class declaration.");
    return issues;
  }

  const classMatch = classMatches[0];
  const actualClass = classMatch[2];
  if (actualClass !== contract.documentClass) {
    issues.push(
      `${profileName} requires ${expectedDeclaration(contract)}, but the generated LaTeX uses ${actualClass}. Retry generation or restore the selected template.`,
    );
  }
  const actualOptions = (
    (classMatch[1] ?? "")
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean)
  );
  const missingOptions = contract.requiredOptions.filter(
    (option) => !optionIsEnabled(actualOptions, option),
  );
  if (missingOptions.length) {
    issues.push(
      `${profileName} requires the document class ${missingOptions.length === 1 ? "option" : "options"} ${missingOptions.join(", ")}. Use ${expectedDeclaration(contract)}.`,
    );
  }
  const forbiddenOptions = (contract.forbiddenOptions ?? []).filter((option) =>
    optionIsEnabled(actualOptions, option),
  );
  if (forbiddenOptions.length) {
    issues.push(
      `${profileName} does not allow the document class ${forbiddenOptions.length === 1 ? "option" : "options"} ${forbiddenOptions.join(", ")} for this submission workflow. Remove ${forbiddenOptions.join(", ")} from the document class declaration.`,
    );
  }
  if (actualClass === "acmart") {
    const affiliations = commandGroupContents(source, "affiliation");
    const missingCountryCount = affiliations.filter(
      (affiliation) => commandMatches(affiliation, "country").length === 0,
    ).length;
    if (missingCountryCount) {
      issues.push(
        `ACM requires every \\affiliation declaration to include a verified \\country{...} field. Add the country to ${missingCountryCount === 1 ? "the affiliation" : `all ${missingCountryCount} affected affiliations`}; if it is unknown, use an explicit TODO country placeholder and resolve it before submission.`,
      );
    }
  }

  const documentRange = environmentRange(source, "document");
  if (!documentRange) {
    issues.push("The generated LaTeX must contain one balanced document environment.");
    return issues;
  }
  const body = source.slice(documentRange.contentStart, documentRange.contentEnd);
  const bodyOffset = documentRange.contentStart;
  const firstSection = commandMatches(body, "section")[0];
  const firstSectionIndex = firstSection
    ? bodyOffset + (firstSection.index ?? body.length)
    : documentRange.contentEnd;

  const titleMatches = commandMatches(source, "title");
  if (titleMatches.length !== 1) {
    issues.push("The publication template requires exactly one direct \\title declaration.");
  }

  const abstractRange = environmentRange(source, "abstract");
  if (
    !abstractRange ||
    abstractRange.start < documentRange.contentStart ||
    abstractRange.end > documentRange.contentEnd
  ) {
    issues.push("The publication template requires one abstract environment inside the document.");
  } else if (abstractRange.end > firstSectionIndex) {
    issues.push("The abstract must be complete before the first section.");
  }

  const makeTitleMatches = commandMatches(body, "maketitle").map((match) => ({
    ...match,
    absoluteIndex: bodyOffset + (match.index ?? 0),
  }));

  if (contract.wrapper === "maketitle") {
    if (makeTitleMatches.length !== 1) {
      issues.push("The publication template requires exactly one direct \\maketitle command inside the document.");
    } else if (makeTitleMatches[0].absoluteIndex > firstSectionIndex) {
      issues.push("The \\maketitle command must appear before the first section.");
    }
  } else if (contract.wrapper === "frontmatter") {
    if (makeTitleMatches.length) {
      issues.push("The elsarticle frontmatter wrapper must not use \\maketitle.");
    }
    const frontmatterRange = environmentRange(source, "frontmatter");
    if (
      !frontmatterRange ||
      frontmatterRange.start < documentRange.contentStart ||
      frontmatterRange.end > documentRange.contentEnd
    ) {
      issues.push("The Elsevier compiler fallback requires one frontmatter environment inside the document.");
    } else {
      if (frontmatterRange.end > firstSectionIndex) {
        issues.push("The frontmatter environment must end before the first section.");
      }
      const titleIndex = titleMatches[0]?.index ?? -1;
      if (
        titleIndex < frontmatterRange.contentStart ||
        titleIndex >= frontmatterRange.contentEnd
      ) {
        issues.push("The \\title declaration must be inside the frontmatter environment.");
      }
      if (
        !abstractRange ||
        abstractRange.start < frontmatterRange.contentStart ||
        abstractRange.end > frontmatterRange.contentEnd
      ) {
        issues.push("The abstract must be entirely inside the frontmatter environment.");
      }
    }
  }

  return [...new Set(issues)];
}

export function assertPublicationLatexContract(
  latex,
  contract,
  profileName,
) {
  const [issue] = publicationLatexContractIssues(latex, contract, profileName);
  if (issue) throw new Error(issue);
}
