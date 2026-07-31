import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPublicationLatexContract,
  getPublicationLatexContract,
  publicationLatexContractIssues,
} from "../publication-template.mjs";

const compilerDirectory = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);

async function fixture(name) {
  return readFile(path.join(compilerDirectory, "fixtures", name), "utf8");
}

const publisherFixtures = [
  ["ieee-igarss-2026", "IEEE IGARSS", "10-ieeetran.tex"],
  ["acm-sigconf", "ACM SIGCONF", "20-acmart.tex"],
  ["springer-lncs", "Springer LNCS", "30-llncs.tex"],
  ["elsevier-research-article", "Elsevier", "40-elsarticle.tex"],
];

test("accepts every checked-in publisher fixture under its own contract", async () => {
  for (const [profileId, label, fileName] of publisherFixtures) {
    const latex = await fixture(fileName);
    assert.doesNotThrow(() =>
      assertPublicationLatexContract(
        latex,
        getPublicationLatexContract(profileId),
        label,
      ),
    );
  }
});

test("rejects every publisher fixture under a different class contract", async () => {
  for (let index = 0; index < publisherFixtures.length; index += 1) {
    const [, , fileName] = publisherFixtures[index];
    const [wrongProfileId, wrongLabel] =
      publisherFixtures[(index + 1) % publisherFixtures.length];
    const issues = publicationLatexContractIssues(
      await fixture(fileName),
      getPublicationLatexContract(wrongProfileId),
      wrongLabel,
    );
    assert.match(issues.join("\n"), /requires \\documentclass/);
  }
});

test("requires the IEEE conference class option", () => {
  const latex = String.raw`\documentclass{IEEEtran}
\title{Test}
\begin{document}
\maketitle
\begin{abstract}Synthetic abstract.\end{abstract}
\section{One}Text.
\end{document}`;
  assert.match(
    publicationLatexContractIssues(
      latex,
      getPublicationLatexContract("ieee-igarss-2026"),
      "IEEE IGARSS",
    ).join("\n"),
    /requires the document class option conference/,
  );
});

test("allows abstract before or after maketitle when both precede sections", async () => {
  const acm = await fixture("20-acmart.tex");
  const ieee = await fixture("10-ieeetran.tex");
  assert.deepEqual(
    publicationLatexContractIssues(
      acm,
      getPublicationLatexContract("acm-sigconf"),
      "ACM",
    ),
    [],
  );
  assert.deepEqual(
    publicationLatexContractIssues(
      ieee,
      getPublicationLatexContract("ieee-igarss-2026"),
      "IEEE",
    ),
    [],
  );
});

test("requires complete Elsevier frontmatter before the first section", () => {
  const missing = String.raw`\documentclass{elsarticle}
\title{Test}
\begin{document}
\begin{abstract}Synthetic abstract.\end{abstract}
\section{One}Text.
\end{document}`;
  assert.match(
    publicationLatexContractIssues(
      missing,
      getPublicationLatexContract("elsevier-research-article"),
      "Elsevier",
    ).join("\n"),
    /requires one frontmatter environment/,
  );

  const misplaced = String.raw`\documentclass{elsarticle}
\title{Outside}
\begin{document}
\begin{frontmatter}
\end{frontmatter}
\begin{abstract}Outside frontmatter.\end{abstract}
\section{One}Text.
\end{document}`;
  const issues = publicationLatexContractIssues(
    misplaced,
    getPublicationLatexContract("elsevier-research-article"),
    "Elsevier",
  ).join("\n");
  assert.match(issues, /title declaration must be inside/);
  assert.match(issues, /abstract must be entirely inside/);
});

test("requires title, abstract, and maketitle before the first section", () => {
  const latex = String.raw`\documentclass{article}
\begin{document}
\section{One}Text.
\title{Late title}
\begin{abstract}Late abstract.\end{abstract}
\maketitle
\end{document}`;
  const issues = publicationLatexContractIssues(
    latex,
    getPublicationLatexContract("custom-publication"),
    "Custom publication",
  ).join("\n");
  assert.match(issues, /abstract must be complete before/);
  assert.match(issues, /maketitle command must appear before/);
});

test("does not accept fake wrappers in comments, literal content, or macros", () => {
  const latex = String.raw`\documentclass{article}
\title{Test}
\newcommand{\fake}{\maketitle}
\begin{document}
\begin{abstract}Synthetic abstract.\end{abstract}
% \maketitle
\verb|\maketitle|
\lstinline|\maketitle|
\begin{verbatim}
\maketitle
\end{verbatim}
\\maketitle
\section{One}Text.
\end{document}`;
  assert.match(
    publicationLatexContractIssues(
      latex,
      getPublicationLatexContract("custom-publication"),
      "Custom publication",
    ).join("\n"),
    /requires exactly one direct \\maketitle/,
  );
});

test("accepts a complete custom article fallback", () => {
  const latex = String.raw`\documentclass{article}
\title{Synthetic Review}
\begin{document}
\maketitle
\begin{abstract}Synthetic abstract.\end{abstract}
\section{Scope}Test material only.
\end{document}`;
  assert.deepEqual(
    publicationLatexContractIssues(
      latex,
      getPublicationLatexContract("custom-publication"),
      "Custom publication",
    ),
    [],
  );
});
