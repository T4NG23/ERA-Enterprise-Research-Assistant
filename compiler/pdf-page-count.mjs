import { inspectLatexEnvironment } from "./publication-template.mjs";

const TECTONIC_PAGE_COUNT_PATTERN =
  /Output written on .+?\((\d{1,5}) pages?(?:,|\))/gi;
const CONTENT_BOUNDARY = String.raw`\clearpage
% Scholar Flow audit: self-contained references omitted from this audit-only compile.
`;

export function tectonicPageCount(log) {
  if (typeof log !== "string" || !log) return null;
  let pageCount = null;
  for (const match of log.matchAll(TECTONIC_PAGE_COUNT_PATTERN)) {
    const candidate = Number(match[1]);
    if (Number.isSafeInteger(candidate) && candidate >= 1 && candidate <= 10_000) {
      pageCount = candidate;
    }
  }
  return pageCount;
}

export function buildContentPageAuditLatex(latex) {
  if (typeof latex !== "string" || !latex.trim()) {
    throw new Error("A LaTeX document is required for the page audit.");
  }
  const source = latex.replaceAll(/\r\n?/g, "\n");
  const bibliography = inspectLatexEnvironment(source, "thebibliography");
  if (
    bibliography.beginCount > 1 ||
    bibliography.endCount > 1 ||
    bibliography.beginCount !== bibliography.endCount
  ) {
    throw new Error(
      "The page audit requires zero or one balanced thebibliography environment.",
    );
  }
  const document = inspectLatexEnvironment(source, "document");
  if (document.beginCount !== 1 || document.endCount !== 1 || !document.range) {
    throw new Error(
      "The page audit requires exactly one balanced document environment.",
    );
  }
  if (!bibliography.range) return source;

  const trailingContent = source
    .slice(bibliography.range.end, document.range.contentEnd)
    .trim();
  if (trailingContent) {
    throw new Error(
      "The page audit cannot verify a document with technical content after the bibliography.",
    );
  }

  return `${source.slice(0, bibliography.range.start)}${CONTENT_BOUNDARY}${source.slice(bibliography.range.end)}`;
}
