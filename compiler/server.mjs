import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseCompilerResult } from "./diagnostics.mjs";
import {
  getSubmissionLatexContract,
  getVenueTemplateContract,
  publicationLatexContractIssues,
} from "./publication-template.mjs";
import { verifyVenueContractArtifact } from "../lib/venue-contract-artifact.mjs";
import { resolveVenueContractSigningSecret } from "../lib/venue-contract-secret.mjs";
import { normalizeConfirmedVenueContract } from "../lib/venue-guidelines.mjs";
import {
  isSubmissionTypeAllowed,
  publisherForProfile,
} from "../lib/submission-types.mjs";
import {
  assessCompiledPageCount,
  getSubmissionPagePolicy,
} from "../lib/page-limits.mjs";
import {
  LIMITS,
  ValidationError,
  safePdfName,
  validateAndDecodeAssets,
  validateLatex,
  validatePdf,
} from "./safety.mjs";
import {
  buildContentPageAuditLatex,
  tectonicPageCount,
} from "./pdf-page-count.mjs";

const compilerDirectory = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || "127.0.0.1";
const port = parsePort(process.env.PORT || "3101");
const token = process.env.SCHOLAR_FLOW_LATEX_COMPILER_TOKEN || "";
const tectonicBin = path.resolve(
  process.env.TECTONIC_BIN || path.join(compilerDirectory, ".bin", "tectonic"),
);
const cacheDirectory = path.resolve(
  process.env.TECTONIC_CACHE_DIR || path.join(compilerDirectory, ".cache"),
);
const onlyCached = process.env.TECTONIC_ONLY_CACHED !== "0";
const maxConcurrency = parsePositiveInteger(process.env.COMPILER_MAX_CONCURRENCY || "2", 8);
const smokeFixtures = Object.freeze([
  { id: "ieeetran", label: "IEEE conference", documentClass: "IEEEtran", file: "10-ieeetran.tex", profileId: "ieee-igarss-2026", submissionType: "Full paper · Initial review" },
  { id: "acmart", label: "ACM proceedings", documentClass: "acmart", file: "20-acmart.tex", profileId: "acm-sigconf", submissionType: "Camera-ready / final paper" },
  { id: "llncs", label: "Springer LNCS", documentClass: "llncs", file: "30-llncs.tex", profileId: "springer-lncs", submissionType: "Full paper · Initial review" },
  { id: "elsarticle", label: "Elsevier article", documentClass: "elsarticle", file: "40-elsarticle.tex", profileId: "elsevier-research-article", submissionType: "Journal research article" },
]);
let activeCompilations = 0;

if (!isLoopbackHost(host)) {
  throw new Error(
    "Closed-isolation mode requires the LaTeX compiler to bind to a loopback host.",
  );
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const localCorsOrigin = allowedLocalCorsOrigin(request.headers.origin);
  if (localCorsOrigin) setLocalCorsHeaders(request, response, localCorsOrigin);

  if (
    request.method === "OPTIONS" &&
    (request.url === "/compile" || request.url === "/smoke")
  ) {
    if (!localCorsOrigin) {
      sendJson(response, 403, errorPayload("ORIGIN_REJECTED", "Origin not allowed."));
      return;
    }
    response.writeHead(204, { "Content-Length": "0" });
    response.end();
    return;
  }

  if (request.method === "GET" && request.url === "/health") {
    const signing = resolveVenueContractSigningSecret(process.env);
    sendJson(response, 200, {
      status: "ok",
      compiler: "tectonic",
      protocolVersion: 4,
      submissionAwareContracts: true,
      signedDynamicVenueContracts: true,
      venueContractSigningConfigured: signing.status === "ready",
      venueContractSigningStatus: signing.status,
      pageCountHeaders: true,
      busy: activeCompilations >= maxConcurrency,
    });
    return;
  }

  if (request.method === "POST" && request.url === "/smoke") {
    if (!localCorsOrigin || token || !isLoopbackHost(host)) {
      sendJson(response, 404, errorPayload("NOT_FOUND", "Route not found."));
      return;
    }
    if (!String(request.headers["content-type"] || "")
      .toLowerCase()
      .startsWith("application/json")) {
      sendJson(response, 415, errorPayload("INVALID_CONTENT_TYPE", "Use application/json."));
      return;
    }
    try {
      const body = await readJson(request, 1_024);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
        throw new ValidationError("The local smoke-test body must be an empty object.");
      }
      await runLocalSmokeTest(response);
    } catch (error) {
      if (response.destroyed) return;
      const normalized = normalizeError(error);
      sendJson(
        response,
        normalized.status,
        errorPayload(normalized.code, normalized.message, normalized.detail),
      );
    }
    return;
  }

  if (request.method !== "POST" || request.url !== "/compile") {
    sendJson(response, 404, errorPayload("NOT_FOUND", "Route not found."));
    return;
  }

  if (token && !hasValidToken(request.headers.authorization, token)) {
    sendJson(response, 401, errorPayload("UNAUTHORIZED", "A valid compiler token is required."));
    return;
  }

  if (!String(request.headers["content-type"] || "")
    .toLowerCase()
    .startsWith("application/json")) {
    sendJson(response, 415, errorPayload("INVALID_CONTENT_TYPE", "Use application/json."));
    return;
  }

  if (activeCompilations >= maxConcurrency) {
    response.setHeader("Retry-After", "5");
    sendJson(response, 429, errorPayload("COMPILER_BUSY", "The compiler is busy. Try again shortly."));
    return;
  }

  activeCompilations += 1;
  try {
    const payload = await readJson(request);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ValidationError("The request body must be an object.");
    }
    validateLatex(payload.latex);
    const dynamicVenue = await verifiedDynamicVenueContract(
      payload,
      process.env,
    );
    const venueTemplateContract = dynamicVenue?.templateContract ?? null;
    const venuePagePolicy = dynamicVenue?.contract.pagePolicy ?? null;
    if (payload.profileId !== undefined) {
      if (
        typeof payload.profileId !== "string" ||
        !payload.profileId ||
        payload.profileId.length > 80
      ) {
        throw new ValidationError(
          "profileId must be a known publication profile ID.",
          "INVALID_PUBLICATION_PROFILE",
          422,
        );
      }
      if (
        typeof payload.submissionType !== "string" ||
        !payload.submissionType ||
        payload.submissionType.length > 120
      ) {
        throw new ValidationError(
          "submissionType is required with profileId and must be 120 characters or less.",
          "INVALID_SUBMISSION_TYPE",
          422,
        );
      }
      if (
        !isSubmissionTypeAllowed(payload.profileId, payload.submissionType)
      ) {
        throw new ValidationError(
          "submissionType is not supported by the selected publication profile.",
          "INVALID_SUBMISSION_TYPE",
          422,
        );
      }
      if (
        dynamicVenue &&
        dynamicVenue.contract.submissionType !== payload.submissionType
      ) {
        throw new ValidationError(
          "The signed venue contract does not match submissionType.",
          "VENUE_CONTRACT_SUBMISSION_MISMATCH",
          422,
        );
      }
      const profilePublisher = publisherForProfile(payload.profileId);
      if (
        dynamicVenue &&
        profilePublisher &&
        dynamicVenue.contract.publisher !== profilePublisher
      ) {
        throw new ValidationError(
          "The signed venue contract publisher does not match profileId.",
          "VENUE_CONTRACT_PUBLISHER_MISMATCH",
          422,
        );
      }
      const contract =
        venueTemplateContract ??
        getSubmissionLatexContract(
          payload.profileId,
          payload.submissionType,
        );
      if (!contract) {
        throw new ValidationError(
          "profileId and submissionType must identify a supported publication workflow.",
          "INVALID_SUBMISSION_TYPE",
          422,
        );
      }
      const [templateIssue] = publicationLatexContractIssues(
        payload.latex,
        contract,
        "The selected publication",
      );
      if (templateIssue) {
        throw new ValidationError(
          templateIssue,
          "PUBLICATION_TEMPLATE_MISMATCH",
          422,
        );
      }
    } else if (dynamicVenue) {
      throw new ValidationError(
        "profileId and submissionType are required with a signed venue contract.",
        "INVALID_PUBLICATION_PROFILE",
        422,
      );
    } else if (payload.submissionType !== undefined) {
      throw new ValidationError(
        "submissionType cannot be supplied without profileId.",
        "INVALID_PUBLICATION_PROFILE",
        422,
      );
    }
    const assets = validateAndDecodeAssets(payload.assets);
    const pagePolicy =
      venueTemplateContract
        ? venuePagePolicy
        : payload.profileId && payload.submissionType
        ? getSubmissionPagePolicy(payload.profileId, payload.submissionType)
        : null;
    const { pdf, totalPageCount, contentPages } = await compile({
      latex: payload.latex,
      assets,
      auditContentPages:
        pagePolicy?.countScope === "content_excluding_references",
    });
    if (response.destroyed) return;
    if (pagePolicy) {
      const assessment = assessCompiledPageCount(pagePolicy, {
        totalPages: totalPageCount,
        contentPages,
      });
      if (assessment.status !== "pass") {
        throw new ValidationError(
          assessment.message,
          assessment.status === "fail"
            ? "PAGE_CONTRACT_VIOLATION"
            : "PAGE_COUNT_UNAVAILABLE",
          assessment.status === "fail" ? 422 : 500,
        );
      }
    }

    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `attachment; filename="${safePdfName(payload.title)}"`,
      "X-Scholar-Flow-Total-Pages": String(totalPageCount),
      "X-Scholar-Flow-Protocol-Version": "4",
      "X-Scholar-Flow-Signed-Dynamic-Venue-Contracts": "true",
      ...(contentPages
        ? { "X-Scholar-Flow-Content-Pages": String(contentPages) }
        : {}),
    });
    response.end(pdf);
  } catch (error) {
    if (response.destroyed) return;
    const normalized = normalizeError(error);
    sendJson(
      response,
      normalized.status,
      errorPayload(normalized.code, normalized.message, normalized.detail),
    );
  } finally {
    activeCompilations -= 1;
  }
});

server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 25;

server.listen(port, host, () => {
  process.stdout.write(`Scholar Flow LaTeX compiler listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  });
}

async function compile({ latex, assets, auditContentPages = false }) {
  await fs.access(tectonicBin, fs.constants.X_OK);
  await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });

  const jobDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "scholar-flow-latex-"));
  const outputDirectory = path.join(jobDirectory, "output");
  try {
    await fs.mkdir(outputDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(jobDirectory, "manuscript.tex"), latex, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    for (const asset of assets) {
      await fs.writeFile(path.join(jobDirectory, asset.name), asset.data, {
        mode: 0o600,
        flag: "wx",
      });
    }

    const args = [
      "--untrusted",
      "--keep-logs",
      "--keep-intermediates",
      "--outdir",
      outputDirectory,
    ];
    if (onlyCached) args.push("--only-cached");
    args.push("manuscript.tex");

    const result = await runCompiler(args, jobDirectory);
    if (result.timedOut) {
      throw new CompilerError(
        "Compilation exceeded the 45-second limit.",
        "COMPILE_TIMEOUT",
        504,
      );
    }
    const diagnostic = diagnoseCompilerResult({
      exitCode: result.code,
      output: result.output,
      latex,
      jobDirectory,
      cacheDirectory,
    });
    if (diagnostic) {
      throw new CompilerError(
        diagnostic.message,
        diagnostic.code,
        diagnostic.status,
        diagnostic.detail,
      );
    }

    const pdfPath = path.join(outputDirectory, "manuscript.pdf");
    const stat = await fs.stat(pdfPath);
    if (!stat.isFile() || stat.size > LIMITS.pdfBytes) {
      throw new CompilerError("The compiler produced an invalid-size PDF.", "INVALID_PDF", 502);
    }
    const pdf = await fs.readFile(pdfPath);
    validatePdf(pdf);
    let log;
    try {
      log = await fs.readFile(
        path.join(outputDirectory, "manuscript.log"),
        "utf8",
      );
    } catch {
      throw new CompilerError(
        "The compiler did not preserve a page-count log.",
        "PAGE_COUNT_UNAVAILABLE",
        502,
      );
    }
    const totalPageCount = tectonicPageCount(log);
    if (!totalPageCount) {
      throw new CompilerError(
        "The compiler produced a PDF but did not report a reliable page count.",
        "PAGE_COUNT_UNAVAILABLE",
        502,
      );
    }

    let contentPages = null;
    if (auditContentPages) {
      let auditLatex;
      try {
        auditLatex = buildContentPageAuditLatex(latex);
      } catch (error) {
        throw new CompilerError(
          error instanceof Error
            ? error.message
            : "The compiler could not prepare the content-page audit.",
          "CONTENT_PAGE_COUNT_UNAVAILABLE",
          422,
        );
      }
      const auditFileName = "manuscript-page-audit.tex";
      await fs.writeFile(path.join(jobDirectory, auditFileName), auditLatex, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const auditArgs = [
        "--untrusted",
        "--keep-logs",
        "--keep-intermediates",
        "--outdir",
        outputDirectory,
      ];
      if (onlyCached) auditArgs.push("--only-cached");
      auditArgs.push(auditFileName);
      const auditResult = await runCompiler(auditArgs, jobDirectory);
      if (auditResult.timedOut) {
        throw new CompilerError(
          "The content-page audit exceeded the 45-second limit.",
          "COMPILE_TIMEOUT",
          504,
        );
      }
      const auditDiagnostic = diagnoseCompilerResult({
        exitCode: auditResult.code,
        output: auditResult.output,
        latex: auditLatex,
        jobDirectory,
        cacheDirectory,
      });
      if (auditDiagnostic) {
        throw new CompilerError(
          "The PDF compiled, but its content-page audit failed.",
          "CONTENT_PAGE_COUNT_UNAVAILABLE",
          422,
          auditDiagnostic.detail,
        );
      }
      let auditLog;
      try {
        auditLog = await fs.readFile(
          path.join(outputDirectory, "manuscript-page-audit.log"),
          "utf8",
        );
      } catch {
        throw new CompilerError(
          "The compiler did not preserve the content-page audit log.",
          "CONTENT_PAGE_COUNT_UNAVAILABLE",
          502,
        );
      }
      contentPages = tectonicPageCount(auditLog);
      if (!contentPages) {
        throw new CompilerError(
          "The compiler did not report a reliable content-page count.",
          "CONTENT_PAGE_COUNT_UNAVAILABLE",
          502,
        );
      }
    }
    return { pdf, totalPageCount, contentPages };
  } finally {
    await fs.rm(jobDirectory, { recursive: true, force: true });
  }
}

async function runLocalSmokeTest(response) {
  if (activeCompilations >= maxConcurrency) {
    response.setHeader("Retry-After", "5");
    sendJson(response, 429, errorPayload("COMPILER_BUSY", "The compiler is busy. Try again shortly."));
    return;
  }

  activeCompilations += 1;
  const results = [];
  try {
    for (let index = 0; index < smokeFixtures.length; index += 1) {
      const fixture = smokeFixtures[index];
      const startedAt = Date.now();
      try {
        const latex = await fs.readFile(
          path.join(compilerDirectory, "fixtures", fixture.file),
          "utf8",
        );
        validateLatex(latex);
        const contract = getSubmissionLatexContract(
          fixture.profileId,
          fixture.submissionType,
        );
        const [templateIssue] = publicationLatexContractIssues(
          latex,
          contract,
          fixture.label,
        );
        if (templateIssue) {
          throw new ValidationError(
            templateIssue,
            "PUBLICATION_TEMPLATE_MISMATCH",
            422,
          );
        }
        const { pdf, totalPageCount } = await compile({
          latex,
          assets: [],
        });
        results.push({
          id: fixture.id,
          label: fixture.label,
          documentClass: fixture.documentClass,
          status: "passed",
          durationMs: Date.now() - startedAt,
          pdfBytes: pdf.length,
          pageCount: totalPageCount,
        });
      } catch (error) {
        const normalized = normalizeError(error);
        results.push({
          id: fixture.id,
          label: fixture.label,
          documentClass: fixture.documentClass,
          status: "failed",
          durationMs: Date.now() - startedAt,
          message: normalized.message,
        });
        if (normalized.status >= 500) {
          for (const remaining of smokeFixtures.slice(index + 1)) {
            results.push({
              id: remaining.id,
              label: remaining.label,
              documentClass: remaining.documentClass,
              status: "skipped",
              durationMs: 0,
              message: "Skipped because the local compiler is unavailable.",
            });
          }
          break;
        }
      }
    }
  } finally {
    activeCompilations -= 1;
  }

  sendJson(response, 200, {
    ok: results.every((result) => result.status === "passed"),
    localOnly: true,
    checkedAt: new Date().toISOString(),
    results,
  });
}

function runCompiler(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(tectonicBin, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        HOME: cacheDirectory,
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        XDG_CACHE_HOME: cacheDirectory,
        TECTONIC_UNTRUSTED_MODE: "1",
        SOURCE_DATE_EPOCH: "0",
      },
    });
    let outputHead = "";
    let outputTail = "";
    let timedOut = false;

    const capture = (chunk) => {
      let value = chunk.toString("utf8");
      const headLimit = Math.floor(LIMITS.compilerLogBytes / 2);
      const tailLimit = LIMITS.compilerLogBytes - headLimit;
      if (outputHead.length < headLimit) {
        const remaining = headLimit - outputHead.length;
        outputHead += value.slice(0, remaining);
        value = value.slice(remaining);
      }
      if (value) outputTail = `${outputTail}${value}`.slice(-tailLimit);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, LIMITS.compileTimeoutMs);
    timer.unref();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const separator = outputTail ? "\n[earlier compiler output omitted]\n" : "";
      resolve({ code, signal, output: `${outputHead}${separator}${outputTail}`, timedOut });
    });
  });
}

async function readJson(request, maxBytes = LIMITS.requestBytes) {
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidationError("The request body is too large.", "REQUEST_TOO_LARGE", 413);
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw new ValidationError("The request body is too large.", "REQUEST_TOO_LARGE", 413);
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("The request body is not valid JSON.", "INVALID_JSON");
  }
}

function hasValidToken(authorization, expected) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = authorization.slice(7);
  const actualDigest = createHash("sha256").update(supplied).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

async function verifiedDynamicVenueContract(payload, environment) {
  const hasContract = Object.hasOwn(payload, "venueContract");
  const hasArtifact = Object.hasOwn(payload, "venueContractArtifact");
  const hasTemplateKey = Object.hasOwn(payload, "venueTemplateKey");
  const hasPagePolicy = Object.hasOwn(payload, "pagePolicy");
  const hasSignedField = hasContract || hasArtifact;
  const hasDerivedField = hasTemplateKey || hasPagePolicy;

  if (hasSignedField && hasDerivedField) {
    throw new ValidationError(
      "Do not mix a signed venue contract with derived venueTemplateKey or pagePolicy fields.",
      "VENUE_CONTRACT_FIELDS_MIXED",
      422,
    );
  }
  if (hasDerivedField) {
    throw new ValidationError(
      "venueTemplateKey and pagePolicy are untrusted legacy fields. Supply the original confirmed venueContract and venueContractArtifact instead.",
      "UNTRUSTED_DYNAMIC_VENUE_FIELDS",
      422,
    );
  }
  if (!hasSignedField) return null;
  if (!hasContract || !hasArtifact) {
    throw new ValidationError(
      "A dynamic venue compile requires both venueContract and venueContractArtifact.",
      "VENUE_CONTRACT_PAIR_REQUIRED",
      422,
    );
  }
  if (
    !payload.venueContract ||
    typeof payload.venueContract !== "object" ||
    Array.isArray(payload.venueContract) ||
    typeof payload.venueContractArtifact !== "string" ||
    !payload.venueContractArtifact
  ) {
    throw new ValidationError(
      "venueContract must be an object and venueContractArtifact must be a non-empty string.",
      "VENUE_CONTRACT_PAIR_REQUIRED",
      422,
    );
  }

  const signing = resolveVenueContractSigningSecret(environment);
  if (signing.status !== "ready") {
    throw new ValidationError(
      signing.error,
      signing.status === "invalid"
        ? "VENUE_CONTRACT_SIGNING_INVALID"
        : "VENUE_CONTRACT_SIGNING_UNAVAILABLE",
      503,
    );
  }
  const verified = await verifyVenueContractArtifact({
    artifact: payload.venueContractArtifact,
    contract: payload.venueContract,
    secret: signing.secret,
  });
  if (!verified) {
    throw new ValidationError(
      "The signed venue contract is invalid or does not match its artifact.",
      "VENUE_CONTRACT_INVALID",
      422,
    );
  }

  let contract;
  try {
    contract = normalizeConfirmedVenueContract(payload.venueContract);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error
        ? `The signed venue contract is invalid: ${error.message}`
        : "The signed venue contract is invalid.",
      "VENUE_CONTRACT_INVALID",
      422,
    );
  }
  const templateContract = getVenueTemplateContract(contract.templateKey);
  if (!templateContract) {
    throw new ValidationError(
      "The signed venue contract selects an unsupported template.",
      "PUBLICATION_TEMPLATE_MISMATCH",
      422,
    );
  }
  return Object.freeze({ contract, templateContract });
}

function normalizeError(error) {
  if (error instanceof ValidationError || error instanceof CompilerError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      detail: error.detail,
    };
  }
  if (error?.code === "ENOENT" || error?.code === "EACCES") {
    return {
      status: 503,
      code: "COMPILER_UNAVAILABLE",
      message: "Tectonic is not installed or executable. Run compiler/setup.mjs.",
    };
  }
  process.stderr.write(`Compiler error: ${String(error?.message || error).slice(0, 500)}\n`);
  return {
    status: 500,
    code: "COMPILER_ERROR",
    message: "The PDF compiler encountered an unexpected error.",
  };
}

class CompilerError extends Error {
  constructor(message, code, status, detail) {
    super(message);
    this.name = "CompilerError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function errorPayload(code, message, detail) {
  return { error: { code, message, ...(detail ? { detail } : {}) } };
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(data.length),
  });
  response.end(data);
}

function parsePort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}

function parsePositiveInteger(value, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`COMPILER_MAX_CONCURRENCY must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

function isLoopbackHost(value) {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function allowedLocalCorsOrigin(origin) {
  if (token || !isLoopbackHost(host) || typeof origin !== "string") return "";
  try {
    const url = new URL(origin);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHost(url.hostname) &&
      url.origin === origin
    ) {
      return origin;
    }
  } catch {
    // Invalid origins are rejected by returning an empty value.
  }
  return "";
}

function setLocalCorsHeaders(request, response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader(
    "Access-Control-Expose-Headers",
    "X-Scholar-Flow-Total-Pages, X-Scholar-Flow-Content-Pages, X-Scholar-Flow-Protocol-Version, X-Scholar-Flow-Signed-Dynamic-Venue-Contracts",
  );
  response.setHeader("Access-Control-Max-Age", "600");
  response.setHeader("Vary", "Origin");
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true");
  }
}
