"use client";

import { useState, useSyncExternalStore } from "react";

import {
  isLoopbackHostname,
  shouldUseDirectCompilerSmoke,
  supportsCompilerBridgeProtocol,
} from "@/lib/compiler-browser-bridge.mjs";

interface SmokeResult {
  id: string;
  label: string;
  documentClass: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  pdfBytes?: number;
  pageCount?: number;
  message?: string;
}

interface SmokeResponse {
  ok: boolean;
  results: SmokeResult[];
  code?: string;
  loopbackFallbackAllowed?: boolean;
}

const panelStyle = {
  position: "fixed",
  right: "16px",
  bottom: "16px",
  zIndex: 50,
  width: "min(360px, calc(100vw - 32px))",
  border: "1px solid #b8cec7",
  borderRadius: "16px",
  background: "#fffdf8",
  padding: "12px 14px",
  boxShadow: "0 14px 38px rgba(23, 42, 58, 0.16)",
  color: "#163044",
  fontSize: "12px",
} as const;

function subscribeToBrowserLocation() {
  return () => {};
}

function localBrowserSnapshot() {
  return isLoopbackHostname(window.location.hostname);
}

function serverBrowserSnapshot() {
  return false;
}

type SmokeResponseBody = Partial<SmokeResponse> & { error?: unknown };

function smokeErrorMessage(body: SmokeResponseBody, status: number) {
  if (typeof body.error === "string" && body.error.trim()) {
    return body.error.trim().slice(0, 500);
  }
  if (
    body.error &&
    typeof body.error === "object" &&
    !Array.isArray(body.error)
  ) {
    const message = (body.error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim().slice(0, 500);
    }
  }
  return `Smoke test failed (HTTP ${status}).`;
}

async function readSmokeResponse(response: Response) {
  try {
    return (await response.json()) as SmokeResponseBody;
  } catch {
    return {} satisfies SmokeResponseBody;
  }
}

async function requestDirectLoopbackSmoke(signal: AbortSignal) {
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
  };
  try {
    health = (await healthResponse.json()) as typeof health;
  } catch {
    throw new Error(
      "The local PDF compiler is from an older Scholar Flow version. Restart npm run dev before testing publisher classes.",
    );
  }
  if (!supportsCompilerBridgeProtocol(health, healthResponse.ok)) {
    throw new Error(
      "The local PDF compiler is from an older Scholar Flow version. Restart npm run dev before testing publisher classes.",
    );
  }

  try {
    return await fetch("http://127.0.0.1:3101/smoke", {
      ...loopbackRequestOptions,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  } catch {
    throw new Error(
      "The local PDF compiler stopped responding. Restart Scholar Flow with npm run dev, then retry the publisher test.",
    );
  }
}

export default function CompilerSmokeTest() {
  const isLocal = useSyncExternalStore(
    subscribeToBrowserLocation,
    localBrowserSnapshot,
    serverBrowserSnapshot,
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<SmokeResult[]>([]);
  const [expanded, setExpanded] = useState(true);

  if (!isLocal) return null;

  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const allPassed = results.length > 0 && passed === results.length;
  const overallStatus = running
    ? "running"
    : error
      ? "error"
      : allPassed
        ? "passed"
        : results.length > 0
          ? "failed"
          : "not-run";
  const statusMessage = running
    ? "Testing four publisher classes. This can take up to 90 seconds."
    : error
      ? error
      : allPassed
        ? `All ${passed} publisher classes passed the local PDF check.`
        : results.length > 0
          ? `${passed} of ${results.length} publisher classes passed${failed ? `; ${failed} failed` : ""}${skipped ? `; ${skipped} skipped` : ""}.`
          : "Publisher classes have not been tested in this session.";

  async function runSmokeTest() {
    setRunning(true);
    setError("");
    setResults([]);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 90_000);
    try {
      let response = await fetch("/api/compile/smoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        signal: controller.signal,
      });
      let body = await readSmokeResponse(response);
      if (
        isLocal &&
        shouldUseDirectCompilerSmoke({
          browserHostname: window.location.hostname,
          code: body.code,
          loopbackFallbackAllowed: body.loopbackFallbackAllowed,
        })
      ) {
        response = await requestDirectLoopbackSmoke(controller.signal);
        body = await readSmokeResponse(response);
      }
      if (!response.ok || !Array.isArray(body.results)) {
        throw new Error(smokeErrorMessage(body, response.status));
      }
      setResults(body.results);
    } catch (caught) {
      setError(
        controller.signal.aborted
          ? "The local compiler check exceeded 90 seconds."
          : caught instanceof Error
            ? caught.message
            : "The local compiler check failed.",
      );
    } finally {
      window.clearTimeout(timeout);
      setRunning(false);
    }
  }

  return (
    <aside
      aria-busy={running}
      aria-label="Local PDF compiler check"
      data-status={overallStatus}
      data-testid="compiler-smoke-panel"
      style={panelStyle}
    >
      <details
        onToggle={(event) => setExpanded(event.currentTarget.open)}
        open={expanded}
      >
        <summary style={{ cursor: "pointer", fontWeight: 800 }}>
          PDF template self-test
          <span
            aria-hidden="true"
            data-testid="compiler-smoke-summary-badge"
            style={{
              color:
                overallStatus === "passed"
                  ? "#297154"
                  : overallStatus === "error" || overallStatus === "failed"
                    ? "#a4423a"
                    : "#64737b",
              float: "right",
              fontSize: "10px",
              marginLeft: "10px",
              textTransform: "uppercase",
            }}
          >
            {overallStatus === "not-run" ? "not run" : overallStatus}
          </span>
        </summary>
        <p
          id="compiler-smoke-description"
          style={{ color: "#64737b", lineHeight: 1.5, margin: "10px 0" }}
        >
          Compiles fixed synthetic IEEE, ACM, Springer, and Elsevier fixtures. It
          does not call a model or send manuscript data.
        </p>
        <button
          aria-describedby="compiler-smoke-description compiler-smoke-status"
          className="secondary-button"
          data-testid="compiler-smoke-run"
          disabled={running}
          onClick={runSmokeTest}
          type="button"
        >
          {running
            ? "Testing publisher classes…"
            : results.length > 0 || error
              ? "Run publisher test again"
              : "Test publisher classes"}
        </button>
        <div
          aria-atomic="true"
          aria-live={error ? "assertive" : "polite"}
          data-testid="compiler-smoke-status"
          id="compiler-smoke-status"
          role={error ? "alert" : "status"}
        >
          <p
            style={{
              color: error
                ? "#a4423a"
                : allPassed
                  ? "#297154"
                  : "#64737b",
              fontWeight: results.length > 0 ? 800 : 400,
              lineHeight: 1.45,
              margin: "10px 0 0",
            }}
          >
            {statusMessage}
          </p>
        </div>
        <div>
          {results.length > 0 && (
            <ul
              aria-label="Publisher class smoke-test results"
              data-testid="compiler-smoke-results"
              style={{ listStyle: "none", margin: "12px 0 0", padding: 0 }}
            >
              {results.map((result) => (
                <li
                  data-status={result.status}
                  data-testid={`compiler-smoke-result-${result.id}`}
                  key={result.id}
                  style={{
                    borderTop: "1px solid #d8ddd7",
                    display: "grid",
                    gap: "3px",
                    gridTemplateColumns: "1fr auto",
                    padding: "8px 0",
                  }}
                >
                  <strong>{result.label}</strong>
                  <span
                    style={{
                      color:
                        result.status === "passed"
                          ? "#297154"
                          : result.status === "failed"
                            ? "#a4423a"
                            : "#64737b",
                      fontWeight: 800,
                    }}
                  >
                    {result.status[0].toUpperCase() + result.status.slice(1)}
                  </span>
                  <span style={{ color: "#64737b", gridColumn: "1 / -1" }}>
                    <code>{result.documentClass}</code>
                    {result.status === "passed"
                      ? ` · ${result.durationMs} ms · ${result.pdfBytes?.toLocaleString()} bytes`
                      : result.message
                        ? ` · ${result.message}`
                        : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </aside>
  );
}
