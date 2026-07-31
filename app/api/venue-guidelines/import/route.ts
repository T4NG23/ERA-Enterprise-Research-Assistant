import { NextResponse } from "next/server";

import { getAiProviderRuntime } from "@/lib/ai-provider-runtime";
import {
  extractVenueGuidelinesWithProvider,
} from "@/lib/ai-provider-server";
import {
  LocalLlamaPublicError,
} from "@/lib/local-llama-client.mjs";
import { OciPublicError } from "@/lib/oci-runtime";
import { signVenueContractArtifact } from "@/lib/venue-contract-artifact.mjs";
import {
  extractPdfTextForChat,
  PdfTextError,
} from "@/lib/pdf-text";

export const runtime = "edge";

const MAX_REQUEST_BYTES = 11 * 1024 * 1024;
const MAX_GUIDELINE_BYTES = 10 * 1024 * 1024;
const MAX_GUIDELINE_TEXT_CHARACTERS = 160_000;
const MAX_CONCURRENT_IMPORTS = 1;
const MAX_RATE_LIMIT_CLIENTS = 512;
const RATE_LIMIT_REQUESTS = 12;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
]);

interface ImportGuardState {
  active: number;
  requestsByClient: Map<string, number[]>;
}

const guardGlobal = globalThis as typeof globalThis & {
  __scholarFlowGuidelineImportGuard?: ImportGuardState;
};
const importGuard =
  guardGlobal.__scholarFlowGuidelineImportGuard ??
  (guardGlobal.__scholarFlowGuidelineImportGuard = {
    active: 0,
    requestsByClient: new Map<string, number[]>(),
  });

class RequestTooLargeError extends Error {}
class InvalidContentLengthError extends Error {}

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

function clientIdentifier(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "single-private-user"
  );
}

function takeImportSlot(request: Request) {
  const now = Date.now();
  if (importGuard.requestsByClient.size > MAX_RATE_LIMIT_CLIENTS) {
    for (const [key, timestamps] of importGuard.requestsByClient) {
      if (
        timestamps.every(
          (timestamp) => now - timestamp >= RATE_LIMIT_WINDOW_MS,
        )
      ) {
        importGuard.requestsByClient.delete(key);
      }
    }
  }

  const rawClient = clientIdentifier(request);
  const client =
    importGuard.requestsByClient.size > MAX_RATE_LIMIT_CLIENTS &&
    !importGuard.requestsByClient.has(rawClient)
      ? "overflow-clients"
      : rawClient;
  const recent = (importGuard.requestsByClient.get(client) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );
  importGuard.requestsByClient.set(client, recent);
  if (recent.length >= RATE_LIMIT_REQUESTS) {
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1_000,
        ),
      ),
    };
  }
  if (importGuard.active >= MAX_CONCURRENT_IMPORTS) {
    return { ok: false as const, retryAfterSeconds: 5 };
  }

  recent.push(now);
  importGuard.active += 1;
  let released = false;
  return {
    ok: true as const,
    release() {
      if (released) return;
      released = true;
      importGuard.active = Math.max(0, importGuard.active - 1);
    },
  };
}

async function parseMultipartFormData(request: Request, contentType: string) {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    if (!/^\d+$/u.test(contentLengthHeader)) {
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
  if (!request.body) throw new TypeError("The request body is missing.");

  let bytesRead = 0;
  const limited = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        if (bytesRead > MAX_REQUEST_BYTES) {
          controller.error(new RequestTooLargeError());
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(limited, {
    headers: { "Content-Type": contentType },
  }).formData();
}

function boundedText(
  value: FormDataEntryValue | null,
  name: string,
  maximum: number,
  required = true,
) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  const result = value.trim();
  if (required && !result) throw new TypeError(`${name} is required.`);
  if (result.length > maximum) {
    throw new TypeError(`${name} must be ${maximum} characters or less.`);
  }
  return result;
}

function extension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
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

function cleanFileName(value: string) {
  return (
    value
      .replaceAll(/[\u0000-\u001f\u007f]/gu, "")
      .replaceAll(/[\\/]/gu, "_")
      .trim()
      .slice(0, 180) || "official-guidelines"
  );
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replaceAll(
    /&(?:#(\d{1,7})|#x([a-f0-9]{1,6})|([a-z]{2,12}));/giu,
    (match, decimal: string, hexadecimal: string, name: string) => {
      if (decimal) {
        const point = Number(decimal);
        return Number.isSafeInteger(point) && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      if (hexadecimal) {
        const point = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(point) && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      return named[name.toLowerCase()] ?? match;
    },
  );
}

function htmlSnapshot(rawHtml: string) {
  const titleMatch = rawHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const withoutNonContent = rawHtml
    .replaceAll(
      /<(?:script|style|template|noscript|svg)\b[\s\S]*?<\/(?:script|style|template|noscript|svg)\s*>/giu,
      " ",
    )
    .replaceAll(/<!--[\s\S]*?-->/gu, " ")
    .replaceAll(
      /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/giu,
      "\n",
    )
    .replaceAll(/<[^>]+>/gu, " ");
  const text = decodeHtmlEntities(withoutNonContent)
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/[ \t\f\v]+/gu, " ")
    .replaceAll(/\n[ \t]+/gu, "\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1].replaceAll(/<[^>]+>/gu, " "))
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, 500)
    : "";
  return { text, title };
}

function decodeUtf8(bytes: Uint8Array, fileName: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError(
      `${fileName} is not valid UTF-8 text. Export it as UTF-8 or searchable PDF.`,
    );
  }
}

async function sha256Hex(bytes: Uint8Array) {
  const digestInput = Uint8Array.from(bytes).buffer;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", digestInput),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function localGuidelineSnapshot(file: File) {
  if (file.size < 1) throw new TypeError("The guideline file is empty.");
  if (file.size > MAX_GUIDELINE_BYTES) {
    throw new RequestTooLargeError(
      "The guideline file is larger than 10 MB.",
    );
  }

  const fileName = cleanFileName(file.name);
  const fileExtension = extension(fileName);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = hasPdfSignature(bytes);
  if (fileExtension === "pdf" && !pdf) {
    throw new TypeError(`${fileName} does not have a valid PDF signature.`);
  }
  if (!pdf && !TEXT_EXTENSIONS.has(fileExtension)) {
    throw new TypeError(
      "Upload one PDF, TXT, Markdown, HTML, or HTM official-guideline file.",
    );
  }

  const sha256 = await sha256Hex(bytes);
  const localSourceUrl = `http://127.0.0.1/offline-guideline/${sha256}`;
  if (pdf) {
    const extracted = await extractPdfTextForChat(bytes, fileName, {
      maxPages: 120,
      maxCharacters: MAX_GUIDELINE_TEXT_CHARACTERS,
      parseMs: 30_000,
    });
    return {
      source: {
        requestedUrl: localSourceUrl,
        finalUrl: localSourceUrl,
        retrievedAt: new Date().toISOString(),
        title: fileName,
        contentType: "application/pdf" as const,
        sha256,
      },
      sourceText: extracted.text,
    };
  }

  const rawText = decodeUtf8(bytes, fileName);
  const html = fileExtension === "html" || fileExtension === "htm";
  const snapshot = html
    ? htmlSnapshot(rawText)
    : {
        text: rawText.replaceAll(/\r\n?/gu, "\n").trim(),
        title: "",
      };
  if (!snapshot.text) {
    throw new TypeError(
      `${fileName} did not contain searchable guideline text.`,
    );
  }
  if (snapshot.text.length > MAX_GUIDELINE_TEXT_CHARACTERS) {
    throw new RequestTooLargeError(
      `The cleaned guideline text exceeds ${MAX_GUIDELINE_TEXT_CHARACTERS.toLocaleString()} characters. Use a more focused official source.`,
    );
  }
  return {
    source: {
      requestedUrl: localSourceUrl,
      finalUrl: localSourceUrl,
      retrievedAt: new Date().toISOString(),
      title: snapshot.title || fileName,
      contentType: html ? ("text/html" as const) : ("text/plain" as const),
      sha256,
    },
    sourceText: snapshot.text,
  };
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return errorResponse(
      "Cross-origin guideline imports are not allowed.",
      403,
      "ORIGIN_REJECTED",
    );
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.toLowerCase().startsWith("multipart/form-data;") ||
    !/boundary=/iu.test(contentType)
  ) {
    return errorResponse(
      "Expected a multipart local guideline upload.",
      415,
      "INVALID_CONTENT_TYPE",
    );
  }

  const providerRuntime = getAiProviderRuntime();
  if (
    providerRuntime.provider === "invalid" ||
    providerRuntime.configurationError
  ) {
    return errorResponse(
      providerRuntime.configurationError ||
        "SCHOLAR_FLOW_AI_PROVIDER is not configured.",
      503,
      "AI_PROVIDER_INVALID_CONFIGURATION",
    );
  }
  const signingSecret = providerRuntime.venueSigningSecret;
  if (!signingSecret) {
    return errorResponse(
      providerRuntime.venueSigningError,
      503,
      "VENUE_CONTRACT_SIGNING_NOT_CONFIGURED",
    );
  }

  let formData: FormData;
  try {
    formData = await parseMultipartFormData(request, contentType);
  } catch (error) {
    return errorResponse(
      error instanceof RequestTooLargeError
        ? error.message || "The guideline upload is larger than 11 MB."
        : error instanceof InvalidContentLengthError
          ? "The request has an invalid Content-Length header."
          : "Expected a valid multipart local guideline upload.",
      error instanceof RequestTooLargeError ? 413 : 400,
      error instanceof RequestTooLargeError
        ? "REQUEST_TOO_LARGE"
        : error instanceof InvalidContentLengthError
          ? "INVALID_CONTENT_LENGTH"
          : "INVALID_FORM",
    );
  }

  let venue: string;
  let publisher: string;
  let submissionType: string;
  let guidelineFile: File;
  try {
    venue = boundedText(formData.get("venue"), "venue", 240);
    publisher = boundedText(
      formData.get("publisher") ?? "",
      "publisher",
      160,
      false,
    );
    submissionType = boundedText(
      formData.get("submissionType"),
      "submissionType",
      120,
    );
    const files = formData.getAll("guidelineFile");
    if (files.length !== 1 || !(files[0] instanceof File)) {
      throw new TypeError("Upload exactly one official guideline file.");
    }
    guidelineFile = files[0];
    const allowedKeys = new Set([
      "venue",
      "publisher",
      "submissionType",
      "guidelineFile",
    ]);
    if ([...formData.keys()].some((key) => !allowedKeys.has(key))) {
      throw new TypeError(
        "The guideline upload contains unexpected fields.",
      );
    }
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : "The upload fields are invalid.",
      400,
      "INVALID_REQUEST",
    );
  }

  const slot = takeImportSlot(request);
  if (!slot.ok) {
    return NextResponse.json(
      {
        error:
          "Venue guideline extraction is busy or rate-limited. Try again shortly.",
        code: "GUIDELINE_IMPORT_RATE_LIMITED",
      },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(slot.retryAfterSeconds),
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  try {
    const snapshot = await localGuidelineSnapshot(guidelineFile);
    const proposal = await extractVenueGuidelinesWithProvider(
      providerRuntime,
      {
        venue,
        publisher,
        submissionType,
        source: snapshot.source,
        sourceText: snapshot.sourceText,
      },
    );
    const proposalArtifact = await signVenueContractArtifact({
      contract: proposal,
      secret: signingSecret,
    });
    return NextResponse.json(
      { proposal, proposalArtifact },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof PdfTextError) {
      return errorResponse(
        error.message,
        error.httpStatus,
        "GUIDELINE_PDF_TEXT_ERROR",
      );
    }
    if (
      error instanceof LocalLlamaPublicError ||
      error instanceof OciPublicError
    ) {
      return errorResponse(error.message, error.httpStatus, error.code);
    }
    if (error instanceof RequestTooLargeError) {
      return errorResponse(
        error.message,
        413,
        "GUIDELINE_SOURCE_TOO_LARGE",
      );
    }
    return errorResponse(
      error instanceof Error
        ? error.message
        : "The venue-guideline extraction failed.",
      422,
      "GUIDELINE_IMPORT_FAILED",
    );
  } finally {
    slot.release();
  }
}
