import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { diagnoseCompilerResult } from "../diagnostics.mjs";

const fixture = (name) =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

test("reports a missing item with exact source context", async () => {
  const latex = await fixture("missing-item.tex");
  const diagnostic = diagnoseCompilerResult({
    exitCode: 1,
    output: [
      "note: Running TeX ...",
      "error: manuscript.tex:6: LaTeX Error: Something's wrong--perhaps a missing \\item.",
      "error: halted on potentially-recoverable error as specified",
    ].join("\n"),
    latex,
  });

  assert.equal(diagnostic.code, "LATEX_LIST_ERROR");
  assert.match(diagnostic.message, /missing an \\item near source line 6/);
  assert.match(diagnostic.detail, /> 6 \| \\end\{itemize\}/);
});

test("reports an item outside a list with exact source context", async () => {
  const latex = await fixture("lonely-item.tex");
  const diagnostic = diagnoseCompilerResult({
    exitCode: 1,
    output:
      "error: manuscript.tex:4: LaTeX Error: Lonely \\item--perhaps a missing list environment.",
    latex,
  });

  assert.equal(diagnostic.code, "LATEX_LIST_ERROR");
  assert.match(diagnostic.message, /outside a list near source line 4/);
  assert.match(diagnostic.detail, /> 4 \| \\item This item/);
});

test("does not treat Underfull or Overfull box warnings as fatal after a successful exit", () => {
  const diagnostic = diagnoseCompilerResult({
    exitCode: 0,
    output: [
      "warning: manuscript.tex:9: Underfull \\hbox (badness 10000)",
      "warning: manuscript.tex:12: Overfull \\hbox (2.0pt too wide)",
    ].join("\n"),
    latex: "irrelevant",
  });

  assert.equal(diagnostic, null);
});

test("keeps the package-cache remediation and redacts known job paths", () => {
  const diagnostic = diagnoseCompilerResult({
    exitCode: 1,
    output:
      "/private/tmp/job/manuscript.tex:3: LaTeX Error: File `amssymb.sty' not found.",
    latex: "\\documentclass{article}\n\\begin{document}\n\\end{document}",
    jobDirectory: "/private/tmp/job",
  });

  assert.equal(diagnostic.code, "COMPILE_CACHE_MISS");
  assert.match(diagnostic.message, /npm run pdf:setup/);
  assert.doesNotMatch(diagnostic.detail, /\/private\/tmp\/job/);
});

test("reports an uncached font metric as a cache miss", () => {
  const diagnostic = diagnoseCompilerResult({
    exitCode: 1,
    output:
      "error: manuscript.tex:12: Font TU/lmtt/m/n/9=[lmmono9-regular]: at 9.0pt not loadable: Metric (TFM) file or installed font not found",
    latex: "\\documentclass{article}\n\\begin{document}\n\\end{document}",
  });

  assert.equal(diagnostic.code, "COMPILE_CACHE_MISS");
  assert.match(diagnostic.message, /lmmono9-regular font resources/);
  assert.match(diagnostic.message, /npm run pdf:setup/);
});

test("reports a missing ACM affiliation country with the actual error line", () => {
  const latex = String.raw`\documentclass[sigconf]{acmart}
\begin{document}
\author{Synthetic Author}
\affiliation{\institution{Synthetic Institution}}
\begin{abstract}Synthetic abstract.\end{abstract}
\maketitle
\end{document}`;
  const diagnostic = diagnoseCompilerResult({
    exitCode: 1,
    output: [
      "warning: manuscript.tex:2: Requested font example",
      "error: manuscript.tex:6: Class acmart Error: No country present for an affiliation.",
      "error: halted on potentially-recoverable error as specified",
    ].join("\n"),
    latex,
  });

  assert.equal(diagnostic.code, "ACM_AFFILIATION_COUNTRY_MISSING");
  assert.match(diagnostic.message, /required \\country/);
  assert.match(diagnostic.message, /source line 6/);
  assert.match(diagnostic.detail, /> 6 \| \\maketitle/);
});
