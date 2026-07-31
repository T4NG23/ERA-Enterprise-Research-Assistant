const MAX_REQUEST_ID_CHARACTERS = 128;
const MAX_REDACTED_WINDOW_CHARACTERS = 100;
const MAX_TOKEN_COUNT = 1_000_000_000;

const KNOWN_FINISH_REASONS = new Set([
  "stop",
  "length",
  "max_tokens",
  "content_filter",
  "tool_calls",
  "function_call",
  "refusal",
  "safety",
  "recitation",
]);

const KNOWN_PART_TYPES = new Set([
  "text",
  "output_text",
  "input_text",
  "image_url",
  "input_image",
  "refusal",
  "reasoning",
  "tool_call",
  "function_call",
  "json",
]);

const KNOWN_HTTP_CONTENT_TYPES = new Set([
  "application/json",
  "text/event-stream",
  "text/plain",
]);

const JSON_PUNCTUATION = new Set(["{", "}", "[", "]", ":", ",", '"']);
const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);
const JSON_SIMPLE_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const AMBIGUOUS_LATEX_COMMANDS = new Set([
  "Big",
  "Bigg",
  "Bigl",
  "Bigr",
  "bar",
  "backslash",
  "begin",
  "beta",
  "bfseries",
  "bibitem",
  "bibliography",
  "bibliographystyle",
  "big",
  "bigcap",
  "bigcup",
  "bigg",
  "bigl",
  "bigr",
  "binom",
  "boldmath",
  "boldsymbol",
  "bot",
  "boxed",
  "breve",
  "bullet",
  "fbox",
  "fcolorbox",
  "flat",
  "float",
  "flushleft",
  "flushright",
  "fontfamily",
  "fontsize",
  "footnote",
  "footnotemark",
  "footnotesize",
  "footnotetext",
  "frac",
  "nabla",
  "natural",
  "neg",
  "neq",
  "newcommand",
  "newenvironment",
  "newline",
  "newpage",
  "nocite",
  "noindent",
  "nolimits",
  "nonumber",
  "normalfont",
  "normalsize",
  "not",
  "notag",
  "nu",
  "raggedleft",
  "raggedright",
  "raisebox",
  "rangle",
  "rbrace",
  "rceil",
  "ref",
  "renewcommand",
  "renewenvironment",
  "rho",
  "right",
  "rightarrow",
  "rightharpoonup",
  "rightleftarrows",
  "rmfamily",
  "roman",
  "rotatebox",
  "rule",
  "tag",
  "tan",
  "tau",
  "tableofcontents",
  "text",
  "textbf",
  "textit",
  "textrm",
  "textsc",
  "textsf",
  "textsubscript",
  "textsuperscript",
  "texttt",
  "thanks",
  "the",
  "theta",
  "thickline",
  "thinspace",
  "thispagestyle",
  "tilde",
  "times",
  "tiny",
  "title",
  "titleformat",
  "today",
  "top",
  "toprule",
  "triangle",
]);

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") {
    try {
      const value = headers.get(name);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  const candidate = record(headers);
  if (!candidate) return "";
  const matchedKey = Object.keys(candidate).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return matchedKey && typeof candidate[matchedKey] === "string"
    ? candidate[matchedKey]
    : "";
}

function sanitizedRequestId(explicitRequestId, headers) {
  const candidates = [
    explicitRequestId,
    headerValue(headers, "opc-request-id"),
    headerValue(headers, "x-request-id"),
    headerValue(headers, "request-id"),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (
      value &&
      value.length <= MAX_REQUEST_ID_CHARACTERS &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
    ) {
      return value;
    }
  }
  return null;
}

function sanitizedHttpContentType(headers) {
  const raw = headerValue(headers, "content-type");
  if (!raw) return "missing";
  const mediaType = raw.split(";", 1)[0].trim().toLowerCase();
  return KNOWN_HTTP_CONTENT_TYPES.has(mediaType) ? mediaType : "other";
}

function firstChoice(body) {
  const source = record(body);
  if (!source || !Array.isArray(source.choices)) return null;
  return record(source.choices[0]);
}

function finishReason(body, explicitFinishReason) {
  const choice = firstChoice(body);
  const raw =
    explicitFinishReason === undefined
      ? choice?.finish_reason
      : explicitFinishReason;
  if (typeof raw !== "string" || !raw.trim()) return "missing";
  const normalized = raw.trim().toLowerCase().replaceAll(/[\s-]+/g, "_");
  return KNOWN_FINISH_REASONS.has(normalized) ? normalized : "other";
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKEN_COUNT
    ? value
    : null;
}

function firstTokenCount(...values) {
  for (const value of values) {
    const count = tokenCount(value);
    if (count !== null) return count;
  }
  return null;
}

function usageDetails(body, explicitUsage) {
  const source = record(body);
  const usage = record(explicitUsage) ?? record(source?.usage);
  const promptDetails = record(
    usage?.prompt_tokens_details ?? usage?.input_tokens_details,
  );
  const completionDetails = record(
    usage?.completion_tokens_details ?? usage?.output_tokens_details,
  );

  return {
    inputTokens: firstTokenCount(
      usage?.input_tokens,
      usage?.prompt_tokens,
      usage?.inputTokens,
      usage?.promptTokens,
    ),
    outputTokens: firstTokenCount(
      usage?.output_tokens,
      usage?.completion_tokens,
      usage?.outputTokens,
      usage?.completionTokens,
    ),
    totalTokens: firstTokenCount(usage?.total_tokens, usage?.totalTokens),
    reasoningTokens: firstTokenCount(
      usage?.reasoning_tokens,
      usage?.reasoningTokens,
      completionDetails?.reasoning_tokens,
      completionDetails?.reasoningTokens,
    ),
    cachedInputTokens: firstTokenCount(
      usage?.cached_tokens,
      usage?.cachedTokens,
      promptDetails?.cached_tokens,
      promptDetails?.cachedTokens,
    ),
  };
}

function contentValue(body, explicitContent) {
  if (explicitContent !== undefined) return explicitContent;
  const message = record(firstChoice(body)?.message);
  return message?.content;
}

function normalizedPartType(value) {
  if (typeof value !== "string" || !value.trim()) return "missing";
  const normalized = value.trim().toLowerCase().replaceAll(/[\s-]+/g, "_");
  return KNOWN_PART_TYPES.has(normalized) ? normalized : "other";
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      return typeof item?.text === "string" ? item.text : "";
    })
    .join("");
}

function contentMetadata(value, parsedText) {
  if (typeof value === "string") {
    return {
      kind: "string",
      partCount: 1,
      partTypes: ["text"],
      characterLength: parsedText.length,
    };
  }
  if (Array.isArray(value)) {
    return {
      kind: "parts",
      partCount: value.length,
      partTypes: value.map((part) => normalizedPartType(record(part)?.type)),
      characterLength: parsedText.length,
    };
  }
  const kind =
    value === undefined
      ? "missing"
      : value === null
        ? "null"
        : typeof value === "object"
          ? "object"
          : typeof value === "boolean"
            ? "boolean"
            : typeof value === "number"
              ? "number"
              : "other";
  return {
    kind,
    partCount: 0,
    partTypes: [],
    characterLength: parsedText.length,
  };
}

function lineColumnOffset(text, line, column) {
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) {
    return null;
  }
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) return null;
    offset = newline + 1;
    currentLine += 1;
  }
  return Math.min(text.length, offset + column - 1);
}

function parseOffset(message, text) {
  const positionMatch = message.match(/(?:at\s+)?position\s+(\d+)/iu);
  if (positionMatch) {
    const position = Number(positionMatch[1]);
    return Number.isSafeInteger(position)
      ? Math.min(text.length, Math.max(0, position))
      : null;
  }

  const lineColumnMatch = message.match(/line\s+(\d+)(?:\s+column|\s+col(?:umn)?\.?|:)\s*(\d+)/iu);
  if (lineColumnMatch) {
    return lineColumnOffset(
      text,
      Number(lineColumnMatch[1]),
      Number(lineColumnMatch[2]),
    );
  }
  return null;
}

function parseCategory(message, text) {
  const normalized = message.toLowerCase();
  if (!text.trim()) return "empty";
  if (/^\s*```/u.test(text)) return "markdown_fence";
  if (/unexpected end|end of json|unterminated json/u.test(normalized)) {
    return "unexpected_end";
  }
  if (/unterminated string|unclosed string/u.test(normalized)) {
    return "unterminated_string";
  }
  if (/escape/u.test(normalized)) return "invalid_escape";
  if (/control character/u.test(normalized)) return "control_character";
  if (/number|exponent|decimal/u.test(normalized)) return "invalid_number";
  if (/after json|trailing|non-whitespace character/u.test(normalized)) {
    return "trailing_content";
  }
  if (/property name|double-quoted property|expected.*[:},]/u.test(normalized)) {
    return "property_syntax";
  }
  if (/unexpected token|unexpected character|expected/u.test(normalized)) {
    return "unexpected_token";
  }
  return "syntax_error";
}

function syntaxOnly(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const escaped = value[index + 1];
      if (escaped === "u") {
        result += "\\u####";
        index += Math.min(5, value.length - index - 1);
      } else if (JSON_SIMPLE_ESCAPES.has(escaped)) {
        result += `\\${escaped}`;
        index += 1;
      } else if (escaped !== undefined) {
        result += "\\?";
        index += 1;
      } else {
        result += "\\";
      }
      continue;
    }
    if (JSON_PUNCTUATION.has(character) || JSON_WHITESPACE.has(character)) {
      result += character;
    } else if (/\d/u.test(character)) {
      result += "0";
    } else if (character === "-" || character === "+" || character === ".") {
      result += character;
    } else {
      result += "•";
    }
  }
  return result.slice(0, MAX_REDACTED_WINDOW_CHARACTERS);
}

function redactedWindow(text, offset) {
  if (!text) {
    return { start: 0, end: 0, errorOffsetInWindow: null, syntax: "" };
  }
  const center = offset ?? 0;
  const maximumStart = Math.max(0, text.length - MAX_REDACTED_WINDOW_CHARACTERS);
  const start = Math.min(maximumStart, Math.max(0, center - 50));
  const end = Math.min(text.length, start + MAX_REDACTED_WINDOW_CHARACTERS);
  return {
    start,
    end,
    errorOffsetInWindow:
      offset === null ? null : Math.min(end - start, Math.max(0, offset - start)),
    syntax: syntaxOnly(text.slice(start, end)),
  };
}

function jsonDiagnostic(text, suppliedError) {
  let error = suppliedError;
  if (error === undefined) {
    try {
      JSON.parse(text);
      return {
        category: "valid",
        offset: null,
        window: redactedWindow("", null),
      };
    } catch (caught) {
      error = caught;
    }
  }

  const message = error instanceof Error ? error.message : "";
  const category = parseCategory(message, text);
  const derivedOffset = parseOffset(message, text);
  const offset =
    derivedOffset ?? (category === "unexpected_end" ? text.length : null);
  return {
    category,
    offset,
    window: redactedWindow(text, offset),
  };
}

function diagnosticId() {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  let encoded = "";
  for (const byte of bytes) encoded += byte.toString(36).padStart(2, "0");
  return `oj-${encoded.slice(0, 10)}`;
}

function stripSingleMarkdownFence(text) {
  const trimmed = text.trim();
  const opening = trimmed.match(
    /^```(?:json)?[ \t]*(?:\r\n|\n|\r)/iu,
  );
  if (!opening) return null;

  const fencedBody = trimmed.slice(opening[0].length);
  const closing = fencedBody.match(
    /(?:\r\n|\n|\r)```[ \t]*$/u,
  );
  if (!closing) return null;

  const contents = fencedBody.slice(
    0,
    fencedBody.length - closing[0].length,
  );
  return contents.includes("```") ? null : contents.trim();
}

function exactlyOneBalancedTopLevelObject(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (depth > 0 && inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (depth > 0 && character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character !== "}") continue;
    if (depth === 0) return null;

    depth -= 1;
    if (depth === 0) {
      candidates.push(text.slice(start, index + 1));
      start = -1;
    }
  }

  return depth === 0 && candidates.length === 1 ? candidates[0] : null;
}

function exactControlCharacterEscape(character) {
  if (character === "\b") return "\\b";
  if (character === "\f") return "\\f";
  if (character === "\n") return "\\n";
  if (character === "\r") return "\\r";
  if (character === "\t") return "\\t";
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function repairJsonStringEncoding(text) {
  let result = "";
  let inString = false;
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }

    if (character === '"') {
      result += character;
      inString = false;
      continue;
    }
    if (character === "\\") {
      const escaped = text[index + 1];
      if (JSON_SIMPLE_ESCAPES.has(escaped)) {
        result += `\\${escaped}`;
        index += 1;
        continue;
      }
      if (
        escaped === "u" &&
        /^[0-9a-f]{4}$/iu.test(text.slice(index + 2, index + 6))
      ) {
        result += text.slice(index, index + 6);
        index += 5;
        continue;
      }

      // A second slash encodes the original slash as data. The following
      // character is deliberately processed normally so its value is kept.
      result += "\\\\";
      changed = true;
      continue;
    }
    if (character.charCodeAt(0) <= 0x1f) {
      result += exactControlCharacterEscape(character);
      changed = true;
      continue;
    }
    result += character;
  }

  return changed ? result : null;
}

function jsonStringEnd(text, openingQuote) {
  for (let index = openingQuote + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === '"') return index;
  }
  return -1;
}

function topLevelStringFieldBounds(text, fieldName) {
  let objectDepth = 0;
  let arrayDepth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const end = jsonStringEnd(text, index);
      if (end < 0) return null;
      if (
        objectDepth === 1 &&
        arrayDepth === 0 &&
        text.slice(index + 1, end) === fieldName
      ) {
        let cursor = end + 1;
        while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
        if (text[cursor] === ":") {
          cursor += 1;
          while (/\s/u.test(text[cursor] ?? "")) cursor += 1;
          if (text[cursor] !== '"') return null;
          const valueEnd = jsonStringEnd(text, cursor);
          return valueEnd < 0
            ? null
            : { start: cursor + 1, end: valueEnd };
        }
      }
      index = end;
      continue;
    }
    if (character === "{") objectDepth += 1;
    else if (character === "}") objectDepth -= 1;
    else if (character === "[") arrayDepth += 1;
    else if (character === "]") arrayDepth -= 1;
    if (objectDepth < 0 || arrayDepth < 0) return null;
  }
  return null;
}

function repairAmbiguousLatexEscapes(text) {
  const bounds = topLevelStringFieldBounds(text, "latex");
  if (!bounds) return null;

  const latexSource = text.slice(bounds.start, bounds.end);
  let repaired = "";
  let changed = false;
  for (let index = 0; index < latexSource.length; index += 1) {
    const character = latexSource[index];
    if (character !== "\\") {
      repaired += character;
      continue;
    }

    const escaped = latexSource[index + 1];
    if (escaped === "\\") {
      repaired += "\\\\";
      index += 1;
      continue;
    }
    if (
      escaped === "u" &&
      /^[0-9a-f]{4}$/iu.test(latexSource.slice(index + 2, index + 6))
    ) {
      repaired += latexSource.slice(index, index + 6);
      index += 5;
      continue;
    }
    if (
      escaped !== undefined &&
      "bfnrt".includes(escaped)
    ) {
      const commandMatch = latexSource
        .slice(index + 1)
        .match(/^[A-Za-z]+/u);
      if (
        commandMatch &&
        AMBIGUOUS_LATEX_COMMANDS.has(commandMatch[0])
      ) {
        repaired += "\\\\";
        changed = true;
        continue;
      }
    }

    repaired += character;
    if (escaped !== undefined && JSON_SIMPLE_ESCAPES.has(escaped)) {
      repaired += escaped;
      index += 1;
    }
  }

  if (!changed) return null;
  return `${text.slice(0, bounds.start)}${repaired}${text.slice(bounds.end)}`;
}

function addRecoveryCandidate(candidates, seen, text, wrapper) {
  if (typeof text !== "string" || seen.has(text)) return;
  seen.add(text);
  candidates.push({ text, wrapper });
}

/**
 * Parses OCI JSON without changing decoded scientific content. Strict parsing
 * always runs first. Recovery can remove one outer JSON markdown fence,
 * isolate exactly one balanced top-level object, and encode only literal
 * backslashes or control characters that JSON forbids inside strings.
 */
export function parseOciJsonWithRecovery(outputText) {
  const text = typeof outputText === "string" ? outputText : "";
  let strictError;
  let strictValue;
  try {
    strictValue = JSON.parse(text);
  } catch (error) {
    strictError = error;
  }
  if (strictError === undefined) {
    const latexRepaired = repairAmbiguousLatexEscapes(text);
    if (latexRepaired !== null) {
      try {
        return {
          ok: true,
          value: JSON.parse(latexRepaired),
          recovery: "latex_string_encoding",
          syntaxRepaired: true,
          wrapperRemoved: false,
        };
      } catch {
        // The original strict value remains authoritative if this narrowly
        // scoped repair cannot itself be parsed.
      }
    }
    return {
      ok: true,
      value: strictValue,
      recovery: "none",
      syntaxRepaired: false,
      wrapperRemoved: false,
    };
  }

  const candidates = [];
  const seen = new Set([text]);
  const fenced = stripSingleMarkdownFence(text);
  addRecoveryCandidate(candidates, seen, fenced, "markdown_fence");
  addRecoveryCandidate(
    candidates,
    seen,
    exactlyOneBalancedTopLevelObject(text),
    "object_extraction",
  );
  if (fenced !== null) {
    addRecoveryCandidate(
      candidates,
      seen,
      exactlyOneBalancedTopLevelObject(fenced),
      "markdown_fence_and_object_extraction",
    );
  }

  for (const candidate of candidates) {
    try {
      const strictCandidate = JSON.parse(candidate.text);
      const latexRepaired = repairAmbiguousLatexEscapes(candidate.text);
      if (latexRepaired !== null) {
        try {
          return {
            ok: true,
            value: JSON.parse(latexRepaired),
            recovery: `${candidate.wrapper}_and_latex_string_encoding`,
            syntaxRepaired: true,
            wrapperRemoved: true,
          };
        } catch {
          // Retain the successfully parsed unmodified candidate.
        }
      }
      return {
        ok: true,
        value: strictCandidate,
        recovery: candidate.wrapper,
        syntaxRepaired: false,
        wrapperRemoved: true,
      };
    } catch {
      // Encoding-only recovery below gets the same bounded candidates.
    }
  }

  const encodingCandidates = [
    { text, wrapper: "none" },
    ...candidates,
  ];
  for (const candidate of encodingCandidates) {
    const latexRepaired = repairAmbiguousLatexEscapes(candidate.text);
    const encodingBase = latexRepaired ?? candidate.text;
    const encodingRepaired = repairJsonStringEncoding(encodingBase);
    const repaired = encodingRepaired ?? latexRepaired;
    if (repaired === null) continue;
    try {
      return {
        ok: true,
        value: JSON.parse(repaired),
        recovery:
          candidate.wrapper === "none"
            ? latexRepaired !== null && encodingRepaired === null
              ? "latex_string_encoding"
              : "string_encoding"
            : `${candidate.wrapper}_and_string_encoding`,
        syntaxRepaired: true,
        wrapperRemoved: candidate.wrapper !== "none",
      };
    } catch {
      // Structural or semantic JSON defects are intentionally not repaired.
    }
  }

  return {
    ok: false,
    parseError: strictError,
  };
}

/**
 * Validates the minimal JSON-mode response used by the OCI health check.
 * The function is intentionally pure and accepts both OpenAI-compatible
 * string content and text split across content parts.
 */
export function ociJsonHealthPassed(body) {
  const choice = firstChoice(body);
  const message = record(choice?.message);
  if (!message) return false;

  const normalizedFinishReason = finishReason(body);
  if (
    normalizedFinishReason === "length" ||
    normalizedFinishReason === "max_tokens" ||
    normalizedFinishReason === "content_filter" ||
    normalizedFinishReason === "refusal" ||
    normalizedFinishReason === "safety" ||
    normalizedFinishReason === "recitation"
  ) {
    return false;
  }
  if (
    typeof message.refusal === "string" &&
    message.refusal.trim().length > 0
  ) {
    return false;
  }

  const text = contentText(message.content).trim();
  if (!text) return false;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }

  const result = record(parsed);
  return (
    result !== null &&
    Object.keys(result).length === 1 &&
    Object.hasOwn(result, "ok") &&
    result.ok === true
  );
}

/**
 * Produces metadata safe for server logs. Raw prompts, model text, exception
 * messages, and unknown upstream labels are never included in the result.
 */
export function createOciJsonDiagnostic({
  responseHeaders,
  requestId,
  body,
  finishReason: explicitFinishReason,
  usage,
  content: explicitContent,
  outputText,
  parseError,
} = {}) {
  const content = contentValue(body, explicitContent);
  const text =
    typeof outputText === "string" ? outputText : contentText(content);

  return {
    diagnosticId: diagnosticId(),
    requestId: sanitizedRequestId(requestId, responseHeaders),
    responseContentType: sanitizedHttpContentType(responseHeaders),
    finishReason: finishReason(body, explicitFinishReason),
    usage: usageDetails(body, usage),
    content: contentMetadata(content, text),
    json: jsonDiagnostic(text, parseError),
  };
}

export const OCI_JSON_DIAGNOSTIC_WINDOW_LIMIT = MAX_REDACTED_WINDOW_CHARACTERS;

export const OCI_JSON_RECOVERY_AUTHOR_WARNING =
  "Scholar Flow repaired malformed JSON string encoding in OCI's response before validation. The decoded content then passed the same schema, LaTeX, publication, and security checks, but an author must review the complete draft and source before use.";

export const OCI_CHAT_MAX_GENERATION_ATTEMPTS = 3;

export const OCI_VALID_JSON_REGENERATION_INSTRUCTION = [
  "VALID_JSON_REGENERATION: A previous generation attempt was not valid JSON.",
  "Start over from the supplied source material and return one new, standalone, complete JSON object.",
  "Do not continue, quote, or reconstruct the prior output.",
  "Apply JSON escaping exactly: escape every backslash inside string values as two backslashes, escape literal control characters, use double-quoted property names and strings, and do not add markdown fences or prose outside the object.",
].join("\n");

export function nextOciChatRetryReason({
  failure,
  attemptsRemaining,
  usedOutputLimitRetry,
  usedMalformedJsonRetry,
}) {
  if (attemptsRemaining !== true) return null;
  if (failure === "output_limit" && usedOutputLimitRetry !== true) {
    return "output_limit";
  }
  if (failure === "malformed_json" && usedMalformedJsonRetry !== true) {
    return "malformed_json";
  }
  return null;
}
