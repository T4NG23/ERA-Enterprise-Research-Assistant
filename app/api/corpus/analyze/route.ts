import { NextResponse } from "next/server";

import {
  CORPUS_ARTIFACT_MAX_TTL_SECONDS,
  signCorpusArtifactToken,
} from "@/lib/corpus-artifact.mjs";
import {
  getAiProviderSelection,
  getAiSigningRuntime,
} from "@/lib/ai-provider-runtime";
import { buildLargeCorpusEvidencePacket } from "@/lib/large-corpus.mjs";
import { safeFileName } from "@/lib/latex-safety";
import {
  extractPdfTextForChat,
  MAX_LARGE_CORPUS_PDF_PAGES,
  MAX_LARGE_CORPUS_PDF_PARSE_MS,
  MAX_LARGE_CORPUS_PDF_TEXT_CHARACTERS,
  PdfTextError,
} from "@/lib/pdf-text";

export const runtime = "edge";

const MAX_REQUEST_BYTES = 44 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 12;
const MAX_PDF_FILES = 10;
const MAX_SEARCHABLE_TEXT_CHARACTERS = 5_000_000;
const OCI_PACKET_CHARACTERS = 40_000;
const LOCAL_MAX_PACKET_CHARACTERS = 20_000;
const LOCAL_MIN_PACKET_CHARACTERS = 12_000;
const MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS = 80_000;
const MAX_COMBINED_EVIDENCE_CHARACTERS = 120_000;
const LOCAL_MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS = 20_000;
const LOCAL_MAX_COMBINED_EVIDENCE_CHARACTERS = 32_000;
const MAX_CONCURRENT_ANALYSES = 1;

const FIELD_LIMITS = {
  title: 300,
  targetVenue: 240,
  submissionType: 120,
  manuscript: MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS,
} as const;

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "tex",
  "bib",
  "csv",
  "json",
]);
const SUPPORTED_EXTENSIONS = new Set(["pdf", ...TEXT_EXTENSIONS]);

interface SourceDocument {
  fileName: string;
  text: string;
}

interface CorpusAnalysisGuardState {
  active: number;
}

const guardGlobal = globalThis as typeof globalThis & {
  __scholarFlowCorpusAnalysisGuard?: CorpusAnalysisGuardState;
};
const corpusAnalysisGuard =
  guardGlobal.__scholarFlowCorpusAnalysisGuard ??
  (guardGlobal.__scholarFlowCorpusAnalysisGuard = { active: 0 });

class RequestTooLargeError extends Error {}
class InvalidContentLengthError extends Error {}

function takeCorpusAnalysisSlot() {
  if (corpusAnalysisGuard.active >= MAX_CONCURRENT_ANALYSES) return null;

  corpusAnalysisGuard.active += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      corpusAnalysisGuard.active = Math.max(0, corpusAnalysisGuard.active - 1);
    },
  };
}

function errorResponse(
  error: string,
  status: number,
  code: string,
  details?: string[],
) {
  return NextResponse.json(
    { error, code, ...(details?.length ? { details } : {}) },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function requestIsSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function parseMultipartFormData(request: Request, contentType: string) {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    if (!/^\d+$/.test(contentLengthHeader)) {
      throw new InvalidContentLengthError();
    }
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength)) {
      throw new InvalidContentLengthError();
    }
    if (contentLength > MAX_REQUEST_BYTES) {
      throw new RequestTooLargeError();
    }
  }

  if (!request.body) {
    throw new Error("The request body is missing.");
  }

  let totalBytes = 0;
  const limitedBody = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_REQUEST_BYTES) {
          controller.error(new RequestTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(limitedBody, {
    headers: { "Content-Type": contentType },
  }).formData();
}

function textField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function fileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLocaleLowerCase("en-US") ?? "";
}

function hasPdfSignature(bytes: Uint8Array) {
  return (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

function corpusPdfError(error: PdfTextError) {
  const codeByPdfError: Record<string, string> = {
    OCI_FALLBACK_PDF_LIMIT: "CORPUS_PDF_LIMIT",
    OCI_PDF_TEXT_REQUIRED: "CORPUS_NO_SEARCHABLE_EVIDENCE",
    OCI_PDF_PASSWORD_PROTECTED: "CORPUS_PDF_PASSWORD_PROTECTED",
    OCI_PDF_EXTRACTION_FAILED: "CORPUS_PDF_EXTRACTION_FAILED",
  };
  return errorResponse(
    error.message,
    error.httpStatus,
    codeByPdfError[error.code] ?? "CORPUS_PDF_EXTRACTION_FAILED",
  );
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return errorResponse(
      "Cross-origin corpus analysis requests are not allowed.",
      403,
      "ORIGIN_REJECTED",
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLocaleLowerCase("en-US").startsWith("multipart/form-data;") ||
    !/boundary=/i.test(contentType)
  ) {
    return errorResponse(
      "Expected a multipart form submission.",
      415,
      "INVALID_CONTENT_TYPE",
    );
  }

  const providerSelection = getAiProviderSelection();
  if (providerSelection === "invalid") {
    return errorResponse(
      "SCHOLAR_FLOW_AI_PROVIDER is required and must be exactly oci or local_llama.",
      503,
      "AI_PROVIDER_INVALID_CONFIGURATION",
    );
  }
  const localLlama = providerSelection === "local_llama";
  const corpusLimits = localLlama
    ? {
        maxManuscriptCharacters:
          LOCAL_MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS,
        minPacketCharacters: LOCAL_MIN_PACKET_CHARACTERS,
        maxPacketCharacters: LOCAL_MAX_PACKET_CHARACTERS,
        maxCombinedCharacters:
          LOCAL_MAX_COMBINED_EVIDENCE_CHARACTERS,
      }
    : {
        maxManuscriptCharacters:
          MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS,
        minPacketCharacters: OCI_PACKET_CHARACTERS,
        maxPacketCharacters: OCI_PACKET_CHARACTERS,
        maxCombinedCharacters: MAX_COMBINED_EVIDENCE_CHARACTERS,
      };
  const signing = getAiSigningRuntime();
  if (!signing.corpusSigningSecret) {
    return errorResponse(
      signing.corpusSigningError ||
        "Set SCHOLAR_FLOW_CORPUS_SIGNING_SECRET before processing a Large Corpus evidence packet.",
      503,
      "CORPUS_SIGNING_NOT_CONFIGURED",
    );
  }

  let formData: FormData;
  try {
    formData = await parseMultipartFormData(request, contentType);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return errorResponse(
        "The corpus analysis request is larger than 44 MB.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
    if (error instanceof InvalidContentLengthError) {
      return errorResponse(
        "The request has an invalid Content-Length header.",
        400,
        "INVALID_CONTENT_LENGTH",
      );
    }
    return errorResponse(
      "Expected a valid multipart form submission.",
      400,
      "INVALID_FORM",
    );
  }

  const rawTitle = textField(formData, "title");
  const rawTargetVenue = textField(formData, "targetVenue");
  const rawSubmissionType = textField(formData, "submissionType");
  const manuscript = textField(formData, "manuscript");
  const title = rawTitle.trim();
  const targetVenue = rawTargetVenue.trim();
  const submissionType = rawSubmissionType.trim();
  const fieldErrors: string[] = [];

  if (!title) {
    fieldErrors.push("Enter a working title.");
  }
  if (!targetVenue) {
    fieldErrors.push("Enter the exact conference, journal, or publication.");
  }
  if (!submissionType) {
    fieldErrors.push("Select a submission type.");
  }
  if (rawTitle.length > FIELD_LIMITS.title) {
    fieldErrors.push(
      `title is ${rawTitle.length.toLocaleString("en-US")} characters; the limit is ${FIELD_LIMITS.title.toLocaleString("en-US")}. Nothing was truncated.`,
    );
  }
  if (rawTargetVenue.length > FIELD_LIMITS.targetVenue) {
    fieldErrors.push(
      `targetVenue is ${rawTargetVenue.length.toLocaleString("en-US")} characters; the limit is ${FIELD_LIMITS.targetVenue.toLocaleString("en-US")}. Nothing was truncated.`,
    );
  }
  if (rawSubmissionType.length > FIELD_LIMITS.submissionType) {
    fieldErrors.push(
      `submissionType is ${rawSubmissionType.length.toLocaleString("en-US")} characters; the limit is ${FIELD_LIMITS.submissionType.toLocaleString("en-US")}. Nothing was truncated.`,
    );
  }
  if (manuscript.length > FIELD_LIMITS.manuscript) {
    fieldErrors.push(
      `manuscript is ${manuscript.length.toLocaleString("en-US")} characters; the limit is ${FIELD_LIMITS.manuscript.toLocaleString("en-US")}. Nothing was truncated.`,
    );
  }
  if (manuscript.length > corpusLimits.maxManuscriptCharacters) {
    fieldErrors.push(
      localLlama
        ? `Local Llama manuscript notes are limited to ${corpusLimits.maxManuscriptCharacters.toLocaleString("en-US")} characters by the 16 GB memory profile. Put the remaining material in corpus files so Scholar Flow can rank it into a bounded evidence packet.`
        : `manuscript is ${manuscript.length.toLocaleString("en-US")} characters; the limit is ${corpusLimits.maxManuscriptCharacters.toLocaleString("en-US")}. Nothing was truncated.`,
    );
  }

  const rawFileFields = formData.getAll("files");
  const files = rawFileFields.filter(
    (value): value is File => typeof value !== "string",
  );
  if (rawFileFields.some((value) => typeof value === "string")) {
    fieldErrors.push("Corpus sources must be uploaded as files.");
  }
  if (files.length === 0) {
    fieldErrors.push("Attach at least one corpus source.");
  }

  if (fieldErrors.length) {
    return errorResponse(
      "Please correct the corpus analysis details.",
      400,
      "VALIDATION_ERROR",
      fieldErrors,
    );
  }

  if (files.length > MAX_FILES) {
    return errorResponse(
      `Attach no more than ${MAX_FILES} corpus source files.`,
      413,
      "CORPUS_FILE_LIMIT",
    );
  }

  const fileRecords = files.map((file) => ({
    file,
    fileName: safeFileName(file.name || "source"),
  }));
  const pdfCount = fileRecords.filter(
    ({ fileName }) => fileExtension(fileName) === "pdf",
  ).length;
  if (pdfCount > MAX_PDF_FILES) {
    return errorResponse(
      `Attach no more than ${MAX_PDF_FILES} PDF files for one corpus analysis.`,
      413,
      "CORPUS_PDF_FILE_LIMIT",
    );
  }

  const totalFileBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalFileBytes > MAX_TOTAL_FILE_BYTES) {
    return errorResponse(
      "Corpus source files must total 40 MB or less.",
      413,
      "CORPUS_TOTAL_FILE_SIZE_LIMIT",
    );
  }

  const oversizedFile = fileRecords.find(({ file }) => file.size > MAX_FILE_BYTES);
  if (oversizedFile) {
    return errorResponse(
      `${oversizedFile.fileName} is larger than 20 MB.`,
      413,
      "CORPUS_FILE_SIZE_LIMIT",
    );
  }

  const fileErrors: string[] = [];
  const seenFileNames = new Set<string>();
  for (const { file, fileName } of fileRecords) {
    const foldedFileName = fileName.toLocaleLowerCase("en-US");
    if (seenFileNames.has(foldedFileName)) {
      fileErrors.push(
        `${fileName} appears more than once after case-insensitive filename sanitization.`,
      );
    } else {
      seenFileNames.add(foldedFileName);
    }

    if (file.size === 0) {
      fileErrors.push(`${fileName} is empty.`);
    }

    const extension = fileExtension(fileName);
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      fileErrors.push(
        `${fileName} is unsupported. Use PDF, TXT, Markdown, LaTeX, BibTeX, CSV, or JSON.`,
      );
    }
  }
  if (fileErrors.length) {
    return errorResponse(
      "Please correct the corpus source files.",
      400,
      "VALIDATION_ERROR",
      fileErrors,
    );
  }

  const analysisSlot = takeCorpusAnalysisSlot();
  if (!analysisSlot) {
    return NextResponse.json(
      {
        error: "Another large corpus analysis is already running. Try again shortly.",
        code: "CORPUS_ANALYSIS_BUSY",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": "15",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  try {
  const sourceDocuments: SourceDocument[] = [];
  let searchableTextCharacters = 0;
  const pdfExtractionDeadline = Date.now() + MAX_LARGE_CORPUS_PDF_PARSE_MS;

  for (const { file, fileName } of fileRecords) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return errorResponse(
        `${fileName} could not be read safely. Remove it or try a smaller file.`,
        422,
        "CORPUS_SOURCE_READ_FAILED",
      );
    }

    const extension = fileExtension(fileName);
    let text: string;
    if (extension === "pdf") {
      if (!hasPdfSignature(bytes)) {
        return errorResponse(
          `${fileName} does not match the required PDF file signature.`,
          422,
          "CORPUS_PDF_SIGNATURE_INVALID",
        );
      }
      const remainingParseMs = pdfExtractionDeadline - Date.now();
      if (remainingParseMs <= 0) {
        return errorResponse(
          "Corpus PDF text extraction did not finish within the shared 60-second window. Use fewer PDFs or attach extracted UTF-8 text files.",
          504,
          "CORPUS_EXTRACTION_TIMEOUT",
        );
      }
      try {
        const extracted = await extractPdfTextForChat(bytes, fileName, {
          maxPages: MAX_LARGE_CORPUS_PDF_PAGES,
          maxCharacters: MAX_LARGE_CORPUS_PDF_TEXT_CHARACTERS,
          parseMs: Math.max(1_000, remainingParseMs),
        });
        text = extracted.text;
      } catch (error) {
        if (
          Date.now() >= pdfExtractionDeadline ||
          (error instanceof PdfTextError &&
            error.message.includes("took too long to read"))
        ) {
          return errorResponse(
            "Corpus PDF text extraction did not finish within the shared 60-second window. Use fewer PDFs or attach extracted UTF-8 text files.",
            504,
            "CORPUS_EXTRACTION_TIMEOUT",
          );
        }
        if (error instanceof PdfTextError) {
          return corpusPdfError(error);
        }
        return errorResponse(
          `${fileName} could not be read as a searchable PDF.`,
          422,
          "CORPUS_PDF_EXTRACTION_FAILED",
        );
      }
    } else {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return errorResponse(
          `${fileName} is not valid UTF-8 text.`,
          422,
          "CORPUS_SOURCE_INVALID_UTF8",
        );
      }
    }

    if (text.length > MAX_LARGE_CORPUS_PDF_TEXT_CHARACTERS) {
      return errorResponse(
        `${fileName} contains more than ${MAX_LARGE_CORPUS_PDF_TEXT_CHARACTERS.toLocaleString("en-US")} searchable characters. Split it into smaller sources. Nothing was truncated.`,
        413,
        "CORPUS_SOURCE_TEXT_LIMIT",
      );
    }
    searchableTextCharacters += text.length;
    if (searchableTextCharacters > MAX_SEARCHABLE_TEXT_CHARACTERS) {
      return errorResponse(
        `Searchable corpus text must total ${MAX_SEARCHABLE_TEXT_CHARACTERS.toLocaleString("en-US")} characters or less. Nothing was truncated.`,
        413,
        "CORPUS_TEXT_LIMIT",
      );
    }
    sourceDocuments.push({ fileName, text });
  }

  if (!sourceDocuments.some(({ text }) => text.trim().length > 0)) {
    return errorResponse(
      "The corpus sources contain no searchable text.",
      422,
      "CORPUS_NO_SEARCHABLE_EVIDENCE",
    );
  }

  try {
    const packetCharacterBudget = Math.max(
      corpusLimits.minPacketCharacters,
      Math.min(
        corpusLimits.maxPacketCharacters,
        corpusLimits.maxCombinedCharacters - manuscript.length,
      ),
    );
    const packet = buildLargeCorpusEvidencePacket({
      sourceDocuments,
      title,
      targetVenue,
      submissionType,
      manuscript,
      maxPacketChars: packetCharacterBudget,
    });
    const selectedChunks = packet.chunks.map((chunk) => ({
      id: chunk.id,
      fileName: chunk.fileName,
      sourceIndex: chunk.sourceIndex,
      chunkIndex: chunk.chunkIndex,
      startChar: chunk.startChar,
      endChar: chunk.endChar,
      partial: chunk.partial,
      score: chunk.score,
      lexicalScore: chunk.lexicalScore,
      roleWeight: chunk.roleWeight,
      sectionRole: chunk.sectionRole,
      sectionHeading: chunk.sectionHeading,
      sectionRoleBasis: chunk.sectionRoleBasis,
      sectionRoles: chunk.sectionRoles,
      matchedKeywords: chunk.matchedKeywords,
    }));
    const artifactToken = await signCorpusArtifactToken({
      secret: signing.corpusSigningSecret,
      title,
      targetVenue,
      submissionType,
      manuscript,
      packet: packet.packetText,
      report: packet.coverage,
      ttlSeconds: CORPUS_ARTIFACT_MAX_TTL_SECONDS,
    });

    return NextResponse.json(
      {
        packetText: packet.packetText,
        artifactToken,
        selectedChunks,
        coverage: packet.coverage,
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return errorResponse(
      error instanceof Error
        ? `The corpus evidence packet could not be built: ${error.message}`
        : "The corpus evidence packet could not be built.",
      422,
      "CORPUS_ANALYSIS_FAILED",
    );
  }
  } finally {
    analysisSlot.release();
  }
}
