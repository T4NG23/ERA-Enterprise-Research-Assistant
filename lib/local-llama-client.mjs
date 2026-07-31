const MAX_RESPONSE_CHARACTERS = 2_000_000;
const MAX_MESSAGE_CHARACTERS = 800_000;
const MAX_MESSAGE_PARTS = 64;
const MAX_JSON_SCHEMA_CHARACTERS = 250_000;
const MAX_TIMEOUT_MS = 20 * 60 * 1_000;
const MAX_OUTPUT_TOKENS = 131_072;

export class LocalLlamaPublicError extends Error {
  constructor({
    message,
    code,
    httpStatus,
    upstreamStatus = 0,
  }) {
    super(message);
    this.name = "LocalLlamaPublicError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstreamStatus = upstreamStatus;
  }
}

function invalidConfiguration(message) {
  return new LocalLlamaPublicError({
    message,
    code: "LOCAL_LLAMA_INVALID_CONFIGURATION",
    httpStatus: 503,
  });
}

function localLlamaEndpoint(rawBaseUrl) {
  if (
    typeof rawBaseUrl !== "string" ||
    !rawBaseUrl ||
    rawBaseUrl !== rawBaseUrl.trim()
  ) {
    throw invalidConfiguration(
      "The local model base URL must be an exact loopback HTTP URL ending in /v1.",
    );
  }

  const authorityMatch = rawBaseUrl.match(
    /^http:\/\/([^/?#]+)(?:[/?#]|$)/iu,
  );
  const rawAuthority = authorityMatch?.[1] ?? "";
  const rawHostMatch = rawAuthority.startsWith("[")
    ? rawAuthority.match(/^\[([^\]]+)\](?::\d{1,5})?$/u)
    : rawAuthority.match(/^([^:]+)(?::\d{1,5})?$/u);
  const rawHostname =
    rawHostMatch?.[1]?.toLocaleLowerCase("en-US") ?? "";

  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw invalidConfiguration(
      "The local model base URL must be an exact loopback HTTP URL ending in /v1.",
    );
  }

  const hostname = url.hostname
    .toLocaleLowerCase("en-US")
    .replace(/^\[([^\]]+)\]$/u, "$1");
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const exactPath = url.pathname === "/v1" || url.pathname === "/v1/";
  if (
    url.protocol !== "http:" ||
    !loopbackHosts.has(rawHostname) ||
    !loopbackHosts.has(hostname) ||
    !exactPath ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw invalidConfiguration(
      "The local model base URL must be an exact loopback HTTP URL ending in /v1.",
    );
  }

  return `${url.origin}/v1/chat/completions`;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function boundedText(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_MESSAGE_CHARACTERS
  ) {
    throw new TypeError(
      `${name} must be nonempty text no longer than ${MAX_MESSAGE_CHARACTERS.toLocaleString("en-US")} characters.`,
    );
  }
  return value;
}

function normalizedMessagePart(part, messageIndex, partIndex) {
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new TypeError(
      `messages[${messageIndex}].content[${partIndex}] must be an object.`,
    );
  }

  if (part.type === "text") {
    return {
      type: "text",
      text: boundedText(
        part.text,
        `messages[${messageIndex}].content[${partIndex}].text`,
      ),
    };
  }

  if (
    part.type === "image_url" &&
    part.image_url &&
    typeof part.image_url === "object" &&
    !Array.isArray(part.image_url) &&
    typeof part.image_url.url === "string" &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(
      part.image_url.url,
    )
  ) {
    return {
      type: "image_url",
      image_url: {
        url: part.image_url.url,
        detail: "high",
      },
    };
  }

  throw new TypeError(
    `messages[${messageIndex}].content[${partIndex}] is not a supported local-model content part.`,
  );
}

function normalizedMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 4) {
    throw new TypeError("messages must contain from 1 through 4 items.");
  }

  return messages.map((message, messageIndex) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new TypeError(`messages[${messageIndex}] must be an object.`);
    }
    if (message.role !== "system" && message.role !== "user") {
      throw new TypeError(
        `messages[${messageIndex}].role must be system or user.`,
      );
    }

    if (typeof message.content === "string") {
      return {
        role: message.role,
        content: boundedText(
          message.content,
          `messages[${messageIndex}].content`,
        ),
      };
    }
    if (
      !Array.isArray(message.content) ||
      message.content.length < 1 ||
      message.content.length > MAX_MESSAGE_PARTS
    ) {
      throw new TypeError(
        `messages[${messageIndex}].content must contain from 1 through ${MAX_MESSAGE_PARTS} parts.`,
      );
    }
    return {
      role: message.role,
      content: message.content.map((part, partIndex) =>
        normalizedMessagePart(part, messageIndex, partIndex),
      ),
    };
  });
}

function normalizedJsonSchema(value) {
  if (value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError("jsonSchema must be a plain JSON object.");
  }

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError("jsonSchema must be serializable JSON.");
  }
  if (
    !serialized ||
    serialized.length > MAX_JSON_SCHEMA_CHARACTERS
  ) {
    throw new TypeError(
      `jsonSchema must serialize to no more than ${MAX_JSON_SCHEMA_CHARACTERS.toLocaleString("en-US")} characters.`,
    );
  }

  const normalized = JSON.parse(serialized);
  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    throw new TypeError("jsonSchema must describe a JSON object.");
  }
  return normalized;
}

function errorForStatus(status) {
  if (status === 413) {
    return new LocalLlamaPublicError({
      message:
        "The manuscript exceeds the configured local model context. Reduce the source material or increase the local context setting.",
      code: "LOCAL_LLAMA_INPUT_TOO_LARGE",
      httpStatus: 413,
      upstreamStatus: status,
    });
  }
  if (status === 404) {
    return new LocalLlamaPublicError({
      message:
        "The configured local model is not available from the loopback Ollama server.",
      code: "LOCAL_LLAMA_MODEL_UNAVAILABLE",
      httpStatus: 503,
      upstreamStatus: status,
    });
  }
  if (status === 429) {
    return new LocalLlamaPublicError({
      message:
        "The local model server is busy. Wait for the current generation to finish and retry.",
      code: "LOCAL_LLAMA_BUSY",
      httpStatus: 429,
      upstreamStatus: status,
    });
  }
  if (status >= 500) {
    return new LocalLlamaPublicError({
      message:
        "The loopback Ollama server could not complete the generation request.",
      code: "LOCAL_LLAMA_UNAVAILABLE",
      httpStatus: 502,
      upstreamStatus: status,
    });
  }
  return new LocalLlamaPublicError({
  message:
      "The loopback Ollama server rejected Scholar Flow's generation request.",
    code: "LOCAL_LLAMA_INVALID_REQUEST",
    httpStatus: 422,
    upstreamStatus: status,
  });
}

/**
 * Send one JSON-mode chat request to an exact loopback Ollama endpoint.
 * The caller cannot override the endpoint path, HTTP method, model, headers,
 * or response format.
 */
export async function localLlamaChatJson(
  config,
  {
    messages,
    temperature = 0,
    maxTokens,
    timeoutMs = 180_000,
    jsonSchema,
  },
) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw invalidConfiguration("The local model configuration is missing.");
  }
  const endpoint = localLlamaEndpoint(config.baseUrl);
  if (
    typeof config.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(config.model)
  ) {
    throw invalidConfiguration("The configured local model name is invalid.");
  }
  if (
    typeof temperature !== "number" ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  ) {
    throw new TypeError("temperature must be a finite number from 0 through 2.");
  }
  const normalizedMaxTokens = boundedInteger(
    maxTokens,
    "maxTokens",
    1,
    MAX_OUTPUT_TOKENS,
  );
  const normalizedTimeoutMs = boundedInteger(
    timeoutMs,
    "timeoutMs",
    1,
    MAX_TIMEOUT_MS,
  );
  const normalized = normalizedMessages(messages);
  const normalizedSchema = normalizedJsonSchema(jsonSchema);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages: normalized,
      response_format: normalizedSchema
        ? { type: "json_schema", schema: normalizedSchema }
        : { type: "json_object" },
      temperature,
      max_tokens: normalizedMaxTokens,
    }),
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(normalizedTimeoutMs),
  });

  if (!response.ok) {
    throw errorForStatus(response.status);
  }

  const responseText = await response.text();
  if (responseText.length > MAX_RESPONSE_CHARACTERS) {
    throw new LocalLlamaPublicError({
      message:
        "The local model returned an unexpectedly large response. Reduce its output limit and retry.",
      code: "LOCAL_LLAMA_RESPONSE_TOO_LARGE",
      httpStatus: 502,
      upstreamStatus: response.status,
    });
  }
  return {
    responseText,
    responseHeaders: response.headers,
  };
}
