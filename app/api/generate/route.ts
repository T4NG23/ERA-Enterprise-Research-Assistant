import { NextResponse } from "next/server";

import { getVenueTemplateContract } from "@/compiler/publication-template.mjs";
import {
  StructuredGenerationMalformedJsonError,
  type PreparedGenerationAttachment,
} from "@/lib/oci-server";
import {
  getAiProviderRuntime,
} from "@/lib/ai-provider-runtime";
import {
  generatePaperWithProvider,
} from "@/lib/ai-provider-server";
import { verifyCorpusArtifactToken } from "@/lib/corpus-artifact.mjs";
import {
  LARGE_CORPUS_ROLES,
  LARGE_CORPUS_SELECTION_POLICY,
  LARGE_CORPUS_WEIGHTING_POLICIES,
  weightingPolicyForSubmissionType,
} from "@/lib/large-corpus-policy.mjs";
import { normalizeAttachmentPlan } from "@/lib/attachment-plan.mjs";
import type {
  AttachmentPlanEntry,
  ConfirmedVenueContract,
  LargeCorpusReport,
  LargeCorpusRole,
  LargeCorpusRoleCoverage,
  LargeCorpusRoleWeight,
} from "@/lib/generation-types";
import { verifyVenueContractArtifact } from "@/lib/venue-contract-artifact.mjs";
import {
  normalizeConfirmedVenueContract,
  publicationRulesFromVenueContract,
} from "@/lib/venue-guidelines.mjs";
import { LocalLlamaPublicError } from "@/lib/local-llama-client.mjs";
import { OciPublicError } from "@/lib/oci-runtime";
import { safeFileName } from "@/lib/latex-safety";
import {
  CUSTOM_PROFILE_ID,
  getPublicationLatexContractForProfile,
  getPublicationProfile,
  type PublicationProfile,
  type PublicationRule,
} from "@/lib/publication-profiles";
import {
  isSubmissionTypeAllowed,
  submissionTypesForProfile,
} from "@/lib/submission-types.mjs";

export const runtime = "edge";

const MAX_REQUEST_BYTES = 44 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 40 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_CHARACTERS = 300_000;
const MAX_TOTAL_TEXT_ATTACHMENT_CHARACTERS = 600_000;
const MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS = 80_000;
const MAX_LARGE_CORPUS_PACKET_CHARACTERS = 80_000;
const LOCAL_MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS = 20_000;
const LOCAL_MAX_LARGE_CORPUS_PACKET_CHARACTERS = 20_000;
const LOCAL_MAX_COMBINED_EVIDENCE_CHARACTERS = 32_000;
const MAX_FILES = 12;
const MAX_PDF_FILES = 10;
const MAX_CONCURRENT_GENERATIONS = 2;
const MAX_CONCURRENT_LOCAL_GENERATIONS = 1;
const RATE_LIMIT_REQUESTS = 8;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const LOCAL_LLAMA_DIAGNOSTIC_ID_PATTERN = /^llj-[a-z0-9]{10}$/;
const OCI_DIAGNOSTIC_ID_PATTERN = /^oj-[a-z0-9]{10}$/;
const LOCAL_LLAMA_MALFORMED_JSON_PUBLIC_MESSAGE =
  "The local model returned an invalid structured paper package. Retry the generation; if it happens again, share the diagnostic reference with the app operator.";
const OCI_MALFORMED_JSON_PUBLIC_MESSAGE =
  "OCI returned an invalid structured paper package. Retry the generation; if it happens again, share the diagnostic reference with the app operator.";

const fieldLimits = {
  profileId: 80,
  submissionType: 120,
  title: 300,
  targetVenue: 240,
  manuscript: 160_000,
  authorMetadata: 12_000,
  customPublisher: 160,
  customVenue: 240,
  customGuidance: 30_000,
  customSourceUrl: 1_000,
  attachmentPlan: 40_000,
  largeCorpusMode: 5,
  largeCorpusPacket: MAX_LARGE_CORPUS_PACKET_CHARACTERS,
  largeCorpusReport: 40_000,
  largeCorpusArtifact: 160,
  venueContract: 100_000,
  venueContractArtifact: 80,
} as const;

const textExtensions = new Set(["txt", "md", "markdown", "tex", "bib", "csv", "json"]);
const binaryMimeByExtension: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

interface GenerationGuardState {
  active: number;
  requestsByClient: Map<string, number[]>;
}

const guardGlobal = globalThis as typeof globalThis & {
  __manuscriptCompilerGenerationGuard?: GenerationGuardState;
};
const generationGuard =
  guardGlobal.__manuscriptCompilerGenerationGuard ??
  (guardGlobal.__manuscriptCompilerGenerationGuard = {
    active: 0,
    requestsByClient: new Map<string, number[]>(),
  });

class RequestTooLargeError extends Error {}

function textField(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function validateFieldLength(
  errors: string[],
  label: string,
  value: string,
  limit: number,
) {
  if (value.length > limit) {
    errors.push(`${label} is ${value.length.toLocaleString()} characters; the limit is ${limit.toLocaleString()}. Nothing was truncated.`);
  }
}

function normalizeLargeCorpusReport(
  raw: string,
  packet: string,
  submissionType: string,
  errors: string[],
): LargeCorpusReport | null {
  if (!raw) {
    errors.push("Process the large corpus before generating the paper.");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    errors.push("The processed corpus coverage report is invalid. Process the corpus again.");
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    errors.push("The processed corpus coverage report is invalid. Process the corpus again.");
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const allowedKeys = new Set([
    "enabled",
    "strategy",
    "weightingPolicy",
    "selectionPolicy",
    "roleWeights",
    "roleCoverage",
    "mapCharacters",
    "sourceCount",
    "totalCharacters",
    "totalChunks",
    "selectedChunks",
    "selectedCharacters",
    "omittedChunks",
    "packetCharacters",
    "sources",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    errors.push("The processed corpus coverage report contains unexpected fields. Process the corpus again.");
    return null;
  }

  const integer = (key: string, maximum: number) => {
    const value = record[key];
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum
      ? Number(value)
      : null;
  };
  const sourceCount = integer("sourceCount", MAX_FILES);
  const totalCharacters = integer("totalCharacters", 5_000_000);
  const totalChunks = integer("totalChunks", 20_000);
  const selectedChunks = integer("selectedChunks", 2_000);
  const selectedCharacters = integer(
    "selectedCharacters",
    MAX_LARGE_CORPUS_PACKET_CHARACTERS,
  );
  const omittedChunks = integer("omittedChunks", 20_000);
  const packetCharacters = integer("packetCharacters", fieldLimits.largeCorpusPacket);
  const mapCharacters = integer(
    "mapCharacters",
    fieldLimits.largeCorpusPacket,
  );
  const expectedWeightingPolicy =
    weightingPolicyForSubmissionType(submissionType);
  if (
    record.enabled !== true ||
    record.strategy !== "lexical-section-balanced-v2" ||
    record.weightingPolicy !== expectedWeightingPolicy ||
    sourceCount === null ||
    totalCharacters === null ||
    totalChunks === null ||
    selectedChunks === null ||
    selectedCharacters === null ||
    omittedChunks === null ||
    packetCharacters === null ||
    mapCharacters === null ||
    sourceCount < 1 ||
    totalCharacters < 1 ||
    totalChunks < 1 ||
    selectedChunks < 1 ||
    selectedCharacters < 1 ||
    packetCharacters < 1 ||
    selectedChunks > totalChunks ||
    omittedChunks !== totalChunks - selectedChunks ||
    packetCharacters !== packet.length ||
    mapCharacters > packetCharacters ||
    !Array.isArray(record.sources) ||
    record.sources.length !== sourceCount
  ) {
    errors.push("The processed corpus coverage report does not match its evidence packet. Process the corpus again.");
    return null;
  }

  const rawSelectionPolicy = record.selectionPolicy;
  if (
    !rawSelectionPolicy ||
    typeof rawSelectionPolicy !== "object" ||
    Array.isArray(rawSelectionPolicy)
  ) {
    errors.push("The processed corpus selection policy is invalid. Process the corpus again.");
    return null;
  }
  const selectionPolicyRecord = rawSelectionPolicy as Record<string, unknown>;
  const selectionPolicyKeys = Object.keys(LARGE_CORPUS_SELECTION_POLICY);
  if (
    Object.keys(selectionPolicyRecord).length !== selectionPolicyKeys.length ||
    selectionPolicyKeys.some(
      (key) =>
        selectionPolicyRecord[key] !==
        LARGE_CORPUS_SELECTION_POLICY[
          key as keyof typeof LARGE_CORPUS_SELECTION_POLICY
        ],
    )
  ) {
    errors.push("The processed corpus selection policy is invalid. Process the corpus again.");
    return null;
  }

  const expectedWeights =
    LARGE_CORPUS_WEIGHTING_POLICIES[expectedWeightingPolicy];
  if (
    !Array.isArray(record.roleWeights) ||
    record.roleWeights.length !== LARGE_CORPUS_ROLES.length
  ) {
    errors.push("The processed corpus role weights are invalid. Process the corpus again.");
    return null;
  }
  const roleWeights: LargeCorpusRoleWeight[] = [];
  for (const [index, item] of record.roleWeights.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("The processed corpus role weights are invalid. Process the corpus again.");
      return null;
    }
    const entry = item as Record<string, unknown>;
    const expected = expectedWeights[index];
    if (
      Object.keys(entry).length !== 3 ||
      !["role", "weight", "substantive"].every((key) =>
        Object.hasOwn(entry, key),
      ) ||
      entry.role !== expected.role ||
      entry.weight !== expected.weight ||
      entry.substantive !== expected.substantive
    ) {
      errors.push("The processed corpus role weights are invalid. Process the corpus again.");
      return null;
    }
    roleWeights.push({
      role: entry.role as LargeCorpusRole,
      weight: entry.weight as number,
      substantive: entry.substantive as boolean,
    });
  }

  if (
    !Array.isArray(record.roleCoverage) ||
    record.roleCoverage.length !== LARGE_CORPUS_ROLES.length
  ) {
    errors.push("The processed corpus role coverage is invalid. Process the corpus again.");
    return null;
  }
  const roleCoverage: LargeCorpusRoleCoverage[] = [];
  for (const [index, item] of record.roleCoverage.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("The processed corpus role coverage is invalid. Process the corpus again.");
      return null;
    }
    const entry = item as Record<string, unknown>;
    const expected = expectedWeights[index];
    const allowedRoleKeys = new Set([
      "role",
      "weight",
      "substantive",
      "headingCount",
      "detectedSources",
      "selectedSources",
      "detectedChunks",
      "selectedChunks",
      "selectedCharacters",
    ]);
    const roleInteger = (key: string, maximum: number) => {
      const value = entry[key];
      return Number.isInteger(value) &&
        Number(value) >= 0 &&
        Number(value) <= maximum
        ? Number(value)
        : null;
    };
    const headingCount = roleInteger("headingCount", 20_000);
    const detectedSources = roleInteger("detectedSources", sourceCount);
    const selectedSources = roleInteger("selectedSources", sourceCount);
    const detectedChunks = roleInteger("detectedChunks", totalChunks);
    const roleSelectedChunks = roleInteger("selectedChunks", selectedChunks);
    const roleSelectedCharacters = roleInteger(
      "selectedCharacters",
      selectedCharacters,
    );
    if (
      Object.keys(entry).some((key) => !allowedRoleKeys.has(key)) ||
      Object.keys(entry).length !== allowedRoleKeys.size ||
      entry.role !== expected.role ||
      entry.weight !== expected.weight ||
      entry.substantive !== expected.substantive ||
      headingCount === null ||
      detectedSources === null ||
      selectedSources === null ||
      detectedChunks === null ||
      roleSelectedChunks === null ||
      roleSelectedCharacters === null ||
      selectedSources > detectedSources ||
      roleSelectedChunks > detectedChunks
    ) {
      errors.push("The processed corpus role coverage is invalid. Process the corpus again.");
      return null;
    }
    roleCoverage.push({
      role: entry.role as LargeCorpusRole,
      weight: entry.weight as number,
      substantive: entry.substantive as boolean,
      headingCount,
      detectedSources,
      selectedSources,
      detectedChunks,
      selectedChunks: roleSelectedChunks,
      selectedCharacters: roleSelectedCharacters,
    });
  }

  const seen = new Set<string>();
  const sources = [];
  for (const [index, item] of record.sources.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`Corpus source ${index + 1} has invalid coverage metadata.`);
      return null;
    }
    const source = item as Record<string, unknown>;
    const sourceKeys = new Set([
      "fileName",
      "characters",
      "chunks",
      "selectedChunks",
      "selectedCharacters",
    ]);
    if (Object.keys(source).some((key) => !sourceKeys.has(key))) {
      errors.push(`Corpus source ${index + 1} has unexpected coverage metadata.`);
      return null;
    }
    const fileName = typeof source.fileName === "string" ? source.fileName : "";
    const foldedName = fileName.toLocaleLowerCase("en-US");
    const sourceInteger = (key: string, maximum: number) => {
      const value = source[key];
      return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum
        ? Number(value)
        : null;
    };
    const characters = sourceInteger("characters", 4_000_000);
    const chunks = sourceInteger("chunks", 20_000);
    const sourceSelectedChunks = sourceInteger("selectedChunks", 2_000);
    const sourceSelectedCharacters = sourceInteger(
      "selectedCharacters",
      MAX_LARGE_CORPUS_PACKET_CHARACTERS,
    );
    if (
      !fileName ||
      fileName.length > 120 ||
      safeFileName(fileName) !== fileName ||
      seen.has(foldedName) ||
      characters === null ||
      chunks === null ||
      sourceSelectedChunks === null ||
      sourceSelectedCharacters === null ||
      sourceSelectedChunks > chunks
    ) {
      errors.push(`Corpus source ${index + 1} has invalid coverage metadata.`);
      return null;
    }
    seen.add(foldedName);
    sources.push({
      fileName,
      characters,
      chunks,
      selectedChunks: sourceSelectedChunks,
      selectedCharacters: sourceSelectedCharacters,
    });
  }

  if (
    sources.reduce((sum, source) => sum + source.characters, 0) !== totalCharacters ||
    sources.reduce((sum, source) => sum + source.chunks, 0) !== totalChunks ||
    sources.reduce((sum, source) => sum + source.selectedChunks, 0) !== selectedChunks ||
    sources.reduce((sum, source) => sum + source.selectedCharacters, 0) !== selectedCharacters
  ) {
    errors.push("The processed corpus totals do not match its source coverage. Process the corpus again.");
    return null;
  }

  return {
    enabled: true,
    strategy: "lexical-section-balanced-v2",
    weightingPolicy: expectedWeightingPolicy,
    selectionPolicy: {
      ...LARGE_CORPUS_SELECTION_POLICY,
    },
    roleWeights,
    roleCoverage,
    mapCharacters,
    sourceCount,
    totalCharacters,
    totalChunks,
    selectedChunks,
    selectedCharacters,
    omittedChunks,
    packetCharacters,
    sources,
  };
}

function extension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function hasBytes(bytes: Uint8Array, expected: number[], offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasValidBinarySignature(fileExtension: string, bytes: Uint8Array) {
  if (fileExtension === "pdf") {
    return hasBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
  }
  if (fileExtension === "png") {
    return hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (fileExtension === "jpg" || fileExtension === "jpeg") {
    return hasBytes(bytes, [0xff, 0xd8, 0xff]);
  }
  if (fileExtension === "webp") {
    return (
      hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
    );
  }
  return false;
}

function validHttpUrl(value: string) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function guidanceSegments(guidance: string) {
  const cleaned = guidance.replaceAll("\r\n", "\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned
    .split(/\n{2,}/)
    .flatMap((paragraph) => {
      const lines = paragraph
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter(Boolean);
      return lines.length > 1 ? lines : [paragraph.trim()];
    })
    .filter((segment) => segment.length >= 12);

  if (paragraphs.length === 0) return [cleaned];

  if (paragraphs.length <= 60) return paragraphs;
  return [...paragraphs.slice(0, 59), paragraphs.slice(59).join("\n")];
}

function guidanceRules(guidance: string, prefix: string): PublicationRule[] {
  return guidanceSegments(guidance).map((segment, index) => ({
    id: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    label: segment.length > 84 ? `${segment.slice(0, 81)}...` : segment,
    value: segment,
    level: "venue-specific",
    detail: "Parsed from user-pasted publication guidance. Confirm the wording, source, track, and effective date before submission.",
  }));
}

function customProfile(
  publisher: string,
  venue: string,
  guidance: string,
  sourceUrl: string,
): PublicationProfile {
  return {
    id: CUSTOM_PROFILE_ID,
    authority: "publisher",
    status: "active",
    publisher: publisher || "Custom publisher",
    venue: venue || "Custom publication",
    shortName: venue || "Custom publication",
    edition: "User-supplied guidance",
    confidence: "starter",
    description: "A custom profile assembled from author-supplied publication guidance.",
    sources: sourceUrl
      ? [{ label: "User-supplied official guidance URL (not fetched)", url: sourceUrl }]
      : [],
    retrievedAt: new Date().toISOString().slice(0, 10),
    template: {
      family: "Determine from supplied guidance",
      layout: "Determine from supplied guidance",
      paperSize: "Determine from supplied guidance",
      output: "Author-review package",
      latex: getPublicationLatexContractForProfile(CUSTOM_PROFILE_ID),
    },
    rules: guidanceRules(guidance, "custom-guidance"),
    unresolvedRules: [
      "Source authenticity and effective date",
      "Any rule absent from the pasted guidance",
      "Final publisher validation",
    ],
    caveat:
      "The server does not fetch or authenticate arbitrary URLs. Authors must confirm every parsed rule against the live official page.",
  };
}

function profileWithVenueGuidance(
  profile: PublicationProfile,
  targetVenue: string,
  guidance: string,
  sourceUrl: string,
): PublicationProfile {
  if (!guidance.trim()) return profile;
  return {
    ...profile,
    venue: targetVenue || profile.venue,
    edition: `${profile.edition} + author-supplied venue guidance`,
    description: `${profile.description} The compliance registry also includes separately identified rules parsed from author-pasted venue guidance.`,
    sources: sourceUrl
      ? [...profile.sources, { label: "Author-supplied venue guidance URL (not fetched)", url: sourceUrl }]
      : profile.sources,
    rules: [...profile.rules, ...guidanceRules(guidance, "venue-guidance")],
    unresolvedRules: [
      ...profile.unresolvedRules,
      "Authenticity, track, and effective date of author-supplied guidance",
    ],
    caveat: `${profile.caveat} Pasted venue rules are traceable but remain author-supplied until independently curated.`,
  };
}

function profileWithConfirmedVenueContract(
  profile: PublicationProfile,
  contract: ConfirmedVenueContract,
): PublicationProfile {
  const latex = getVenueTemplateContract(contract.templateKey);
  if (!latex) {
    throw new Error("The confirmed venue template is not supported.");
  }
  const importedRules = publicationRulesFromVenueContract(
    contract,
  ) as PublicationRule[];
  const importedRuleIds = new Set(importedRules.map((rule) => rule.id));
  return {
    ...profile,
    authority: "venue",
    publisher: contract.publisher || profile.publisher,
    venue: contract.venue,
    shortName: contract.venue,
    edition: `Author-confirmed snapshot · ${contract.confirmedAt.slice(0, 10)}`,
    confidence: "starter",
    description:
      "An exact-venue profile assembled from a locally uploaded source snapshot and rules explicitly confirmed by the author. Non-venue-specific publisher rules remain as baseline requirements.",
    sources: [
      ...profile.sources.filter(
        (source) => source.url !== contract.source.finalUrl,
      ),
      {
        label: `Retrieved official guideline snapshot · SHA-256 ${contract.source.sha256.slice(0, 12)}…`,
        url: contract.source.finalUrl,
      },
    ],
    retrievedAt: contract.source.retrievedAt.slice(0, 10),
    template: {
      family: `Author-confirmed ${latex.documentClass} contract`,
      layout:
        contract.rules.find((rule) => rule.category === "layout")
          ?.requirement ?? "Review the locally extracted venue rules",
      paperSize: "Review the locally extracted venue rules",
      output: "Author-review submission package",
      latex,
    },
    rules: [
      ...profile.rules.filter(
        (rule) =>
          rule.level !== "venue-specific" &&
          !importedRuleIds.has(rule.id),
      ),
      ...importedRules,
    ],
    unresolvedRules: [...contract.unresolved],
    caveat:
      "These rules were extracted from a locally uploaded source and confirmed by the author; they are not an Scholar Flow-curated or publisher-certified profile. Recheck the publisher's current source outside the isolated runtime before submission.",
  };
}

function errorResponse(
  error: string,
  status: number,
  code?: string,
  details?: string[],
  diagnosticId?: string,
) {
  const diagnosticPattern =
    code === "LOCAL_LLAMA_MALFORMED_JSON"
      ? LOCAL_LLAMA_DIAGNOSTIC_ID_PATTERN
      : code === "OCI_MALFORMED_JSON"
        ? OCI_DIAGNOSTIC_ID_PATTERN
        : null;
  const safeDiagnosticId =
    diagnosticPattern &&
    typeof diagnosticId === "string" &&
    diagnosticPattern.test(diagnosticId)
      ? diagnosticId
      : undefined;
  return NextResponse.json(
    {
      error,
      ...(code ? { code } : {}),
      ...(details?.length ? { details } : {}),
      ...(safeDiagnosticId ? { diagnosticId: safeDiagnosticId } : {}),
    },
    { status, headers: { "Cache-Control": "no-store" } },
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
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new Error("Invalid Content-Length header.");
    }
    if (contentLength > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
  }

  if (!request.body) throw new Error("Missing request body.");
  let total = 0;
  const limitedBody = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > MAX_REQUEST_BYTES) {
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

function clientIdentifier(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "single-private-user"
  );
}

function takeGenerationSlot(
  request: Request,
  provider: "oci" | "local_llama",
):
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number; reason: string } {
  const now = Date.now();
  if (generationGuard.requestsByClient.size > 512) {
    for (const [key, timestamps] of generationGuard.requestsByClient) {
      if (timestamps.every((timestamp) => now - timestamp >= RATE_LIMIT_WINDOW_MS)) {
        generationGuard.requestsByClient.delete(key);
      }
    }
  }
  const rawClient = clientIdentifier(request);
  const client =
    generationGuard.requestsByClient.size > 512 &&
    !generationGuard.requestsByClient.has(rawClient)
      ? "overflow-clients"
      : rawClient;
  const recent = (generationGuard.requestsByClient.get(client) ?? []).filter(
    (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
  );
  generationGuard.requestsByClient.set(client, recent);

  if (recent.length >= RATE_LIMIT_REQUESTS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((RATE_LIMIT_WINDOW_MS - (now - recent[0])) / 1000),
    );
    return {
      ok: false,
      retryAfterSeconds,
      reason: "Generation is limited to eight requests per ten minutes for this private app.",
    };
  }
  const concurrencyLimit =
    provider === "local_llama"
      ? MAX_CONCURRENT_LOCAL_GENERATIONS
      : MAX_CONCURRENT_GENERATIONS;
  if (generationGuard.active >= concurrencyLimit) {
    return {
      ok: false,
      retryAfterSeconds: 15,
      reason:
        provider === "local_llama"
          ? "A local paper generation is already running. The 16 GB profile processes one model request at a time."
          : "Two paper generations are already running. Try again shortly.",
    };
  }

  recent.push(now);
  generationGuard.active += 1;
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      generationGuard.active = Math.max(0, generationGuard.active - 1);
    },
  };
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return errorResponse("Cross-origin generation requests are not allowed.", 403, "ORIGIN_REJECTED");
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;") || !/boundary=/i.test(contentType)) {
    return errorResponse("Expected a multipart form submission.", 400, "INVALID_FORM");
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

  let formData: FormData;
  try {
    formData = await parseMultipartFormData(request, contentType);
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return errorResponse("The submission package is larger than 44 MB.", 413, "REQUEST_TOO_LARGE");
    }
    return errorResponse("Expected a valid multipart form submission.", 400, "INVALID_FORM");
  }

  const rawFields = {
    profileId: textField(formData, "profileId"),
    submissionType: textField(formData, "submissionType"),
    title: textField(formData, "title"),
    targetVenue: textField(formData, "targetVenue"),
    manuscript: textField(formData, "manuscript"),
    authorMetadata: textField(formData, "authorMetadata"),
    customPublisher: textField(formData, "customPublisher"),
    customVenue: textField(formData, "customVenue"),
    customGuidance: textField(formData, "customGuidance"),
    customSourceUrl: textField(formData, "customSourceUrl"),
    attachmentPlan: textField(formData, "attachmentPlan"),
    largeCorpusMode: textField(formData, "largeCorpusMode"),
    largeCorpusPacket: textField(formData, "largeCorpusPacket").replaceAll(
      /\r\n?/g,
      "\n",
    ),
    largeCorpusReport: textField(formData, "largeCorpusReport"),
    largeCorpusArtifact: textField(formData, "largeCorpusArtifact"),
    venueContract: textField(formData, "venueContract"),
    venueContractArtifact: textField(
      formData,
      "venueContractArtifact",
    ),
  };

  const validationErrors: string[] = [];
  (Object.keys(fieldLimits) as Array<keyof typeof fieldLimits>).forEach((key) => {
    validateFieldLength(validationErrors, key, rawFields[key], fieldLimits[key]);
  });

  const profileId = rawFields.profileId.trim();
  const submissionType = rawFields.submissionType.trim();
  const title = rawFields.title.trim();
  const requestedTargetVenue = rawFields.targetVenue.trim();
  const manuscript = rawFields.manuscript;
  const authorMetadata = rawFields.authorMetadata;
  const customPublisher = rawFields.customPublisher.trim();
  const customVenue = rawFields.customVenue.trim();
  const customGuidance = rawFields.customGuidance;
  const customSourceUrl = rawFields.customSourceUrl.trim();
  const largeCorpusMode = rawFields.largeCorpusMode === "true";
  const largeCorpusPacket = rawFields.largeCorpusPacket;
  let largeCorpusReport: LargeCorpusReport | null = null;
  let confirmedVenueContract: ConfirmedVenueContract | null = null;

  if (
    rawFields.largeCorpusMode &&
    rawFields.largeCorpusMode !== "true" &&
    rawFields.largeCorpusMode !== "false"
  ) {
    validationErrors.push("Large Corpus mode must be either enabled or disabled.");
  }
  if (
    largeCorpusMode &&
    providerRuntime.provider === "oci" &&
    providerRuntime.config.transport !== "chat"
  ) {
    validationErrors.push(
      "Large Corpus mode requires OCI Chat transport when OCI is selected.",
    );
  }
  if (
    largeCorpusMode &&
    manuscript.length > MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS
  ) {
    validationErrors.push(
      `Large Corpus manuscript notes are limited to ${MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS.toLocaleString()} characters so the evidence packet, publication rules, final images, and generated paper retain context headroom.`,
    );
  }
  if (
    largeCorpusMode &&
    providerRuntime.provider === "local_llama" &&
    manuscript.length >
      LOCAL_MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS
  ) {
    validationErrors.push(
      `Local Llama manuscript notes are limited to ${LOCAL_MAX_LARGE_CORPUS_MANUSCRIPT_CHARACTERS.toLocaleString()} characters by the 16 GB profile. Reprocess the corpus after moving the remaining material into source files.`,
    );
  }
  if (
    largeCorpusMode &&
    providerRuntime.provider === "local_llama" &&
    largeCorpusPacket.length > LOCAL_MAX_LARGE_CORPUS_PACKET_CHARACTERS
  ) {
    validationErrors.push(
      `The local evidence packet exceeds the ${LOCAL_MAX_LARGE_CORPUS_PACKET_CHARACTERS.toLocaleString()}-character 16 GB profile. Process the corpus again under the active local provider.`,
    );
  }
  if (
    largeCorpusMode &&
    providerRuntime.provider === "local_llama" &&
    manuscript.length + largeCorpusPacket.length >
      LOCAL_MAX_COMBINED_EVIDENCE_CHARACTERS
  ) {
    validationErrors.push(
      `Local manuscript notes and the evidence packet must total ${LOCAL_MAX_COMBINED_EVIDENCE_CHARACTERS.toLocaleString()} characters or less. Process the corpus again after shortening the notes.`,
    );
  }
  if (
    !largeCorpusMode &&
    (largeCorpusPacket ||
      rawFields.largeCorpusReport ||
      rawFields.largeCorpusArtifact)
  ) {
    validationErrors.push("Processed corpus data may only be submitted in Large Corpus mode.");
  }
  if (largeCorpusMode) {
    if (!largeCorpusPacket.trim()) {
      validationErrors.push("Process the large corpus before generating the paper.");
    }
    if (
      largeCorpusPacket.length <= fieldLimits.largeCorpusPacket &&
      rawFields.largeCorpusReport.length <= fieldLimits.largeCorpusReport
    ) {
      largeCorpusReport = normalizeLargeCorpusReport(
        rawFields.largeCorpusReport,
        largeCorpusPacket,
        submissionType,
        validationErrors,
      );
    }
  }
  if (
    largeCorpusMode &&
    largeCorpusReport &&
    largeCorpusPacket.trim() &&
    rawFields.largeCorpusArtifact.length <= fieldLimits.largeCorpusArtifact
  ) {
    if (!providerRuntime.corpusSigningSecret) {
      return errorResponse(
        providerRuntime.corpusSigningError,
        503,
        "CORPUS_SIGNING_NOT_CONFIGURED",
      );
    }
    const artifactVerified = await verifyCorpusArtifactToken({
      token: rawFields.largeCorpusArtifact,
      secret: providerRuntime.corpusSigningSecret,
      title,
      targetVenue: requestedTargetVenue,
      submissionType,
      manuscript,
      packet: largeCorpusPacket,
      report: largeCorpusReport,
    });
    if (!artifactVerified) {
      validationErrors.push(
        "The processed corpus packet is expired or no longer matches the title, venue, manuscript notes, or measured coverage. Process the corpus again.",
      );
    }
  }

  if (!title) validationErrors.push("Enter a working title.");
  if (!submissionType) validationErrors.push("Select a submission type.");
  if (!validHttpUrl(customSourceUrl)) {
    validationErrors.push("The official source must be a valid HTTP or HTTPS URL.");
  }
  if (
    Boolean(rawFields.venueContract) !==
    Boolean(rawFields.venueContractArtifact)
  ) {
    validationErrors.push(
      "The confirmed venue contract is incomplete. Import and confirm the official guidelines again.",
    );
  } else if (
    rawFields.venueContract &&
    rawFields.venueContractArtifact &&
    rawFields.venueContract.length <= fieldLimits.venueContract &&
    rawFields.venueContractArtifact.length <=
      fieldLimits.venueContractArtifact
  ) {
    const signingSecret = providerRuntime.venueSigningSecret;
    if (!signingSecret) {
      return errorResponse(
        providerRuntime.venueSigningError,
        503,
        "VENUE_CONTRACT_SIGNING_NOT_CONFIGURED",
      );
    }
    try {
      const parsed = JSON.parse(rawFields.venueContract);
      const verified = await verifyVenueContractArtifact({
        artifact: rawFields.venueContractArtifact,
        contract: parsed,
        secret: signingSecret,
      });
      if (!verified) {
        validationErrors.push(
          "The confirmed venue contract signature is invalid. Import and confirm the official guidelines again.",
        );
      } else {
        const normalized = normalizeConfirmedVenueContract(parsed);
        confirmedVenueContract = normalized as ConfirmedVenueContract;
        if (normalized.venue !== requestedTargetVenue) {
          validationErrors.push(
            "The confirmed venue contract does not match the exact publication name.",
          );
        }
        if (normalized.submissionType !== submissionType) {
          validationErrors.push(
            "The confirmed venue contract does not match the selected submission type.",
          );
        }
        if (
          customPublisher &&
          normalized.publisher !== customPublisher
        ) {
          validationErrors.push(
            "The confirmed venue contract does not match the entered publisher.",
          );
        }
        if (
          customSourceUrl &&
          new URL(customSourceUrl).href !== normalized.source.requestedUrl
        ) {
          validationErrors.push(
            "The local guideline source changed after confirmation. Upload and confirm the file again.",
          );
        }
      }
    } catch {
      validationErrors.push(
        "The confirmed venue contract is invalid. Import and confirm the official guidelines again.",
      );
    }
  }

  let profile = getPublicationProfile(profileId);
  if (profileId === CUSTOM_PROFILE_ID) {
    if (!requestedTargetVenue && !customVenue) {
      validationErrors.push("Enter the exact publication or journal name.");
    }
    if (
      !confirmedVenueContract &&
      customGuidance.trim().length < 120
    ) {
      validationErrors.push("Paste at least 120 characters of official author guidance.");
    }
    profile = customProfile(
      customPublisher,
      requestedTargetVenue || customVenue,
      customGuidance,
      customSourceUrl,
    );
  } else if (!profile) {
    validationErrors.push("Select a valid publication profile.");
  } else if (
    profile.authority === "venue" &&
    requestedTargetVenue &&
    requestedTargetVenue !== profile.venue
  ) {
    validationErrors.push(
      "The exact publication name must match the selected verified venue profile.",
    );
  } else if (profile.authority === "publisher" && !requestedTargetVenue) {
    validationErrors.push("Enter the exact conference, journal, or publication name.");
  } else if (profile.authority === "publisher" && customGuidance.trim()) {
    profile = profileWithVenueGuidance(
      profile,
      requestedTargetVenue,
      customGuidance,
      customSourceUrl,
    );
  }

  if (
    profile &&
    confirmedVenueContract &&
    profileId !== CUSTOM_PROFILE_ID &&
    confirmedVenueContract.publisher !== profile.publisher
  ) {
    validationErrors.push(
      "The confirmed venue contract does not match the selected publisher profile. Import and confirm the exact venue rules again under the correct profile family.",
    );
  }

  if (profile && confirmedVenueContract) {
    try {
      profile = profileWithConfirmedVenueContract(
        profile,
        confirmedVenueContract,
      );
    } catch (error) {
      validationErrors.push(
        error instanceof Error
          ? error.message
          : "The confirmed venue contract could not be applied.",
      );
    }
  }

  if (profile && submissionType && !isSubmissionTypeAllowed(profileId, submissionType)) {
    const allowedTypes = submissionTypesForProfile(profileId);
    validationErrors.push(
      allowedTypes.length
        ? `Select a submission type supported by this profile: ${allowedTypes.join(", ")}.`
        : "The selected publication profile has no configured submission workflow.",
    );
  }

  const uploadedFiles = formData
    .getAll("files")
    .filter((value): value is File => typeof value !== "string");
  const files = uploadedFiles.filter((file) => file.size > 0);

  for (const file of uploadedFiles.filter((candidate) => candidate.size === 0)) {
    validationErrors.push(`${safeFileName(file.name || "attachment")} is empty.`);
  }

  if (!manuscript.trim() && files.length === 0 && !largeCorpusPacket.trim()) {
    validationErrors.push("Paste manuscript text or attach at least one supported file.");
  }
  if (files.length > MAX_FILES) {
    validationErrors.push(`Attach no more than ${MAX_FILES} files.`);
  }
  const pdfCount = files.filter((file) => extension(file.name) === "pdf").length;
  if (pdfCount > MAX_PDF_FILES) {
    validationErrors.push(`Attach no more than ${MAX_PDF_FILES} PDF files per generation.`);
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_TOTAL_FILE_BYTES) {
    validationErrors.push("Attachments must total 40 MB or less.");
  }

  const preparedAttachments: PreparedGenerationAttachment[] = [];
  const seenFileNames = new Set<string>();
  const seenFoldedFileNames = new Set<string>();
  let totalTextCharacters = 0;
  try {
    for (const file of files.slice(0, MAX_FILES)) {
      const fileName = safeFileName(file.name);
      const fileExtension = extension(fileName);
      const foldedFileName = fileName.toLocaleLowerCase("en-US");
      if (seenFileNames.has(fileName) || seenFoldedFileNames.has(foldedFileName)) {
        validationErrors.push(`${fileName} appears more than once after filename sanitization.`);
        continue;
      }
      seenFileNames.add(fileName);
      seenFoldedFileNames.add(foldedFileName);
      const binaryMimeType = binaryMimeByExtension[fileExtension];

      if (file.size > MAX_FILE_BYTES) {
        validationErrors.push(`${fileName} is larger than 20 MB.`);
        continue;
      }
      if (!textExtensions.has(fileExtension) && !binaryMimeType) {
        validationErrors.push(
          `${fileName} is unsupported. Use PDF, TXT, Markdown, LaTeX, BibTeX, CSV, JSON, PNG, JPG, or WebP.`,
        );
        continue;
      }
      if (largeCorpusMode && !binaryMimeType?.startsWith("image/")) {
        validationErrors.push(
          `${fileName} is a corpus source. Process PDF and text sources in the Large Corpus step; only direct image attachments may be sent with the final generation.`,
        );
        continue;
      }
      if (
        binaryMimeType?.startsWith("image/") &&
        file.size > MAX_IMAGE_BYTES
      ) {
        validationErrors.push(`${fileName} is larger than the 7 MB image limit.`);
        continue;
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (textExtensions.has(fileExtension)) {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          validationErrors.push(`${fileName} is not valid UTF-8 text.`);
          continue;
        }
        if (text.length > MAX_TEXT_ATTACHMENT_CHARACTERS) {
          validationErrors.push(
            `${fileName} is ${text.length.toLocaleString()} characters; text attachments are limited to ${MAX_TEXT_ATTACHMENT_CHARACTERS.toLocaleString()} characters. Nothing was truncated.`,
          );
          continue;
        }
        if (totalTextCharacters + text.length > MAX_TOTAL_TEXT_ATTACHMENT_CHARACTERS) {
          validationErrors.push(
            `${fileName} would put text attachments above the ${MAX_TOTAL_TEXT_ATTACHMENT_CHARACTERS.toLocaleString()}-character combined limit. Nothing was truncated.`,
          );
          continue;
        }
        preparedAttachments.push({ fileName, text });
        totalTextCharacters += text.length;
        continue;
      }

      if (!hasValidBinarySignature(fileExtension, bytes)) {
        validationErrors.push(`${fileName} does not match the expected ${fileExtension.toUpperCase()} file signature.`);
        continue;
      }
      if (!binaryMimeType) {
        validationErrors.push(`${fileName} has no recognized binary media type.`);
        continue;
      }
      preparedAttachments.push({
        fileName,
        mimeType: binaryMimeType,
        bytes,
      });
    }
  } catch {
    return errorResponse(
      "An attachment could not be read safely. Remove the affected file or try a smaller attachment.",
      500,
      "ATTACHMENT_PREPARATION_FAILED",
    );
  }

  let normalizedAttachmentPlan: AttachmentPlanEntry[] = [];
  if (!rawFields.attachmentPlan) {
    validationErrors.push("The attachment order and placement plan is missing.");
  } else if (rawFields.attachmentPlan.length <= fieldLimits.attachmentPlan) {
    try {
      normalizedAttachmentPlan = normalizeAttachmentPlan(
        JSON.parse(rawFields.attachmentPlan),
        preparedAttachments.map((attachment) => attachment.fileName),
      ) as AttachmentPlanEntry[];
    } catch (error) {
      validationErrors.push(
        error instanceof Error
          ? error.message
          : "The attachment order and placement plan is invalid.",
      );
    }
  }

  if (validationErrors.length || !profile) {
    return errorResponse(
      "Please correct the highlighted submission details.",
      400,
      "VALIDATION_ERROR",
      validationErrors,
    );
  }

  const submissionProfile: PublicationProfile = {
    ...profile,
    template: {
      ...profile.template,
      latex: confirmedVenueContract
        ? profile.template.latex
        : getPublicationLatexContractForProfile(
            profile.id,
            submissionType,
          ),
    },
  };

  const attachmentOrder = new Map(
    normalizedAttachmentPlan.map((entry, index) => [entry.fileName, index]),
  );
  preparedAttachments.sort(
    (left, right) =>
      (attachmentOrder.get(left.fileName) ?? Number.MAX_SAFE_INTEGER) -
      (attachmentOrder.get(right.fileName) ?? Number.MAX_SAFE_INTEGER),
  );
  const slot = takeGenerationSlot(request, providerRuntime.provider);
  if (!slot.ok) {
    return NextResponse.json(
      { error: slot.reason, code: "RATE_LIMITED" },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(slot.retryAfterSeconds),
        },
      },
    );
  }

  const effectiveTargetVenue =
    submissionProfile.authority === "venue"
      ? submissionProfile.venue
      : requestedTargetVenue || customVenue || submissionProfile.venue;

  try {
    const result = await generatePaperWithProvider(providerRuntime, {
      profile: submissionProfile,
      targetVenue: effectiveTargetVenue,
      submissionType,
      title,
      manuscript,
      authorMetadata,
      customGuidance: "",
      customSourceUrl: "",
      attachments: preparedAttachments,
      attachmentPlan: normalizedAttachmentPlan,
      largeCorpusMode,
      largeCorpusPacket,
      largeCorpusReport,
      pagePolicy: confirmedVenueContract?.pagePolicy ?? null,
      venueContract: confirmedVenueContract
        ? {
            contract: confirmedVenueContract,
            artifact: rawFields.venueContractArtifact,
          }
        : null,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StructuredGenerationMalformedJsonError) {
      console.error(error.toServerLogRecord());
      const local = error.backend === "local_llama";
      return errorResponse(
        local
          ? LOCAL_LLAMA_MALFORMED_JSON_PUBLIC_MESSAGE
          : OCI_MALFORMED_JSON_PUBLIC_MESSAGE,
        502,
        local
          ? "LOCAL_LLAMA_MALFORMED_JSON"
          : "OCI_MALFORMED_JSON",
        undefined,
        error.diagnosticId,
      );
    }
    if (
      error instanceof LocalLlamaPublicError ||
      error instanceof OciPublicError
    ) {
      return errorResponse(error.message, error.httpStatus, error.code);
    }
    const status = error instanceof Error && error.name === "TimeoutError" ? 504 : 502;
    const local = providerRuntime.provider === "local_llama";
    const message =
      status === 504
        ? largeCorpusMode
          ? `${local ? "The local model" : "OCI"} did not finish the Large Corpus draft within five minutes. The measured corpus report is still useful; process a smaller or more focused source collection and retry.`
          : `${local ? "The local model" : "OCI"} did not finish within the request window. ${local ? "Check that Ollama is running on loopback, or " : ""}retry with fewer attachments.`
        : `${local ? "The local model" : "OCI"} could not generate the paper package.`;
    return errorResponse(
      message,
      status,
      status === 504
        ? local
          ? "LOCAL_LLAMA_TIMEOUT"
          : "OCI_TIMEOUT"
        : local
          ? "LOCAL_LLAMA_ERROR"
          : "OCI_ERROR",
    );
  } finally {
    slot.release();
  }
}
