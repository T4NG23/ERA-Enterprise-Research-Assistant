import assert from "node:assert/strict";
import test from "node:test";

import {
  findLatexListIssues,
  repairLatexListStructure,
} from "../latex-structure.mjs";

test("leaves valid lists and bibliographies unchanged", () => {
  const latex = String.raw`\begin{itemize}
  \item First
  \item Second
\end{itemize}
\begin{thebibliography}{1}
  \bibitem{verified} Verified reference.
\end{thebibliography}`;

  assert.deepEqual(findLatexListIssues(latex), []);
  assert.deepEqual(repairLatexListStructure(latex), { latex, repairs: [] });
});

test("inserts one item before plain generated list text", () => {
  const latex = String.raw`Before
\begin{itemize}
  Generated text without an item marker.
\end{itemize}
After`;

  const repaired = repairLatexListStructure(latex);
  assert.equal(repaired.repairs.length, 1);
  assert.equal(repaired.repairs[0].environment, "itemize");
  assert.equal(repaired.repairs[0].line, 3);
  assert.match(repaired.latex, /  \\item Generated text/);
  assert.deepEqual(repairLatexListStructure(repaired.latex), {
    latex: repaired.latex,
    repairs: [],
  });
});

test("does not rewrite a valid control-sequence prefix", () => {
  const latex = String.raw`\begin{enumerate}
  \setcounter{enumi}{3}
  \item Fourth entry.
\end{enumerate}`;

  assert.deepEqual(findLatexListIssues(latex), []);
  assert.deepEqual(repairLatexListStructure(latex), { latex, repairs: [] });
});

test("removes a completely empty list", () => {
  const latex = String.raw`A
\begin{description}
  % no entries yet
\end{description}
B`;

  const repaired = repairLatexListStructure(latex);
  assert.equal(repaired.repairs[0].action, "Removed the empty description environment.");
  assert.doesNotMatch(repaired.latex, /description/);
  assert.match(repaired.latex, /^A\n\nB$/);
});

test("reports raw bibliography text without inventing citation keys", () => {
  const latex = String.raw`\begin{thebibliography}{99}
  Verified reference text.
\end{thebibliography}`;

  const repaired = repairLatexListStructure(latex);
  assert.equal(repaired.latex, latex);
  assert.deepEqual(repaired.repairs, []);
  const issues = findLatexListIssues(latex);
  assert.equal(issues[0].environment, "thebibliography");
  assert.match(issues[0].action, /will not guess citation boundaries or keys/);
});

test("allows a bibliography control-sequence preamble before its first entry", () => {
  const latex = String.raw`\begin{thebibliography}{1}
  \providecommand{\url}[1]{#1}
  \bibitem{verified} Verified reference.
\end{thebibliography}`;

  assert.deepEqual(findLatexListIssues(latex), []);
  assert.deepEqual(repairLatexListStructure(latex), { latex, repairs: [] });
});

test("inserts an item for visible text before an existing first item", () => {
  const latex = String.raw`\begin{itemize}[noitemsep]
  Introductory list text.
  \item Existing entry.
\end{itemize}`;

  const repaired = repairLatexListStructure(latex);
  assert.equal(repaired.repairs.length, 1);
  assert.match(repaired.latex, /\[noitemsep\]\n  \\item Introductory/);
  assert.match(repaired.latex, /\\item Existing entry/);
});

test("leaves lonely items to TeX so custom list macros are not rejected", () => {
  const latex = String.raw`Text
\item Outside a list.`;

  assert.deepEqual(findLatexListIssues(latex), []);
  assert.deepEqual(repairLatexListStructure(latex), { latex, repairs: [] });
});

test("ignores comments, verbatim, inline code, and escaped command slashes", () => {
  const latex = String.raw`% \begin{itemize} hidden
\begin{verbatim}
\item literal code
\end{verbatim}
\verb|\item|
\lstinline|\item|
\\item is rendered text, not a list command.`;

  assert.deepEqual(findLatexListIssues(latex), []);
});

test("uses TeX control-word boundaries and supports core and starred lists", () => {
  const latex = String.raw`\begin{list}{}{\setlength{\leftmargin}{1em}}
  \item1 Core list entry.
\end{list}
\begin{itemize*}
  \item Inline entry.
\end{itemize*}`;

  assert.deepEqual(findLatexListIssues(latex), []);
  assert.deepEqual(repairLatexListStructure(latex), { latex, repairs: [] });
});

test("does not delete a label-only list", () => {
  const latex = String.raw`\begin{itemize}
  \label{kept-label}
\end{itemize}`;

  assert.deepEqual(repairLatexListStructure(latex), { latex, repairs: [] });
});

test("scans thousands of valid lists within a bounded test window", { timeout: 2_000 }, () => {
  const list = String.raw`\begin{itemize}\item Valid entry.\end{itemize}
`;
  assert.deepEqual(findLatexListIssues(list.repeat(6_000)), []);
});
