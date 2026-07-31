import "server-only";

import { ociJsonHealthPassed } from "@/lib/oci-json-diagnostics.mjs";

export type OciReadinessStatus =
  | "ready"
  | "missing"
  | "project_required"
  | "invalid_config"
  | "invalid"
  | "denied"
  | "model_unavailable"
  | "unavailable";

export type OciTransport = "chat" | "responses";

export interface OciRuntimeConfig {
  enabled: boolean;
  apiKey: string;
  region: string;
  projectId: string;
  model: string;
  maxOutputTokens: number;
  baseUrl: string;
  transport: OciTransport;
  configurationError: string | null;
}

export class OciPublicError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly upstreamStatus: number;
  readonly requestId: string | null;

  constructor({
    message,
    code,
    httpStatus,
    upstreamStatus,
    requestId,
  }: {
    message: string;
    code: string;
    httpStatus: number;
    upstreamStatus: number;
    requestId?: string | null;
  }) {
    super(message);
    this.name = "OciPublicError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstreamStatus = upstreamStatus;
    this.requestId = requestId ?? null;
  }
}

interface OciErrorPayload {
  error?: {
    code?: unknown;
    message?: unknown;
    type?: unknown;
    param?: unknown;
  };
  code?: unknown;
  message?: unknown;
}

type OciEnvironment = Record<string, string | undefined>;

function enabledValue(value: string | undefined) {
  if (value === undefined || !value.trim()) return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function configurationError(
  region: string,
  projectId: string,
  model: string,
  rawBaseUrl: string,
  transport: string,
  rawMaxOutputTokens: string,
  maxOutputTokens: number,
) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-\d+$/.test(region)) {
    return "ORESOLVE_GENAI_REGION must be a valid OCI region identifier, such as us-ashburn-1.";
  }
  if (projectId && !/^ocid1\.generativeaiproject\.[A-Za-z0-9._-]+$/.test(projectId)) {
    return "ORESOLVE_GENAI_PROJECT_ID must be an OCI Generative AI Project OCID.";
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,199}$/.test(model)) {
    return "ORESOLVE_GENAI_MODEL contains unsupported characters.";
  }
  if (transport !== "chat" && transport !== "responses") {
    return "ORESOLVE_GENAI_TRANSPORT must be either chat or responses.";
  }
  if (
    (rawMaxOutputTokens && !/^\d+$/.test(rawMaxOutputTokens)) ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 4_096 ||
    maxOutputTokens > 65_536
  ) {
    return "ORESOLVE_GENAI_MAX_OUTPUT_TOKENS must be an integer from 4096 through 65536.";
  }

  try {
    const url = new URL(rawBaseUrl);
    const expectedHost = `inference.generativeai.${region}.oci.oraclecloud.com`;
    const normalizedPath = url.pathname.replace(/\/+$/, "");
    if (
      url.protocol !== "https:" ||
      url.hostname !== expectedHost ||
      url.port ||
      normalizedPath !== "/openai/v1" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return `ORESOLVE_GENAI_BASE_URL must be https://${expectedHost}/openai/v1 and match ORESOLVE_GENAI_REGION.`;
    }
  } catch {
    return "ORESOLVE_GENAI_BASE_URL must be a valid OCI Generative AI OpenAI-compatible endpoint.";
  }
  return null;
}

export function getOciRuntimeConfig(
  environment: OciEnvironment = process.env,
): OciRuntimeConfig {
  const enabled = enabledValue(environment.ORESOLVE_GENAI_ENABLED);
  const apiKey = environment.ORESOLVE_GENAI_API_KEY?.trim() ?? "";
  const region =
    environment.ORESOLVE_GENAI_REGION?.trim().toLowerCase() ||
    "us-ashburn-1";
  const projectId =
    environment.ORESOLVE_GENAI_PROJECT_ID?.trim() ?? "";
  const model =
    environment.ORESOLVE_GENAI_MODEL?.trim() ||
    "google.gemini-2.5-flash";
  const rawMaxOutputTokens =
    environment.ORESOLVE_GENAI_MAX_OUTPUT_TOKENS?.trim() ?? "";
  const defaultMaxOutputTokens = /^google\.gemini-2\.5-(?:flash|pro)$/.test(model)
    ? 65_536
    : 32_768;
  const maxOutputTokens = rawMaxOutputTokens
    ? Number(rawMaxOutputTokens)
    : defaultMaxOutputTokens;
  const rawBaseUrl =
    environment.ORESOLVE_GENAI_BASE_URL?.trim() ||
    `https://inference.generativeai.${region}.oci.oraclecloud.com/openai/v1`;
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const transport =
    environment.ORESOLVE_GENAI_TRANSPORT?.trim().toLowerCase() ||
    "chat";

  return {
    enabled,
    apiKey,
    region,
    projectId,
    model,
    maxOutputTokens,
    baseUrl,
    transport: transport as OciTransport,
    configurationError: configurationError(
      region,
      projectId,
      model,
      baseUrl,
      transport,
      rawMaxOutputTokens,
      maxOutputTokens,
    ),
  };
}

export function ociHeaders(
  config: OciRuntimeConfig,
  json = false,
  includeProject = true,
) {
  return {
    Authorization: `Bearer ${config.apiKey}`,
    Accept: "application/json",
    ...(includeProject && config.projectId
      ? { "OpenAI-Project": config.projectId }
      : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function readOciError(response: Response) {
  let payload: OciErrorPayload = {};
  try {
    payload = (await response.json()) as OciErrorPayload;
  } catch {
    // Status-based handling remains safe if OCI returns an empty or non-JSON body.
  }

  const values = [
    payload.error?.code,
    payload.error?.type,
    payload.error?.param,
    payload.error?.message,
    payload.code,
    payload.message,
  ];
  return values
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .slice(0, 1_000);
}

function publicError(
  response: Response,
  code: string,
  message: string,
  httpStatus = 502,
) {
  return new OciPublicError({
    code,
    message,
    httpStatus,
    upstreamStatus: response.status,
    requestId: response.headers.get("opc-request-id"),
  });
}

export async function ociErrorFromResponse(
  response: Response,
  model: string,
) {
  const categoryText = await readOciError(response);

  if (
    response.status === 400 &&
    /openai-project|generative ai project|project (?:id|ocid)|opc-conversation-store-id/i.test(
      categoryText,
    )
  ) {
    return publicError(
      response,
      "OCI_PROJECT_REQUIRED",
      "Add ORESOLVE_GENAI_PROJECT_ID with the OCID of an OCI Generative AI Project in the configured region, then restart Scholar Flow.",
      503,
    );
  }

  if (response.status === 401) {
    return publicError(
      response,
      "OCI_KEY_REJECTED",
      "Oracle Cloud rejected ORESOLVE_GENAI_API_KEY. Confirm that the Generative AI API key is active, then update .env.local and restart Scholar Flow.",
      503,
    );
  }

  if (response.status === 403) {
    return publicError(
      response,
      "OCI_PERMISSION_DENIED",
      "Oracle Cloud denied this Generative AI request. Check the key permissions, model access, and region. Responses mode also requires project and Files access.",
      503,
    );
  }

  if (response.status === 404) {
    return publicError(
      response,
      "OCI_MODEL_UNAVAILABLE",
      `The configured OCI model (${model}) or regional endpoint is unavailable to this API key.`,
      503,
    );
  }

  if (response.status === 413 || /too large|payload|request size|context length|token limit/i.test(categoryText)) {
    return publicError(
      response,
      "OCI_INPUT_TOO_LARGE",
      "The submission exceeds an OCI request, file, or model context limit. Split the manuscript or submit fewer attachments.",
      413,
    );
  }

  if (response.status === 429) {
    return publicError(
      response,
      "OCI_QUOTA_EXCEEDED",
      "The OCI Generative AI project has reached a rate or quota limit. Try again later or review the project's limits.",
      429,
    );
  }

  if (response.status >= 500) {
    return publicError(
      response,
      "OCI_UNAVAILABLE",
      "OCI Generative AI is temporarily unavailable. Try again later.",
      502,
    );
  }

  if (/json.?schema|structured output|text\.format|response format|schema/i.test(categoryText)) {
    return publicError(
      response,
      "OCI_SCHEMA_REJECTED",
      "OCI Generative AI rejected Scholar Flow's structured output format. This is an app configuration issue, not a manuscript problem.",
    );
  }

  if (/\bpdf\b|\bimage\b|\bmedia\b|mime|attachment|input_file|input_image|file_id/i.test(categoryText)) {
    return publicError(
      response,
      "OCI_ATTACHMENT_REJECTED",
      "OCI Generative AI could not process one of the attachments. Convert the suspect file to a standard PDF, PNG, or JPEG and retry.",
      422,
    );
  }

  return publicError(
    response,
    "OCI_INVALID_REQUEST",
    "OCI Generative AI rejected the request. Review the configured project, region, and model, or retry with fewer attachments.",
  );
}

type OciAccessResult = {
  ready: boolean;
  status: OciReadinessStatus;
  message?: string;
};

function readinessFromError(error: OciPublicError): OciAccessResult {
  const status: OciReadinessStatus =
    error.code === "OCI_KEY_REJECTED"
      ? "invalid"
      : error.code === "OCI_PROJECT_REQUIRED"
        ? "project_required"
        : error.code === "OCI_PERMISSION_DENIED"
          ? "denied"
          : error.code === "OCI_MODEL_UNAVAILABLE"
            ? "model_unavailable"
            : "unavailable";
  return { ready: false, status, message: error.message };
}

async function verifyOciChatAccess(
  config: OciRuntimeConfig,
): Promise<OciAccessResult> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: ociHeaders(config, true, false),
    body: JSON.stringify({
      model: config.model,
      messages: [
        {
          role: "user",
          content: 'Return only the JSON object {"ok":true}.',
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 128,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });

  if (response.ok) {
    let jsonHealthPassed = false;
    try {
      jsonHealthPassed = ociJsonHealthPassed(await response.json());
    } catch {
      // A malformed 2xx body is a format-readiness failure, not a credential error.
    }
    if (!jsonHealthPassed) {
      return {
        ready: false,
        status: "unavailable",
        message:
          "OCI accepted the health request but did not return the expected JSON object for the configured model and transport.",
      };
    }
    return {
      ready: true,
      status: "ready",
      message:
        "OCI Chat Completions, the configured model, and a basic JSON-mode response were verified. Searchable PDF text is extracted locally before generation.",
    };
  }

  return readinessFromError(await ociErrorFromResponse(response, config.model));
}

async function verifyOciResponsesAccess(
  config: OciRuntimeConfig,
): Promise<OciAccessResult> {
  if (!config.projectId) {
    return {
      ready: false,
      status: "project_required",
      message:
        "Responses mode requires ORESOLVE_GENAI_PROJECT_ID for OCI Files access.",
    };
  }

  const response = await fetch(`${config.baseUrl}/files?limit=1`, {
    headers: ociHeaders(config),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });

  if (response.ok) {
    return {
      ready: true,
      status: "ready",
      message:
        "OCI credentials, project, and Files access were verified. Model access is confirmed when you generate a package.",
    };
  }

  return readinessFromError(await ociErrorFromResponse(response, config.model));
}

export async function verifyOciAccess(
  config: OciRuntimeConfig,
): Promise<OciAccessResult> {
  try {
    return config.transport === "responses"
      ? await verifyOciResponsesAccess(config)
      : await verifyOciChatAccess(config);
  } catch {
    return {
      ready: false,
      status: "unavailable",
      message:
        "Scholar Flow could not verify OCI Generative AI access. Check the network, regional endpoint, and server configuration.",
    };
  }
}
