"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { repairLatexListStructure } from "@/compiler/latex-structure.mjs";
import { getVenueTemplateContract } from "@/compiler/publication-template.mjs";
import {
  isLoopbackHostname,
  parseCompilerPageCount,
  shouldUseDirectPdfCompiler,
  supportsCompilerBridgeProtocol,
} from "@/lib/compiler-browser-bridge.mjs";
import {
  LARGE_CORPUS_ROLES,
  LARGE_CORPUS_SELECTION_POLICY,
  LARGE_CORPUS_WEIGHTING_POLICIES,
} from "@/lib/large-corpus-policy.mjs";
import type {
  ApiErrorBody,
  AttachmentPlanEntry,
  ConfirmedVenueContract,
  GenerationResult,
  LargeCorpusReport,
  LargeCorpusRole,
} from "@/lib/generation-types";
import {
  CUSTOM_PROFILE_ID,
  getPublicationLatexContractForProfile,
  publicationProfiles,
  type PublicationLatexContract,
  type PublicationProfile,
} from "@/lib/publication-profiles";
import {
  syntheticTestFixtureOrder,
  syntheticTestFixtures,
  type SyntheticTestFixtureId,
} from "@/lib/synthetic-test-fixtures";
import {
  defaultSubmissionTypeForProfile,
  isSubmissionTypeAllowed,
  submissionTypesForProfile,
} from "@/lib/submission-types.mjs";
import {
  assessCompiledPageCount,
  getSubmissionPagePolicy,
  pagePolicyTargetText,
} from "@/lib/page-limits.mjs";
import { VENUE_TEMPLATE_OPTIONS } from "@/lib/venue-guidelines.mjs";

type ResultTab = "draft" | "compliance" | "latex" | "checklist";
type ResearchMaterialMode = "standard" | "large_corpus";
type HealthStatus =
  | "checking"
  | "ready"
  | "missing"
  | "project_required"
  | "invalid"
  | "invalid_config"
  | "denied"
  | "model_unavailable"
  | "invalid_response"
  | "unavailable";

interface HealthState {
  configured: boolean | null;
  ready: boolean | null;
  status: HealthStatus;
  message?: string;
  model: string;
  provider: "oci" | "local_llama" | "invalid";
  mode: "cloud_testing" | "isolated" | "invalid";
  transport:
    | "oci_chat"
    | "oci_responses"
    | "local_chat_completions"
    | null;
  contextTokens?: number;
  vision?: boolean;
  profiles: number;
  venueContractSigning?: {
    configured: boolean;
    mode:
      | "dedicated_secret"
      | "invalid_dedicated_secret"
      | "none";
    stableAcrossModelChanges: boolean;
    warning: string;
  };
  checked: boolean;
}

interface CorpusAnalysisState {
  packetText: string;
  artifactToken: string;
  coverage: LargeCorpusReport;
  selectedChunks: CorpusSelectedChunk[];
  inputSignature: string;
  analyzedAt: string;
}

interface CorpusSelectedChunk {
  id: string;
  fileName: string;
  sourceIndex: number;
  chunkIndex: number;
  startChar: number;
  endChar: number;
  partial: boolean;
  score: number;
  lexicalScore: number;
  roleWeight: number;
  sectionRole: LargeCorpusRole;
  sectionHeading: string;
  sectionRoleBasis: "direct" | "inherited" | "unclassified" | "preface";
  sectionRoles: LargeCorpusRole[];
  matchedKeywords: string[];
}

interface VenueGuidelineProposal {
  version: 1;
  venue: string;
  publisher: string;
  submissionType: string;
  source: {
    requestedUrl: string;
    finalUrl: string;
    retrievedAt: string;
    title: string;
    contentType: "text/html" | "text/plain" | "application/pdf";
    sha256: string;
  };
  extractor: {
    model: string;
    version: "venue-guidelines-v1";
  };
  pageLimit: {
    mode:
      | "minimum_pages"
      | "maximum_pages"
      | "exact_pages"
      | "page_range";
    minPages: number | null;
    maxPages: number | null;
    exactPages: number | null;
    countScope:
      | "total_pdf"
      | "content_excluding_references"
      | "unknown";
    strength: "required" | "recommended" | "ambiguous";
    excerpt: string;
    explanation: string;
  } | null;
  template: {
    key: ConfirmedVenueContract["templateKey"];
    strength: "required" | "recommended" | "ambiguous";
    excerpt: string;
    explanation: string;
  } | null;
  rules: Array<{
    id: string;
    category: string;
    label: string;
    requirement: string;
    strength: "required" | "recommended";
    excerpt: string;
  }>;
  unresolved: string[];
}

interface ConfirmedVenueState {
  contract: ConfirmedVenueContract;
  artifact: string;
  inputSignature: string;
}

const loadingMessages = [
  "Reading the manuscript and attachments",
  "Mapping evidence to publication rules",
  "Building the structured author-review draft",
  "Preparing LaTeX and the compliance report",
];

const DEFAULT_PROFILE = publicationProfiles[0];
const DEFAULT_SUBMISSION_TYPE =
  defaultSubmissionTypeForProfile(DEFAULT_PROFILE.id) ?? "";

const MAX_ATTACHMENT_FILES = 12;
const MAX_PDF_FILES = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const STRUCTURED_JSON_DIAGNOSTIC_ID_PATTERN =
  /^(?:llj|oj)-[a-z0-9]{10}$/;
const supportedAttachmentExtensions = new Set([
  "pdf",
  "txt",
  "md",
  "markdown",
  "tex",
  "bib",
  "csv",
  "json",
  "png",
  "jpg",
  "jpeg",
  "webp",
]);
const paperFigureExtensions = new Set(["png", "jpg", "jpeg"]);
const directImageAssetExtensions = new Set(["png", "jpg", "jpeg", "webp"]);
const supportedCorpusExtensions = new Set([
  "pdf",
  "txt",
  "md",
  "markdown",
  "tex",
  "bib",
  "csv",
  "json",
]);

function attachmentPlanKey(file: File) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function defaultAttachmentPlanEntry(
  file: File,
  order: number,
): AttachmentPlanEntry {
  const figure = paperFigureExtensions.has(fileExtension(file.name));
  return {
    fileName: safeAttachmentName(file.name),
    purpose: figure ? "figure" : "source",
    order,
    section: "",
    relativePlacement: "",
    captionOrNote: "",
  };
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "upload") {
    return <svg {...common}><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/></svg>;
  }
  if (name === "spark") {
    return <svg {...common}><path d="m12 3 1.2 4.1a5 5 0 0 0 3.4 3.4l4.1 1.2-4.1 1.2a5 5 0 0 0-3.4 3.4L12 20.4l-1.2-4.1a5 5 0 0 0-3.4-3.4l-4.1-1.2 4.1-1.2a5 5 0 0 0 3.4-3.4L12 3Z"/></svg>;
  }
  if (name === "check") {
    return <svg {...common}><path d="m5 12.5 4.2 4.2L19 7"/></svg>;
  }
  if (name === "alert") {
    return <svg {...common}><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></svg>;
  }
  if (name === "copy") {
    return <svg {...common}><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>;
  }
  if (name === "download") {
    return <svg {...common}><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg>;
  }
  if (name === "external") {
    return <svg {...common}><path d="M14 5h5v5M19 5l-8 8"/><path d="M17 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5"/></svg>;
  }
  if (name === "file") {
    return <svg {...common}><path d="M7 3h7l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v5h5M9 13h6m-6 4h5"/></svg>;
  }
  if (name === "close") {
    return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>;
  }
  if (name === "arrow") {
    return <svg {...common}><path d="M5 12h14m-5-5 5 5-5 5"/></svg>;
  }
  return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 70) || "manuscript";
}

function safeAttachmentName(fileName: string) {
  return fileName.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "attachment";
}

function corpusInputSignature(
  title: string,
  targetVenue: string,
  submissionType: string,
  manuscript: string,
  files: File[],
) {
  return JSON.stringify({
    title,
    targetVenue,
    submissionType,
    manuscript,
    files: files.map((file) => ({
      name: safeAttachmentName(file.name),
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    })),
  });
}

function venueGuidelineInputSignature(
  profileId: string,
  publisher: string,
  venue: string,
  submissionType: string,
  sourceUrl: string,
) {
  return JSON.stringify({
    profileId,
    publisher: publisher.trim(),
    venue: venue.trim(),
    submissionType,
    sourceUrl: sourceUrl.trim(),
  });
}

function defaultVenueTemplateKey(
  profileId: string,
  submissionType: string,
): ConfirmedVenueContract["templateKey"] {
  if (profileId === "ieee-igarss-2026") return "ieee-conference";
  if (profileId === "acm-sigconf") {
    return submissionType === "Camera-ready / final paper"
      ? "acm-sigconf-final"
      : "acm-sigconf-review";
  }
  if (profileId === "springer-lncs") return "springer-lncs";
  if (profileId === "elsevier-research-article") {
    return "elsevier-article";
  }
  return "generic-article";
}

function validVenueGuidelineProposal(
  value: unknown,
): value is VenueGuidelineProposal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proposal = value as Record<string, unknown>;
  const source =
    proposal.source &&
    typeof proposal.source === "object" &&
    !Array.isArray(proposal.source)
      ? (proposal.source as Record<string, unknown>)
      : null;
  return (
    proposal.version === 1 &&
    typeof proposal.venue === "string" &&
    typeof proposal.submissionType === "string" &&
    Boolean(source) &&
    typeof source?.finalUrl === "string" &&
    typeof source?.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(source.sha256) &&
    Array.isArray(proposal.rules) &&
    Array.isArray(proposal.unresolved)
  );
}

function percentage(value: number) {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function validCorpusCoverage(value: unknown): value is LargeCorpusReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const coverage = value as Record<string, unknown>;
  const numericKeys = [
    "sourceCount",
    "totalCharacters",
    "totalChunks",
    "selectedChunks",
    "selectedCharacters",
    "omittedChunks",
    "packetCharacters",
    "mapCharacters",
  ];
  if (numericKeys.some((key) => typeof coverage[key] !== "number")) return false;
  if (
    coverage.enabled !== true ||
    coverage.strategy !== "lexical-section-balanced-v2" ||
    !["empirical-research-v1", "review-synthesis-v1"].includes(
      String(coverage.weightingPolicy),
    ) ||
    !coverage.selectionPolicy ||
    typeof coverage.selectionPolicy !== "object" ||
    Array.isArray(coverage.selectionPolicy) ||
    !Array.isArray(coverage.roleWeights) ||
    coverage.roleWeights.length !== LARGE_CORPUS_ROLES.length ||
    !Array.isArray(coverage.roleCoverage) ||
    coverage.roleCoverage.length !== LARGE_CORPUS_ROLES.length ||
    !Array.isArray(coverage.sources)
  ) {
    return false;
  }
  const selectionPolicy = coverage.selectionPolicy as Record<string, unknown>;
  if (
    Object.entries(LARGE_CORPUS_SELECTION_POLICY).some(
      ([key, value]) => selectionPolicy[key] !== value,
    )
  ) {
    return false;
  }
  const expectedWeights =
    LARGE_CORPUS_WEIGHTING_POLICIES[
      coverage.weightingPolicy as keyof typeof LARGE_CORPUS_WEIGHTING_POLICIES
    ];
  const validRoleWeights = coverage.roleWeights.every((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    const expected = expectedWeights[index];
    return (
      entry.role === expected.role &&
      entry.weight === expected.weight &&
      entry.substantive === expected.substantive
    );
  });
  const validRoleCoverage = coverage.roleCoverage.every((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    const expected = expectedWeights[index];
    return (
      entry.role === expected.role &&
      entry.weight === expected.weight &&
      entry.substantive === expected.substantive &&
      [
        "headingCount",
        "detectedSources",
        "selectedSources",
        "detectedChunks",
        "selectedChunks",
        "selectedCharacters",
      ].every((key) => typeof entry[key] === "number")
    );
  });
  const validSources = coverage.sources.every((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return false;
    const entry = source as Record<string, unknown>;
    return (
      typeof entry.fileName === "string" &&
      [
        "characters",
        "chunks",
        "selectedChunks",
        "selectedCharacters",
      ].every((key) => typeof entry[key] === "number")
    );
  });
  return validRoleWeights && validRoleCoverage && validSources;
}

function validCorpusSelectedChunks(value: unknown): value is CorpusSelectedChunk[] {
  if (!Array.isArray(value) || value.length > 2_000) return false;
  const roleSet = new Set<string>(LARGE_CORPUS_ROLES);
  const basisSet = new Set([
    "direct",
    "inherited",
    "unclassified",
    "preface",
  ]);
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const chunk = item as Record<string, unknown>;
    const integers = [
      "sourceIndex",
      "chunkIndex",
      "startChar",
      "endChar",
      "score",
      "lexicalScore",
      "roleWeight",
    ];
    return (
      typeof chunk.id === "string" &&
      /^source-\d{2}-chunk-\d{4}$/u.test(chunk.id) &&
      typeof chunk.fileName === "string" &&
      chunk.fileName.length > 0 &&
      integers.every(
        (key) =>
          Number.isInteger(chunk[key]) && Number(chunk[key]) >= 0,
      ) &&
      Number(chunk.endChar) > Number(chunk.startChar) &&
      typeof chunk.partial === "boolean" &&
      typeof chunk.sectionRole === "string" &&
      roleSet.has(chunk.sectionRole) &&
      typeof chunk.sectionHeading === "string" &&
      typeof chunk.sectionRoleBasis === "string" &&
      basisSet.has(chunk.sectionRoleBasis) &&
      Array.isArray(chunk.sectionRoles) &&
      chunk.sectionRoles.every(
        (role) => typeof role === "string" && roleSet.has(role),
      ) &&
      Array.isArray(chunk.matchedKeywords) &&
      chunk.matchedKeywords.length <= 96 &&
      chunk.matchedKeywords.every(
        (keyword) => typeof keyword === "string" && keyword.length <= 48,
      )
    );
  });
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadBlob(contents: string, fileName: string, type: string) {
  saveBlob(new Blob([contents], { type }), fileName);
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error(`Could not encode ${file.name}.`));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

interface LatexSourceContext {
  line: number;
  startLine: number;
  endLine: number;
  lines: Array<{ number: number; text: string }>;
}

interface LatexListRepair {
  environment: string;
  line: number;
  action: string;
}

interface SyntheticTestState {
  id: SyntheticTestFixtureId;
  label: string;
  modified: boolean;
}

function compilerSourceLine(details: string[]) {
  const compilerOutput = details.join("\n");
  const patterns = [
    /^error:\s+manuscript\.tex:(\d+)(?::\d+)?/im,
    /manuscript\.tex:(\d+)(?::\d+)?/i,
    /^>\s*(\d+)\s*\|/m,
    /\bl\.(\d+)\b/i,
    /\bline\s+(\d+)\b/i,
  ];
  for (const pattern of patterns) {
    const match = compilerOutput.match(pattern);
    if (!match) continue;
    const line = Number(match[1]);
    if (Number.isSafeInteger(line) && line > 0) return line;
  }
  return null;
}

function sourceContext(source: string, line: number | null): LatexSourceContext | null {
  if (!line) return null;
  const sourceLines = source.replaceAll(/\r\n?/g, "\n").split("\n");
  if (line > sourceLines.length) return null;
  const startLine = Math.max(1, line - 2);
  const endLine = Math.min(sourceLines.length, line + 2);
  return {
    line,
    startLine,
    endLine,
    lines: sourceLines
      .slice(startLine - 1, endLine)
      .map((text, index) => ({ number: startLine + index, text })),
  };
}

async function requestPdfCompilation(
  payload: {
    latex: string;
    title: string;
    profileId: string;
    submissionType: string;
    assets: Array<{
      name: string;
      mimeType: string;
      dataBase64: string;
    }>;
    venueContract: ConfirmedVenueContract | null;
    venueContractArtifact: string;
  },
  signal: AbortSignal,
) {
  const {
    venueContract,
    venueContractArtifact,
    ...staticPayload
  } = payload;
  const compilerPayload = venueContract
    ? { ...staticPayload, venueContract, venueContractArtifact }
    : staticPayload;
  const requestInit: RequestInit = {
    body: JSON.stringify(compilerPayload),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  };
  const response = await fetch("/api/compile", requestInit);
  if (
    !isLoopbackHostname(window.location.hostname) ||
    response.status !== 502
  ) {
    return response;
  }

  try {
    const body = (await response.clone().json()) as {
      code?: string;
      loopbackFallbackAllowed?: unknown;
    };
    if (
      !shouldUseDirectPdfCompiler({
        browserHostname: window.location.hostname,
        status: response.status,
        code: body.code,
        loopbackFallbackAllowed: body.loopbackFallbackAllowed,
      })
    ) {
      return response;
    }
  } catch {
    return response;
  }

  const loopbackRequestOptions = {
    cache: "no-store",
    credentials: "omit",
    mode: "cors",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  } satisfies RequestInit;

  let healthResponse: Response;
  try {
    healthResponse = await fetch(
      "http://127.0.0.1:3101/health",
      loopbackRequestOptions,
    );
  } catch {
    throw new Error(
      "The local PDF compiler could not be reached. Run npm run pdf:setup once, then start Scholar Flow with npm run dev.",
    );
  }

  let health: {
    protocolVersion?: unknown;
    submissionAwareContracts?: unknown;
    pageCountHeaders?: unknown;
    signedDynamicVenueContracts?: unknown;
    venueContractSigningConfigured?: unknown;
  };
  try {
    health = (await healthResponse.json()) as typeof health;
  } catch {
    throw new Error(
      "The local PDF compiler is from an older Scholar Flow version. Restart npm run dev before compiling this submission workflow.",
    );
  }
  if (!supportsCompilerBridgeProtocol(health, healthResponse.ok)) {
    throw new Error(
      "The local PDF compiler is from an older Scholar Flow version. Restart npm run dev before compiling this submission workflow.",
    );
  }
  if (
    venueContract &&
    health.venueContractSigningConfigured !== true
  ) {
    throw new Error(
      "The local PDF compiler does not have a valid venue-contract signing secret. Set the same 32–1,024 byte SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET in .env.local and restart npm run dev.",
    );
  }

  try {
    return await fetch("http://127.0.0.1:3101/compile", {
      ...requestInit,
      ...loopbackRequestOptions,
    });
  } catch {
    throw new Error(
      "The local PDF compiler could not be reached. Run npm run pdf:setup once, then start Scholar Flow with npm run dev.",
    );
  }
}

function latexContractLabel(contract: PublicationLatexContract) {
  const options = contract.requiredOptions.length
    ? `[${contract.requiredOptions.join(",")}]`
    : "";
  return `${contract.documentClass}${options}`;
}

function paperToMarkdown(
  result: GenerationResult,
  syntheticTest: SyntheticTestState | null = null,
) {
  const sections = result.paper.sections.flatMap((section) => [
    `## ${section.heading}`,
    "",
    section.body,
    "",
  ]);
  const figurePlan = result.paper.figurePlacements.flatMap((figure) => [
    `### ${figure.fileName}`,
    "",
    figure.caption,
    "",
    `_Placement: ${figure.placementNote}_`,
    "",
  ]);

  return [
    ...(syntheticTest
      ? [
          "# SYNTHETIC TEST OUTPUT - NOT FOR SUBMISSION",
          "",
          `Fixture: ${syntheticTest.label}${syntheticTest.modified ? " (modified or mixed with user edits)" : ""}`,
          "",
        ]
      : []),
    `# ${result.paper.title}`,
    "",
    "## Abstract",
    "",
    result.paper.abstract,
    "",
    "## Keywords",
    "",
    result.paper.keywords.join(", "),
    "",
    ...sections,
    ...(figurePlan.length ? ["## Figure and table plan", "", ...figurePlan] : []),
  ].join("\n").trimEnd() + "\n";
}

function ProfileSidebar({
  profile,
  isCustom,
  customPublisher,
  submissionType,
  targetVenue,
  confirmedVenue,
}: {
  profile?: PublicationProfile;
  isCustom: boolean;
  customPublisher: string;
  submissionType: string;
  targetVenue: string;
  confirmedVenue: ConfirmedVenueState | null;
}) {
  if (confirmedVenue) {
    const contract = confirmedVenue.contract;
    const template = getVenueTemplateContract(contract.templateKey);
    return (
      <aside className="profile-card">
        <div className="profile-topline">
          <span className="profile-kicker">Exact venue snapshot</span>
          <span className="status-pill starter">Author confirmed</span>
        </div>
        <h2>{contract.venue}</h2>
        <p className="profile-publisher">{contract.publisher || customPublisher || profile?.publisher || "Publisher not entered"}</p>
        <div className="profile-meta-row"><span>{contract.pagePolicy ? pagePolicyTargetText(contract.pagePolicy) : "No hard page contract"}</span><span>{template ? latexContractLabel(template) : contract.templateKey}</span><span>{contract.confirmedAt.slice(0, 10)}</span></div>
        <p className="profile-description">Extracted from one locally uploaded official source and explicitly reviewed by the author. This is not a publisher-certified profile.</p>
        <div className="rule-stack">
          {contract.rules.map((rule, index) => <div className="rule-row" key={rule.id} title={rule.excerpt}><span className="rule-index">{String(index + 1).padStart(2, "0")}</span><div><div className="rule-title-line"><strong>{rule.label}</strong><span>{rule.strength}</span></div><p>{rule.requirement}</p></div></div>)}
        </div>
        {contract.unresolved.length > 0 && <div className="unresolved-box"><p className="mini-heading">Still needs author review</p><ul>{contract.unresolved.map((rule) => <li key={rule}>{rule}</li>)}</ul></div>}
        <div className="profile-source-box"><div><span className="source-dot"/><p><strong>Local snapshot loaded</strong><small>{contract.source.retrievedAt.slice(0, 10)}</small></p></div><div className="source-links"><span>SHA-256 {contract.source.sha256.slice(0, 12)}…</span></div></div>
        <p className="profile-caveat">Outside this isolated session, recheck the publisher&apos;s current source, track, and effective date before submission.</p>
      </aside>
    );
  }

  if (isCustom) {
    return (
      <aside className="profile-card profile-card-custom">
        <div className="profile-topline">
          <span className="profile-kicker">Custom profile</span>
          <span className="status-pill starter">Author supplied</span>
        </div>
        <h2>{targetVenue || "Exact publication needed"}</h2>
        <p className="profile-publisher">{customPublisher || "Publisher not entered"}</p>
        <div className="profile-meta-row"><span>article fallback</span><span>Single author-review source</span></div>
        <div className="profile-explainer">
          <Icon name="info" />
          <p>Upload one official HTML, text, or searchable PDF source, review the locally extracted proposal, and confirm it—or use the review-only pasted-guidance fallback.</p>
        </div>
        <div className="rule-stack">
          <div className="rule-row"><span className="rule-index">01</span><div><strong>Source text</strong><p>Only pasted guidance is treated as evidence.</p></div></div>
          <div className="rule-row"><span className="rule-index">02</span><div><strong>Human verification</strong><p>Dates, track, anonymity, and final format remain unresolved.</p></div></div>
        </div>
      </aside>
    );
  }

  if (!profile) return null;
  const submissionContract = getPublicationLatexContractForProfile(
    profile.id,
    submissionType,
  );
  return (
    <aside className="profile-card">
      <div className="profile-topline">
        <span className="profile-kicker">Selected rule profile</span>
        <span className={`status-pill ${profile.confidence}`}>
          {profile.confidence === "verified" ? "Verified venue" : "Publisher starter"}
        </span>
      </div>
      <h2>{profile.shortName}</h2>
      <p className="profile-publisher">{profile.publisher}</p>
      <div className="profile-meta-row">
        <span>{profile.template.layout}</span>
        <span>{latexContractLabel(submissionContract)} {submissionContract.classBasis === "compiler-fallback" ? "compiler fallback" : "class"}</span>
        <span>{profile.status === "closed" ? "2026 cycle closed" : profile.edition}</span>
      </div>
      <p className="profile-description">{profile.description}</p>

      <div className="rule-stack">
        {profile.rules.map((rule, index) => (
          <div className="rule-row" key={rule.id} title={rule.detail}>
            <span className="rule-index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <div className="rule-title-line"><strong>{rule.label}</strong><span>{rule.level}</span></div>
              <p>{rule.value}</p>
            </div>
          </div>
        ))}
      </div>

      {profile.unresolvedRules.length > 0 && (
        <div className="unresolved-box">
          <p className="mini-heading">Exact venue still decides</p>
          <ul>{profile.unresolvedRules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
        </div>
      )}

      <div className="profile-source-box">
        <div><span className="source-dot"/><p><strong>Sources checked</strong><small>{profile.retrievedAt}</small></p></div>
        <div className="source-links">
          {profile.sources.map((source) => (
            <span key={source.url} title="External navigation is disabled in Scholar Flow.">
              {source.label}
            </span>
          ))}
        </div>
      </div>
      <p className="profile-caveat">{profile.caveat}</p>
    </aside>
  );
}

function ResultWorkspace({
  result,
  generatedFiles,
  syntheticTest,
}: {
  result: GenerationResult;
  generatedFiles: File[];
  syntheticTest: SyntheticTestState | null;
}) {
  const [tab, setTab] = useState<ResultTab>("draft");
  const [copied, setCopied] = useState(false);
  const [pdfStatus, setPdfStatus] = useState<"idle" | "compiling" | "success" | "error">("idle");
  const [pdfMessage, setPdfMessage] = useState("");
  const [pdfDetails, setPdfDetails] = useState<string[]>([]);
  const [pdfPageMeasurement, setPdfPageMeasurement] = useState<{
    totalPages: number;
    contentPages: number | null;
  } | null>(null);
  const [editableLatex, setEditableLatex] = useState(result.latex);
  const [lastCompileLatex, setLastCompileLatex] = useState(result.latex);
  const [latexRepairs, setLatexRepairs] = useState<LatexListRepair[]>([]);
  const [isEditingLatex, setIsEditingLatex] = useState(false);
  const pdfControllerRef = useRef<AbortController | null>(null);
  const latexEditorRef = useRef<HTMLTextAreaElement>(null);
  const editableLatexRef = useRef(editableLatex);
  const titleSlug = slugify(result.paper.title);
  const downloadSlug = syntheticTest
    ? `synthetic-test-${titleSlug}`
    : titleSlug;
  const expectedContract =
    (result.metadata.venueContract
      ? getVenueTemplateContract(
          result.metadata.venueContract.contract.templateKey,
        )
      : null) ??
    getPublicationLatexContractForProfile(
      result.metadata.profileId,
      result.metadata.submissionType,
    );
  const expectedDocumentClass = latexContractLabel(expectedContract);
  const pagePolicy =
    result.metadata.venueContract?.contract.pagePolicy ??
    getSubmissionPagePolicy(
      result.metadata.profileId,
      result.metadata.submissionType,
    );
  const latexWasEdited = editableLatex !== result.latex;
  const sourceChangedSinceFailure =
    pdfStatus === "error" && editableLatex !== lastCompileLatex;
  const errorLine = useMemo(() => compilerSourceLine(pdfDetails), [pdfDetails]);
  const errorContext = useMemo(
    () => sourceContext(lastCompileLatex, errorLine),
    [errorLine, lastCompileLatex],
  );
  const errorFocusKey = useMemo(
    () => (pdfStatus === "error" && errorLine ? `${errorLine}:${pdfDetails.join("\n")}` : ""),
    [errorLine, pdfDetails, pdfStatus],
  );
  const counts = useMemo(() => {
    return result.compliance.reduce<Record<string, number>>((acc, item) => {
      acc[item.status] = (acc[item.status] ?? 0) + 1;
      return acc;
    }, {});
  }, [result.compliance]);
  const compiledPageAssessment = useMemo(
    () =>
      pagePolicy && pdfPageMeasurement
        ? assessCompiledPageCount(pagePolicy, pdfPageMeasurement)
        : null,
    [pagePolicy, pdfPageMeasurement],
  );

  async function copyLatex() {
    await navigator.clipboard.writeText(editableLatex);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  useEffect(() => {
    editableLatexRef.current = editableLatex;
  }, [editableLatex]);

  useEffect(() => {
    return () => {
      pdfControllerRef.current?.abort();
      pdfControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (
      pdfStatus !== "error" ||
      tab !== "latex" ||
      !isEditingLatex ||
      !errorLine ||
      !errorFocusKey
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const editor = latexEditorRef.current;
      if (!editor) return;
      const normalizedSource = editableLatexRef.current.replaceAll(/\r\n?/g, "\n");
      const beforeLine = normalizedSource
        .split("\n")
        .slice(0, errorLine - 1)
        .join("\n");
      const start = beforeLine.length + (errorLine > 1 ? 1 : 0);
      const lineText = normalizedSource.split("\n")[errorLine - 1] ?? "";
      editor.focus();
      editor.setSelectionRange(start, start + lineText.length);
      const lineRatio = (errorLine - 1) / Math.max(1, normalizedSource.split("\n").length - 1);
      editor.scrollTop = Math.max(
        0,
        lineRatio * editor.scrollHeight - editor.clientHeight / 3,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [errorFocusKey, errorLine, isEditingLatex, pdfStatus, tab]);

  function updateLatex(nextLatex: string) {
    setEditableLatex(nextLatex);
    if (pdfPageMeasurement) {
      setPdfPageMeasurement(null);
      setPdfStatus("idle");
      setPdfMessage("");
      setPdfDetails([]);
    }
  }

  function resetLatex() {
    if (
      latexWasEdited &&
      !window.confirm("Discard your LaTeX edits and restore the generated source?")
    ) {
      return;
    }
    setEditableLatex(result.latex);
    setPdfStatus("idle");
    setPdfMessage("");
    setPdfDetails([]);
    setPdfPageMeasurement(null);
    setLatexRepairs([]);
  }

  async function compilePdf() {
    const plannedFigureNames = result.metadata.attachmentPlan
      .filter((entry) => entry.purpose === "figure")
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.fileName);
    const filesBySafeName = new Map<string, File>();
    let duplicateName = "";
    for (const file of generatedFiles) {
      const safeName = safeAttachmentName(file.name);
      if (filesBySafeName.has(safeName)) duplicateName = safeName;
      filesBySafeName.set(safeName, file);
    }
    if (duplicateName) {
      setPdfStatus("error");
      setPdfMessage(
        `Two figure names become ${duplicateName} after safe filename conversion. Rename one attachment and generate the paper again.`,
      );
      return;
    }
    const missingFigureNames = plannedFigureNames.filter(
      (fileName) => !filesBySafeName.has(fileName),
    );
    if (missingFigureNames.length) {
      setPdfStatus("error");
      setPdfMessage(
        `The planned figure ${missingFigureNames.join(", ")} is no longer available in this browser session. Attach it again and regenerate the paper.`,
      );
      return;
    }
    const figureFiles = plannedFigureNames.map(
      (fileName) => filesBySafeName.get(fileName) as File,
    );

    let repairResult: { latex: string; repairs: LatexListRepair[] };
    try {
      repairResult = repairLatexListStructure(editableLatex) as {
        latex: string;
        repairs: LatexListRepair[];
      };
    } catch {
      setPdfStatus("error");
      setPdfMessage(
        "Scholar Flow could not inspect the LaTeX list structure. Review the editable source before retrying.",
      );
      setPdfDetails([]);
      setTab("latex");
      setIsEditingLatex(true);
      return;
    }
    const sourceToCompile = repairResult.latex;
    const repairs = Array.isArray(repairResult.repairs) ? repairResult.repairs : [];
    if (sourceToCompile !== editableLatex) setEditableLatex(sourceToCompile);
    setLatexRepairs(repairs);
    setPdfStatus("compiling");
    setPdfMessage(
      repairs.length
        ? `Applied ${repairs.length} conservative LaTeX list ${repairs.length === 1 ? "fix" : "fixes"}; compiling the repaired source…`
        : "Compiling the current LaTeX in the configured PDF service…",
    );
    setPdfDetails([]);
    setPdfPageMeasurement(null);
    setLastCompileLatex(sourceToCompile);
    const controller = new AbortController();
    pdfControllerRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 90_000);

    try {
      const assets = await Promise.all(
        figureFiles.map(async (file) => ({
          name: safeAttachmentName(file.name),
          mimeType:
            fileExtension(file.name) === "png"
              ? "image/png"
              : "image/jpeg",
          dataBase64: await fileToBase64(file),
        })),
      );
      const response = await requestPdfCompilation(
        {
          latex: sourceToCompile,
          title: result.paper.title,
          profileId: result.metadata.profileId,
          submissionType: result.metadata.submissionType,
          assets,
          venueContract:
            result.metadata.venueContract?.contract ?? null,
          venueContractArtifact:
            result.metadata.venueContract?.artifact ?? "",
        },
        controller.signal,
      );

      if (!response.ok) {
        let message = `PDF compilation failed (HTTP ${response.status}).`;
        let details: string[] = [];
        const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
        try {
          if (contentType.includes("json")) {
            const body = (await response.json()) as {
              error?: string | { message?: string; detail?: string };
              details?: string[];
            };
            const compilerMessage =
              typeof body.error === "string" ? body.error : body.error?.message;
            const compilerDetail =
              typeof body.error === "object" ? body.error?.detail : "";
            details = [
              ...(Array.isArray(body.details)
                ? body.details.filter(
                    (detail): detail is string => typeof detail === "string" && Boolean(detail.trim()),
                  )
                : []),
              ...(compilerDetail ? [compilerDetail] : []),
            ];
            message =
              compilerMessage ||
              message;
          } else {
            const responseText = (await response.text()).replaceAll(/\s+/g, " ").trim();
            if (responseText) message = responseText.slice(0, 320);
          }
        } catch {
          // The HTTP status remains useful if the compiler's error body is unreadable.
        }
        throw Object.assign(new Error(message), { details });
      }

      if (
        result.metadata.venueContract &&
        (response.headers.get("x-scholar-flow-protocol-version") !== "4" ||
          response.headers.get(
            "x-scholar-flow-signed-dynamic-venue-contracts",
          ) !== "true")
      ) {
        throw new Error(
          "The PDF compiler response did not confirm signed dynamic venue support. Restart Scholar Flow and its compiler, then retry.",
        );
      }

      const pdfBytes = await response.arrayBuffer();
      const signature = new Uint8Array(pdfBytes, 0, Math.min(5, pdfBytes.byteLength));
      if (
        signature.length < 5 ||
        signature[0] !== 0x25 ||
        signature[1] !== 0x50 ||
        signature[2] !== 0x44 ||
        signature[3] !== 0x46 ||
        signature[4] !== 0x2d
      ) {
        throw new Error("The PDF service returned an invalid file. Nothing was downloaded.");
      }

      const totalPages = parseCompilerPageCount(
        response.headers.get("x-scholar-flow-total-pages"),
      );
      const contentPages = parseCompilerPageCount(
        response.headers.get("x-scholar-flow-content-pages"),
      );
      if (
        !totalPages ||
        (pagePolicy?.countScope ===
          "content_excluding_references" &&
          !contentPages)
      ) {
        throw new Error(
          "The compiler did not return the required page measurements. Restart Scholar Flow and its PDF compiler, then retry.",
        );
      }
      setPdfPageMeasurement({ totalPages, contentPages });
      const pageAssessment = pagePolicy
        ? assessCompiledPageCount(pagePolicy, { totalPages, contentPages })
        : null;
      if (
        pageAssessment &&
        (pageAssessment.status === "fail" ||
          pageAssessment.status === "unavailable")
      ) {
        setPdfStatus("error");
        setPdfMessage(
          `${pageAssessment.message} The download was blocked. Edit the current LaTeX and retry; this does not make another model request.`,
        );
        setTab("latex");
        setIsEditingLatex(true);
        return;
      }

      saveBlob(new Blob([pdfBytes], { type: "application/pdf" }), `${downloadSlug}.pdf`);
      setPdfStatus("success");
      setPdfMessage(
        `${repairs.length ? `PDF downloaded after ${repairs.length} conservative list ${repairs.length === 1 ? "fix" : "fixes"}. ` : "PDF downloaded. "}${pageAssessment?.message ?? `The compiler measured ${totalPages} total ${totalPages === 1 ? "page" : "pages"}.`} Review its layout, fonts, figures, citations, and accessibility before submission.`,
      );
    } catch (error) {
      const details =
        error instanceof Error &&
        "details" in error &&
        Array.isArray((error as Error & { details?: unknown }).details)
          ? (error as Error & { details: string[] }).details
          : [];
      setPdfStatus("error");
      setPdfDetails(details);
      setPdfMessage(
        controller.signal.aborted
          ? "PDF compilation took longer than 90 seconds and was stopped. Try again, or download the .tex file and compile it locally."
          : error instanceof Error
            ? error.message
            : "The PDF could not be compiled. Download the .tex file and inspect it before trying again.",
      );
      if (!controller.signal.aborted && details.length) {
        setTab("latex");
        setIsEditingLatex(true);
      }
    } finally {
      window.clearTimeout(timeout);
      if (pdfControllerRef.current === controller) pdfControllerRef.current = null;
    }
  }

  return (
    <section className="result-shell" aria-live="polite">
      {syntheticTest && (
        <div className="synthetic-output-banner" role="note">
          <Icon name="alert"/>
          <p><strong>Synthetic test output - not for submission</strong><span>{syntheticTest.label}{syntheticTest.modified ? " was modified and may contain mixed test and user material." : " uses entirely fictional test material."} Downloaded filenames are prefixed with synthetic-test.</span></p>
        </div>
      )}
      <div className="result-header">
        <div>
          <p className="eyebrow">Author-review package</p>
          <h2>{result.paper.title}</h2>
          <p>{result.metadata.profileName} · Generated with {result.metadata.model} · {new Date(result.metadata.generatedAt).toLocaleString()}</p>
        </div>
        <div className="result-actions">
          <button className="secondary-button" onClick={() => downloadBlob(paperToMarkdown(result, syntheticTest), `${downloadSlug}-draft.md`, "text/markdown")} type="button"><Icon name="download"/>Paper draft (.md)</button>
          <button className="secondary-button dark" onClick={() => downloadBlob(editableLatex, `${downloadSlug}.tex`, "application/x-tex")} type="button"><Icon name="download"/>{latexWasEdited ? "Download edited LaTeX" : "Download LaTeX (.tex)"}</button>
          <button aria-describedby="pdf-compile-note pdf-compile-status" className="secondary-button pdf-button" disabled={pdfStatus === "compiling"} onClick={compilePdf} type="button">{pdfStatus === "compiling" ? <><span className="spinner"/>Compiling PDF…</> : <><Icon name="download"/>Compile &amp; download PDF</>}</button>
          <button className="secondary-button" onClick={() => downloadBlob(JSON.stringify({ ...result, latex: editableLatex, ...(syntheticTest ? { syntheticTest: { ...syntheticTest, notForSubmission: true } } : {}) }, null, 2), `${downloadSlug}-report.json`, "application/json")} type="button"><Icon name="download"/>Full report (.json)</button>
        </div>
      </div>

      <div className="result-output-summary" aria-label="Generated files and views">
        <div><Icon name="check"/><p><strong>Paper draft ready</strong><span>Read it below or download the Markdown file.</span></p></div>
        <div><Icon name="check"/><p><strong>{expectedContract.classBasis === "compiler-fallback" ? "Compiler fallback validated" : "Publisher template validated"}</strong><span>Generated source passed the {expectedDocumentClass} contract for {result.metadata.submissionType}.</span></p></div>
        <div><Icon name="file"/><p><strong>PDF available on demand</strong><span>Compile the LaTeX and download a PDF for author review.</span></p></div>
        <div><Icon name="check"/><p><strong>Review report ready</strong><span>Check every rule, warning, and author action.</span></p></div>
      </div>

      <div className="pdf-compile-note" id="pdf-compile-note"><Icon name="info"/><p><strong>PDF compilation is a separate author-review step.</strong> Clicking the PDF button rechecks the current source against the {expectedDocumentClass} publication contract, then sends it with the PNG/JPG figures saved with this generation to Scholar Flow&apos;s loopback-only LaTeX compiler. It does not make another model request. Uploaded manuscript PDFs and other source files are not sent. {pagePolicy ? `The compiler measures the PDF and blocks a download unless it contains ${pagePolicyTargetText(pagePolicy)}. ` : ""}Always inspect the result; a successful compile does not certify every publisher rule.</p></div>
      <div aria-atomic="true" aria-live={pdfStatus === "error" ? "assertive" : "polite"} className={`pdf-compile-status ${pdfStatus}`} id="pdf-compile-status" role={pdfStatus === "error" ? "alert" : "status"}>{pdfMessage && <><Icon name={pdfStatus === "success" ? "check" : pdfStatus === "error" ? "alert" : "info"}/><p>{pdfMessage}</p></>}</div>

      <div className="result-tabs" role="tablist" aria-label="Generated package views">
        {(["draft", "compliance", "latex", "checklist"] as ResultTab[]).map((item) => (
          <button aria-controls={`result-panel-${item}`} aria-selected={tab === item} className={tab === item ? "active" : ""} id={`result-tab-${item}`} key={item} onClick={() => setTab(item)} role="tab" tabIndex={tab === item ? 0 : -1} type="button">
            {item === "draft" ? "Paper draft" : item === "latex" ? "LaTeX source" : item}
            {item === "compliance" && <span>{result.compliance.length}</span>}
          </button>
        ))}
      </div>

      {tab === "draft" && (
        <div aria-labelledby="result-tab-draft" className="draft-view" id="result-panel-draft" role="tabpanel">
          <div className="draft-toolbar"><p><strong>Generated paper draft</strong><span>Review and edit this author draft before submission.</span></p><button className="secondary-button" onClick={() => downloadBlob(paperToMarkdown(result, syntheticTest), `${downloadSlug}-draft.md`, "text/markdown")} type="button"><Icon name="download"/>Download draft (.md)</button></div>
          <div className="abstract-card">
            <p className="mini-heading">Abstract</p>
            <p>{result.paper.abstract}</p>
            <div className="keyword-row">{result.paper.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div>
          </div>
          {result.paper.sections.map((section, index) => (
            <article className="generated-section" key={`${section.heading}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{section.heading}</h3><p>{section.body}</p></div>
            </article>
          ))}
          {result.paper.figurePlacements.length > 0 && (
            <div className="figure-plan">
              <p className="mini-heading">Figure and table plan</p>
              {result.paper.figurePlacements.map((figure) => (
                <div key={`${figure.fileName}-${figure.caption}`}><Icon name="file"/><p><strong>{figure.fileName}</strong><span>{figure.caption}</span><small>{figure.placementNote}</small></p></div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "compliance" && (
        <div aria-labelledby="result-tab-compliance" className="compliance-view" id="result-panel-compliance" role="tabpanel">
          {pagePolicy && (
            <div className={`compiled-page-check ${compiledPageAssessment?.status ?? "pending"}`}>
              <Icon name={compiledPageAssessment?.status === "pass" ? "check" : "alert"}/>
              <p><strong>Compiled PDF page contract</strong><span>{compiledPageAssessment?.message ?? `Compile the current source to verify ${pagePolicyTargetText(pagePolicy)}. Model-estimated pagination is not treated as a pass.`}</span></p>
            </div>
          )}
          <div className="score-strip">
            <div><strong>{counts.pass ?? 0}</strong><span>Pass</span></div>
            <div><strong>{counts.review ?? 0}</strong><span>Review</span></div>
            <div><strong>{counts.fail ?? 0}</strong><span>Fail</span></div>
            <p>This is a drafting check, not publisher certification.</p>
          </div>
          <div className="compliance-list">
            {result.compliance.map((item) => (
              <div className="compliance-row" key={`${item.ruleId}-${item.label}`}>
                <span className={`compliance-icon ${item.status}`}><Icon name={item.status === "pass" ? "check" : "alert"}/></span>
                <div><div className="compliance-title"><strong>{item.label}</strong><code>{item.ruleId}</code><span className={item.status}>{item.status.replaceAll("_", " ")}</span></div><p>{item.evidence}</p>{item.action && <small>Author action: {item.action}</small>}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "latex" && (
        <div aria-labelledby="result-tab-latex" className="latex-view" id="result-panel-latex" role="tabpanel">
          <div className="latex-safety"><Icon name="alert"/><p><strong>Generated LaTeX is untrusted source code.</strong> Review it before use and compile only in an isolated environment with shell escape disabled. This app rejects known file, shell, and Lua execution primitives but cannot prove source safety.</p></div>
          {latexRepairs.length > 0 && <div className="latex-repair-note"><Icon name="check"/><div><strong>Conservative list repair applied before the latest compile</strong><p>Scholar Flow updated the editable source, so downloads, copy, the JSON report, and retry all use the repaired version.</p><ul>{latexRepairs.map((repair, index) => <li key={`${repair.environment}-${repair.line}-${index}`}><code>line {repair.line}</code><span>{repair.environment}: {repair.action}</span></li>)}</ul></div></div>}
          {pdfStatus === "error" && pdfDetails.length > 0 && (
            <section aria-labelledby="latex-compiler-error-title" className="latex-error-workbench">
              <div className="latex-error-heading"><Icon name="alert"/><div><h3 id="latex-compiler-error-title">Compiler feedback</h3><p><strong>{pdfMessage}</strong><span>{errorContext ? `The compiler pointed to line ${errorContext.line} in the failed source. Review the highlighted context, edit below, then retry.` : "The compiler did not return a reliable line number. Review its details, edit the source below, then retry."}</span></p></div></div>
              {errorContext && (
                <div aria-label={`LaTeX source around compiler line ${errorContext.line}`} className="latex-source-context">
                  {errorContext.lines.map((line) => <div className={line.number === errorContext.line ? "active" : ""} key={line.number}><span>{line.number}</span><code>{line.text || " "}</code></div>)}
                </div>
              )}
              <details><summary>Show compiler details</summary><pre className="compiler-log">{pdfDetails.join("\n\n")}</pre></details>
              <div className="latex-error-actions"><button className="secondary-button pdf-button" onClick={compilePdf} type="button"><Icon name="download"/>Retry PDF with edited source</button><span>{sourceChangedSinceFailure ? "Source changed since this failure. Retry to test your fix; no regeneration is needed." : "Edit the source below before retrying."}</span></div>
            </section>
          )}
          <div className="code-toolbar"><p><span/><span/><span/>{latexWasEdited ? "Edited LaTeX source (.tex)" : "Generated LaTeX source (.tex)"}</p><div className="code-toolbar-actions"><button aria-describedby="pdf-compile-note pdf-compile-status" disabled={pdfStatus === "compiling"} onClick={compilePdf} type="button">{pdfStatus === "compiling" ? <><span className="spinner"/>Compiling…</> : <><Icon name="download"/>{pdfStatus === "error" ? "Retry PDF" : "Download PDF"}</>}</button><button className={isEditingLatex ? "active" : ""} disabled={pdfStatus === "compiling"} onClick={() => setIsEditingLatex((current) => !current)} type="button"><Icon name={isEditingLatex ? "file" : "copy"}/>{isEditingLatex ? "Preview source" : "Edit source"}</button>{latexWasEdited && <button disabled={pdfStatus === "compiling"} onClick={resetLatex} type="button"><Icon name="close"/>Reset generated</button>}<button onClick={() => downloadBlob(editableLatex, `${downloadSlug}.tex`, "application/x-tex")} type="button"><Icon name="download"/>Download .tex</button><button onClick={copyLatex} type="button"><Icon name={copied ? "check" : "copy"}/>{copied ? "Copied" : "Copy code"}</button></div></div>
          {isEditingLatex ? <textarea aria-label="Editable LaTeX source" className="latex-source-editor" disabled={pdfStatus === "compiling"} onChange={(event) => updateLatex(event.target.value)} ref={latexEditorRef} spellCheck={false} value={editableLatex}/> : <pre><code>{editableLatex}</code></pre>}
          <div className="latex-source-meta"><span>{editableLatex.split(/\r?\n/).length.toLocaleString()} lines · {editableLatex.length.toLocaleString()} characters</span><span>{latexWasEdited ? "Edited locally — retry PDF or download the revised .tex file." : "Switch to Edit source to fix compiler feedback without regenerating the paper."}</span></div>
        </div>
      )}

      {tab === "checklist" && (
        <div aria-labelledby="result-tab-checklist" className="checklist-grid" id="result-panel-checklist" role="tabpanel">
          <div className="checklist-card warning-list"><p className="mini-heading">Warnings to resolve</p>{result.warnings.length ? result.warnings.map((warning) => <div key={warning}><Icon name="alert"/><p>{warning}</p></div>) : <p className="empty-note">No warnings returned.</p>}</div>
          <div className="checklist-card action-list"><p className="mini-heading">Author checklist</p>{result.authorChecklist.map((action) => <div key={action}><Icon name="check"/><p>{action}</p></div>)}</div>
          <div className="checklist-card provenance-card"><p className="mini-heading">Rule provenance</p><p className="provenance-summary"><strong>{result.metadata.targetVenue}</strong><span>{result.metadata.venueContract ? `Author-confirmed local snapshot · ${result.metadata.venueContract.contract.contractId}` : result.metadata.profileAuthority === "venue" && result.metadata.profileConfidence === "verified" ? "Curated venue profile" : "Publisher or author-supplied starter profile — human confirmation required"}</span></p><div className="provenance-links">{result.metadata.profileSources.length ? result.metadata.profileSources.map((source) => <span key={`${source.label}-${source.url}`} title="External navigation is disabled in Scholar Flow.">{source.label}</span>) : <p>No source reference was supplied. Confirm every rule directly with the publication outside Scholar Flow.</p>}</div></div>
        </div>
      )}
    </section>
  );
}

function CorpusCoveragePanel({
  analysis,
  isCurrent,
  onClear,
}: {
  analysis: CorpusAnalysisState;
  isCurrent: boolean;
  onClear: () => void;
}) {
  const { coverage } = analysis;
  const representedSources = coverage.sources.filter(
    (source) => source.selectedChunks > 0,
  ).length;
  const omittedSources = Math.max(
    0,
    coverage.sourceCount - representedSources,
  );
  const sourceCoverage = coverage.sourceCount
    ? representedSources / coverage.sourceCount
    : 0;
  const detectedRoles = coverage.roleCoverage.filter(
    (role) => role.detectedChunks > 0,
  );
  const selectedRoles = detectedRoles.filter(
    (role) => role.selectedChunks > 0,
  );
  const weightingPolicyLabel =
    coverage.weightingPolicy === "review-synthesis-v1"
      ? "Review synthesis"
      : "Empirical research";
  return (
    <section
      aria-labelledby="corpus-coverage-title"
      className={`corpus-coverage-panel ${isCurrent ? "current" : "stale"}`}
    >
      <div className="corpus-coverage-heading">
        <div>
          <p className="eyebrow">Corpus evidence coverage</p>
          <h3 id="corpus-coverage-title">
            {isCurrent ? "Analysis ready for drafting" : "Analysis is out of date"}
          </h3>
          <p>
            Processed {new Date(analysis.analyzedAt).toLocaleString()}. The signed
            packet is valid for 30 minutes. Scholar Flow combines title, venue,
            and note relevance with fixed {weightingPolicyLabel.toLowerCase()}{" "}
            section-role weights. Directly recognized headings receive role
            bonuses; lower-level headings may inherit a detected parent role,
            while unknown top-level headings and the preface remain unclassified.
            The audit below shows that basis. It seeds every source and detected
            substantive role when the character budget permits, then restores
            source order before drafting. This transparent heuristic is not proof
            that every claim was understood or cited. Selection happens before
            model request, so the model cannot recover prose marked omitted; PDF content
            stream order may also differ from visual reading order in complex
            multi-column files.
          </p>
        </div>
        <div className="corpus-coverage-actions">
          <span className={`corpus-status-pill ${isCurrent ? "ready" : "stale"}`}>
            {isCurrent ? "Current" : "Process again"}
          </span>
          <button className="secondary-button" onClick={onClear} type="button">
            Clear analysis
          </button>
        </div>
      </div>

      {!isCurrent && (
        <p aria-live="polite" className="corpus-stale-notice">
          <Icon name="alert" size={15}/>
          The title, venue, submission type, manuscript, or corpus files changed
          after this report. Process the corpus again before generating.
        </p>
      )}

      <dl className="corpus-coverage-stats">
        <div><dt>Sources selected</dt><dd>{representedSources} of {coverage.sourceCount}</dd></div>
        <div><dt>Sources omitted</dt><dd>{omittedSources}</dd></div>
        <div><dt>Source coverage</dt><dd>{percentage(sourceCoverage)}</dd></div>
        <div><dt>Section roles selected</dt><dd>{selectedRoles.length} of {detectedRoles.length}</dd></div>
        <div><dt>Weighting policy</dt><dd>{weightingPolicyLabel}</dd></div>
        <div><dt>Unique excerpt characters</dt><dd>{coverage.selectedCharacters.toLocaleString()}</dd></div>
        <div><dt>Corpus map</dt><dd>{coverage.mapCharacters.toLocaleString()} chars</dd></div>
        <div><dt>Evidence packet</dt><dd>{coverage.packetCharacters.toLocaleString()} chars</dd></div>
      </dl>

      {coverage.omittedChunks > 0 && (
        <p className="corpus-limit-notice">
          <Icon name="alert" size={15}/>
          The bounded packet omitted {coverage.omittedChunks.toLocaleString()} of {coverage.totalChunks.toLocaleString()} candidate chunks. Omitted and partially represented sources remain visible below; the final draft must not be treated as a full-corpus review.
        </p>
      )}

      <details className="corpus-audit-details">
        <summary>Inspect corpus map and selected evidence</summary>
        <p>
          The map reports unique selected characters for every detected section.
          Scores combine lexical relevance with the primary section-role bonus;
          they are ranking signals, not confidence scores.
        </p>
        <pre>{analysis.packetText.slice(0, coverage.mapCharacters)}</pre>
        <div
          aria-label="Selected corpus evidence audit"
          className="corpus-coverage-table-wrap"
          role="region"
          tabIndex={0}
        >
          <table className="corpus-coverage-table corpus-audit-table">
            <caption>Selected evidence chunks in restored source order</caption>
            <thead>
              <tr>
                <th scope="col">Source / chunk</th>
                <th scope="col">Character range</th>
                <th scope="col">Primary role</th>
                <th scope="col">Score</th>
                <th scope="col">Matched query terms</th>
              </tr>
            </thead>
            <tbody>
              {analysis.selectedChunks.map((chunk) => (
                <tr key={chunk.id}>
                  <th scope="row">{chunk.fileName} · {chunk.chunkIndex + 1}</th>
                  <td>{chunk.startChar.toLocaleString()}–{chunk.endChar.toLocaleString()}{chunk.partial ? " · partial excerpt" : ""}</td>
                  <td>{chunk.sectionRole.replaceAll("-", " ")} · {chunk.sectionRoleBasis}{chunk.sectionHeading ? ` · ${chunk.sectionHeading}` : ""}</td>
                  <td>{chunk.score} = {chunk.lexicalScore} lexical + {chunk.roleWeight} role</td>
                  <td>{chunk.matchedKeywords.length ? chunk.matchedKeywords.join(", ") : "No query-term match; selected for source/role breadth"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div
        aria-label="Corpus section-role coverage"
        className="corpus-coverage-table-wrap"
        role="region"
        tabIndex={0}
      >
        <table className="corpus-coverage-table">
          <caption>
            Section-role weighting and coverage — weights are ranking bonuses,
            not percentages
          </caption>
          <thead>
            <tr>
              <th scope="col">Detected role</th>
              <th scope="col">Fixed weight</th>
              <th scope="col">Source coverage</th>
              <th scope="col">Chunks selected</th>
              <th scope="col">Unique excerpt characters</th>
            </tr>
          </thead>
          <tbody>
            {detectedRoles.map((role) => (
              <tr key={role.role}>
                <th scope="row">{role.role.replaceAll("-", " ")}</th>
                <td>{role.weight}{role.substantive ? " · breadth seed" : " · no breadth seed"}</td>
                <td>{role.selectedSources} / {role.detectedSources}</td>
                <td>{role.selectedChunks} / {role.detectedChunks}</td>
                <td>{role.selectedCharacters.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        aria-label="Per-source corpus coverage"
        className="corpus-coverage-table-wrap"
        role="region"
        tabIndex={0}
      >
        <table className="corpus-coverage-table">
          <caption>Selected versus omitted evidence by corpus source</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Packet status</th>
              <th scope="col">Chunks</th>
              <th scope="col">Unique excerpt characters selected</th>
            </tr>
          </thead>
          <tbody>
            {coverage.sources.map((source) => {
              const selected = source.selectedChunks > 0;
              return (
                <tr key={source.fileName}>
                  <th scope="row">{source.fileName}</th>
                  <td><span className={`corpus-source-status ${selected ? "selected" : "omitted"}`}>{selected ? "Selected" : source.characters ? "Omitted" : "No searchable text"}</span></td>
                  <td>{source.selectedChunks} / {source.chunks}</td>
                  <td>{source.selectedCharacters.toLocaleString()} selected; {source.characters.toLocaleString()} source chars</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ManuscriptWorkspace() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const corpusFileInputRef = useRef<HTMLInputElement>(null);
  const guidelineFileInputRef = useRef<HTMLInputElement>(null);
  const corpusAnalysisControllerRef = useRef<AbortController | null>(null);
  const dragDepthRef = useRef(0);
  const corpusDragDepthRef = useRef(0);
  const generatedPackageRef = useRef<HTMLDivElement>(null);
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE.id);
  const [submissionType, setSubmissionType] = useState(DEFAULT_SUBMISSION_TYPE);
  const [submissionTypeNotice, setSubmissionTypeNotice] = useState("");
  const [targetVenue, setTargetVenue] = useState(DEFAULT_PROFILE.venue);
  const [customPublisher, setCustomPublisher] = useState("");
  const [customSourceUrl, setCustomSourceUrl] = useState("");
  const [guidelineFile, setGuidelineFile] = useState<File | null>(null);
  const [customGuidance, setCustomGuidance] = useState("");
  const [guidelineProposal, setGuidelineProposal] =
    useState<VenueGuidelineProposal | null>(null);
  const [guidelineProposalArtifact, setGuidelineProposalArtifact] =
    useState("");
  const [guidelineInputAtImport, setGuidelineInputAtImport] = useState("");
  const [guidelineErrors, setGuidelineErrors] = useState<string[]>([]);
  const [isImportingGuidelines, setIsImportingGuidelines] =
    useState(false);
  const [isConfirmingGuidelines, setIsConfirmingGuidelines] =
    useState(false);
  const [selectedTemplateKey, setSelectedTemplateKey] =
    useState<ConfirmedVenueContract["templateKey"]>(
      defaultVenueTemplateKey(DEFAULT_PROFILE.id, DEFAULT_SUBMISSION_TYPE),
    );
  const [enforceImportedPageLimit, setEnforceImportedPageLimit] =
    useState(true);
  const [selectedPageMode, setSelectedPageMode] =
    useState<NonNullable<VenueGuidelineProposal["pageLimit"]>["mode"]>(
      "maximum_pages",
    );
  const [selectedPageScope, setSelectedPageScope] = useState<
    "total_pdf" | "content_excluding_references" | ""
  >("");
  const [selectedMinPages, setSelectedMinPages] = useState("");
  const [selectedMaxPages, setSelectedMaxPages] = useState("");
  const [selectedExactPages, setSelectedExactPages] = useState("");
  const [guidelineAuthorConfirmed, setGuidelineAuthorConfirmed] =
    useState(false);
  const [confirmedVenue, setConfirmedVenue] =
    useState<ConfirmedVenueState | null>(null);
  const [title, setTitle] = useState("");
  const [authorMetadata, setAuthorMetadata] = useState("");
  const [manuscript, setManuscript] = useState("");
  const [researchMaterialMode, setResearchMaterialMode] =
    useState<ResearchMaterialMode>("standard");
  const [corpusFiles, setCorpusFiles] = useState<File[]>([]);
  const [corpusUploadErrors, setCorpusUploadErrors] = useState<string[]>([]);
  const [corpusAnalysisErrors, setCorpusAnalysisErrors] = useState<string[]>([]);
  const [corpusAnalysis, setCorpusAnalysis] =
    useState<CorpusAnalysisState | null>(null);
  const [isAnalyzingCorpus, setIsAnalyzingCorpus] = useState(false);
  const [isDraggingCorpusFiles, setIsDraggingCorpusFiles] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [attachmentPlan, setAttachmentPlan] = useState<
    Record<string, AttachmentPlanEntry>
  >({});
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [syntheticTest, setSyntheticTest] = useState<SyntheticTestState | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [result, setResult] = useState<GenerationResult | null>(null);
  const [generatedFiles, setGeneratedFiles] = useState<File[]>([]);
  const [generatedSyntheticTest, setGeneratedSyntheticTest] =
    useState<SyntheticTestState | null>(null);
  const [errors, setErrorMessages] = useState<string[]>([]);
  const [generationDiagnosticId, setGenerationDiagnosticId] =
    useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [loadingIndex, setLoadingIndex] = useState(0);
  const [health, setHealth] = useState<HealthState>({
    configured: null,
    ready: null,
    status: "checking",
    model: "AI backend",
    provider: "invalid",
    mode: "invalid",
    transport: null,
    profiles: publicationProfiles.length,
    checked: false,
  });

  const selectedProfile = publicationProfiles.find((profile) => profile.id === profileId);
  const isCustom = profileId === CUSTOM_PROFILE_ID;
  const availableSubmissionTypes = submissionTypesForProfile(profileId);
  const hasSubmissionWorkflow = availableSubmissionTypes.length > 0;
  const needsExactGuidance = isCustom || selectedProfile?.confidence === "starter";
  const guidelineSourceIdentity = guidelineFile
    ? JSON.stringify({
        name: safeAttachmentName(guidelineFile.name),
        size: guidelineFile.size,
        lastModified: guidelineFile.lastModified,
      })
    : customSourceUrl;
  const currentGuidelineInputSignature = useMemo(
    () =>
      venueGuidelineInputSignature(
        profileId,
        customPublisher,
        targetVenue,
        submissionType,
        guidelineSourceIdentity,
      ),
    [
      customPublisher,
      guidelineSourceIdentity,
      profileId,
      submissionType,
      targetVenue,
    ],
  );
  const guidelineProposalIsCurrent =
    Boolean(guidelineProposal) &&
    guidelineInputAtImport === currentGuidelineInputSignature;
  const confirmedVenueIsCurrent =
    Boolean(confirmedVenue) &&
    confirmedVenue?.inputSignature === currentGuidelineInputSignature;
  const manuscriptWords = manuscript.trim() ? manuscript.trim().split(/\s+/).length : 0;
  const totalAttachmentBytes = files.reduce((total, file) => total + file.size, 0);

  function setErrors(nextErrors: string[]) {
    setGenerationDiagnosticId(null);
    setErrorMessages(nextErrors);
  }
  const totalCorpusBytes = corpusFiles.reduce((total, file) => total + file.size, 0);
  const currentCorpusInputSignature = useMemo(
    () =>
      corpusInputSignature(
        title,
        targetVenue,
        submissionType,
        manuscript,
        corpusFiles,
      ),
    [corpusFiles, manuscript, submissionType, targetVenue, title],
  );
  const largeCorpusMode = researchMaterialMode === "large_corpus";
  const isolatedLocalLlama =
    health.provider === "local_llama" && health.mode === "isolated";
  const ociCloudTesting =
    health.provider === "oci" && health.mode === "cloud_testing";
  const providerPrivacyVerified = isolatedLocalLlama || ociCloudTesting;
  const generationBackendName = isolatedLocalLlama
    ? "the local Ollama model"
    : ociCloudTesting
      ? "OCI Generative AI"
      : "the configured AI backend";
  const modelRequestLabel = isolatedLocalLlama
    ? "local Ollama request"
    : ociCloudTesting
      ? "OCI model request"
      : "model request";
  const largeCorpusTransportUnsupported =
    health.checked &&
    ![
      "oci_chat",
      "oci_responses",
      "local_chat_completions",
    ].includes(health.transport ?? "");
  const manuscriptCharacterLimit = largeCorpusMode
    ? isolatedLocalLlama
      ? 20_000
      : 80_000
    : 160_000;
  const corpusAnalysisIsCurrent =
    corpusAnalysis?.inputSignature === currentCorpusInputSignature;

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Health check failed");
        return (await response.json()) as Omit<HealthState, "checked">;
      })
      .then((next) => setHealth({ ...next, checked: true }))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setHealth((current) => ({
          ...current,
          ready: false,
          status: "unavailable",
          message: "The backend health check could not be reached. Confirm Scholar Flow is running and refresh the page.",
          checked: true,
        }));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!isGenerating) return;
    const interval = window.setInterval(
      () => setLoadingIndex((current) => (current + 1) % loadingMessages.length),
      2200,
    );
    return () => window.clearInterval(interval);
  }, [isGenerating]);

  useEffect(() => {
    return () => {
      corpusAnalysisControllerRef.current?.abort();
      corpusAnalysisControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!result) return;
    const frame = window.requestAnimationFrame(() => {
      generatedPackageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      generatedPackageRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [result]);

  function chooseGuidelineFile(incoming: FileList | null) {
    const file = incoming?.item(0) ?? null;
    markSyntheticTestModified();
    setGuidelineFile(file);
    setCustomSourceUrl("");
    setGuidelineProposal(null);
    setGuidelineProposalArtifact("");
    setGuidelineInputAtImport("");
    setGuidelineErrors([]);
    setConfirmedVenue(null);
    setGuidelineAuthorConfirmed(false);
    if (guidelineFileInputRef.current) {
      guidelineFileInputRef.current.value = "";
    }
  }

  function markSyntheticTestModified() {
    setSyntheticTest((current) =>
      current && !current.modified ? { ...current, modified: true } : current,
    );
  }

  async function importOfficialGuidelines() {
    const nextErrors: string[] = [];
    if (!targetVenue.trim()) {
      nextErrors.push(
        "Enter the exact conference, journal, or publication first.",
      );
    }
    if (!guidelineFile) {
      nextErrors.push(
        "Choose one official guideline PDF, text, Markdown, or HTML file.",
      );
    } else if (guidelineFile.size > 10 * 1024 * 1024) {
      nextErrors.push("The official guideline file must be 10 MB or smaller.");
    } else if (
      !["pdf", "txt", "md", "markdown", "html", "htm"].includes(
        fileExtension(guidelineFile.name),
      )
    ) {
      nextErrors.push(
        "The official guideline file must be PDF, TXT, Markdown, HTML, or HTM.",
      );
    }
    if (!submissionType) nextErrors.push("Select a submission type.");
    if (health.ready !== true) {
      nextErrors.push(
        health.message ||
          "The configured AI backend must be ready before extracting venue rules.",
      );
    }
    if (nextErrors.length) {
      setGuidelineErrors(nextErrors);
      return;
    }

    setIsImportingGuidelines(true);
    setGuidelineErrors([]);
    setConfirmedVenue(null);
    setGuidelineAuthorConfirmed(false);
    const requestSignature = currentGuidelineInputSignature;
    const controller = new AbortController();
    const guidelineTimeoutMs = isolatedLocalLlama ? 240_000 : 100_000;
    const timeout = window.setTimeout(
      () => controller.abort(),
      guidelineTimeoutMs,
    );
    try {
      const formData = new FormData();
      formData.set("venue", targetVenue);
      formData.set(
        "publisher",
        customPublisher || selectedProfile?.publisher || "",
      );
      formData.set("submissionType", submissionType);
      formData.set(
        "guidelineFile",
        guidelineFile!,
        safeAttachmentName(guidelineFile!.name),
      );
      const response = await fetch("/api/venue-guidelines/import", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        proposal?: unknown;
        proposalArtifact?: unknown;
        error?: unknown;
        details?: unknown;
      };
      if (!response.ok) {
        const details = Array.isArray(body.details)
          ? body.details.filter(
              (item): item is string => typeof item === "string",
            )
          : [];
        setGuidelineErrors(
          details.length
            ? details
            : [
                typeof body.error === "string"
                  ? body.error
                  : "The official guideline import failed.",
              ],
        );
        return;
      }
      if (
        !validVenueGuidelineProposal(body.proposal) ||
        typeof body.proposalArtifact !== "string" ||
        !/^1\.[A-Za-z0-9_-]{43}$/u.test(body.proposalArtifact)
      ) {
        setGuidelineErrors([
          "The configured guideline extractor returned an incomplete proposal. Retry the official file.",
        ]);
        return;
      }

      const proposal = body.proposal;
      setCustomSourceUrl(proposal.source.requestedUrl);
      setGuidelineProposal(proposal);
      setGuidelineProposalArtifact(body.proposalArtifact);
      setGuidelineInputAtImport(requestSignature);
      setSelectedTemplateKey(
        proposal.template?.key ??
          defaultVenueTemplateKey(profileId, submissionType),
      );
      setEnforceImportedPageLimit(Boolean(proposal.pageLimit));
      setSelectedPageMode(
        proposal.pageLimit?.mode ?? "maximum_pages",
      );
      setSelectedPageScope(
        proposal.pageLimit?.countScope === "unknown"
          ? ""
          : (proposal.pageLimit?.countScope ?? ""),
      );
      setSelectedMinPages(
        proposal.pageLimit?.minPages?.toString() ?? "",
      );
      setSelectedMaxPages(
        proposal.pageLimit?.maxPages?.toString() ?? "",
      );
      setSelectedExactPages(
        proposal.pageLimit?.exactPages?.toString() ?? "",
      );
    } catch (error) {
      setGuidelineErrors([
        error instanceof Error && error.name === "AbortError"
          ? `Guideline extraction did not finish within ${Math.round(guidelineTimeoutMs / 1_000)} seconds. Use a more focused official file and retry.`
          : `The guideline extractor could not be reached. Confirm Scholar Flow and ${generationBackendName} are available.`,
      ]);
    } finally {
      window.clearTimeout(timeout);
      setIsImportingGuidelines(false);
    }
  }

  async function confirmOfficialGuidelines() {
    if (
      !guidelineProposal ||
      !guidelineProposalArtifact ||
      !guidelineProposalIsCurrent
    ) {
      setGuidelineErrors([
        "The extracted proposal is missing or stale. Upload and extract the exact official file again.",
      ]);
      return;
    }
    if (!guidelineAuthorConfirmed) {
      setGuidelineErrors([
        "Confirm that you checked the venue, track, source excerpts, template, and page rule against the official page.",
      ]);
      return;
    }

    let pagePolicy: Record<string, unknown> | null = null;
    if (enforceImportedPageLimit) {
      if (!selectedPageScope) {
        setGuidelineErrors([
          "Choose whether references count toward the page limit.",
        ]);
        return;
      }
      const parsePages = (value: string) =>
        /^\d+$/.test(value) ? Number(value) : Number.NaN;
      const common = {
        id: `imported-${selectedPageMode}-${guidelineProposal.source.sha256.slice(0, 12)}`,
        mode: selectedPageMode,
        countScope: selectedPageScope,
        ruleIds: ["imported-pages-01"],
        sourceBasis:
          guidelineProposal.pageLimit?.excerpt ||
          "Page policy explicitly confirmed by the author against the locally uploaded source snapshot.",
      };
      if (selectedPageMode === "exact_pages") {
        const exactPages = parsePages(selectedExactPages);
        if (!Number.isSafeInteger(exactPages) || exactPages < 1) {
          setGuidelineErrors(["Enter a valid exact page count."]);
          return;
        }
        pagePolicy = { ...common, exactPages };
      } else if (selectedPageMode === "minimum_pages") {
        const minPages = parsePages(selectedMinPages);
        if (!Number.isSafeInteger(minPages) || minPages < 1) {
          setGuidelineErrors(["Enter a valid minimum page count."]);
          return;
        }
        pagePolicy = { ...common, minPages };
      } else if (selectedPageMode === "maximum_pages") {
        const maxPages = parsePages(selectedMaxPages);
        if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
          setGuidelineErrors(["Enter a valid maximum page count."]);
          return;
        }
        pagePolicy = { ...common, maxPages };
      } else {
        const minPages = parsePages(selectedMinPages);
        const maxPages = parsePages(selectedMaxPages);
        if (
          !Number.isSafeInteger(minPages) ||
          !Number.isSafeInteger(maxPages) ||
          minPages < 1 ||
          maxPages < 1 ||
          minPages >= maxPages
        ) {
          setGuidelineErrors([
            "Enter a valid inclusive range whose minimum is less than its maximum. Use Exact pages when both are equal.",
          ]);
          return;
        }
        pagePolicy = { ...common, minPages, maxPages };
      }
    }

    setIsConfirmingGuidelines(true);
    setGuidelineErrors([]);
    try {
      const response = await fetch("/api/venue-guidelines/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          proposal: guidelineProposal,
          proposalArtifact: guidelineProposalArtifact,
          templateKey: selectedTemplateKey,
          pagePolicy,
          confirmed: true,
        }),
      });
      const body = (await response.json()) as {
        contract?: unknown;
        artifact?: unknown;
        error?: unknown;
      };
      if (
        !response.ok ||
        !body.contract ||
        typeof body.contract !== "object" ||
        typeof body.artifact !== "string" ||
        !/^1\.[A-Za-z0-9_-]{43}$/u.test(body.artifact)
      ) {
        setGuidelineErrors([
          typeof body.error === "string"
            ? body.error
            : "The venue contract could not be confirmed.",
        ]);
        return;
      }
      setConfirmedVenue({
        contract: body.contract as ConfirmedVenueContract,
        artifact: body.artifact,
        inputSignature: currentGuidelineInputSignature,
      });
    } catch {
      setGuidelineErrors([
        "The venue-contract confirmation endpoint could not be reached.",
      ]);
    } finally {
      setIsConfirmingGuidelines(false);
    }
  }

  function changeProfile(nextId: string) {
    markSyntheticTestModified();
    const nextSubmissionType = isSubmissionTypeAllowed(nextId, submissionType)
      ? submissionType
      : defaultSubmissionTypeForProfile(nextId) ?? "";
    setProfileId(nextId);
    setSubmissionType(nextSubmissionType);
    setSubmissionTypeNotice(
      nextSubmissionType !== submissionType
        ? `Submission type changed to ${nextSubmissionType} because it is compatible with the selected profile.`
        : "",
    );
    setErrors([]);
    setGuidelineErrors([]);
    setConfirmedVenue(null);
    setGuidelineAuthorConfirmed(false);
    const nextProfile = publicationProfiles.find((profile) => profile.id === nextId);
    setTargetVenue(nextProfile?.authority === "venue" ? nextProfile.venue : "");
    setSelectedTemplateKey(
      defaultVenueTemplateKey(nextId, nextSubmissionType),
    );
  }

  function addFiles(incoming: FileList | File[] | null) {
    if (!incoming) return;
    if (incoming.length > 0) markSyntheticTestModified();
    const combined = [...files, ...Array.from(incoming)];
    const unique = combined.filter(
      (file, index) =>
        combined.findIndex(
          (candidate) => candidate.name === file.name && candidate.size === file.size,
        ) === index,
    );
    const accepted: File[] = [];
    const nextErrors: string[] = [];
    let acceptedBytes = 0;
    let acceptedPdfs = 0;

    for (const file of unique) {
      const extension = fileExtension(file.name);
      if (accepted.length >= MAX_ATTACHMENT_FILES) {
        nextErrors.push(`Only the first ${MAX_ATTACHMENT_FILES} valid files were added.`);
        break;
      }
      if (
        !(largeCorpusMode
          ? directImageAssetExtensions.has(extension)
          : supportedAttachmentExtensions.has(extension))
      ) {
        nextErrors.push(
          largeCorpusMode
            ? `${file.name} is not a final image asset. In Large Corpus mode, add PDF and text sources above; this uploader accepts only PNG, JPG, JPEG, or WebP.`
            : `${file.name} uses an unsupported file type.`,
        );
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        nextErrors.push(`${file.name} is larger than 20 MB.`);
        continue;
      }
      if (["png", "jpg", "jpeg", "webp"].includes(extension) && file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
        nextErrors.push(`${file.name} is larger than the 7 MB image limit.`);
        continue;
      }
      if (extension === "pdf" && acceptedPdfs >= MAX_PDF_FILES) {
        nextErrors.push(`Only the first ${MAX_PDF_FILES} PDF files were added.`);
        continue;
      }
      if (acceptedBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        nextErrors.push(`${file.name} would put the attachments above the 40 MB combined limit.`);
        continue;
      }
      accepted.push(file);
      acceptedBytes += file.size;
      if (extension === "pdf") acceptedPdfs += 1;
    }

    setFiles(accepted);
    setAttachmentPlan((current) => {
      const next: Record<string, AttachmentPlanEntry> = {};
      const usedOrders = new Set(
        Object.values(current)
          .map((entry) => entry.order)
          .filter((order) => Number.isInteger(order) && order >= 1 && order <= 99),
      );
      let nextOrder = 1;
      for (const file of accepted) {
        const key = attachmentPlanKey(file);
        const expectedFileName = safeAttachmentName(file.name);
        const existing = current[key];
        if (existing?.fileName === expectedFileName) {
          next[key] = existing;
          continue;
        }
        while (usedOrders.has(nextOrder)) nextOrder += 1;
        next[key] = defaultAttachmentPlanEntry(file, nextOrder);
        usedOrders.add(nextOrder);
      }
      return next;
    });
    setUploadErrors([...new Set(nextErrors)]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    markSyntheticTestModified();
    const removedFile = files[index];
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
    if (removedFile) {
      setAttachmentPlan((current) => {
        const next = { ...current };
        delete next[attachmentPlanKey(removedFile)];
        return next;
      });
    }
    setUploadErrors([]);
  }

  function updateAttachmentPlan(
    file: File,
    update: Partial<Omit<AttachmentPlanEntry, "fileName">>,
  ) {
    markSyntheticTestModified();
    const key = attachmentPlanKey(file);
    setAttachmentPlan((current) => ({
      ...current,
      [key]: {
        ...(current[key] ?? defaultAttachmentPlanEntry(file, files.indexOf(file) + 1)),
        ...update,
        fileName: safeAttachmentName(file.name),
      },
    }));
  }

  function changeResearchMaterialMode(nextMode: ResearchMaterialMode) {
    if (nextMode === "large_corpus" && largeCorpusTransportUnsupported) {
      setErrors([
        "Large Corpus mode is unavailable with the configured generation transport.",
      ]);
      return;
    }
    markSyntheticTestModified();
    if (nextMode === "large_corpus") {
      const retainedFiles = files.filter((file) =>
        directImageAssetExtensions.has(fileExtension(file.name)),
      );
      const removedFiles = files.filter(
        (file) => !directImageAssetExtensions.has(fileExtension(file.name)),
      );
      if (removedFiles.length) {
        const retainedKeys = new Set(retainedFiles.map(attachmentPlanKey));
        setFiles(retainedFiles);
        setAttachmentPlan((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([key]) => retainedKeys.has(key)),
          ),
        );
        setUploadErrors([
          `${removedFiles.length} non-image direct ${removedFiles.length === 1 ? "attachment was" : "attachments were"} removed when Large Corpus mode was selected. Add PDF and text evidence to the corpus-source uploader below.`,
        ]);
      } else {
        setUploadErrors([]);
      }
    } else {
      setUploadErrors([]);
    }
    setResearchMaterialMode(nextMode);
    setErrors([]);
    setCorpusAnalysisErrors([]);
  }

  function addCorpusFiles(incoming: FileList | File[] | null) {
    if (!incoming) return;
    if (incoming.length > 0) markSyntheticTestModified();

    const combined = [...corpusFiles, ...Array.from(incoming)];
    const accepted: File[] = [];
    const nextErrors: string[] = [];
    const seenNames = new Set<string>();
    let acceptedBytes = 0;
    let acceptedPdfs = 0;

    for (const file of combined) {
      const canonicalName = safeAttachmentName(file.name);
      const foldedName = canonicalName.toLocaleLowerCase("en-US");
      const extension = fileExtension(canonicalName);
      if (seenNames.has(foldedName)) {
        if (!corpusFiles.includes(file)) {
          nextErrors.push(
            `${file.name} duplicates the corpus filename ${canonicalName} after safe filename conversion.`,
          );
        }
        continue;
      }
      seenNames.add(foldedName);
      if (accepted.length >= MAX_ATTACHMENT_FILES) {
        nextErrors.push(
          `Only the first ${MAX_ATTACHMENT_FILES} valid corpus files were added.`,
        );
        break;
      }
      if (!supportedCorpusExtensions.has(extension)) {
        nextErrors.push(
          `${file.name} is not a supported corpus source. Use PDF, TXT, Markdown, LaTeX, BibTeX, CSV, or JSON.`,
        );
        continue;
      }
      if (file.size === 0) {
        nextErrors.push(`${file.name} is empty.`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        nextErrors.push(`${file.name} is larger than 20 MB.`);
        continue;
      }
      if (extension === "pdf" && acceptedPdfs >= MAX_PDF_FILES) {
        nextErrors.push(
          `Only the first ${MAX_PDF_FILES} PDF corpus files were added.`,
        );
        continue;
      }
      if (acceptedBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        nextErrors.push(
          `${file.name} would put the corpus sources above the 40 MB combined limit.`,
        );
        continue;
      }
      accepted.push(file);
      acceptedBytes += file.size;
      if (extension === "pdf") acceptedPdfs += 1;
    }

    setCorpusFiles(accepted);
    setCorpusUploadErrors([...new Set(nextErrors)]);
    setCorpusAnalysisErrors([]);
    setCorpusAnalysis(null);
    if (corpusFileInputRef.current) corpusFileInputRef.current.value = "";
  }

  function removeCorpusFile(index: number) {
    markSyntheticTestModified();
    setCorpusFiles((current) =>
      current.filter((_, fileIndex) => fileIndex !== index),
    );
    setCorpusUploadErrors([]);
    setCorpusAnalysisErrors([]);
    setCorpusAnalysis(null);
  }

  function clearCorpusFiles() {
    markSyntheticTestModified();
    setCorpusFiles([]);
    setCorpusUploadErrors([]);
    setCorpusAnalysisErrors([]);
    setCorpusAnalysis(null);
    setIsDraggingCorpusFiles(false);
    corpusDragDepthRef.current = 0;
    if (corpusFileInputRef.current) corpusFileInputRef.current.value = "";
  }

  async function processLargeCorpus() {
    const nextErrors: string[] = [];
    if (largeCorpusTransportUnsupported) {
      nextErrors.push(
        "Large Corpus mode is unavailable with the configured generation transport.",
      );
    }
    if (!title.trim()) nextErrors.push("Enter a working title before processing the corpus.");
    if (!targetVenue.trim()) {
      nextErrors.push(
        "Enter the exact conference, journal, or publication before processing the corpus.",
      );
    }
    if (corpusFiles.length === 0) {
      nextErrors.push("Add at least one corpus source before processing.");
    }
    if (manuscript.length > manuscriptCharacterLimit) {
      nextErrors.push(
        isolatedLocalLlama
          ? "Local Llama Large Corpus notes are limited to 20,000 characters by the 16 GB profile. Put the remaining evidence in corpus files so Scholar Flow can rank it."
          : "Large Corpus manuscript notes are limited to 80,000 characters so the evidence packet, final images, and generated paper retain context headroom.",
      );
    }
    if (nextErrors.length) {
      setCorpusAnalysisErrors(nextErrors);
      return;
    }

    const requestSignature = currentCorpusInputSignature;
    const formData = new FormData();
    formData.set("title", title);
    formData.set("targetVenue", targetVenue);
    formData.set("submissionType", submissionType);
    formData.set("manuscript", manuscript);
    corpusFiles.forEach((file) =>
      formData.append("files", file, safeAttachmentName(file.name)),
    );

    setIsAnalyzingCorpus(true);
    setCorpusAnalysis(null);
    setCorpusAnalysisErrors([]);
    const controller = new AbortController();
    corpusAnalysisControllerRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 90_000);
    try {
      let response: Response;
      try {
        response = await fetch("/api/corpus/analyze", {
          method: "POST",
          body: formData,
          signal: controller.signal,
        });
      } catch {
        setCorpusAnalysisErrors([
          timedOut
            ? "Corpus processing did not finish within 90 seconds. Use fewer PDFs, split large PDFs, or attach extracted UTF-8 text files and try again."
            : "The corpus processor could not be reached. Confirm the app is running and try again.",
        ]);
        return;
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) {
        setCorpusAnalysisErrors([
          response.status === 413
            ? "The corpus request is too large. Keep every file within 20 MB and all corpus sources within 40 MB combined."
            : `The corpus processor returned HTTP ${response.status}. Please retry.`,
        ]);
        return;
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        setCorpusAnalysisErrors([
          `The corpus processor returned unreadable JSON (HTTP ${response.status}). Please retry.`,
        ]);
        return;
      }
      if (!response.ok) {
        const apiError = body as ApiErrorBody;
        setCorpusAnalysisErrors(
          apiError.details?.length
            ? apiError.details
            : [apiError.error || "Corpus processing failed."],
        );
        return;
      }

      const record = body as Record<string, unknown>;
      if (
        typeof record.packetText !== "string" ||
        !record.packetText.trim() ||
        typeof record.artifactToken !== "string" ||
        record.artifactToken.length < 49 ||
        record.artifactToken.length > 160 ||
        !validCorpusCoverage(record.coverage) ||
        !validCorpusSelectedChunks(record.selectedChunks)
      ) {
        setCorpusAnalysisErrors([
          "The corpus processor returned an incomplete coverage report. Please retry.",
        ]);
        return;
      }
      setCorpusAnalysis({
        packetText: record.packetText,
        artifactToken: record.artifactToken,
        coverage: record.coverage,
        selectedChunks: record.selectedChunks,
        inputSignature: requestSignature,
        analyzedAt: new Date().toISOString(),
      });
    } catch {
      setCorpusAnalysisErrors([
        "Scholar Flow received a corpus response it could not process. Please retry.",
      ]);
    } finally {
      window.clearTimeout(timeout);
      if (corpusAnalysisControllerRef.current === controller) {
        corpusAnalysisControllerRef.current = null;
      }
      setIsAnalyzingCorpus(false);
    }
  }

  function loadSyntheticTestFixture(fixtureId: SyntheticTestFixtureId) {
    const hasUnsavedFormData =
      profileId !== DEFAULT_PROFILE.id ||
      submissionType !== DEFAULT_SUBMISSION_TYPE ||
      targetVenue !== DEFAULT_PROFILE.venue ||
      Boolean(
        customPublisher.trim() ||
          customSourceUrl.trim() ||
          guidelineFile ||
          customGuidance.trim() ||
          title.trim() ||
          authorMetadata.trim() ||
          manuscript.trim() ||
          researchMaterialMode !== "standard" ||
          corpusFiles.length ||
          corpusAnalysis ||
          files.length ||
          result,
      );
    if (
      hasUnsavedFormData &&
      !window.confirm(
        "Replace the current publication choices, research text, attachments, and generated result with synthetic test data?",
      )
    ) {
      return;
    }

    const fixture = syntheticTestFixtures[fixtureId];
    if (!isSubmissionTypeAllowed(fixture.profileId, fixture.submissionType)) {
      setErrors([`${fixture.label} has an invalid publication and submission-type pairing.`]);
      return;
    }
    setProfileId(fixture.profileId);
    setTargetVenue(fixture.targetVenue);
    setSubmissionType(fixture.submissionType);
    setSubmissionTypeNotice("");
    setCustomPublisher(fixture.customPublisher);
    setCustomSourceUrl(fixture.customSourceUrl);
    setGuidelineFile(null);
    setCustomGuidance(fixture.customGuidance);
    setGuidelineProposal(null);
    setGuidelineProposalArtifact("");
    setGuidelineInputAtImport("");
    setGuidelineErrors([]);
    setConfirmedVenue(null);
    setGuidelineAuthorConfirmed(false);
    setSelectedTemplateKey(
      defaultVenueTemplateKey(
        fixture.profileId,
        fixture.submissionType,
      ),
    );
    setTitle(fixture.title);
    setAuthorMetadata(fixture.authorMetadata);
    setManuscript(fixture.manuscript);
    setResearchMaterialMode("standard");
    setCorpusFiles([]);
    setCorpusUploadErrors([]);
    setCorpusAnalysisErrors([]);
    setCorpusAnalysis(null);
    setIsAnalyzingCorpus(false);
    setIsDraggingCorpusFiles(false);
    setFiles([]);
    setAttachmentPlan({});
    setUploadErrors([]);
    setIsDraggingFiles(false);
    setErrors([]);
    setResult(null);
    setGeneratedFiles([]);
    setGeneratedSyntheticTest(null);
    setLoadingIndex(0);
    setSyntheticTest({
      id: fixture.id,
      label: fixture.label,
      modified: false,
    });
    dragDepthRef.current = 0;
    corpusDragDepthRef.current = 0;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (corpusFileInputRef.current) corpusFileInputRef.current.value = "";
    if (guidelineFileInputRef.current) {
      guidelineFileInputRef.current.value = "";
    }
  }

  function clearSyntheticTestData() {
    if (
      syntheticTest?.modified &&
      !window.confirm(
        "Clear the mixed synthetic test and user-entered material, attachments, and generated output?",
      )
    ) {
      return;
    }
    setProfileId(DEFAULT_PROFILE.id);
    setSubmissionType(DEFAULT_SUBMISSION_TYPE);
    setSubmissionTypeNotice("");
    setTargetVenue(DEFAULT_PROFILE.venue);
    setCustomPublisher("");
    setCustomSourceUrl("");
    setGuidelineFile(null);
    setCustomGuidance("");
    setGuidelineProposal(null);
    setGuidelineProposalArtifact("");
    setGuidelineInputAtImport("");
    setGuidelineErrors([]);
    setConfirmedVenue(null);
    setGuidelineAuthorConfirmed(false);
    setSelectedTemplateKey(
      defaultVenueTemplateKey(
        DEFAULT_PROFILE.id,
        DEFAULT_SUBMISSION_TYPE,
      ),
    );
    setTitle("");
    setAuthorMetadata("");
    setManuscript("");
    setResearchMaterialMode("standard");
    setCorpusFiles([]);
    setCorpusUploadErrors([]);
    setCorpusAnalysisErrors([]);
    setCorpusAnalysis(null);
    setIsAnalyzingCorpus(false);
    setIsDraggingCorpusFiles(false);
    setFiles([]);
    setAttachmentPlan({});
    setUploadErrors([]);
    setIsDraggingFiles(false);
    setErrors([]);
    setResult(null);
    setGeneratedFiles([]);
    setGeneratedSyntheticTest(null);
    setLoadingIndex(0);
    setSyntheticTest(null);
    dragDepthRef.current = 0;
    corpusDragDepthRef.current = 0;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (corpusFileInputRef.current) corpusFileInputRef.current.value = "";
    if (guidelineFileInputRef.current) {
      guidelineFileInputRef.current.value = "";
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextErrors: string[] = [];
    const submittedFiles = [...files];
    const submittedAttachmentPlan = submittedFiles.map((file, index) => {
      const current =
        attachmentPlan[attachmentPlanKey(file)] ??
        defaultAttachmentPlanEntry(file, index + 1);
      return {
        ...current,
        fileName: safeAttachmentName(file.name),
        section: current.section.trim(),
        relativePlacement: current.relativePlacement.trim(),
        captionOrNote: current.captionOrNote.trim(),
      };
    });
    if (!isSubmissionTypeAllowed(profileId, submissionType)) {
      nextErrors.push("Select a submission type that is compatible with the publication profile.");
    }
    if (!targetVenue.trim()) nextErrors.push("Enter the exact conference, journal, or publication name.");
    if (!title.trim()) nextErrors.push("Enter a working title.");
    if (!largeCorpusMode && !manuscript.trim() && files.length === 0) {
      nextErrors.push("Paste manuscript text or attach at least one file.");
    }
    if (largeCorpusMode && !corpusAnalysisIsCurrent) {
      nextErrors.push(
        corpusAnalysis
          ? "The Large Corpus analysis is out of date. Process the corpus again after your title, venue, submission type, manuscript, or corpus-file changes."
          : "Process the Large Corpus sources before generating the paper.",
      );
    }
    if (
      isCustom &&
      !confirmedVenueIsCurrent &&
      customGuidance.trim().length < 120
    ) {
      nextErrors.push(
        "Custom profiles need either a current confirmed venue contract or at least 120 characters of pasted official guidance.",
      );
    }
    if (confirmedVenue && !confirmedVenueIsCurrent) {
      nextErrors.push(
        "The confirmed venue contract is out of date because the publication, submission type, publisher, or local guideline file changed. Upload and confirm it again.",
      );
    }

    const seenPlanNames = new Set<string>();
    const seenPlanOrders = new Set<number>();
    for (const [index, plan] of submittedAttachmentPlan.entries()) {
      if (
        largeCorpusMode &&
        !directImageAssetExtensions.has(fileExtension(submittedFiles[index]?.name ?? ""))
      ) {
        nextErrors.push(
          `${plan.fileName}: Large Corpus final attachments must be PNG, JPG, JPEG, or WebP images. Move PDF and text evidence to the corpus-source uploader.`,
        );
      }
      const foldedName = plan.fileName.toLocaleLowerCase("en-US");
      if (seenPlanNames.has(foldedName)) {
        nextErrors.push(
          `Two attachments resolve to the exact filename ${plan.fileName}. Rename one file before generating.`,
        );
      }
      seenPlanNames.add(foldedName);
      if (!Number.isInteger(plan.order) || plan.order < 1 || plan.order > 99) {
        nextErrors.push(`${plan.fileName}: order must be a whole number from 1 through 99.`);
      } else if (seenPlanOrders.has(plan.order)) {
        nextErrors.push(`${plan.fileName}: order ${plan.order} is already assigned to another attachment.`);
      }
      seenPlanOrders.add(plan.order);
      if (plan.purpose === "figure") {
        if (!paperFigureExtensions.has(fileExtension(plan.fileName))) {
          nextErrors.push(`${plan.fileName}: only PNG, JPG, or JPEG files can be placed as paper figures.`);
        }
        if (!plan.section) {
          nextErrors.push(`${plan.fileName}: enter the paper section where this figure belongs.`);
        }
        if (!plan.captionOrNote) {
          nextErrors.push(`${plan.fileName}: enter the exact figure caption.`);
        }
      }
    }
    if (nextErrors.length) {
      setErrors([...new Set(nextErrors)]);
      return;
    }
    if (health.ready !== true) {
      setErrors([
        health.message ||
          (health.checked
            ? "The configured AI backend is not ready. Check its runtime configuration and try again."
            : "Wait for the AI backend readiness check to finish."),
      ]);
      return;
    }

    const submittedSyntheticTest = syntheticTest
      ? { ...syntheticTest }
      : null;
    const formData = new FormData();
    formData.set("profileId", profileId);
    formData.set("submissionType", submissionType);
    formData.set("targetVenue", targetVenue);
    formData.set("customVenue", targetVenue);
    formData.set("customPublisher", customPublisher);
    formData.set("customSourceUrl", customSourceUrl);
    formData.set("customGuidance", customGuidance);
    formData.set(
      "venueContract",
      confirmedVenueIsCurrent && confirmedVenue
        ? JSON.stringify(confirmedVenue.contract)
        : "",
    );
    formData.set(
      "venueContractArtifact",
      confirmedVenueIsCurrent && confirmedVenue
        ? confirmedVenue.artifact
        : "",
    );
    formData.set("title", title);
    formData.set("authorMetadata", authorMetadata);
    formData.set("manuscript", manuscript);
    formData.set("attachmentPlan", JSON.stringify(submittedAttachmentPlan));
    formData.set("largeCorpusMode", largeCorpusMode ? "true" : "false");
    formData.set(
      "largeCorpusPacket",
      largeCorpusMode && corpusAnalysisIsCurrent && corpusAnalysis
        ? corpusAnalysis.packetText
        : "",
    );
    formData.set(
      "largeCorpusReport",
      largeCorpusMode && corpusAnalysisIsCurrent && corpusAnalysis
        ? JSON.stringify(corpusAnalysis.coverage)
        : "",
    );
    formData.set(
      "largeCorpusArtifact",
      largeCorpusMode && corpusAnalysisIsCurrent && corpusAnalysis
        ? corpusAnalysis.artifactToken
        : "",
    );
    submittedFiles.forEach((file) =>
      formData.append("files", file, safeAttachmentName(file.name)),
    );

    setIsGenerating(true);
    setLoadingIndex(0);
    setErrors([]);
    setResult(null);
    setGeneratedFiles([]);
    setGeneratedSyntheticTest(null);
    try {
      let response: Response;
      try {
        response = await fetch("/api/generate", { method: "POST", body: formData });
      } catch {
        setErrors(["The backend could not be reached. Confirm the app is running and try again."]);
        return;
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("json")) {
        let responseText = "";
        try {
          responseText = (await response.text()).replaceAll(/\s+/g, " ").trim().slice(0, 180);
        } catch {
          // The HTTP status below remains useful even if the response body is unreadable.
        }
        if (response.status === 413) {
          setErrors(["The server rejected this upload as too large. Keep every file within 20 MB and all attachments within 40 MB combined."]);
        } else {
          const statusLabel = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
          setErrors([`The server returned HTTP ${statusLabel}${responseText ? `: ${responseText}` : "."}`]);
        }
        return;
      }

      let body: GenerationResult | ApiErrorBody;
      try {
        body = (await response.json()) as GenerationResult | ApiErrorBody;
      } catch {
        setErrors([`The server returned unreadable JSON (HTTP ${response.status}). Please retry.`]);
        return;
      }
      if (!response.ok) {
        const apiError = body as ApiErrorBody;
        const diagnosticId =
          typeof apiError.code === "string" &&
          apiError.code.endsWith("MALFORMED_JSON") &&
          typeof apiError.diagnosticId === "string" &&
          STRUCTURED_JSON_DIAGNOSTIC_ID_PATTERN.test(
            apiError.diagnosticId,
          )
            ? apiError.diagnosticId
            : null;
        setGenerationDiagnosticId(diagnosticId);
        setErrorMessages(
          apiError.details?.length
            ? apiError.details
            : [apiError.error || "Generation failed."],
        );
        return;
      }
      setGeneratedFiles(submittedFiles);
      setGeneratedSyntheticTest(submittedSyntheticTest);
      setResult(body as GenerationResult);
    } catch {
      setErrors(["Scholar Flow received a response it could not process. Please retry."]);
    } finally {
      setIsGenerating(false);
    }
  }

  const backendLabel =
    health.ready === true
      ? isolatedLocalLlama
        ? `${health.model} · isolated Llama`
        : ociCloudTesting
          ? `${health.model} · OCI cloud testing`
          : `${health.model} · privacy mode unverified`
      : !health.checked
        ? "Checking AI backend"
        : health.status === "invalid_config" || health.mode === "invalid"
          ? "AI provider config invalid"
          : health.status === "project_required"
            ? "OCI project needed"
            : health.status === "denied"
              ? "AI access denied"
              : health.status === "model_unavailable"
                ? "Configured model unavailable"
                : isolatedLocalLlama
                  ? "Local Llama unavailable"
                  : ociCloudTesting
                    ? "OCI testing backend unavailable"
                    : "AI backend unavailable";
  const dataHandlingNotice = isolatedLocalLlama
    ? largeCorpusMode
      ? "The processed evidence packet, manuscript text, and final image assets are sent only to the loopback Ollama server. Original corpus files remain inside Scholar Flow's local process and are not resent during final drafting. This isolated mode rejects cloud model endpoints."
      : "Scholar Flow extracts searchable PDF text locally, then sends manuscript text, extracted text, text attachments, and supported images only to the loopback Ollama server. This isolated mode rejects cloud model endpoints."
    : ociCloudTesting
      ? largeCorpusMode
        ? `The processed evidence packet, manuscript text, and final image assets are sent to OCI Generative AI for processing by ${health.model}. Original corpus files remain inside Scholar Flow's process and are not resent during final drafting. This is cloud testing mode, not closed isolation.`
        : `Scholar Flow extracts searchable PDF text locally, then sends manuscript text, extracted text, text attachments, and supported images to OCI Generative AI for processing by ${health.model}. This is cloud testing mode, not closed isolation.`
      : "Scholar Flow could not verify the configured provider or its privacy boundary. Do not upload sensitive material.";
  const footerRuntimeNotice = isolatedLocalLlama
    ? "Local Ollama · No live publication web retrieval · Human approval required"
    : ociCloudTesting
      ? "OCI cloud testing · Research materials leave this app · Human approval required"
      : "Provider privacy unverified · Do not upload sensitive material · Human approval required";

  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="site-header-inner">
          <a className="brand" href="#top"><span className="brand-mark"><img alt="" src="/scholar-flow-mark.svg"/></span><span><strong>Scholar Flow</strong><small>Venue-aware paper preparation</small></span></a>
          <div className="header-status">
            <span className="registry-count" title="Built-in rule sets for IEEE IGARSS, ACM SIGCONF, Springer LNCS, and Elsevier">{publicationProfiles.length} publication rule sets</span>
            <span className={`backend-pill ${health.ready === true ? "ready" : health.checked ? "missing" : "checking"}`} title={health.message}><i/>{backendLabel}</span>
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Publication-aware drafting</p>
          <h1>Compile your research into a <em>submission-ready review package.</em></h1>
        </div>
      </section>

      <section className="workspace-layout">
        <div className="form-column">
          {health.checked && health.ready === false && (
            <div className="config-banner"><Icon name="info"/><div><strong>{health.status === "invalid_config" || health.mode === "invalid" ? "The AI provider configuration is invalid" : health.status === "model_unavailable" ? "The configured model is unavailable" : isolatedLocalLlama && health.status === "missing" ? "Local Ollama setup is incomplete" : ociCloudTesting ? "The OCI testing backend could not be verified" : "The AI backend could not be verified"}</strong><p>{health.message || (isolatedLocalLlama ? "Start Ollama, then refresh this page." : ociCloudTesting ? "Check the OCI project, credentials, model access, and region, then refresh this page." : "Select and configure an explicit AI provider, then refresh this page.")}{isolatedLocalLlama ? " Isolated mode rejects cloud model endpoints and credentials." : ociCloudTesting ? " OCI mode uses external cloud processing and is not closed isolation." : " Scholar Flow will not claim an isolation boundary until the provider mode is verified."}</p></div></div>
          )}
          {health.checked && health.ready === true && isolatedLocalLlama && (
            <div className="config-banner"><Icon name="check"/><div><strong>Local Ollama mode</strong><p>Scholar Flow sends model requests only to the loopback Ollama server. OCI remains available only through the deliberate provider switch.</p></div></div>
          )}
          {health.checked && health.ready === true && ociCloudTesting && (
            <div className="config-banner"><Icon name="info"/><div><strong>Cloud testing mode: OCI Generative AI</strong><p>Paper inputs and uploaded guideline text are sent to Oracle Cloud Infrastructure for model processing. This is not closed isolation; do not upload confidential, embargoed, export-controlled, or unauthorized material.</p></div></div>
          )}
          {health.checked && health.ready === true && !providerPrivacyVerified && (
            <div className="config-banner"><Icon name="alert"/><div><strong>The provider privacy boundary is not verified</strong><p>Do not upload sensitive material until Scholar Flow reports either OCI cloud testing or local Ollama mode.</p></div></div>
          )}
          {health.checked && health.ready === true && health.venueContractSigning?.warning && (
            <div className="config-banner"><Icon name="info"/><div><strong>Fix the dedicated venue-signing configuration</strong><p>{health.venueContractSigning.warning}</p></div></div>
          )}

          <form onSubmit={submit}>
            <section className="form-section">
              <div className="section-heading"><span>01</span><div><p className="eyebrow">Publication target</p><h2>Choose the rule authority</h2><p>Publisher defaults are useful starting points. Exact venue rules are needed before a package can be called compliant.</p></div></div>
              <div className="field-grid two">
                <label className="field-label">Profile family<select className="field-control" onChange={(event) => changeProfile(event.target.value)} value={profileId}>{publicationProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.shortName} · {profile.confidence === "verified" ? "verified venue" : "starter"}</option>)}<option value={CUSTOM_PROFILE_ID}>Custom publication · paste official rules</option></select></label>
                <label className="field-label" htmlFor="submission-type">Submission type<select aria-describedby="submission-type-notice" className="field-control" disabled={!hasSubmissionWorkflow} id="submission-type" onChange={(event) => { markSyntheticTestModified(); setSubmissionType(event.target.value); setSubmissionTypeNotice(""); }} value={submissionType}>{availableSubmissionTypes.map((type: string) => <option key={type}>{type}</option>)}</select><small aria-live="polite" id="submission-type-notice">{submissionTypeNotice || (hasSubmissionWorkflow ? "Options are limited to workflows supported by the selected profile." : "This profile has no configured submission workflow and cannot be generated.")}</small></label>
              </div>
              <div className="field-grid two mt-20">
                {isCustom && <label className="field-label">Publisher or society<input className="field-control" maxLength={160} onChange={(event) => { markSyntheticTestModified(); setCustomPublisher(event.target.value); }} placeholder="e.g., IEEE, ACM, Nature Portfolio" value={customPublisher}/></label>}
                <label className={`field-label ${isCustom ? "" : "wide"}`}>Exact conference, journal, or publication<input className="field-control" maxLength={240} onChange={(event) => { markSyntheticTestModified(); setTargetVenue(event.target.value); }} placeholder="e.g., ACM KDD 2027 Research Track" readOnly={selectedProfile?.authority === "venue"} value={targetVenue}/><small>{selectedProfile?.authority === "venue" ? "Fixed by the verified venue profile." : "Required because publisher-wide page limits do not exist."}</small></label>
              </div>

              {needsExactGuidance && (
                <div className="guidance-box">
                  <div className="guidance-heading"><Icon name="file"/><div><strong>Upload the exact venue&apos;s official rules</strong><p>Scholar Flow does not browse publication websites. Save the official author-guideline page or PDF separately, then upload that one file. Scholar Flow hashes it locally and asks {generationBackendName} to propose page and formatting rules.{ociCloudTesting ? " The extracted guideline text leaves this app for OCI cloud processing." : isolatedLocalLlama ? " The guideline text stays within the isolated local runtime." : " The privacy boundary is unverified until a valid provider mode is reported."}</p></div></div>
                  <div className="guideline-import-row">
                    <label className="field-label">Official guideline file<input accept=".pdf,.txt,.md,.markdown,.html,.htm" className="field-control" onChange={(event) => chooseGuidelineFile(event.target.files)} ref={guidelineFileInputRef} type="file"/><small>{guidelineFile ? `${safeAttachmentName(guidelineFile.name)} · ${formatBytes(guidelineFile.size)}` : "PDF, TXT, Markdown, HTML, or HTM · 10 MB maximum · processed locally"}</small></label>
                    <button className="secondary-button dark" disabled={isImportingGuidelines || isConfirmingGuidelines || isGenerating || !guidelineFile} onClick={importOfficialGuidelines} type="button">{isImportingGuidelines ? <><span className="spinner"/>Extracting rules…</> : <><Icon name="file"/>Extract local rules</>}</button>
                  </div>

                  {guidelineErrors.length > 0 && <div aria-live="assertive" className="guideline-errors" role="alert"><Icon name="alert"/><ul>{guidelineErrors.map((error) => <li key={error}>{error}</li>)}</ul></div>}

                  {guidelineProposal && !guidelineProposalIsCurrent && <div className="guideline-stale"><Icon name="alert"/><p><strong>Imported rules are out of date.</strong><span>The publication, submission type, publisher, or local source file changed. Extract the official rules again before confirming them.</span></p></div>}

                  {guidelineProposal && guidelineProposalIsCurrent && (
                    <section aria-labelledby="guideline-review-title" className="guideline-review">
                      <div className="guideline-source-card">
                        <div><p className="eyebrow">Uploaded source snapshot</p><h3 id="guideline-review-title">{guidelineProposal.source.title || guidelineProposal.venue}</h3><p><span>No external link is stored or opened by Scholar Flow.</span><span>{new Date(guidelineProposal.source.retrievedAt).toLocaleString()} · {guidelineProposal.source.contentType}</span><code>SHA-256 {guidelineProposal.source.sha256}</code></p></div>
                        <span className="author-confirmed-badge">AI-extracted proposal</span>
                      </div>

                      <div className="guideline-review-grid">
                        <fieldset className="guideline-rule-editor">
                          <legend>Page contract</legend>
                          <label className="guideline-check"><input checked={enforceImportedPageLimit} onChange={(event) => { setEnforceImportedPageLimit(event.target.checked); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} type="checkbox"/><span><strong>Enforce a compiled page limit</strong><small>Turn this off when the source has no mandatory page rule or remains ambiguous.</small></span></label>
                          {guidelineProposal.pageLimit ? <blockquote><strong>{guidelineProposal.pageLimit.strength}</strong> “{guidelineProposal.pageLimit.excerpt}”<span>{guidelineProposal.pageLimit.explanation}</span></blockquote> : <p className="guideline-empty">The configured model did not find an explicit page limit in this snapshot.</p>}
                          {enforceImportedPageLimit && <>
                            <label className="field-label">Limit type<select className="field-control" onChange={(event) => { setSelectedPageMode(event.target.value as typeof selectedPageMode); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} value={selectedPageMode}><option value="minimum_pages">Minimum pages</option><option value="maximum_pages">Maximum pages</option><option value="exact_pages">Exact pages</option><option value="page_range">Inclusive page range</option></select></label>
                            <div className="field-grid two mt-16">
                              {(selectedPageMode === "minimum_pages" || selectedPageMode === "page_range") && <label className="field-label">Minimum<input className="field-control" inputMode="numeric" min="1" onChange={(event) => { setSelectedMinPages(event.target.value); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} step="1" type="number" value={selectedMinPages}/></label>}
                              {(selectedPageMode === "maximum_pages" || selectedPageMode === "page_range") && <label className="field-label">Maximum<input className="field-control" inputMode="numeric" min="1" onChange={(event) => { setSelectedMaxPages(event.target.value); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} step="1" type="number" value={selectedMaxPages}/></label>}
                              {selectedPageMode === "exact_pages" && <label className="field-label wide">Exact pages<input className="field-control" inputMode="numeric" min="1" onChange={(event) => { setSelectedExactPages(event.target.value); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} step="1" type="number" value={selectedExactPages}/></label>}
                            </div>
                            <label className="field-label mt-16">What the limit counts<select className="field-control" onChange={(event) => { setSelectedPageScope(event.target.value as typeof selectedPageScope); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} value={selectedPageScope}><option value="">Choose from the official wording…</option><option value="total_pdf">Total PDF, including references</option><option value="content_excluding_references">Content pages, excluding references</option></select><small>Scholar Flow will not guess whether references count.</small></label>
                          </>}
                        </fieldset>

                        <fieldset className="guideline-rule-editor">
                          <legend>LaTeX template contract</legend>
                          {guidelineProposal.template ? <blockquote><strong>{guidelineProposal.template.strength}</strong> “{guidelineProposal.template.excerpt}”<span>{guidelineProposal.template.explanation}</span></blockquote> : <p className="guideline-empty">The configured model did not identify one of Scholar Flow&apos;s allowlisted templates.</p>}
                          <label className="field-label">Confirmed template<select className="field-control" onChange={(event) => { setSelectedTemplateKey(event.target.value as ConfirmedVenueContract["templateKey"]); setConfirmedVenue(null); setGuidelineAuthorConfirmed(false); }} value={selectedTemplateKey}>{VENUE_TEMPLATE_OPTIONS.map((option: { key: string; label: string }) => <option key={option.key} value={option.key}>{option.label}</option>)}</select><small>Only cached, allowlisted classes are executable. Unsupported template instructions remain review items.</small></label>
                        </fieldset>
                      </div>

                      <details className="guideline-rule-list" open>
                        <summary>{guidelineProposal.rules.length} additional formatting and submission {guidelineProposal.rules.length === 1 ? "rule" : "rules"}</summary>
                        {guidelineProposal.rules.length ? <ol>{guidelineProposal.rules.map((rule) => <li key={rule.id}><div><strong>{rule.label}</strong><span>{rule.requirement}</span><small>{rule.category} · {rule.strength}</small></div><blockquote>“{rule.excerpt}”</blockquote></li>)}</ol> : <p>No additional atomic rules were extracted from this snapshot.</p>}
                      </details>

                      {guidelineProposal.unresolved.length > 0 && <div className="guideline-unresolved"><strong>Still unresolved</strong><ul>{guidelineProposal.unresolved.map((item) => <li key={item}>{item}</li>)}</ul></div>}

                      <label className="guideline-check confirmation"><input checked={guidelineAuthorConfirmed} onChange={(event) => { setGuidelineAuthorConfirmed(event.target.checked); setConfirmedVenue(null); }} type="checkbox"/><span><strong>I checked this venue, track, source, page rule, reference scope, and template.</strong><small>This creates an author-confirmed signed snapshot. It does not make the profile publisher-certified or guarantee acceptance.</small></span></label>
                      <div className="guideline-confirm-row"><button className="secondary-button dark" disabled={!guidelineAuthorConfirmed || isConfirmingGuidelines || isImportingGuidelines} onClick={confirmOfficialGuidelines} type="button">{isConfirmingGuidelines ? <><span className="spinner"/>Confirming…</> : <><Icon name="check"/>Confirm &amp; apply rules</>}</button>{confirmedVenueIsCurrent && <span className="venue-confirmed-status"><Icon name="check" size={15}/>Author-confirmed contract active</span>}</div>
                    </section>
                  )}

                  <details className="manual-guidance-fallback">
                    <summary>Manual fallback: paste official guidance</summary>
                    <p>Use this when you cannot export the official page or PDF. Pasted prose remains review-only and cannot activate compiled page enforcement.</p>
                    <label className="field-label mt-16">Official guidance text<textarea className="field-control compact-textarea" maxLength={30000} onChange={(event) => { markSyntheticTestModified(); setCustomGuidance(event.target.value); }} placeholder="Paste page limits, review anonymity, template requirements, required sections, deadlines, and artwork rules…" value={customGuidance}/><small>{customGuidance.length.toLocaleString()} / 30,000 characters {isCustom && !confirmedVenueIsCurrent ? "· 120 minimum without a confirmed import" : "· optional fallback"}</small></label>
                  </details>
                </div>
              )}
            </section>

            <section className="form-section">
              <div className="section-heading"><span>02</span><div><p className="eyebrow">Research material</p><h2>Add the manuscript and facts</h2><p>The model is told to preserve claims and flag missing facts instead of filling gaps.</p></div></div>
              <div className="test-data-box">
                <div className="test-data-copy">
                  <span className="test-data-icon"><Icon name="spark" size={19}/></span>
                  <div><p className="eyebrow">Safe test papers</p><h3>Try each publisher workflow with one click</h3><p>Each option loads fictional text, changes the selected profile, and clears attachments and prior output. Loading and generation remain on this machine. Generated files are tests, not submission material.</p></div>
                </div>
                <div className="test-data-actions" aria-label="Synthetic test fixtures">
                  {syntheticTestFixtureOrder.map((fixtureId) => {
                    const fixture = syntheticTestFixtures[fixtureId];
                    return <button aria-pressed={syntheticTest?.id === fixtureId} className={`test-fixture-button ${syntheticTest?.id === fixtureId ? "active" : ""}`} disabled={isGenerating || isAnalyzingCorpus} key={fixtureId} onClick={() => loadSyntheticTestFixture(fixtureId)} type="button"><strong>{fixture.label}</strong><span>{fixture.description}</span></button>;
                  })}
                </div>
                {syntheticTest && <div aria-atomic="true" aria-live="polite" className={`test-data-status ${syntheticTest.modified ? "modified" : ""}`}><Icon name={syntheticTest.modified ? "alert" : "check"} size={14}/><p><strong>{syntheticTest.modified ? "Synthetic sample modified" : "Synthetic test mode"}</strong><span>{syntheticTest.modified ? "This form may now contain mixed test and user data. Any generated package remains marked as synthetic." : `${syntheticTest.label} loaded. Attachments and previous output were cleared.`}</span></p><button disabled={isGenerating || isAnalyzingCorpus} onClick={clearSyntheticTestData} type="button">Clear test data</button></div>}
              </div>
              <fieldset aria-describedby="research-material-mode-help" className="research-mode-fieldset" disabled={isGenerating || isAnalyzingCorpus}>
                <legend>Research input mode</legend>
                <div className="research-mode-options">
                  <label className="research-mode-option">
                    <input checked={researchMaterialMode === "standard"} name="research-material-mode" onChange={() => changeResearchMaterialMode("standard")} type="radio" value="standard"/>
                    <span><strong>Standard paper</strong><small>Use pasted text and up to 12 direct attachments in one drafting request.</small></span>
                  </label>
                  <label className="research-mode-option">
                    <input checked={researchMaterialMode === "large_corpus"} disabled={largeCorpusTransportUnsupported} name="research-material-mode" onChange={() => changeResearchMaterialMode("large_corpus")} type="radio" value="large_corpus"/>
                    <span><strong>Large Corpus</strong><small>{largeCorpusTransportUnsupported ? "Unavailable with the configured generation transport." : "Build a source- and section-balanced evidence packet, inspect measured omissions, then draft."}</small></span>
                  </label>
                </div>
                <p aria-live="polite" id="research-material-mode-help">
                  {largeCorpusMode
                    ? "Large Corpus uses a submission-type-aware, transparent ranking heuristic. It does not claim the complete source collection was understood."
                    : "Standard mode preserves the existing direct manuscript and attachment workflow."}
                </p>
              </fieldset>
              <label className="field-label">Working title<input className="field-control title-control" maxLength={300} onChange={(event) => { markSyntheticTestModified(); setTitle(event.target.value); }} placeholder="A precise, evidence-supported working title" value={title}/></label>
              <label className="field-label mt-20">Authors and verified metadata<textarea className="field-control metadata-textarea" maxLength={12000} onChange={(event) => { markSyntheticTestModified(); setAuthorMetadata(event.target.value); }} placeholder="Names in order; affiliations; corresponding author and email; ORCIDs; funding and conflict statements only if confirmed…" value={authorMetadata}/><small>Do not paste passwords, private keys, or other credentials.</small></label>
              <label className="field-label mt-20">Manuscript, notes, or structured findings<textarea className="field-control manuscript-textarea" maxLength={manuscriptCharacterLimit} onChange={(event) => { markSyntheticTestModified(); setManuscript(event.target.value); }} placeholder="Paste the abstract, introduction, methods, experiments, results, discussion, citations, and any TODO notes…" value={manuscript}/><small>{manuscriptWords.toLocaleString()} words · {manuscript.length.toLocaleString()} / {manuscriptCharacterLimit.toLocaleString()} characters{largeCorpusMode ? " · reduced to reserve model context for the evidence packet and images" : ""}</small></label>

              {largeCorpusMode && (
                <section aria-labelledby="large-corpus-title" className="large-corpus-workspace">
                  <div className="large-corpus-heading">
                    <div>
                      <p className="eyebrow">Staged source analysis</p>
                      <h3 id="large-corpus-title">Build a bounded evidence packet</h3>
                      <p>Scholar Flow maps explicit headings in their observed hierarchy, classifies recognized roles, records when lower-level headings inherit a parent role, leaves unknown top-level roles unclassified, weights roles for the selected submission type, seeds source and section breadth when space permits, then restores source order. This deterministic selection happens before the {ociCloudTesting ? "OCI model request" : isolatedLocalLlama ? "local Ollama request" : "model request"}, so the model sees only the bounded packet. The report shows selected, partial, and omitted evidence instead of assuming every page is equally important or logically ordered.</p>
                    </div>
                    {corpusFiles.length > 0 && <button className="secondary-button" disabled={isAnalyzingCorpus || isGenerating} onClick={clearCorpusFiles} type="button">Clear corpus</button>}
                  </div>

                  <button
                    aria-describedby="corpus-attachment-limits"
                    aria-label="Choose or drop Large Corpus source files"
                    className={`upload-zone corpus-upload-zone ${isDraggingCorpusFiles ? "dragging" : ""}`}
                    disabled={isAnalyzingCorpus || isGenerating}
                    onClick={() => corpusFileInputRef.current?.click()}
                    onDragEnter={(event) => { event.preventDefault(); corpusDragDepthRef.current += 1; setIsDraggingCorpusFiles(true); }}
                    onDragLeave={(event) => { event.preventDefault(); corpusDragDepthRef.current = Math.max(0, corpusDragDepthRef.current - 1); if (corpusDragDepthRef.current === 0) setIsDraggingCorpusFiles(false); }}
                    onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                    onDrop={(event) => { event.preventDefault(); event.stopPropagation(); corpusDragDepthRef.current = 0; setIsDraggingCorpusFiles(false); addCorpusFiles(event.dataTransfer.files); }}
                    type="button"
                  >
                    <span className="upload-glyph"><Icon name="upload" size={24}/></span>
                    <div><strong>Drop corpus sources here or click to browse</strong><p id="corpus-attachment-limits">PDF, TXT, Markdown, LaTeX, BibTeX, CSV, or JSON · 20 MB each · 40 MB combined · 12 files max · 10 PDFs max</p></div>
                    <span className="secondary-button">Choose corpus files</span>
                  </button>
                  <input accept=".pdf,.txt,.md,.markdown,.tex,.bib,.csv,.json" disabled={isAnalyzingCorpus || isGenerating} hidden multiple onChange={(event) => addCorpusFiles(event.target.files)} ref={corpusFileInputRef} type="file"/>
                  <div className="upload-summary"><span>{formatBytes(totalCorpusBytes)} of 40 MB used</span><span>{corpusFiles.length} of {MAX_ATTACHMENT_FILES} corpus files</span></div>
                  <p className="field-help">PDFs must contain searchable text and may contain at most 600 pages. Each source may contain up to 4,000,000 searchable characters, with 5,000,000 extracted characters across the corpus. Files remain limited to 20 MB each and 40 MB total. Corpus files create the measured evidence packet and are not inserted as LaTeX figures.</p>

                  {corpusUploadErrors.length > 0 && <div className="upload-errors" role="alert">{corpusUploadErrors.map((error) => <p key={error}><Icon name="alert" size={14}/>{error}</p>)}</div>}

                  {corpusFiles.length > 0 && (
                    <ul aria-label="Selected Large Corpus sources" className="corpus-file-list">
                      {corpusFiles.map((file, index) => (
                        <li key={attachmentPlanKey(file)}>
                          <span className="attachment-file-icon"><Icon name="file" size={16}/></span>
                          <p><strong>{safeAttachmentName(file.name)}</strong><span>{formatBytes(file.size)} · source {index + 1}</span></p>
                          <button aria-label={`Remove ${file.name} from the corpus`} disabled={isAnalyzingCorpus || isGenerating} onClick={() => removeCorpusFile(index)} type="button"><Icon name="close" size={16}/></button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="corpus-process-row">
                    <button aria-describedby="corpus-process-status" className="secondary-button dark corpus-process-button" disabled={isAnalyzingCorpus || isGenerating || corpusFiles.length === 0 || largeCorpusTransportUnsupported} onClick={processLargeCorpus} type="button">
                      {isAnalyzingCorpus ? <><span className="spinner"/>Processing corpus…</> : <><Icon name="spark"/>{corpusAnalysis ? "Process corpus again" : "Process corpus"}</>}
                    </button>
                    <p aria-atomic="true" aria-live="polite" id="corpus-process-status">
                      {isAnalyzingCorpus
                        ? "Extracting and selecting evidence. Keep this page open."
                        : corpusAnalysisIsCurrent
                          ? "Current analysis is ready for final generation."
                          : corpusAnalysis
                            ? "Inputs changed after analysis. Process the corpus again."
                            : "Process these sources before generating the paper."}
                    </p>
                  </div>
                  {corpusAnalysisErrors.length > 0 && <div className="upload-errors" role="alert">{corpusAnalysisErrors.map((error) => <p key={error}><Icon name="alert" size={14}/>{error}</p>)}</div>}

                  {corpusAnalysis && <CorpusCoveragePanel analysis={corpusAnalysis} isCurrent={Boolean(corpusAnalysisIsCurrent)} onClear={() => { setCorpusAnalysis(null); setCorpusAnalysisErrors([]); }}/>}
                </section>
              )}

              {largeCorpusMode && (
                <div className="direct-assets-intro">
                  <p className="eyebrow">Final figures and image assets</p>
                  <h3>Add only images needed by the final paper</h3>
                  <p>Use the existing attachment planner below for PNG, JPG, JPEG, or WebP images. PDF and text evidence belongs in the corpus uploader above. WebP can be inspected but cannot be compiled as a LaTeX figure.</p>
                </div>
              )}

              <button aria-describedby="attachment-limits" aria-label="Choose files or drop attachments here" className={`upload-zone ${isDraggingFiles ? "dragging" : ""}`} onClick={() => fileInputRef.current?.click()} onDragEnter={(event) => { event.preventDefault(); dragDepthRef.current += 1; setIsDraggingFiles(true); }} onDragLeave={(event) => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (dragDepthRef.current === 0) setIsDraggingFiles(false); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dragDepthRef.current = 0; setIsDraggingFiles(false); addFiles(event.dataTransfer.files); }} type="button">
                <span className="upload-glyph"><Icon name="upload" size={24}/></span>
                <div><strong>{largeCorpusMode ? "Drop final image assets here or click to browse" : "Drop files here or click anywhere to browse"}</strong><p id="attachment-limits">{largeCorpusMode ? "PNG, JPG, JPEG, or WebP · 7 MB each · 40 MB combined · 12 files max" : "PDF/text: 20 MB each · images: 7 MB each · 40 MB combined · 10 PDFs max"}</p></div>
                <span className="secondary-button">{largeCorpusMode ? "Choose image assets" : "Choose files"}</span>
              </button>
              <input accept={largeCorpusMode ? ".png,.jpg,.jpeg,.webp" : ".pdf,.txt,.md,.markdown,.tex,.bib,.csv,.json,.png,.jpg,.jpeg,.webp"} hidden multiple onChange={(event) => addFiles(event.target.files)} ref={fileInputRef} type="file"/>
              <div className="upload-summary"><span>{formatBytes(totalAttachmentBytes)} of 40 MB used · text character limits also apply</span><span>{files.length} of {MAX_ATTACHMENT_FILES} files</span></div>
              <p className="field-help">PDFs must contain searchable text. Scholar Flow extracts that text locally; attach important figures separately only when the configured model supports vision.{ociCloudTesting ? " Extracted text and supported images are then sent to OCI for model processing." : isolatedLocalLlama ? " Model processing stays on the loopback Ollama server." : ""}</p>
              {uploadErrors.length > 0 && <div className="upload-errors" role="alert">{uploadErrors.map((error) => <p key={error}><Icon name="alert" size={14}/>{error}</p>)}</div>}

              {files.length > 0 && (
                <div className="attachment-plan">
                  <div className="attachment-plan-heading">
                    <div>
                      <p className="eyebrow">Attachment order &amp; placement</p>
                      <h3>Tell the paper exactly how every file is used</h3>
                    </div>
                    <p>Exact AI filenames are locked. The configured model must follow this plan and may not guess a filename, caption, or location.</p>
                  </div>
                  <ul className="attachment-plan-list">
                    {files.map((file, index) => {
                      const plan =
                        attachmentPlan[attachmentPlanKey(file)] ??
                        defaultAttachmentPlanEntry(file, index + 1);
                      const canBeFigure = paperFigureExtensions.has(fileExtension(file.name));
                      const helpId = `attachment-plan-help-${index}`;
                      return (
                        <li className="attachment-card" key={attachmentPlanKey(file)}>
                          <div className="attachment-card-header">
                            <span className="attachment-file-icon"><Icon name="file"/></span>
                            <p>
                              <strong>{file.name}</strong>
                              <span>{formatBytes(file.size)} · {file.type || "detected by extension"}</span>
                            </p>
                            <button aria-label={`Remove ${file.name}`} disabled={isGenerating} onClick={() => removeFile(index)} type="button"><Icon name="close" size={16}/></button>
                          </div>
                          <div className="attachment-fields">
                            <label className="field-label wide">
                              Exact filename used by the paper
                              <input className="field-control attachment-file-name" readOnly value={plan.fileName}/>
                              <small>This locked name is sent with the file so the model cannot rename or guess it.</small>
                            </label>
                            <label className="field-label">
                              Use as
                              <select
                                aria-describedby={helpId}
                                className="field-control"
                                disabled={isGenerating}
                                onChange={(event) => updateAttachmentPlan(file, { purpose: event.target.value as AttachmentPlanEntry["purpose"] })}
                                value={plan.purpose}
                              >
                                {canBeFigure && <option value="figure">Figure in the paper</option>}
                                <option value="source">Source material only</option>
                              </select>
                            </label>
                            <label className="field-label">
                              File order
                              <input
                                className="field-control"
                                disabled={isGenerating}
                                inputMode="numeric"
                                max={99}
                                min={1}
                                onChange={(event) => updateAttachmentPlan(file, { order: event.target.valueAsNumber })}
                                type="number"
                                value={Number.isNaN(plan.order) ? "" : plan.order}
                              />
                              <small>Use a unique number from 1 to 99.</small>
                            </label>
                            <label className="field-label">
                              Paper section {plan.purpose === "figure" && <span className="required-mark">Required</span>}
                              <input
                                className="field-control"
                                disabled={isGenerating}
                                maxLength={160}
                                onChange={(event) => updateAttachmentPlan(file, { section: event.target.value })}
                                placeholder="e.g., Methodology"
                                value={plan.section}
                              />
                            </label>
                            <label className="field-label">
                              Relative location
                              <input
                                className="field-control"
                                disabled={isGenerating}
                                maxLength={500}
                                onChange={(event) => updateAttachmentPlan(file, { relativePlacement: event.target.value })}
                                placeholder="e.g., After the dataset-preparation paragraph"
                                value={plan.relativePlacement}
                              />
                            </label>
                            <label className="field-label wide">
                              {plan.purpose === "figure" ? "Exact figure caption" : "Source usage note"} {plan.purpose === "figure" && <span className="required-mark">Required</span>}
                              <textarea
                                className="field-control attachment-note"
                                disabled={isGenerating}
                                maxLength={2000}
                                onChange={(event) => updateAttachmentPlan(file, { captionOrNote: event.target.value })}
                                placeholder={plan.purpose === "figure" ? "Enter the exact caption the paper must use." : "Optional: explain which claim or section this file supports."}
                                value={plan.captionOrNote}
                              />
                            </label>
                          </div>
                          <p className="attachment-purpose-help" id={helpId}>
                            {canBeFigure
                              ? plan.purpose === "figure"
                                ? "This image will be included in LaTeX using the locked filename, section, order, and caption above."
                                : "The model may inspect this image as evidence, but it must not place it in the paper."
                              : fileExtension(file.name) === "webp"
                                ? "WebP can be inspected as source material, but convert it to PNG or JPG before using it as a paper figure."
                                : "This file supplies evidence or text and cannot be inserted as a LaTeX figure."}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>

            <section className="build-section">
              <div><p className="eyebrow">Ready to compile</p><h2>Generate your paper draft and source</h2><p>Scholar Flow creates an editable paper draft, downloadable LaTeX, and a rule-by-rule review report. The generated LaTeX can then be compiled into a PDF for author review.</p><div className="build-deliverables" aria-label="Generated outputs"><span>Paper draft</span><span>LaTeX .tex</span><span>PDF .pdf on demand</span><span>Compliance report</span></div></div>
              <div className="data-notice"><Icon name="info" size={16}/><span>{dataHandlingNotice} Scholar Flow does not maintain its own manuscript database or browser project storage; refreshing clears unsaved form state. It performs no live publication-website retrieval.{ociCloudTesting ? " Processing and retention outside Scholar Flow remain governed by your Oracle account, OCI service configuration, and applicable model-provider terms." : isolatedLocalLlama ? " For a hard zero-egress boundary, also use a network-disabled VM, container, or host firewall." : ""}</span></div>
              {largeCorpusMode && <p aria-live="polite" className={`corpus-final-status ${corpusAnalysisIsCurrent && !largeCorpusTransportUnsupported ? "ready" : "waiting"}`} id="large-corpus-final-status">{largeCorpusTransportUnsupported ? "Large Corpus generation is unavailable with the configured generation transport." : isAnalyzingCorpus ? "Corpus processing is still running." : corpusAnalysisIsCurrent ? `The current corpus analysis will be used for the final ${modelRequestLabel}.` : corpusAnalysis ? "Process the corpus again because its analysis is stale." : "Process the corpus before final generation."}</p>}
              <button aria-describedby={largeCorpusMode ? "large-corpus-final-status" : undefined} className="primary-button" disabled={isGenerating || isAnalyzingCorpus || health.ready !== true || !hasSubmissionWorkflow || (largeCorpusMode && (!corpusAnalysisIsCurrent || largeCorpusTransportUnsupported))} type="submit">{isGenerating ? <><span className="spinner"/>{loadingMessages[loadingIndex]}</> : <><Icon name="spark"/>{syntheticTest ? "Generate synthetic test package" : largeCorpusMode ? "Generate from processed corpus" : "Generate paper draft & LaTeX"}<Icon name="arrow"/></>}</button>
              {errors.length > 0 && <div className="error-box" role="alert"><Icon name="alert"/><div><strong>Before this can run</strong><ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>{generationDiagnosticId && <p>Diagnostic reference: <code>{generationDiagnosticId}</code></p>}</div></div>}
            </section>
          </form>
        </div>

        <div className="profile-column"><ProfileSidebar confirmedVenue={confirmedVenueIsCurrent ? confirmedVenue : null} customPublisher={customPublisher} isCustom={isCustom} profile={selectedProfile} submissionType={submissionType} targetVenue={targetVenue}/></div>
      </section>

      {result && <div className="generated-anchor" id="generated-package" ref={generatedPackageRef} tabIndex={-1}><ResultWorkspace generatedFiles={generatedFiles} key={`${result.metadata.generatedAt}-${result.paper.title}`} result={result} syntheticTest={generatedSyntheticTest}/></div>}

      <footer><div><span className="brand-mark small"><img alt="" src="/scholar-flow-mark.svg"/></span><p><strong>Scholar Flow</strong><small>Rules assist authors. Authors remain responsible for accuracy, disclosure, and submission.</small></p></div><p>{footerRuntimeNotice}</p></footer>
    </main>
  );
}
