const LIST_ENVIRONMENTS = Object.freeze({
  itemize: "item",
  "itemize*": "item",
  enumerate: "item",
  "enumerate*": "item",
  description: "item",
  "description*": "item",
  list: "item",
  thebibliography: "bibitem",
});

const listEnvironmentNames = new Set(Object.keys(LIST_ENVIRONMENTS));
const listTokenPattern =
  /\\(?:(begin|end)\s*\{\s*([A-Za-z@*]+)\s*\}|(bibitem|item)(?![A-Za-z@]))/g;
const MAX_RECORDED_FINDINGS = 512;
const ambiguousPlainTextStarts = new Set([
  "\\",
  "{",
  "}",
  "$",
  "&",
  "#",
  "^",
  "_",
  "~",
  "[",
  "]",
]);

/**
 * @typedef {object} LatexListIssue
 * @property {string} environment
 * @property {number} line
 * @property {string} action
 */

/**
 * Find standard list structures that TeX can report as a missing `\\item`.
 * Lonely items and custom list macros remain the compiler's responsibility so
 * this preflight does not reject valid class-defined environments.
 *
 * @param {string} latex
 * @returns {LatexListIssue[]}
 */
export function findLatexListIssues(latex) {
  return analyzeLatexLists(latex).issues;
}

/**
 * Conservatively repair generated lists. Clearly plain text before the first
 * item receives one item marker, while a whitespace/comment-only list is
 * removed. Bibliographies and control-sequence prefixes are never rewritten.
 *
 * @param {string} latex
 * @returns {{ latex: string, repairs: LatexListIssue[] }}
 */
export function repairLatexListStructure(latex) {
  if (typeof latex !== "string" || !latex) return { latex, repairs: [] };

  const { replacements } = analyzeLatexLists(latex);
  const applicable = replacements
    .filter((replacement) => replacement.start >= 0 && replacement.end >= replacement.start)
    .sort((left, right) => right.start - left.start || right.end - left.end);

  let repaired = latex;
  const repairs = [];
  let lastStart = latex.length + 1;
  for (const replacement of applicable) {
    // Refuse overlapping rewrites. Nested missing-item environments naturally
    // use insertions at different offsets, so this protects only ambiguous input.
    if (replacement.end > lastStart) continue;
    repaired = `${repaired.slice(0, replacement.start)}${replacement.text}${repaired.slice(replacement.end)}`;
    repairs.push(replacement.issue);
    lastStart = replacement.start;
  }

  repairs.sort((left, right) => left.line - right.line);
  return { latex: repaired, repairs };
}

function analyzeLatexLists(latex) {
  if (typeof latex !== "string" || !latex) {
    return { issues: [], replacements: [] };
  }

  const source = maskIgnoredRegions(stripCommentsPreservingLines(latex));
  const lineStarts = lineStartOffsets(source);
  const stack = [];
  const records = [];
  const issues = [];
  const replacements = [];
  const addIssue = (issue) => {
    if (issues.length < MAX_RECORDED_FINDINGS) issues.push(issue);
  };
  const addReplacement = (replacement) => {
    if (replacements.length < MAX_RECORDED_FINDINGS) {
      replacements.push(replacement);
    }
  };
  listTokenPattern.lastIndex = 0;

  for (const match of source.matchAll(listTokenPattern)) {
    const [token, boundary, environment, itemCommand] = match;
    const tokenStart = match.index ?? 0;
    if (commandSlashIsEscaped(source, tokenStart)) continue;

    if (boundary === "begin") {
      const target = listEnvironmentNames.has(environment);
      const record = {
        environment,
        target,
        beginStart: tokenStart,
        beginLine: lineNumberAt(lineStarts, tokenStart),
        contentStart: target
          ? contentStartAfterArguments(
              source,
              tokenStart + token.length,
              environment,
            )
          : tokenStart + token.length,
        endStart: -1,
        endEnd: -1,
        items: [],
      };
      stack.push(record);
      if (target) records.push(record);
      continue;
    }

    if (boundary === "end") {
      let matchingIndex = -1;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].environment === environment) {
          matchingIndex = index;
          break;
        }
      }
      if (matchingIndex < 0) {
        if (listEnvironmentNames.has(environment)) {
          addIssue({
            environment,
            line: lineNumberAt(lineStarts, tokenStart),
            action: `Remove this unmatched \\end{${environment}} or add its opening environment.`,
          });
        }
        continue;
      }

      for (let index = stack.length - 1; index > matchingIndex; index -= 1) {
        const unclosed = stack[index];
        if (unclosed.target) {
          addIssue({
            environment: unclosed.environment,
            line: unclosed.beginLine,
            action: `Close \\begin{${unclosed.environment}} before ending ${environment}.`,
          });
        }
      }
      stack.splice(matchingIndex + 1);
      const record = stack.pop();
      if (record.target) {
        record.endStart = tokenStart;
        record.endEnd = tokenStart + token.length;
      }
      continue;
    }

    const active = stack.at(-1);
    if (!active?.target) continue;
    const expected = LIST_ENVIRONMENTS[active.environment];
    if (expected !== itemCommand) {
      addIssue({
        environment: active.environment,
        line: lineNumberAt(lineStarts, tokenStart),
        action: `Use \\${expected} entries inside this ${active.environment} environment.`,
      });
      continue;
    }
    active.items.push({ start: tokenStart });
  }

  for (const unclosed of stack) {
    if (unclosed.target) {
      addIssue({
        environment: unclosed.environment,
        line: unclosed.beginLine,
        action: `Add \\end{${unclosed.environment}} for this opening environment.`,
      });
    }
  }

  for (const record of records) {
    if (record.endStart < 0) continue;
    const firstItem = record.items[0];
    const prefixEnd = firstItem?.start ?? record.endStart;
    const contentIndex = firstNonWhitespaceIndex(
      source,
      record.contentStart,
      prefixEnd,
    );

    if (contentIndex < 0 && firstItem) continue;

    if (contentIndex < 0) {
      const issue = {
        environment: record.environment,
        line: record.beginLine,
        action: `Removed the empty ${record.environment} environment.`,
      };
      addIssue(issue);
      addReplacement({
        start: record.beginStart,
        end: record.endEnd,
        text: "",
        issue,
      });
      continue;
    }

    const command = LIST_ENVIRONMENTS[record.environment];
    if (command === "bibitem") {
      if (startsClearlyPlainText(source, contentIndex)) {
        addIssue({
          environment: record.environment,
          line: lineNumberAt(lineStarts, contentIndex),
          action:
            "Add a verified \\bibitem{unique-key} before each reference. Scholar Flow will not guess citation boundaries or keys.",
        });
      }
      continue;
    }
    if (!startsClearlyPlainText(source, contentIndex)) {
      // A control sequence, group, math expression, or option before the first
      // item may be valid list setup. Let TeX decide instead of adding a blank item.
      continue;
    }

    const issue = {
      environment: record.environment,
      line: lineNumberAt(lineStarts, contentIndex),
      action: "Inserted an item marker before existing list text.",
    };
    addIssue(issue);
    addReplacement({
      start: contentIndex,
      end: contentIndex,
      text: "\\item ",
      issue,
    });
  }

  return { issues, replacements };
}

function contentStartAfterArguments(source, tokenEnd, environment) {
  let cursor = skipWhitespace(source, tokenEnd, source.length);
  if (environment === "thebibliography") {
    return consumeBalanced(source, cursor, "{", "}") || tokenEnd;
  }
  if (environment === "list") {
    const labelEnd = consumeBalanced(source, cursor, "{", "}");
    if (!labelEnd) return tokenEnd;
    cursor = skipWhitespace(source, labelEnd, source.length);
    return consumeBalanced(source, cursor, "{", "}") || tokenEnd;
  }
  const optionEnd = consumeBalanced(source, cursor, "[", "]");
  return optionEnd || tokenEnd;
}

function firstNonWhitespaceIndex(source, start, end) {
  const cursor = skipWhitespace(source, start, end);
  return cursor < end ? cursor : -1;
}

function startsClearlyPlainText(source, index) {
  return !ambiguousPlainTextStarts.has(source[index]);
}

function commandSlashIsEscaped(source, index) {
  let precedingSlashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
    precedingSlashes += 1;
  }
  return precedingSlashes % 2 === 1;
}

function skipWhitespace(source, start, end) {
  let cursor = start;
  while (cursor < end && /\s/.test(source[cursor])) cursor += 1;
  return cursor;
}

function consumeBalanced(source, start, open, close) {
  if (source[start] !== open) return 0;
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source[cursor] === open) depth += 1;
    if (source[cursor] !== close) continue;
    depth -= 1;
    if (depth === 0) return cursor + 1;
  }
  return 0;
}

function stripCommentsPreservingLines(source) {
  return source
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part)) return part;
      for (let index = 0; index < part.length; index += 1) {
        if (part[index] !== "%") continue;
        let backslashes = 0;
        for (
          let cursor = index - 1;
          cursor >= 0 && part[cursor] === "\\";
          cursor -= 1
        ) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) {
          return `${part.slice(0, index)}${" ".repeat(part.length - index)}`;
        }
      }
      return part;
    })
    .join("");
}

function maskIgnoredRegions(source) {
  const blockMasked = source.replace(
    /\\begin\s*\{\s*(?:verbatim\*?|lstlisting)\s*\}[\s\S]*?\\end\s*\{\s*(?:verbatim\*?|lstlisting)\s*\}/g,
    maskExceptNewlines,
  );
  return blockMasked
    .split(/(\r?\n)/)
    .map((part) => {
      if (/^\r?\n$/.test(part)) return part;
      return part
        .replace(/\\verb\*?([^\sA-Za-z])[^\r\n]*?\1/g, maskExceptNewlines)
        .replace(
          /\\lstinline(?:\s*\[[^\]]*\])?([^\sA-Za-z])[^\r\n]*?\1/g,
          maskExceptNewlines,
        );
    })
    .join("");
}

function maskExceptNewlines(value) {
  return value.replace(/[^\r\n]/g, " ");
}

function lineStartOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") offsets.push(index + 1);
  }
  return offsets;
}

function lineNumberAt(lineStarts, index) {
  let lower = 0;
  let upper = lineStarts.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (lineStarts[middle] <= index) lower = middle + 1;
    else upper = middle;
  }
  return Math.max(1, lower);
}

export const LATEX_LIST_ENVIRONMENTS = Object.freeze(
  [...listEnvironmentNames],
);
