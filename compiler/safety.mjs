import { Buffer } from "node:buffer";
import path from "node:path";
import { findLatexListIssues } from "./latex-structure.mjs";
import { SUPPORTED_LATEX_PACKAGES } from "./supported-packages.mjs";

export const LIMITS = Object.freeze({
  requestBytes: 18 * 1024 * 1024,
  latexBytes: 750 * 1024,
  assetCount: 12,
  assetBytes: 7 * 1024 * 1024,
  assetsTotalBytes: 12 * 1024 * 1024,
  pdfBytes: 24 * 1024 * 1024,
  compilerLogBytes: 64 * 1024,
  compileTimeoutMs: 45_000,
});

const assetTypes = Object.freeze({
  "image/png": new Set([".png"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "application/pdf": new Set([".pdf"]),
});

const allowedDocumentClasses = new Set([
  "article",
  "IEEEtran",
  "acmart",
  "llncs",
  "elsarticle",
]);
const allowedLatexPackages = new Set(SUPPORTED_LATEX_PACKAGES);

const blockedLatex = [
  ["file input", /\\(?:input|include|subfile|InputIfFileExists|IfFileExists)\s*(?:\{|\b)/],
  ["file output", /\\(?:openout|openin|read|write|newwrite|newread)\b/],
  ["shell execution", /\\(?:write18|ShellEscape|sys_if_shell)\b/i],
  ["Lua execution", /\\(?:directlua|luaexec|luadirect|latelua)\b/i],
  ["external bibliography", /\\(?:bibliography|addbibresource)\s*(?:\[|\{)/i],
  ["embedded file creation", /\\begin\s*\{filecontents\*?\}/i],
  ["raw PDF objects", /\\(?:pdfobj|pdfannot|pdfcatalog|pdfstartlink|pdfxform)\b/i],
  ["driver specials", /\\special\s*\{/i],
  ["package loading primitives", /\\(?:RequirePackage|LoadClass|documentstyle)\b/],
  ["unsafe URL scheme", /(?:javascript|data|file):/i],
];

export class ValidationError extends Error {
  constructor(message, code = "INVALID_REQUEST", status = 400) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.status = status;
  }
}

export function stripLatexComments(source) {
  return source
    .split(/\r?\n/)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== "%") continue;
        let backslashes = 0;
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
          backslashes += 1;
        }
        if (backslashes % 2 === 0) return line.slice(0, index);
      }
      return line;
    })
    .join("\n");
}

export function validateLatex(latex) {
  if (typeof latex !== "string") {
    throw new ValidationError("latex must be a string.", "INVALID_LATEX");
  }

  const bytes = Buffer.byteLength(latex, "utf8");
  if (bytes === 0 || bytes > LIMITS.latexBytes) {
    throw new ValidationError(
      `latex must be between 1 byte and ${LIMITS.latexBytes} bytes.`,
      "LATEX_TOO_LARGE",
      413,
    );
  }
  if (latex.includes("\0")) {
    throw new ValidationError("latex contains a null byte.", "INVALID_LATEX");
  }

  const source = stripLatexComments(latex);
  const classMatches = [...source.matchAll(/\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g)];
  if (classMatches.length !== 1) {
    throw new ValidationError(
      "latex must contain exactly one document class declaration.",
      "INVALID_LATEX_STRUCTURE",
      422,
    );
  }
  const documentClass = classMatches[0][1].trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(documentClass)) {
    throw new ValidationError(
      "The document class must be a package name, not a path.",
      "UNSAFE_LATEX",
      422,
    );
  }
  if (!allowedDocumentClasses.has(documentClass)) {
    throw new ValidationError(
      "The document class is not one of: article, IEEEtran, acmart, llncs, or elsarticle.",
      "UNSUPPORTED_DOCUMENT_CLASS",
      422,
    );
  }

  const begins = source.match(/\\begin\s*\{document\}/g)?.length ?? 0;
  const ends = source.match(/\\end\s*\{document\}/g)?.length ?? 0;
  if (begins !== 1 || ends !== 1) {
    throw new ValidationError(
      "latex must contain exactly one document environment.",
      "INVALID_LATEX_STRUCTURE",
      422,
    );
  }

  const listIssue = findLatexListIssues(latex)[0];
  if (listIssue) {
    throw new ValidationError(
      `The ${listIssue.environment} list near line ${listIssue.line} is malformed. ${listIssue.action}`,
      "INVALID_LATEX_LIST",
      422,
    );
  }

  for (const [label, pattern] of blockedLatex) {
    if (pattern.test(source)) {
      throw new ValidationError(
        `latex uses a blocked ${label} command.`,
        "UNSAFE_LATEX",
        422,
      );
    }
  }

  const packageCommandCount = source.match(/\\usepackage\b/g)?.length ?? 0;
  const packageMatches = [
    ...source.matchAll(
      /\\usepackage(?:\s*\[[^\]{}]{0,500}\])?\s*\{\s*([^{}]+?)\s*\}/g,
    ),
  ];
  if (packageMatches.length !== packageCommandCount) {
    throw new ValidationError(
      "Every package command must use plain supported package names.",
      "UNSAFE_LATEX",
      422,
    );
  }
  for (const match of packageMatches) {
    const packages = match[1].split(",").map((value) => value.trim());
    if (packages.some((name) => !/^[A-Za-z0-9_-]{1,64}$/.test(name))) {
      throw new ValidationError(
        "Package names cannot contain paths or file extensions.",
        "UNSAFE_LATEX",
        422,
      );
    }
    const unsupported = [
      ...new Set(packages.filter((name) => !allowedLatexPackages.has(name))),
    ];
    if (unsupported.length) {
      throw new ValidationError(
        `Unsupported cached LaTeX ${unsupported.length === 1 ? "package" : "packages"}: ${unsupported.join(", ")}.`,
        "UNSUPPORTED_LATEX_PACKAGE",
        422,
      );
    }
  }

  for (const match of source.matchAll(/\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    const name = match[1].trim();
    if (!isSafeAssetReference(name)) {
      throw new ValidationError(
        "Figure references must use a plain uploaded filename.",
        "UNSAFE_LATEX",
        422,
      );
    }
  }

  return source;
}

export function validateAndDecodeAssets(rawAssets) {
  if (rawAssets === undefined) return [];
  if (!Array.isArray(rawAssets)) {
    throw new ValidationError("assets must be an array.", "INVALID_ASSETS");
  }
  if (rawAssets.length > LIMITS.assetCount) {
    throw new ValidationError(
      `No more than ${LIMITS.assetCount} assets can be compiled at once.`,
      "TOO_MANY_ASSETS",
      413,
    );
  }

  const names = new Set();
  let totalBytes = 0;
  return rawAssets.map((asset) => {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw new ValidationError("Each asset must be an object.", "INVALID_ASSET");
    }
    const { name, mimeType, dataBase64 } = asset;
    validateAssetName(name);
    if (typeof mimeType !== "string" || !assetTypes[mimeType]) {
      throw new ValidationError(
        `Unsupported asset type for ${name}. Use PNG, JPEG, or PDF.`,
        "UNSUPPORTED_ASSET",
        415,
      );
    }

    const extension = path.extname(name).toLowerCase();
    if (!assetTypes[mimeType].has(extension)) {
      throw new ValidationError(
        `The filename extension for ${name} does not match its media type.`,
        "INVALID_ASSET",
      );
    }

    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new ValidationError(`Duplicate asset filename: ${name}.`, "DUPLICATE_ASSET");
    }
    names.add(normalizedName);

    const data = decodeBase64(dataBase64, name);
    if (data.length === 0 || data.length > LIMITS.assetBytes) {
      throw new ValidationError(
        `${name} must be between 1 byte and ${LIMITS.assetBytes} bytes.`,
        "ASSET_TOO_LARGE",
        413,
      );
    }
    totalBytes += data.length;
    if (totalBytes > LIMITS.assetsTotalBytes) {
      throw new ValidationError(
        `Assets exceed the ${LIMITS.assetsTotalBytes}-byte combined limit.`,
        "ASSETS_TOO_LARGE",
        413,
      );
    }
    assertMagic(data, mimeType, name);
    return { name, mimeType, data };
  });
}

export function validatePdf(data) {
  if (!Buffer.isBuffer(data) || data.length < 8 || data.length > LIMITS.pdfBytes) {
    throw new ValidationError(
      "The compiler did not produce a valid-size PDF.",
      "INVALID_COMPILER_OUTPUT",
      502,
    );
  }
  if (!data.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new ValidationError(
      "The compiler output does not have a PDF signature.",
      "INVALID_COMPILER_OUTPUT",
      502,
    );
  }
  const tail = data.subarray(Math.max(0, data.length - 2048)).toString("latin1");
  if (!tail.includes("%%EOF")) {
    throw new ValidationError(
      "The compiler output is incomplete.",
      "INVALID_COMPILER_OUTPUT",
      502,
    );
  }
}

export function safePdfName(title) {
  const base = typeof title === "string" ? title.normalize("NFKD") : "paper";
  const cleaned = base
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .trim()
    .replace(/[ _]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
  return `${cleaned || "paper"}.pdf`;
}

function validateAssetName(name) {
  if (
    typeof name !== "string" ||
    name.length > 120 ||
    path.basename(name) !== name ||
    name.startsWith(".") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ||
    name.includes("..")
  ) {
    throw new ValidationError(
      "Asset filenames may contain only letters, numbers, dots, underscores, and hyphens.",
      "INVALID_ASSET_NAME",
    );
  }
}

function isSafeAssetReference(name) {
  if (!name || name.length > 120 || path.basename(name) !== name || name.includes("..")) {
    return false;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function decodeBase64(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil((LIMITS.assetBytes * 4) / 3) + 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new ValidationError(`Invalid base64 data for ${name}.`, "INVALID_ASSET");
  }
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value) {
    throw new ValidationError(`Invalid base64 data for ${name}.`, "INVALID_ASSET");
  }
  return data;
}

function assertMagic(data, mimeType, name) {
  const valid =
    (mimeType === "image/png" &&
      data.length >= 8 &&
      data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (mimeType === "image/jpeg" &&
      data.length >= 4 &&
      data[0] === 0xff &&
      data[1] === 0xd8 &&
      data[2] === 0xff &&
      data[data.length - 2] === 0xff &&
      data[data.length - 1] === 0xd9) ||
    (mimeType === "application/pdf" &&
      data.length >= 8 &&
      data.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii")));

  if (!valid) {
    throw new ValidationError(
      `The contents of ${name} do not match ${mimeType}.`,
      "INVALID_ASSET_SIGNATURE",
      415,
    );
  }
}
