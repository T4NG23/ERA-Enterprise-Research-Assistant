const MAX_DETAIL_CHARACTERS = 4_000;
const MAX_SOURCE_LINE_CHARACTERS = 240;

/**
 * Convert a failed Tectonic process into a stable, user-facing diagnostic.
 * A successful exit is always accepted, even when its log contains box warnings.
 */
export function diagnoseCompilerResult({
  exitCode,
  output,
  latex,
  jobDirectory = "",
  cacheDirectory = "",
}) {
  if (exitCode === 0) return null;

  const detailLog = sanitizeCompilerLog(output, { jobDirectory, cacheDirectory });
  const missingResource = missingCachedResource(output);
  if (missingResource) {
    return {
      code: "COMPILE_CACHE_MISS",
      status: 422,
      message: `The cached LaTeX compiler is missing ${missingResource}. Run npm run pdf:setup locally, or rebuild the production compiler image, then retry.`,
      detail: detailLog,
    };
  }

  const missingAcmCountry = /Class acmart Error:\s+No country present for an affiliation\./i.exec(output);
  if (missingAcmCountry) {
    const line = errorLineNumber(String(output), missingAcmCountry.index);
    const lineSuffix = line ? ` near source line ${line}` : "";
    return {
      code: "ACM_AFFILIATION_COUNTRY_MISSING",
      status: 422,
      message: `An ACM affiliation is missing its required \\country{...} field${lineSuffix}. Add a verified country inside every \\affiliation block, then retry.`,
      detail: detailWithSourceContext(detailLog, latex, line),
    };
  }

  const listProblem = findListProblem(output, latex);
  if (listProblem) {
    const lineSuffix = listProblem.line ? ` near source line ${listProblem.line}` : "";
    const message = listProblem.kind === "lonely-item"
      ? `A LaTeX \\item appears outside a list${lineSuffix}. Move it inside an itemize, enumerate, or description environment.`
      : `A LaTeX list is missing an \\item${lineSuffix}. Start every list entry with \\item and remove any empty list environments.`;
    return {
      code: "LATEX_LIST_ERROR",
      status: 422,
      message,
      detail: detailWithSourceContext(detailLog, latex, listProblem.line),
    };
  }

  return {
    code: "COMPILE_FAILED",
    status: 422,
    message: "LaTeX compilation failed. Review the generated source and compiler details.",
    detail: detailLog,
  };
}

export function sanitizeCompilerLog(value, { jobDirectory = "", cacheDirectory = "" } = {}) {
  let log = String(value || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
  if (jobDirectory) log = log.replaceAll(jobDirectory, "[job]");
  if (cacheDirectory) log = log.replaceAll(cacheDirectory, "[cache]");
  log = log.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  const lines = log.split(/\r?\n/).filter(Boolean).slice(-40).join("\n");
  return lines.slice(0, MAX_DETAIL_CHARACTERS) || undefined;
}

function missingCachedResource(value) {
  const log = String(value || "");
  const match = log.match(
    /LaTeX Error:\s+File\s+[`']([^`'\r\n]+)[`']\s+not found\./i,
  );
  if (match) {
    const name = match[1].trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(name) ? name : "a required package";
  }
  const fontMatch = log.match(
    /Font\s+[^=\r\n]+\s*=\s*\[?([A-Za-z0-9][A-Za-z0-9._-]{0,119})\]?:[^\r\n]*not loadable:[^\r\n]*(?:not found|missing)/i,
  );
  return fontMatch ? `${fontMatch[1]} font resources` : "";
}

function findListProblem(output, latex) {
  const log = String(output || "");
  const lonelyMatch = /LaTeX Error:\s+Lonely\s+\\item\b[^\r\n]*/i.exec(log);
  if (lonelyMatch) {
    return {
      kind: "lonely-item",
      line: errorLineNumber(log, lonelyMatch.index) || likelyLonelyItemLine(latex),
    };
  }

  const missingMatch = /LaTeX Error:\s+Something(?:'|’)s wrong--perhaps a missing\s+\\item\b[^\r\n]*/i.exec(log);
  if (missingMatch) {
    return {
      kind: "missing-item",
      line: errorLineNumber(log, missingMatch.index) || likelyMissingItemLine(latex),
    };
  }
  return null;
}

function errorLineNumber(log, diagnosticIndex) {
  const lineStart = log.lastIndexOf("\n", diagnosticIndex) + 1;
  const lineEndCandidate = log.indexOf("\n", diagnosticIndex);
  const lineEnd = lineEndCandidate === -1 ? log.length : lineEndCandidate;
  const diagnosticLine = log.slice(lineStart, lineEnd);
  const filenameLocation = diagnosticLine.match(/\.tex:(\d+):/i);
  if (filenameLocation) return positiveLineNumber(filenameLocation[1]);

  const traditionalLocation = log
    .slice(diagnosticIndex)
    .match(/(?:^|\r?\n)l\.(\d+)\b/m);
  return traditionalLocation ? positiveLineNumber(traditionalLocation[1]) : 0;
}

function likelyLonelyItemLine(latex) {
  const lines = String(latex || "").split(/\r?\n/);
  let listDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/(?<!\\)%.*$/, "");
    for (const token of line.matchAll(/\\(begin|end)\s*\{(itemize|enumerate|description)\}|\\item\b/g)) {
      if (token[0].startsWith("\\item") && listDepth === 0) return index + 1;
      if (token[1] === "begin") listDepth += 1;
      if (token[1] === "end") listDepth = Math.max(0, listDepth - 1);
    }
  }
  return 0;
}

function likelyMissingItemLine(latex) {
  const source = String(latex || "");
  const environment = /\\begin\s*\{(itemize|enumerate|description)\}([\s\S]*?)\\end\s*\{\1\}/g;
  for (const match of source.matchAll(environment)) {
    if (!/\\item\b/.test(match[2])) {
      const prefix = source.slice(0, match.index + match[0].lastIndexOf("\\end"));
      return prefix.split(/\r?\n/).length;
    }
  }
  return 0;
}

function detailWithSourceContext(log, latex, line) {
  const context = sourceContext(latex, line);
  if (!context) return log;
  return [`Source context:\n${context}`, log ? `Compiler output:\n${log}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_DETAIL_CHARACTERS);
}

function sourceContext(latex, line) {
  if (!line) return "";
  const lines = String(latex || "").split(/\r?\n/);
  if (line < 1 || line > lines.length) return "";
  const first = Math.max(1, line - 2);
  const last = Math.min(lines.length, line + 2);
  const width = String(last).length;
  const context = [];
  for (let number = first; number <= last; number += 1) {
    const marker = number === line ? ">" : " ";
    const value = lines[number - 1]
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .slice(0, MAX_SOURCE_LINE_CHARACTERS);
    context.push(`${marker} ${String(number).padStart(width, " ")} | ${value}`);
  }
  return context.join("\n");
}

function positiveLineNumber(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}
