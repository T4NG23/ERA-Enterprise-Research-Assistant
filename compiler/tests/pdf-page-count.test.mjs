import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildContentPageAuditLatex,
  tectonicPageCount,
} from "../pdf-page-count.mjs";

const compilerSource = readFileSync(
  new URL("../server.mjs", import.meta.url),
  "utf8",
);

test("preserves Tectonic intermediates for both reliable page-count logs", () => {
  assert.equal(
    [...compilerSource.matchAll(/"--keep-intermediates"/gu)].length,
    2,
  );
  assert.match(
    compilerSource,
    /finally \{\s+await fs\.rm\(jobDirectory, \{ recursive: true, force: true \}\)/u,
  );
});

test("parses bounded Tectonic total and content page measurements", () => {
  assert.equal(
    tectonicPageCount(
      "Output written on manuscript.xdv (4 pages, 1200 bytes).",
    ),
    4,
  );
  assert.equal(
    tectonicPageCount(
      "Output written on first.xdv (2 pages, 100 bytes).\nOutput written on second.xdv (5 pages, 200 bytes).",
    ),
    5,
  );
  assert.equal(tectonicPageCount("No output line"), null);
});

test("omits one real bibliography from the audit-only source", () => {
  const latex = String.raw`\documentclass{article}
\begin{document}
\section{Results}
Content.
% \begin{thebibliography}{9}
\begin{verbatim}
\begin{thebibliography}{9}
\end{verbatim}
\begin{thebibliography}{9}
\bibitem{x} Synthetic reference.
\end{thebibliography}
\end{document}`;
  const audited = buildContentPageAuditLatex(latex);

  assert.match(audited, /Scholar Flow audit:/);
  assert.doesNotMatch(audited, /\\bibitem\{x\}/);
  assert.match(audited, /\\begin\{verbatim\}[\s\S]*\\begin\{thebibliography\}/);
});

test("counts all document content when no bibliography exists", () => {
  const latex = String.raw`\documentclass{article}
\begin{document}
\section{Conclusion}
Content.
\end{document}`;
  const audited = buildContentPageAuditLatex(latex);

  assert.equal(audited, latex);
});

test("fails closed when technical content follows the bibliography", () => {
  const latex = String.raw`\documentclass{article}
\begin{document}
\section{Results}
Content.
\begin{thebibliography}{9}
\bibitem{x} One.
\end{thebibliography}
\section{Late appendix}
More technical content.
\end{document}`;

  assert.throws(
    () => buildContentPageAuditLatex(latex),
    /technical content after the bibliography/,
  );
});

test("fails closed for ambiguous bibliography boundaries", () => {
  const latex = String.raw`\documentclass{article}
\begin{document}
\begin{thebibliography}{9}
\bibitem{x} One.
\end{thebibliography}
\begin{thebibliography}{9}
\bibitem{y} Two.
\end{thebibliography}
\end{document}`;

  assert.throws(
    () => buildContentPageAuditLatex(latex),
    /zero or one balanced thebibliography/,
  );
});
