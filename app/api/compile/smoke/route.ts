import { NextResponse } from "next/server";

import {
  isLoopbackHostname,
  permitsLoopbackCompilerFallback,
} from "@/lib/compiler-browser-bridge.mjs";

export const runtime = "edge";

const CLASS_TIMEOUT_MS = 20_000;
const MAX_SMOKE_PDF_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;

const smokeFixtures = [
  {
    id: "ieeetran",
    label: "IEEE conference",
    documentClass: "IEEEtran",
    profileId: "ieee-igarss-2026",
    submissionType: "Full paper · Initial review",
    latex: String.raw`\documentclass[conference]{IEEEtran}
\begin{document}
\title{Scholar Flow Local Compiler Check}
\author{Synthetic Test Author}
\maketitle
\begin{abstract}This is fixed synthetic text used only to test local PDF compilation.\end{abstract}
\section{Check}
The IEEE class compiled successfully.
\end{document}`,
  },
  {
    id: "acmart",
    label: "ACM proceedings",
    documentClass: "acmart",
    profileId: "acm-sigconf",
    submissionType: "Camera-ready / final paper",
    latex: String.raw`\documentclass[sigconf]{acmart}
\settopmatter{printacmref=false}
\begin{document}
\title{Scholar Flow Local Compiler Check}
\author{Synthetic Test Author}
\affiliation{\institution{Synthetic Institution}\country{United States}}
\begin{abstract}This is fixed synthetic text used only to test local PDF compilation.\end{abstract}
\maketitle
\section{Check}
The ACM class compiled successfully.
\end{document}`,
  },
  {
    id: "llncs",
    label: "Springer LNCS",
    documentClass: "llncs",
    profileId: "springer-lncs",
    submissionType: "Full paper · Initial review",
    latex: String.raw`\documentclass[runningheads]{llncs}
\begin{document}
\title{Scholar Flow Local Compiler Check}
\author{Synthetic Test Author}
\institute{Synthetic Institution}
\maketitle
\begin{abstract}This is fixed synthetic text used only to test local PDF compilation.\end{abstract}
\section{Check}
The LNCS class compiled successfully.
\end{document}`,
  },
  {
    id: "elsarticle",
    label: "Elsevier article",
    documentClass: "elsarticle",
    profileId: "elsevier-research-article",
    submissionType: "Journal research article",
    latex: String.raw`\documentclass[preprint,12pt]{elsarticle}
\begin{document}
\begin{frontmatter}
\title{Scholar Flow Local Compiler Check}
\author{Synthetic Test Author}
\begin{abstract}This is fixed synthetic text used only to test local PDF compilation.\end{abstract}
\end{frontmatter}
\section{Check}
The Elsevier class compiled successfully.
\end{document}`,
  },
] as const;

interface SmokeResult {
  id: string;
  label: string;
  documentClass: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  pdfBytes?: number;
  message?: string;
}

class LimitedBodyError extends Error {}

function isAuthorizedLocalRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const requestUrl = new URL(request.url);
  if (!isLoopbackHostname(requestUrl.hostname)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const originUrl = new URL(origin);
    return (
      originUrl.origin === requestUrl.origin &&
      isLoopbackHostname(originUrl.hostname)
    );
  } catch {
    return false;
  }
}

function compilerConfiguration(request: Request) {
  const requestUrl = new URL(request.url);
  const configuredUrl = process.env.SCHOLAR_FLOW_LATEX_COMPILER_URL?.trim();
  const rawUrl =
    configuredUrl ||
    (isLoopbackHostname(requestUrl.hostname)
      ? "http://127.0.0.1:3101/compile"
      : "");
  const url = new URL(rawUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !isLoopbackHostname(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Closed-isolation mode requires a loopback-only PDF compiler URL.",
    );
  }
  const token = process.env.SCHOLAR_FLOW_LATEX_COMPILER_TOKEN?.trim() ?? "";
  if (token.length > 4_096 || /[\r\n]/.test(token)) {
    throw new Error("The PDF compiler token is invalid.");
  }
  const usesLocalDefault = permitsLoopbackCompilerFallback({
    requestHostname: requestUrl.hostname,
    configuredUrl: configuredUrl ?? "",
    token,
  });
  return { url: url.toString(), token, usesLocalDefault };
}

async function readLimitedBody(response: Response, maximum: number) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new LimitedBodyError();
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

function isPdf(bytes: Uint8Array) {
  return (
    bytes.byteLength >= 8 &&
    new TextDecoder("ascii").decode(bytes.slice(0, 5)) === "%PDF-"
  );
}

async function boundedCompilerError(response: Response) {
  try {
    const bytes = await readLimitedBody(response, MAX_ERROR_BYTES);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const record = value as Record<string, unknown>;
    const nested =
      record.error && typeof record.error === "object" && !Array.isArray(record.error)
        ? (record.error as Record<string, unknown>)
        : null;
    const message = nested?.message;
    return typeof message === "string"
      ? message
          .replaceAll(/[\u0000-\u001f\u007f]/g, "")
          .slice(0, 500)
      : "";
  } catch {
    return "";
  }
}

async function testFixture(
  fixture: (typeof smokeFixtures)[number],
  compiler: ReturnType<typeof compilerConfiguration>,
): Promise<{ result: SmokeResult; unavailable: boolean }> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASS_TIMEOUT_MS);
  try {
    const headers = new Headers({
      Accept: "application/pdf, application/json",
      "Content-Type": "application/json",
    });
    if (compiler.token) headers.set("Authorization", `Bearer ${compiler.token}`);
    const response = await fetch(compiler.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        latex: fixture.latex,
        title: `${fixture.label} smoke test`,
        profileId: fixture.profileId,
        submissionType: fixture.submissionType,
        assets: [],
      }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const message = await boundedCompilerError(response);
      return {
        unavailable: response.status >= 500 || response.status === 401 || response.status === 403,
        result: {
          id: fixture.id,
          label: fixture.label,
          documentClass: fixture.documentClass,
          status: "failed",
          durationMs,
          message: message || `Compiler returned HTTP ${response.status}.`,
        },
      };
    }

    const bytes = await readLimitedBody(response, MAX_SMOKE_PDF_BYTES);
    if (!isPdf(bytes)) {
      return {
        unavailable: false,
        result: {
          id: fixture.id,
          label: fixture.label,
          documentClass: fixture.documentClass,
          status: "failed",
          durationMs,
          message: "Compiler returned an invalid PDF.",
        },
      };
    }
    return {
      unavailable: false,
      result: {
        id: fixture.id,
        label: fixture.label,
        documentClass: fixture.documentClass,
        status: "passed",
        durationMs,
        pdfBytes: bytes.byteLength,
      },
    };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      unavailable: true,
      result: {
        id: fixture.id,
        label: fixture.label,
        documentClass: fixture.documentClass,
        status: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        message: timedOut
          ? "Compiler did not respond within 20 seconds."
          : error instanceof LimitedBodyError
            ? "Compiler returned an unexpectedly large response."
            : "Local PDF compiler could not be reached.",
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  if (!isAuthorizedLocalRequest(request)) {
    return NextResponse.json(
      { error: "Not found." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  let compiler: ReturnType<typeof compilerConfiguration>;
  try {
    compiler = compilerConfiguration(request);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The PDF compiler configuration is invalid.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const results: SmokeResult[] = [];
  let compilerUnavailable = false;
  for (let index = 0; index < smokeFixtures.length; index += 1) {
    const fixture = smokeFixtures[index];
    const test = await testFixture(fixture, compiler);
    results.push(test.result);
    if (test.unavailable) {
      compilerUnavailable = true;
      for (const remaining of smokeFixtures.slice(index + 1)) {
        results.push({
          id: remaining.id,
          label: remaining.label,
          documentClass: remaining.documentClass,
          status: "skipped",
          durationMs: 0,
          message: "Skipped because the compiler service is unavailable.",
        });
      }
      break;
    }
  }

  return NextResponse.json(
    {
      ok: results.every((result) => result.status === "passed"),
      localOnly: true,
      ...(compilerUnavailable ? { code: "LOCAL_COMPILER_UNAVAILABLE" } : {}),
      ...(compilerUnavailable && compiler.usesLocalDefault
        ? { loopbackFallbackAllowed: true }
        : {}),
      checkedAt: new Date().toISOString(),
      results,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
