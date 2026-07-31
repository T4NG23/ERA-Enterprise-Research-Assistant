import { NextResponse } from "next/server";

import {
  signVenueContractArtifact,
  verifyVenueContractArtifact,
} from "@/lib/venue-contract-artifact.mjs";
import {
  getAiProviderSelection,
  getAiSigningRuntime,
} from "@/lib/ai-provider-runtime";
import { createConfirmedVenueContract } from "@/lib/venue-guidelines.mjs";

export const runtime = "edge";

const MAX_REQUEST_BYTES = 160_000;

class RequestTooLargeError extends Error {}

function errorResponse(error: string, status: number, code: string) {
  return NextResponse.json(
    { error, code },
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

async function readLimitedJson(request: Request) {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)
  ) {
    throw new RequestTooLargeError();
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
  const text = await new Response(limited).text();
  return JSON.parse(text) as unknown;
}

export async function POST(request: Request) {
  if (!requestIsSameOrigin(request)) {
    return errorResponse(
      "Cross-origin venue-contract confirmation is not allowed.",
      403,
      "ORIGIN_REJECTED",
    );
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    return errorResponse(
      "Expected an application/json venue-contract request.",
      415,
      "INVALID_CONTENT_TYPE",
    );
  }

  if (getAiProviderSelection() === "invalid") {
    return errorResponse(
      "SCHOLAR_FLOW_AI_PROVIDER is required and must be exactly oci or local_llama.",
      503,
      "AI_PROVIDER_INVALID_CONFIGURATION",
    );
  }
  const signing = getAiSigningRuntime();
  const secret = signing.venueSigningSecret;
  if (!secret) {
    return errorResponse(
      signing.venueSigningError ||
        "Venue contracts require a dedicated guideline signing secret.",
      503,
      "VENUE_CONTRACT_SIGNING_NOT_CONFIGURED",
    );
  }

  let body: unknown;
  try {
    body = await readLimitedJson(request);
  } catch (error) {
    return errorResponse(
      error instanceof RequestTooLargeError
        ? "The venue-contract request is too large."
        : "Expected valid JSON venue-contract data.",
      error instanceof RequestTooLargeError ? 413 : 400,
      error instanceof RequestTooLargeError
        ? "REQUEST_TOO_LARGE"
        : "INVALID_JSON",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(
      "The venue-contract request must be an object.",
      400,
      "INVALID_REQUEST",
    );
  }
  const record = body as Record<string, unknown>;
  const allowedKeys = new Set([
    "proposal",
    "proposalArtifact",
    "templateKey",
    "pagePolicy",
    "confirmed",
  ]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return errorResponse(
      "The venue-contract request contains unexpected fields.",
      400,
      "INVALID_REQUEST",
    );
  }
  if (
    record.confirmed !== true ||
    typeof record.proposalArtifact !== "string" ||
    typeof record.templateKey !== "string"
  ) {
    return errorResponse(
      "Review the extracted rules and explicitly confirm the source, template, and page policy.",
      422,
      "VENUE_CONTRACT_CONFIRMATION_REQUIRED",
    );
  }

  const proposalVerified = await verifyVenueContractArtifact({
    artifact: record.proposalArtifact,
    contract: record.proposal,
    secret,
  });
  if (!proposalVerified) {
    return errorResponse(
      "The extracted guideline proposal no longer matches its local source snapshot. Upload the official file again.",
      422,
      "VENUE_GUIDELINE_PROPOSAL_STALE",
    );
  }

  try {
    const contract = createConfirmedVenueContract({
      proposal: record.proposal,
      templateKey: record.templateKey,
      pagePolicy: record.pagePolicy ?? null,
    });
    const artifact = await signVenueContractArtifact({ contract, secret });
    return NextResponse.json(
      { contract, artifact },
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
        ? error.message
        : "The confirmed venue contract is invalid.",
      422,
      "VENUE_CONTRACT_INVALID",
    );
  }
}
