import { SUPPORTED_LATEX_PACKAGES } from "@/compiler/supported-packages.mjs";
import { findLatexListIssues } from "@/compiler/latex-structure.mjs";

const dangerousLatexPatterns: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "shell escape",
    pattern: /\\(?:immediate\s*\\)?write\s*18\b/i,
  },
  {
    label: "shell escape macro",
    pattern: /\\(?:ShellEscape|DelayedShellEscape|luaexec)\b/i,
  },
  {
    label: "shell-enabled package",
    pattern:
      /\\usepackage(?:\s*\[[^\]]*\])?\s*\{[^}]*\b(?:shellesc|minted|pythontex|sagetex|catchfile)\b[^}]*\}/i,
  },
  {
    label: "Lua execution",
    pattern: /\\(?:directlua|latelua)\b/i,
  },
  {
    label: "file or stream access",
    pattern:
      /\\(?:input|include|openin|openout|newread|newwrite|read|readline|write|lstinputlisting|verbatiminput|CatchFileDef)\b/i,
  },
  {
    label: "file creation",
    pattern: /\\begin\s*\{\s*filecontents\*?\s*\}/i,
  },
  {
    label: "TeX metaprogramming",
    pattern: /\\(?:catcode|csname|endcsname|everyjob|everyeof)\b/i,
  },
  {
    label: "driver-level primitive",
    pattern: /\\(?:special|pdfliteral|pdfobj|pdfannot)\b/i,
  },
  {
    label: "active external link",
    pattern: /\\(?:href|url)\s*\{\s*(?:run|file|javascript)\s*:/i,
  },
];

const compileOnlyDangerousLatexPatterns: Array<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "external bibliography file",
    pattern: /\\(?:bibliography|addbibresource)\b/i,
  },
  {
    label: "dynamic class or package loader",
    pattern: /\\(?:RequirePackage|LoadClass|documentstyle)\b/i,
  },
  {
    label: "driver-level file primitive",
    pattern: /\\(?:pdfximage|pdfrefximage|pdfattachment)\b/i,
  },
  {
    label: "arbitrary graphics path",
    pattern: /\\(?:graphicspath|DeclareGraphicsExtensions|includepdf|attachfile)\b/i,
  },
];

export const ALLOWED_LATEX_DOCUMENT_CLASSES = [
  "article",
  "IEEEtran",
  "acmart",
  "llncs",
  "elsarticle",
] as const;

const allowedDocumentClasses = new Set<string>(
  ALLOWED_LATEX_DOCUMENT_CLASSES,
);

export const ALLOWED_LATEX_PACKAGES = SUPPORTED_LATEX_PACKAGES;

const allowedLatexPackages = new Set<string>(ALLOWED_LATEX_PACKAGES);

export const COMPILE_ASSET_MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
} as const;

export type CompileAssetMimeType =
  (typeof COMPILE_ASSET_MIME_BY_EXTENSION)[keyof typeof COMPILE_ASSET_MIME_BY_EXTENSION];

export function safeFileName(fileName: string) {
  return (
    fileName.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) ||
    "attachment"
  );
}

export function fileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function hasValidBinarySignature(
  extension: string,
  bytes: Uint8Array,
) {
  if (extension === "pdf") {
    return hasBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  }
  if (extension === "png") {
    return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (extension === "jpg" || extension === "jpeg") {
    return hasBytes(bytes, [0xff, 0xd8, 0xff]);
  }
  if (extension === "webp") {
    return (
      hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    );
  }
  return false;
}

export function latexForInspection(latex: string) {
  const uncommented = latex
    .split(/\r?\n/)
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
        if (slashes % 2 === 0) return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
  return uncommented.replaceAll(/\s+/g, " ").trim();
}

export function assertSafeLatex(
  latex: string,
  subject = "The model returned LaTeX that",
) {
  const inspectable = latexForInspection(latex);
  const blocked = dangerousLatexPatterns.find(({ pattern }) =>
    pattern.test(inspectable),
  );
  if (blocked) {
    throw new Error(
      `${subject} contains a blocked ${blocked.label} primitive. Please retry the generation.`,
    );
  }
}

function commandCount(source: string, command: string) {
  return Array.from(source.matchAll(new RegExp(`\\\\${command}\\b`, "g"))).length;
}

export function latexGraphicFileNames(latex: string) {
  const source = latexForInspection(latex);
  const graphicCommandCount = commandCount(source, "includegraphics");
  const graphicMatches = Array.from(
    source.matchAll(
      /\\includegraphics(?:\s*\[[^\]{}]{0,1000}\])?\s*\{\s*([^{}]+?)\s*\}/g,
    ),
  );
  if (graphicMatches.length !== graphicCommandCount) {
    throw new Error(
      "Every \\includegraphics command must use one plain uploaded filename.",
    );
  }
  return graphicMatches.map((match) => match[1].trim());
}

export function assertCompilableLatex(
  latex: string,
  assetFileNames: readonly string[] = [],
  options: { checkListStructure?: boolean } = {},
) {
  assertSafeLatex(latex, "The LaTeX source");
  const source = latexForInspection(latex);
  const compileOnlyBlocked = compileOnlyDangerousLatexPatterns.find(
    ({ pattern }) => pattern.test(source),
  );
  if (compileOnlyBlocked) {
    throw new Error(
      `The LaTeX source contains a blocked ${compileOnlyBlocked.label} primitive. Use a self-contained paper and retry.`,
    );
  }

  const documentClassCount = commandCount(source, "documentclass");
  const documentClassMatch = source.match(
    /\\documentclass(?:\s*\[[a-zA-Z0-9,=._ -]{0,240}\])?\s*\{\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*\}/,
  );
  if (documentClassCount !== 1 || !documentClassMatch) {
    throw new Error(
      "The LaTeX source must contain exactly one plain \\documentclass declaration.",
    );
  }

  const documentClass = documentClassMatch[1];
  if (!allowedDocumentClasses.has(documentClass)) {
    throw new Error(
      `The document class ${documentClass} is not available. Use one of: ${ALLOWED_LATEX_DOCUMENT_CLASSES.join(", ")}.`,
    );
  }

  const beginMatches = Array.from(
    source.matchAll(/\\begin\s*\{\s*document\s*\}/g),
  );
  const endMatches = Array.from(
    source.matchAll(/\\end\s*\{\s*document\s*\}/g),
  );
  if (beginMatches.length !== 1 || endMatches.length !== 1) {
    throw new Error(
      "The LaTeX source must contain exactly one document environment.",
    );
  }

  const classIndex = documentClassMatch.index ?? -1;
  const beginIndex = beginMatches[0].index ?? -1;
  const endIndex = endMatches[0].index ?? -1;
  if (
    classIndex < 0 ||
    beginIndex <= classIndex ||
    endIndex <= beginIndex ||
    source.slice(0, classIndex).trim() ||
    source.slice(endIndex + endMatches[0][0].length).trim()
  ) {
    throw new Error(
      "The LaTeX source must be one complete document with no executable content outside it.",
    );
  }

  if (options.checkListStructure !== false) {
    const listIssue = findLatexListIssues(latex)[0];
    if (listIssue) {
      throw new Error(
        `The LaTeX ${listIssue.environment} list near line ${listIssue.line} is malformed. ${listIssue.action}`,
      );
    }
  }

  const packageCommandCount = commandCount(source, "usepackage");
  const packageMatches = Array.from(
    source.matchAll(
      /\\usepackage(?:\s*\[[^\]{}]{0,500}\])?\s*\{\s*([^{}]+?)\s*\}/g,
    ),
  );
  if (packageMatches.length !== packageCommandCount) {
    throw new Error("Every \\usepackage command must use a plain package name.");
  }
  for (const match of packageMatches) {
    const packageNames = match[1].split(",").map((name) => name.trim());
    if (
      packageNames.length === 0 ||
      packageNames.some(
        (name) => !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name),
      )
    ) {
      throw new Error(
        "Package paths and computed package names are not allowed in PDF compilation.",
      );
    }
    const unsupportedPackages = [
      ...new Set(
        packageNames.filter((name) => !allowedLatexPackages.has(name)),
      ),
    ];
    if (unsupportedPackages.length) {
      throw new Error(
        `The LaTeX ${unsupportedPackages.length === 1 ? "package" : "packages"} ${unsupportedPackages.join(", ")} ${unsupportedPackages.length === 1 ? "is" : "are"} not available in Scholar Flow's cached compiler. Use only: ${ALLOWED_LATEX_PACKAGES.join(", ")}.`,
      );
    }
  }

  const graphicFileNames = latexGraphicFileNames(latex);
  const availableAssets = new Set(assetFileNames);
  for (const fileName of graphicFileNames) {
    if (fileName !== safeFileName(fileName) || !availableAssets.has(fileName)) {
      throw new Error(
        `The LaTeX source references ${fileName || "an empty filename"}, but that exact safe asset was not supplied.`,
      );
    }
  }
}
