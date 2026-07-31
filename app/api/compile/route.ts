import { NextResponse } from "next/server";

import {
  assertPublicationLatexContract,
  getVenueTemplateContract,
} from "@/compiler/publication-template.mjs";
import {
  isLoopbackHostname,
  parseCompilerPageCount,
  permitsLoopbackCompilerFallback,
  supportsCompilerBridgeProtocol,
} from "@/lib/compiler-browser-bridge.mjs";
import {
  assertCompilableLatex,
  COMPILE_ASSET_MIME_BY_EXTENSION,
  fileExtension,
  hasValidBinarySignature,
  safeFileName,
  type CompileAssetMimeType,
} from "@/lib/latex-safety";
import {
  CUSTOM_PROFILE_ID,
  getPublicationLatexContractForProfile,
  getPublicationProfile,
  type PublicationLatexContract,
} from "@/lib/publication-profiles";
import {
  isSubmissionTypeAllowed,
  publisherForProfile,
} from "@/lib/submission-types.mjs";
import {
  assessCompiledPageCount,
  getSubmissionPagePolicy,
} from "@/lib/page-limits.mjs";
import { verifyVenueContractArtifact } from "@/lib/venue-contract-artifact.mjs";
import {
  venueContractSigningHealth,
  venueContractSigningSecret,
} from "@/lib/venue-contract-runtime";
import { normalizeConfirmedVenueContract } from "@/lib/venue-guidelines.mjs";
import type { ConfirmedVenueContract } from "@/lib/generation-types";

export const runtime = "edge";

const MAX_REQUEST_BYTES = 18 * 1024 * 1024;
const MAX_LATEX_CHARACTERS = 500_000;
const MAX_TITLE_CHARACTERS = 500;
const MAX_PROFILE_ID_CHARACTERS = 80;
const MAX_SUBMISSION_TYPE_CHARACTERS = 120;
const MAX_ASSETS = 8;
const MAX_ASSET_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_COMPILER_ERROR_BYTES = 64 * 1024;
const MAX_COMPILER_HEALTH_BYTES = 8 * 1024;
const COMPILER_TIMEOUT_MS = 55_000;
const MAX_CONCURRENT_COMPILATIONS = 2;
const RATE_LIMIT_REQUESTS = 12;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

const allowedAssetExtensions = new Set(["png", "jpg", "jpeg"]);

interface CompileGuardState {
  active: number;
  requestsByClient: Map<string, number[]>;
}

interface ValidatedAsset {
  name: string;
  mimeType: CompileAssetMimeType;
  dataBase64: string;
}

const guardGlobal = globalThis as typeof globalThis & {
  __scholarFlowPdfCompileGuard?: CompileGuardState;
};
const compileGuard =
  guardGlobal.__scholarFlowPdfCompileGuard ??
  (guardGlobal.__scholarFlowPdfCompileGuard = {
    active: 0,
    requestsByClient: new Map<string, number[]>(),
  });

class BodyTooLargeError extends Error {}
class ResponseTooLargeError extends Error {}

function errorResponse(
  error: string,
  status: number,
  code: string,
  details?: string[],
  options?: { loopbackFallbackAllowed?: boolean },
) {
  return NextResponse.json(
    {
      error,
      code,
      ...(details?.length ? { details } : {}),
      ...(options?.loopbackFallbackAllowed
        ? { loopbackFallbackAllowed: true }
        : {}),
    },
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

async function readLimitedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  TooLarge: typeof BodyTooLargeError | typeof ResponseTooLargeError,
) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new TooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function strictRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error(`${path}.${unexpected} is not an accepted field.`);
  }
  return record;
}

function submittedVenueContractFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const hasContract = Object.hasOwn(record, "venueContract");
  const hasArtifact = Object.hasOwn(record, "venueContractArtifact");
  if (!hasContract && !hasArtifact) {
    return null;
  }
  return {
    hasContract,
    hasArtifact,
    contract: record.venueContract,
    artifact: record.venueContractArtifact,
  };
}

function decodeBase64(value: string) {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("The file data is not canonical base64.");
  }
  if (value.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4) {
    throw new Error("The encoded file is larger than 7 MB.");
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("The file data is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function validatePayload(value: unknown) {
  const body = strictRecord(value, "request", [
    "latex",
    "title",
    "profileId",
    "submissionType",
    "assets",
    "venueContract",
    "venueContractArtifact",
  ]);
  const errors: string[] = [];

  const latex =
    typeof body.latex === "string"
      ? body.latex.replaceAll(/\r\n?/g, "\n")
      : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const profileId =
    typeof body.profileId === "string" ? body.profileId.trim() : "";
  const submissionType =
    typeof body.submissionType === "string" ? body.submissionType.trim() : "";
  const rawAssets = Array.isArray(body.assets) ? body.assets : null;
  const hasVenueContract = Object.hasOwn(body, "venueContract");
  const hasVenueContractArtifact = Object.hasOwn(
    body,
    "venueContractArtifact",
  );
  const venueContractArtifact =
    typeof body.venueContractArtifact === "string"
      ? body.venueContractArtifact
      : "";
  let venueContract: ConfirmedVenueContract | null = null;
  let publicationContract: PublicationLatexContract | null = null;
  let publicationLabel = "the selected publication";

  if (hasVenueContract !== hasVenueContractArtifact) {
    errors.push(
      "A dynamic venue compile requires both the confirmed contract and its signature.",
    );
  } else if (hasVenueContract && hasVenueContractArtifact) {
    try {
      if (
        !body.venueContract ||
        typeof body.venueContract !== "object" ||
        Array.isArray(body.venueContract) ||
        !venueContractArtifact
      ) {
        throw new Error(
          "The confirmed venue contract and its signature must both be non-empty.",
        );
      }
      venueContract = normalizeConfirmedVenueContract(
        body.venueContract,
      ) as ConfirmedVenueContract;
      if (!/^1\.[A-Za-z0-9_-]{43}$/u.test(venueContractArtifact)) {
        throw new Error("The venue-contract signature is invalid.");
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "The confirmed venue contract is invalid.",
      );
    }
  }

  if (!latex.trim()) errors.push("LaTeX source is required.");
  if (latex.length > MAX_LATEX_CHARACTERS) {
    errors.push("LaTeX source must be 500,000 characters or less.");
  }
  if (!title) errors.push("A paper title is required.");
  if (title.length > MAX_TITLE_CHARACTERS) {
    errors.push("The paper title must be 500 characters or less.");
  }
  if (!profileId) {
    errors.push("A publication profile ID is required.");
  } else if (profileId.length > MAX_PROFILE_ID_CHARACTERS) {
    errors.push("The publication profile ID must be 80 characters or less.");
  }
  if (!submissionType) {
    errors.push("A submission type is required.");
  } else if (submissionType.length > MAX_SUBMISSION_TYPE_CHARACTERS) {
    errors.push("The submission type must be 120 characters or less.");
  }
  if (
    profileId &&
    profileId.length <= MAX_PROFILE_ID_CHARACTERS &&
    submissionType &&
    submissionType.length <= MAX_SUBMISSION_TYPE_CHARACTERS
  ) {
    if (!isSubmissionTypeAllowed(profileId, submissionType)) {
      errors.push(
        "The submission type is not supported by the selected publication profile.",
      );
    } else {
      try {
        if (venueContract) {
          if (venueContract.submissionType !== submissionType) {
            throw new Error(
              "The confirmed venue contract does not match this submission type.",
            );
          }
          const requiredPublisher = publisherForProfile(profileId);
          if (
            requiredPublisher &&
            venueContract.publisher !== requiredPublisher
          ) {
            throw new Error(
              "The confirmed venue contract does not match this publication profile.",
            );
          }
          publicationContract =
            getVenueTemplateContract(venueContract.templateKey) ?? null;
          if (!publicationContract) {
            throw new Error(
              "The confirmed venue template is not supported.",
            );
          }
          publicationLabel = venueContract.venue;
        } else {
          publicationContract = getPublicationLatexContractForProfile(
            profileId,
            submissionType,
          );
          publicationLabel =
            getPublicationProfile(profileId)?.shortName ??
            (profileId === CUSTOM_PROFILE_ID
              ? "Custom publication"
              : "the selected publication");
        }
      } catch {
        errors.push("Select a valid publication workflow before compiling the PDF.");
      }
    }
  }
  if (!rawAssets) {
    errors.push("assets must be an array.");
  } else if (rawAssets.length > MAX_ASSETS) {
    errors.push(`Attach no more than ${MAX_ASSETS} compilation assets.`);
  }

  const assets: ValidatedAsset[] = [];
  const seenNames = new Set<string>();
  let totalAssetBytes = 0;

  for (const [index, rawAsset] of (rawAssets ?? [])
    .slice(0, MAX_ASSETS)
    .entries()) {
    try {
      const asset = strictRecord(rawAsset, `assets[${index}]`, [
        "name",
        "mimeType",
        "dataBase64",
      ]);
      if (typeof asset.name !== "string" || !asset.name || asset.name.length > 120) {
        throw new Error("The asset name must be between 1 and 120 characters.");
      }
      const sanitizedName = safeFileName(asset.name);
      if (asset.name !== sanitizedName) {
        throw new Error(
          `The asset name must already be sanitized as ${sanitizedName}.`,
        );
      }
      if (seenNames.has(sanitizedName)) {
        throw new Error(
          `${sanitizedName} appears more than once after filename sanitization.`,
        );
      }
      seenNames.add(sanitizedName);

      const extension = fileExtension(sanitizedName);
      if (!allowedAssetExtensions.has(extension)) {
        throw new Error("Only PNG, JPG, and JPEG figure assets can be compiled.");
      }
      const expectedMimeType =
        COMPILE_ASSET_MIME_BY_EXTENSION[
          extension as "png" | "jpg" | "jpeg"
        ];
      if (asset.mimeType !== expectedMimeType) {
        throw new Error(
          `${sanitizedName} must use the exact media type ${expectedMimeType}.`,
        );
      }
      if (typeof asset.dataBase64 !== "string") {
        throw new Error("The asset data must be a base64 string.");
      }

      const bytes = decodeBase64(asset.dataBase64);
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        throw new Error(`${sanitizedName} is larger than 7 MB.`);
      }
      if (!hasValidBinarySignature(extension, bytes)) {
        throw new Error(
          `${sanitizedName} does not match its declared ${expectedMimeType} signature.`,
        );
      }
      if (
        (extension === "jpg" || extension === "jpeg") &&
        (bytes.length < 5 ||
          bytes[bytes.length - 2] !== 0xff ||
          bytes[bytes.length - 1] !== 0xd9)
      ) {
        throw new Error(
          `${sanitizedName} does not have a complete JPEG signature.`,
        );
      }

      totalAssetBytes += bytes.byteLength;
      if (totalAssetBytes > MAX_TOTAL_ASSET_BYTES) {
        throw new Error("Compilation assets must total 12 MB or less.");
      }
      assets.push({
        name: sanitizedName,
        mimeType: expectedMimeType,
        dataBase64: asset.dataBase64,
      });
    } catch (error) {
      errors.push(
        error instanceof Error
          ? `Asset ${index + 1}: ${error.message}`
          : `Asset ${index + 1} is invalid.`,
      );
    }
  }

  if (latex && latex.length <= MAX_LATEX_CHARACTERS) {
    try {
      assertCompilableLatex(
        latex,
        assets.map((asset) => asset.name),
      );
      if (publicationContract) {
        assertPublicationLatexContract(
          latex,
          publicationContract,
          publicationLabel,
        );
      }
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : "The LaTeX source is unsafe.",
      );
    }
  }

  if (errors.length) {
    throw Object.assign(new Error("The PDF request is invalid."), { details: errors });
  }
  return {
    latex,
    title,
    profileId,
    submissionType,
    assets,
    venueContract,
    venueContractArtifact,
  };
}

function clientIdentifier(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "single-private-user"
  );
}

function takeCompilationSlot(request: Request):
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number; reason: string } {
  const now = Date.now();
  if (compileGuard.requestsByClient.size > 512) {
    for (const [key, timestamps] of compileGuard.requestsByClient) {
      if (
        timestamps.every(
          (timestamp) => now - timestamp >= RATE_LIMIT_WINDOW_MS,
        )
      ) {
        compileGuard.requestsByClient.delete(key);
      }
    }
  }

  const rawClient = clientIdentifier(request);
  const client =
    compileGuard.requestsByClient.size > 512 &&
    !compileGuard.requestsByClient.has(rawClient)
      ? "overflow-clients"
      : rawClient;
  const recent = (compileGuard.requestsByClient.get(client) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );
  compileGuard.requestsByClient.set(client, recent);

  if (recent.length >= RATE_LIMIT_REQUESTS) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000),
      ),
      reason: "PDF compilation is limited to twelve requests per ten minutes.",
    };
  }
  if (compileGuard.active >= MAX_CONCURRENT_COMPILATIONS) {
    return {
      ok: false,
      retryAfterSeconds: 15,
      reason: "Two PDF compilations are already running. Try again shortly.",
    };
  }

  recent.push(now);
  compileGuard.active += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      compileGuard.active = Math.max(0, compileGuard.active - 1);
    },
  };
}

function compilerConfiguration(request: Request) {
  const requestUrl = new URL(request.url);
  const configuredUrl = process.env.SCHOLAR_FLOW_LATEX_COMPILER_URL?.trim();
  const rawUrl =
    configuredUrl ||
    (isLoopbackHostname(requestUrl.hostname)
      ? "http://127.0.0.1:3101/compile"
      : "");
  if (!rawUrl) {
    throw Object.assign(
      new Error(
        "PDF compilation is not configured. Add SCHOLAR_FLOW_LATEX_COMPILER_URL for a private isolated compiler.",
      ),
      { code: "PDF_COMPILER_NOT_CONFIGURED" },
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error("The PDF compiler URL is invalid."), {
      code: "PDF_COMPILER_INVALID_CONFIGURATION",
    });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw Object.assign(
      new Error(
        "Closed-isolation mode requires a loopback-only PDF compiler URL without credentials, query parameters, or fragments.",
      ),
      { code: "PDF_COMPILER_INVALID_CONFIGURATION" },
    );
  }

  const token = process.env.SCHOLAR_FLOW_LATEX_COMPILER_TOKEN?.trim() ?? "";
  if (token.length > 4096 || /[\r\n]/.test(token)) {
    throw Object.assign(new Error("The PDF compiler token is invalid."), {
      code: "PDF_COMPILER_INVALID_CONFIGURATION",
    });
  }
  const usesLocalDefault = permitsLoopbackCompilerFallback({
    requestHostname: requestUrl.hostname,
    configuredUrl: configuredUrl ?? "",
    token,
  });
  const healthUrl = new URL(url);
  const healthPath = healthUrl.pathname.replace(/\/compile\/?$/u, "/health");
  if (healthPath === healthUrl.pathname) {
    throw Object.assign(
      new Error("The PDF compiler URL must end in /compile."),
      { code: "PDF_COMPILER_INVALID_CONFIGURATION" },
    );
  }
  healthUrl.pathname = healthPath;
  healthUrl.search = "";
  healthUrl.hash = "";

  return {
    url: url.toString(),
    healthUrl: healthUrl.toString(),
    token,
    usesLocalDefault,
  };
}

function cleanCompilerText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  return value
    .replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

async function compilerErrorDetails(response: Response) {
  try {
    const bytes = await readLimitedBody(
      response.body,
      MAX_COMPILER_ERROR_BYTES,
      ResponseTooLargeError,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const nestedError =
      record.error &&
      typeof record.error === "object" &&
      !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : null;
    const error = nestedError
      ? cleanCompilerText(nestedError.message, 2_000)
      : cleanCompilerText(record.error, 2_000);
    const details = Array.isArray(record.details)
      ? record.details
          .map((detail) => cleanCompilerText(detail, 1_000))
          .filter(Boolean)
          .slice(0, 10)
      : nestedError
        ? [cleanCompilerText(nestedError.detail, 1_000)].filter(Boolean)
        : [];
    return { error, details };
  } catch {
    return null;
  }
}

async function compilerSupportsSignedVenueContracts(
  compiler: ReturnType<typeof compilerConfiguration>,
  signal: AbortSignal,
) {
  const headers = new Headers({ Accept: "application/json" });
  if (compiler.token) headers.set("Authorization", `Bearer ${compiler.token}`);
  const response = await fetch(compiler.healthUrl, {
    method: "GET",
    headers,
    cache: "no-store",
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    return { protocolSupported: false, signingConfigured: false };
  }

  try {
    const bytes = await readLimitedBody(
      response.body,
      MAX_COMPILER_HEALTH_BYTES,
      ResponseTooLargeError,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(text) as unknown;
    return {
      protocolSupported: supportsCompilerBridgeProtocol(value, true),
      signingConfigured:
        Boolean(
          value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>)
              .venueContractSigningConfigured === true,
        ),
    };
  } catch {
    return { protocolSupported: false, signingConfigured: false };
  }
}

function pdfFileName(title: string) {
  const withoutPdf = title.replace(/\.pdf$/i, "").trim();
  const base = safeFileName(withoutPdf).replace(/^\.+/, "");
  return `${base && base !== "attachment" ? base : "scholar-flow-paper"}.pdf`;
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return errorResponse(
      "Cross-origin PDF compilation requests are not allowed.",
      403,
      "ORIGIN_REJECTED",
    );
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    return errorResponse(
      "Expected an application/json PDF request.",
      415,
      "INVALID_CONTENT_TYPE",
    );
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return errorResponse(
        "The Content-Length header is invalid.",
        400,
        "INVALID_REQUEST",
      );
    }
    if (contentLength > MAX_REQUEST_BYTES) {
      return errorResponse(
        "The PDF request is larger than 18 MB.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
  }

  let rawPayload: unknown;
  try {
    const bytes = await readLimitedBody(
      request.body,
      MAX_REQUEST_BYTES,
      BodyTooLargeError,
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rawPayload = JSON.parse(text);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return errorResponse(
        "The PDF request is larger than 18 MB.",
        413,
        "REQUEST_TOO_LARGE",
      );
    }
    return errorResponse(
      "Expected a valid UTF-8 JSON PDF request.",
      400,
      "INVALID_JSON",
    );
  }

  const submittedVenueFields =
    submittedVenueContractFields(rawPayload);
  if (
    submittedVenueFields &&
    (!submittedVenueFields.hasContract ||
      !submittedVenueFields.hasArtifact ||
      !submittedVenueFields.contract ||
      typeof submittedVenueFields.contract !== "object" ||
      Array.isArray(submittedVenueFields.contract) ||
      typeof submittedVenueFields.artifact !== "string" ||
      !submittedVenueFields.artifact)
  ) {
    return errorResponse(
      "A dynamic venue compile requires both a non-empty confirmed contract and its signature. Omit both fields for a static profile.",
      422,
      "VENUE_CONTRACT_PAIR_REQUIRED",
    );
  }
  const submittedVenueContract = submittedVenueFields
    ? {
        contract: submittedVenueFields.contract,
        artifact: submittedVenueFields.artifact as string,
      }
    : null;
  if (submittedVenueContract) {
    const signingHealth = venueContractSigningHealth();
    const secret = venueContractSigningSecret();
    if (!signingHealth.configured || !secret) {
      return errorResponse(
        signingHealth.warning,
        503,
        "VENUE_CONTRACT_SIGNING_NOT_CONFIGURED",
      );
    }
    const verified =
      await verifyVenueContractArtifact({
        artifact: submittedVenueContract.artifact,
        contract: submittedVenueContract.contract,
        secret,
      });
    if (!verified) {
      return errorResponse(
        "The confirmed venue contract signature is invalid. Generate the paper again from a current confirmed guideline snapshot.",
        422,
        "VENUE_CONTRACT_INVALID",
      );
    }
  }

  let payload: ReturnType<typeof validatePayload>;
  try {
    payload = validatePayload(rawPayload);
  } catch (error) {
    const details =
      error instanceof Error &&
      "details" in error &&
      Array.isArray((error as Error & { details?: unknown }).details)
        ? ((error as Error & { details: string[] }).details)
        : [error instanceof Error ? error.message : "The PDF request is invalid."];
    return errorResponse(
      "Correct the LaTeX or figure files before compiling.",
      400,
      "PDF_VALIDATION_ERROR",
      details,
    );
  }

  let compiler: ReturnType<typeof compilerConfiguration>;
  try {
    compiler = compilerConfiguration(request);
  } catch (error) {
    return errorResponse(
      error instanceof Error
        ? error.message
        : "PDF compilation is not configured.",
      503,
      error instanceof Error && "code" in error
        ? String((error as Error & { code: unknown }).code)
        : "PDF_COMPILER_NOT_CONFIGURED",
    );
  }

  const slot = takeCompilationSlot(request);
  if (!slot.ok) {
    return NextResponse.json(
      { error: slot.reason, code: "PDF_RATE_LIMITED" },
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMPILER_TIMEOUT_MS);

  try {
    const headers = new Headers({
      Accept: "application/pdf, application/json",
      "Content-Type": "application/json",
    });
    if (compiler.token) headers.set("Authorization", `Bearer ${compiler.token}`);

    if (payload.venueContract) {
      const dynamicHealth = await compilerSupportsSignedVenueContracts(
        compiler,
        controller.signal,
      );
      if (!dynamicHealth.protocolSupported) {
        return errorResponse(
          "The configured PDF compiler does not support authenticated dynamic venue contracts. Restart or rebuild it before compiling this paper.",
          502,
          "PDF_COMPILER_OUTDATED",
        );
      }
      if (!dynamicHealth.signingConfigured) {
        return errorResponse(
          "The PDF compiler does not have a valid venue-contract signing secret. Configure the same 32–1,024 byte secret used by Scholar Flow and restart the compiler.",
          503,
          "PDF_COMPILER_VENUE_SIGNING_NOT_CONFIGURED",
        );
      }
    }

    const upstreamPayload = payload.venueContract
      ? {
          latex: payload.latex,
          title: payload.title,
          profileId: payload.profileId,
          submissionType: payload.submissionType,
          assets: payload.assets,
          // Forward the exact object that was authenticated above. The isolated
          // compiler verifies it independently before deriving either policy.
          venueContract: submittedVenueContract!.contract,
          venueContractArtifact: submittedVenueContract!.artifact,
        }
      : {
          latex: payload.latex,
          title: payload.title,
          profileId: payload.profileId,
          submissionType: payload.submissionType,
          assets: payload.assets,
        };
    const response = await fetch(compiler.url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      const upstream = await compilerErrorDetails(response);
      const authenticationFailure =
        response.status === 401 || response.status === 403;
      const status =
        response.status === 429
          ? 429
          : response.status < 500 && !authenticationFailure
            ? 422
            : 502;
      return errorResponse(
        authenticationFailure
          ? "The private PDF compiler rejected its configured credentials."
          : upstream?.error || "The LaTeX compiler could not build this paper.",
        status,
        authenticationFailure
          ? "PDF_COMPILER_AUTH_ERROR"
          : "PDF_COMPILATION_FAILED",
        upstream?.details,
      );
    }

    if (
      payload.venueContract &&
      (response.headers.get("x-scholar-flow-protocol-version") !== "4" ||
        response.headers.get(
          "x-scholar-flow-signed-dynamic-venue-contracts",
        ) !== "true")
    ) {
      await response.body?.cancel();
      return errorResponse(
        "The PDF compiler response did not authenticate support for signed dynamic venue contracts. Restart or rebuild the compiler, then retry.",
        502,
        "PDF_COMPILER_OUTDATED",
      );
    }

    const totalPageCount = parseCompilerPageCount(
      response.headers.get("x-scholar-flow-total-pages"),
    );
    const contentPageCount = parseCompilerPageCount(
      response.headers.get("x-scholar-flow-content-pages"),
    );
    const pagePolicy =
      payload.venueContract?.pagePolicy ??
      getSubmissionPagePolicy(
        payload.profileId,
        payload.submissionType,
      );
    if (
      !totalPageCount ||
      (pagePolicy?.countScope === "content_excluding_references" &&
        !contentPageCount)
    ) {
      return errorResponse(
        "The PDF compiler is not reporting the page measurements required by this version of Scholar Flow. Restart or rebuild the compiler, then retry.",
        502,
        "PDF_COMPILER_OUTDATED",
      );
    }
    if (pagePolicy) {
      const pageAssessment = assessCompiledPageCount(pagePolicy, {
        totalPages: totalPageCount,
        contentPages: contentPageCount,
      });
      if (pageAssessment.status !== "pass") {
        await response.body?.cancel();
        return errorResponse(
          pageAssessment.message,
          pageAssessment.status === "fail" ? 422 : 502,
          pageAssessment.status === "fail"
            ? "PAGE_CONTRACT_VIOLATION"
            : "PAGE_COUNT_UNAVAILABLE",
          [
            `Measured total pages: ${totalPageCount}.`,
            ...(contentPageCount
              ? [`Measured content pages: ${contentPageCount}.`]
              : []),
          ],
        );
      }
    }

    const responseContentLength = response.headers.get("content-length");
    if (
      responseContentLength &&
      (!Number.isFinite(Number(responseContentLength)) ||
        Number(responseContentLength) < 0 ||
        Number(responseContentLength) > MAX_PDF_BYTES)
    ) {
      return errorResponse(
        "The compiled PDF exceeded the 10 MB download limit.",
        502,
        "PDF_OUTPUT_TOO_LARGE",
      );
    }

    let pdf: Uint8Array;
    try {
      pdf = await readLimitedBody(
        response.body,
        MAX_PDF_BYTES,
        ResponseTooLargeError,
      );
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return errorResponse(
          "The compiled PDF exceeded the 10 MB download limit.",
          502,
          "PDF_OUTPUT_TOO_LARGE",
        );
      }
      throw error;
    }

    if (!hasValidBinarySignature("pdf", pdf)) {
      return errorResponse(
        "The compiler returned an invalid PDF response.",
        502,
        "PDF_OUTPUT_INVALID",
      );
    }

    const fileName = pdfFileName(payload.title);
    const pdfBuffer = new ArrayBuffer(pdf.byteLength);
    new Uint8Array(pdfBuffer).set(pdf);
    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(pdf.byteLength),
        "Content-Security-Policy": "sandbox",
        "Content-Type": "application/pdf",
        "Referrer-Policy": "no-referrer",
        "X-Scholar-Flow-Total-Pages": String(totalPageCount),
        "X-Scholar-Flow-Protocol-Version": "4",
        "X-Scholar-Flow-Signed-Dynamic-Venue-Contracts": "true",
        ...(contentPageCount
          ? { "X-Scholar-Flow-Content-Pages": String(contentPageCount) }
          : {}),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (
      controller.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return errorResponse(
        "The PDF compiler did not finish within 55 seconds.",
        504,
        "PDF_COMPILER_TIMEOUT",
      );
    }
    return errorResponse(
      "The private PDF compiler could not be reached.",
      502,
      "PDF_COMPILER_UNAVAILABLE",
      undefined,
      compiler.usesLocalDefault
        ? { loopbackFallbackAllowed: true }
        : undefined,
    );
  } finally {
    clearTimeout(timeout);
    slot.release();
  }
}
