import "server-only";

export const MAX_CHAT_PDF_PAGES = 150;
export const MAX_CHAT_PDF_TEXT_CHARACTERS = 300_000;
export const MAX_CHAT_PDF_PARSE_MS = 30_000;
export const MAX_LARGE_CORPUS_PDF_PAGES = 600;
export const MAX_LARGE_CORPUS_PDF_TEXT_CHARACTERS = 4_000_000;
export const MAX_LARGE_CORPUS_PDF_PARSE_MS = 60_000;

export interface PdfTextExtractionLimits {
  maxPages: number;
  maxCharacters: number;
  parseMs: number;
}

export class PdfTextError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(message: string, code: string, httpStatus = 422) {
    super(message);
    this.name = "PdfTextError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function timeoutError(fileName: string) {
  return new PdfTextError(
    `${fileName} took too long to read. Try a smaller searchable PDF or export its text separately.`,
    "OCI_PDF_EXTRACTION_FAILED",
  );
}

async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
  fileName: string,
) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw timeoutError(fileName);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(timeoutError(fileName)), remaining);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function searchablePageText(items: unknown[]) {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const candidate = item as { str?: unknown; hasEOL?: unknown };
      if (typeof candidate.str !== "string") return "";
      return `${candidate.str}${candidate.hasEOL === true ? "\n" : " "}`;
    })
    .join("")
    .replaceAll(/[^\S\r\n]+/g, " ")
    .replaceAll(/ *\n */g, "\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

function isPasswordError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "PasswordException" ||
    candidate.code === 1 ||
    candidate.code === 2
  );
}

export async function extractPdfTextForChat(
  bytes: Uint8Array,
  fileName: string,
  limits: PdfTextExtractionLimits = {
    maxPages: MAX_CHAT_PDF_PAGES,
    maxCharacters: MAX_CHAT_PDF_TEXT_CHARACTERS,
    parseMs: MAX_CHAT_PDF_PARSE_MS,
  },
): Promise<{ text: string; pages: number }> {
  const maxPages = Math.min(
    MAX_LARGE_CORPUS_PDF_PAGES,
    Math.max(1, Math.floor(limits.maxPages)),
  );
  const maxCharacters = Math.min(
    MAX_LARGE_CORPUS_PDF_TEXT_CHARACTERS,
    Math.max(1, Math.floor(limits.maxCharacters)),
  );
  const parseMs = Math.min(
    MAX_LARGE_CORPUS_PDF_PARSE_MS,
    Math.max(1_000, Math.floor(limits.parseMs)),
  );
  const deadline = Date.now() + parseMs;
  let pdf: Awaited<ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>> | null =
    null;

  try {
    const { getDocumentProxy } = await import("unpdf");
    pdf = await beforeDeadline(
      getDocumentProxy(Uint8Array.from(bytes)),
      deadline,
      fileName,
    );

    if (pdf.numPages > maxPages) {
      throw new PdfTextError(
        `${fileName} has more than ${maxPages} pages. Split it into smaller PDFs before generating.`,
        "OCI_FALLBACK_PDF_LIMIT",
        413,
      );
    }

    const pages: string[] = [];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await beforeDeadline(pdf.getPage(pageNumber), deadline, fileName);
      try {
        const content = await beforeDeadline(
          page.getTextContent(),
          deadline,
          fileName,
        );
        const text = searchablePageText(content.items);
        const pagePart = `--- Page ${pageNumber} of ${pdf.numPages} ---\n${text}`;
        extractedCharacters += pagePart.length;
        if (extractedCharacters > maxCharacters) {
          throw new PdfTextError(
            `${fileName} contains more than ${maxCharacters.toLocaleString()} searchable characters. Split it into smaller PDFs before generating.`,
            "OCI_FALLBACK_PDF_LIMIT",
            413,
          );
        }
        pages.push(pagePart);
      } finally {
        page.cleanup();
      }
    }

    const text = pages.join("\n\n").trim();
    const searchableText = text.replaceAll(/--- Page \d+ of \d+ ---/g, "").trim();
    if (!searchableText) {
      throw new PdfTextError(
        `${fileName} contains no searchable text. Run OCR, export a searchable PDF or text file, and attach figures separately as PNG, JPG, or WebP.`,
        "OCI_PDF_TEXT_REQUIRED",
      );
    }

    return { text, pages: pdf.numPages };
  } catch (error) {
    if (error instanceof PdfTextError) throw error;
    if (isPasswordError(error)) {
      throw new PdfTextError(
        `${fileName} is password-protected. Attach an authorized, unlocked copy before generating.`,
        "OCI_PDF_PASSWORD_PROTECTED",
      );
    }
    throw new PdfTextError(
      `${fileName} could not be read as a searchable PDF. Re-export it or attach its text separately.`,
      "OCI_PDF_EXTRACTION_FAILED",
    );
  } finally {
    if (pdf) {
      try {
        await pdf.destroy();
      } catch {
        // The document has already been released as far as this request is concerned.
      }
    }
  }
}
