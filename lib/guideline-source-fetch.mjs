const MEBIBYTE = 1024 * 1024;

export const OFFICIAL_SCHOLARLY_DOMAINS = Object.freeze([
  // IEEE and IGARSS
  "ieee.org",
  "computer.org",
  "ieeeigarss.org",
  // ACM
  "acm.org",
  // Springer Nature
  "springer.com",
  "springernature.com",
  "nature.com",
  // Elsevier
  "elsevier.com",
  "sciencedirect.com",
  // Wiley
  "wiley.com",
  // Taylor & Francis
  "tandfonline.com",
  "taylorandfrancis.com",
  // Sage
  "sagepub.com",
  // Open-access publishers
  "plos.org",
  "frontiersin.org",
  "mdpi.com",
  // Oxford and Cambridge
  "oup.com",
  "cambridge.org",
  // APS, AIP, ACS, RSC, and IOP
  "aps.org",
  "aip.org",
  "scitation.org",
  "acs.org",
  "rsc.org",
  "iop.org",
  // Computing and AI venues
  "thecvf.com",
  "neurips.cc",
  "icml.cc",
  "aaai.org",
  "aclweb.org",
  "usenix.org",
  // Engineering and optics
  "spie.org",
  "spiedigitallibrary.org",
  "optica.org",
  "asme.org",
]);

export const GUIDELINE_SOURCE_LIMITS = Object.freeze({
  maxUrlCharacters: 4_096,
  maxRedirects: 3,
  defaultTimeoutMs: 12_000,
  maxTimeoutMs: 30_000,
  defaultMaxBytes: 10 * MEBIBYTE,
  maxBytes: 25 * MEBIBYTE,
  defaultMaxTextCharacters: 750_000,
  maxTextCharacters: 2_000_000,
  maxTitleCharacters: 300,
});

const ACCEPTED_MIME_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/pdf",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SUPPORTED_CONTENT_ENCODINGS = new Set([
  "",
  "identity",
  "gzip",
  "br",
  "deflate",
]);
const MAX_BODY_CHUNKS = 16_384;
const PRIVATE_HOST_SUFFIXES = Object.freeze([
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "home",
  "lan",
  "corp",
  "private",
  "test",
  "example",
  "invalid",
  "onion",
  "arpa",
]);
const FETCH_OPTION_KEYS = new Set([
  "extraDomains",
  "fetchImpl",
  "maxBytes",
  "maxRedirects",
  "maxTextCharacters",
  "now",
  "timeoutMs",
]);
const URL_VALIDATION_OPTION_KEYS = new Set(["extraDomains"]);
const HOST_LABEL_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?|[a-z0-9])$/u;
const HTML_ENTITY_PATTERN =
  /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/giu;
const BLOCKED_HTML_CONTAINERS = new Set([
  "head",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "textarea",
  "select",
  "button",
  "datalist",
  "output",
]);
const HTML_LINE_TAGS = new Set([
  "address",
  "article",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "ul",
]);

const HTML_ENTITIES = new Map(
  Object.entries({
    amp: "&",
    apos: "'",
    bull: "•",
    cent: "¢",
    copy: "©",
    divide: "÷",
    emsp: " ",
    ensp: " ",
    euro: "€",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    le: "≤",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    middot: "·",
    nbsp: " ",
    ndash: "–",
    pound: "£",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    reg: "®",
    rsquo: "’",
    thinsp: " ",
    times: "×",
    trade: "™",
    yen: "¥",
  }),
);

export class GuidelineSourceFetchError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GuidelineSourceFetchError";
    this.code = code;
  }
}

function fail(message, code) {
  return new GuidelineSourceFetchError(message, code);
}

function assertPlainOptions(value, allowedKeys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fail(`${name} must be an options object.`, "INVALID_CONFIG");
  }
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) {
    throw fail(
      `${name}.${unexpected} is not a supported option.`,
      "INVALID_CONFIG",
    );
  }
}

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw fail(
      `${name} must be an integer from ${minimum.toLocaleString(
        "en-US",
      )} through ${maximum.toLocaleString("en-US")}.`,
      "INVALID_CONFIG",
    );
  }
  return value;
}

function isIpLiteral(hostname) {
  const unbracketed = hostname.replace(/^\[|\]$/gu, "");
  return (
    unbracketed.includes(":") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(unbracketed)
  );
}

function hasPrivateSuffix(hostname) {
  return PRIVATE_HOST_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function normalizedExtraDomain(value, index) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw fail(
      `extraDomains[${index}] must be a non-empty hostname without surrounding whitespace.`,
      "INVALID_CONFIG",
    );
  }
  if (
    value.length > 253 ||
    value.includes("*") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("@") ||
    value.endsWith(".") ||
    !/^[a-z0-9.-]+$/iu.test(value)
  ) {
    throw fail(
      `extraDomains[${index}] must be a hostname, not a URL or wildcard.`,
      "INVALID_CONFIG",
    );
  }

  let hostname;
  try {
    hostname = new URL(`https://${value}/`).hostname.toLowerCase();
  } catch {
    throw fail(
      `extraDomains[${index}] is not a valid hostname.`,
      "INVALID_CONFIG",
    );
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2 ||
    labels.some((label) => !HOST_LABEL_PATTERN.test(label)) ||
    isIpLiteral(hostname) ||
    hostname === "localhost" ||
    hasPrivateSuffix(hostname)
  ) {
    throw fail(
      `extraDomains[${index}] is not an eligible public hostname suffix.`,
      "INVALID_CONFIG",
    );
  }
  return hostname;
}

function allowedDomainSet(extraDomains) {
  if (!Array.isArray(extraDomains)) {
    throw fail("extraDomains must be an array of hostnames.", "INVALID_CONFIG");
  }
  const domains = new Set(OFFICIAL_SCHOLARLY_DOMAINS);
  extraDomains.forEach((value, index) => {
    domains.add(normalizedExtraDomain(value, index));
  });
  return domains;
}

function hostnameMatchesAllowedSuffix(hostname, allowedDomains) {
  for (const domain of allowedDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function validateUrlAgainstDomains(value, allowedDomains) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > GUIDELINE_SOURCE_LIMITS.maxUrlCharacters
  ) {
    throw fail(
      `Guideline source URLs must be non-empty strings no longer than ${GUIDELINE_SOURCE_LIMITS.maxUrlCharacters.toLocaleString(
        "en-US",
      )} characters.`,
      "INVALID_URL",
    );
  }
  if (
    /[\u0000-\u0020\u007f]/u.test(value) ||
    value.includes("\\") ||
    value.includes("#")
  ) {
    throw fail(
      "Guideline source URLs cannot contain whitespace, control characters, backslashes, or fragments.",
      "INVALID_URL",
    );
  }

  const authorityMatch = /^https:\/\/([^/?#]*)/iu.exec(value);
  if (!authorityMatch || !authorityMatch[1]) {
    throw fail("Guideline source URLs must use HTTPS.", "INVALID_URL");
  }
  const rawAuthority = authorityMatch[1];
  if (rawAuthority.includes("@")) {
    throw fail(
      "Guideline source URLs cannot include credentials.",
      "INVALID_URL",
    );
  }
  // Inspect the raw authority because URL normalizes an explicit :443 away.
  if (rawAuthority.includes(":")) {
    throw fail(
      "Guideline source URLs cannot include a port or IP literal.",
      "INVALID_URL",
    );
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw fail("The guideline source URL is invalid.", "INVALID_URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw fail(
      "Guideline source URLs require HTTPS without credentials, ports, or fragments.",
      "INVALID_URL",
    );
  }
  if (
    !hostname ||
    hostname.endsWith(".") ||
    hostname === "localhost" ||
    isIpLiteral(hostname) ||
    hasPrivateSuffix(hostname)
  ) {
    throw fail(
      "Guideline source URLs must use an eligible public hostname.",
      "INVALID_URL",
    );
  }
  if (!hostnameMatchesAllowedSuffix(hostname, allowedDomains)) {
    throw fail(
      "The guideline source hostname is not an approved scholarly domain.",
      "DOMAIN_NOT_ALLOWED",
    );
  }
  return url;
}

function validateRedirectTarget(location, currentUrl, allowedDomains) {
  if (
    /[\u0000-\u0020\u007f]/u.test(location) ||
    location.includes("\\") ||
    location.includes("#")
  ) {
    throw fail(
      "The guideline source returned an unsafe redirect target.",
      "INVALID_URL",
    );
  }
  let target;
  try {
    if (/^https:\/\//iu.test(location)) {
      // Preserve the raw authority so an explicit default port is not
      // normalized away before validation.
      target = location;
    } else if (location.startsWith("//")) {
      target = `https:${location}`;
    } else {
      target = new URL(location, currentUrl).href;
    }
  } catch {
    throw fail(
      "The guideline source returned an invalid redirect target.",
      "REDIRECT_INVALID",
    );
  }
  return validateUrlAgainstDomains(target, allowedDomains);
}

/**
 * Validate and normalize a source URL without performing a network request.
 *
 * @param {unknown} value
 * @param {{ extraDomains?: string[] }} [options]
 */
export function validateGuidelineSourceUrl(value, options = {}) {
  assertPlainOptions(
    options,
    URL_VALIDATION_OPTION_KEYS,
    "Guideline URL validation options",
  );
  const domains = allowedDomainSet(options.extraDomains ?? []);
  return validateUrlAgainstDomains(value, domains).href;
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return typeof value === "string" ? value.trim() : "";
}

async function cancelResponseBody(response) {
  try {
    await response?.body?.cancel?.();
  } catch {
    // Cancellation is a resource-release optimization, not a response result.
  }
}

function parsedContentType(value) {
  if (!value) {
    throw fail(
      "The guideline source did not provide a Content-Type header.",
      "MIME_NOT_ALLOWED",
    );
  }
  if (value.includes(",")) {
    throw fail(
      "The guideline source returned an ambiguous Content-Type.",
      "MIME_NOT_ALLOWED",
    );
  }
  const mime = value.split(";", 1)[0].trim().toLowerCase();
  if (!ACCEPTED_MIME_TYPES.has(mime)) {
    throw fail(
      "Guideline sources must be HTML, plain text, or PDF.",
      "MIME_NOT_ALLOWED",
    );
  }
  const charsetMatch =
    /;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(value);
  if (/;\s*charset\s*=/iu.test(value) && !charsetMatch) {
    throw fail(
      "The guideline source declared an invalid text charset.",
      "TEXT_DECODING_FAILED",
    );
  }
  const charset = (
    charsetMatch?.[1] ??
    charsetMatch?.[2] ??
    charsetMatch?.[3] ??
    "utf-8"
  )
    .trim()
    .toLowerCase();
  if (
    charset.length > 40 ||
    !/^[a-z0-9._-]+$/u.test(charset)
  ) {
    throw fail(
      "The guideline source declared an invalid text charset.",
      "TEXT_DECODING_FAILED",
    );
  }
  return { mime, charset };
}

function parsedContentEncoding(value) {
  const encoding = value.toLowerCase();
  if (
    encoding.includes(",") ||
    !SUPPORTED_CONTENT_ENCODINGS.has(encoding)
  ) {
    throw fail(
      "The guideline source used an unsupported or ambiguous Content-Encoding.",
      "CONTENT_ENCODING_INVALID",
    );
  }
  return encoding;
}

function parsedContentLength(value, maximum) {
  if (!value) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw fail(
      "The guideline source returned an invalid or ambiguous Content-Length.",
      "CONTENT_LENGTH_INVALID",
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw fail(
      "The guideline source returned an invalid Content-Length.",
      "CONTENT_LENGTH_INVALID",
    );
  }
  if (length > maximum) {
    throw fail(
      "The guideline source exceeds the configured byte limit.",
      "CONTENT_TOO_LARGE",
    );
  }
  return length;
}

function byteView(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw fail(
    "The guideline source returned a malformed response body.",
    "FETCH_PROTOCOL_ERROR",
  );
}

async function readBoundedBody(
  response,
  maximum,
  declaredLength,
  encoding,
  signal,
) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    throw fail(
      "The guideline source did not return a readable response body.",
      "FETCH_PROTOCOL_ERROR",
    );
  }

  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = byteView(value);
      total += chunk.byteLength;
      if (total > maximum) {
        throw fail(
          "The guideline source exceeds the configured byte limit.",
          "CONTENT_TOO_LARGE",
        );
      }
      if (chunks.length >= MAX_BODY_CHUNKS) {
        throw fail(
          "The guideline source returned an excessively fragmented body.",
          "FETCH_PROTOCOL_ERROR",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original bounded-read failure.
    }
    if (error instanceof GuidelineSourceFetchError) throw error;
    if (signal.aborted) {
      throw fail(
        "The guideline source request timed out.",
        "FETCH_TIMEOUT",
      );
    }
    throw fail(
      "The guideline source body could not be retrieved.",
      "FETCH_FAILED",
    );
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some stream implementations do not require or support releaseLock.
    }
  }

  if (total === 0) {
    throw fail(
      "The guideline source returned an empty document.",
      "EMPTY_CONTENT",
    );
  }
  // Fetch implementations normally decode supported content encodings while
  // retaining the wire Content-Length. Exact equality is therefore meaningful
  // only for identity/no encoding.
  if (
    (encoding === "" || encoding === "identity") &&
    declaredLength !== null &&
    declaredLength !== total
  ) {
    throw fail(
      "The guideline source body did not match its Content-Length.",
      "CONTENT_LENGTH_MISMATCH",
    );
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodedCodePoint(entity) {
  let codePoint;
  if (entity.startsWith("#x") || entity.startsWith("#X")) {
    codePoint = Number.parseInt(entity.slice(2), 16);
  } else {
    codePoint = Number.parseInt(entity.slice(1), 10);
  }
  if (
    !Number.isInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return "�";
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value) {
  return value.replace(HTML_ENTITY_PATTERN, (match, entity) => {
    if (entity.startsWith("#")) return decodedCodePoint(entity);
    return HTML_ENTITIES.get(entity.toLowerCase()) ?? match;
  });
}

function normalizeExtractedText(value) {
  const normalized = value
    .replaceAll(/\r\n?/gu, "\n")
    .replaceAll(/[\u2028\u2029]/gu, "\n")
    .replaceAll("\u00a0", " ")
    .replaceAll(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu,
      "",
    );
  return normalized
    .split("\n")
    .map((line) =>
      line
        .replaceAll(/[ \f\v]+/gu, " ")
        .replaceAll(/\t+/gu, "\t")
        .trim(),
    )
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();
}

function parsedHtmlTag(tag) {
  const match = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/iu.exec(tag);
  if (!match) return null;
  return {
    closing: Boolean(match[1]),
    name: match[2].toLowerCase().split(":").at(-1),
    selfClosing: /\/\s*>$/u.test(tag),
  };
}

function appendHtmlText(chunks, value) {
  if (!value) return;
  if (/^\s+$/u.test(value)) {
    chunks.push(" ");
    return;
  }
  chunks.push(value);
}

function htmlTagSeparator(tag) {
  if (tag.name === "br") return "\n";
  if (tag.name === "li") return tag.closing ? "" : "\n- ";
  if (tag.name === "td" || tag.name === "th") return "\t";
  if (tag.name === "tr" || tag.name === "caption") {
    return tag.closing ? "" : "\n";
  }
  return HTML_LINE_TAGS.has(tag.name) ? "\n" : "";
}

function structuredHtmlText(html) {
  const chunks = [];
  const blockedStack = [];
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf("<", cursor);
    if (tagStart < 0) {
      if (blockedStack.length === 0) {
        appendHtmlText(chunks, html.slice(cursor));
      }
      break;
    }
    if (blockedStack.length === 0) {
      appendHtmlText(chunks, html.slice(cursor, tagStart));
    }

    if (html.startsWith("<!--", tagStart)) {
      const commentEnd = html.indexOf("-->", tagStart + 4);
      if (commentEnd < 0) break;
      cursor = commentEnd + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", tagStart)) {
      const cdataEnd = html.indexOf("]]>", tagStart + 9);
      if (cdataEnd < 0) break;
      if (blockedStack.length === 0) {
        appendHtmlText(chunks, html.slice(tagStart + 9, cdataEnd));
      }
      cursor = cdataEnd + 3;
      continue;
    }

    const tagEnd = html.indexOf(">", tagStart + 1);
    if (tagEnd < 0) {
      if (blockedStack.length === 0) {
        const partialTag = parsedHtmlTag(`${html.slice(tagStart)}>`);
        if (!partialTag || !BLOCKED_HTML_CONTAINERS.has(partialTag.name)) {
          appendHtmlText(chunks, html.slice(tagStart));
        }
      }
      break;
    }

    const rawTag = html.slice(tagStart, tagEnd + 1);
    const tag = parsedHtmlTag(rawTag);
    if (!tag) {
      if (
        blockedStack.length === 0 &&
        !rawTag.startsWith("<!") &&
        !rawTag.startsWith("<?")
      ) {
        appendHtmlText(chunks, rawTag);
      }
      cursor = tagEnd + 1;
      continue;
    }

    if (blockedStack.length > 0) {
      if (
        tag.closing &&
        tag.name === blockedStack[blockedStack.length - 1]
      ) {
        blockedStack.pop();
      } else if (
        !tag.closing &&
        !tag.selfClosing &&
        BLOCKED_HTML_CONTAINERS.has(tag.name)
      ) {
        blockedStack.push(tag.name);
      }
      cursor = tagEnd + 1;
      continue;
    }

    if (BLOCKED_HTML_CONTAINERS.has(tag.name)) {
      if (!tag.closing && !tag.selfClosing) blockedStack.push(tag.name);
    } else {
      chunks.push(htmlTagSeparator(tag));
    }
    cursor = tagEnd + 1;
  }

  return normalizeExtractedText(decodeHtmlEntities(chunks.join("")));
}

function inlineHtmlText(value) {
  return structuredHtmlText(value).replaceAll(/\s+/gu, " ");
}

function htmlTitle(html) {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html)?.[1];
  if (title) {
    const extracted = inlineHtmlText(title);
    if (extracted) return extracted;
  }
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/iu.exec(html)?.[1];
  return heading ? inlineHtmlText(heading) : "";
}

function cleanedHtmlText(html) {
  return structuredHtmlText(html);
}

function decodeText(bytes, charset) {
  if (typeof TextDecoder !== "function") {
    throw fail(
      "TextDecoder is unavailable in this runtime.",
      "TEXT_DECODING_FAILED",
    );
  }
  let text;
  try {
    text = new TextDecoder(charset, {
      fatal: charset === "utf-8" || charset === "utf8",
    }).decode(bytes);
  } catch {
    throw fail(
      "The guideline source text could not be decoded with its declared charset.",
      "TEXT_DECODING_FAILED",
    );
  }
  if (text.includes("\u0000")) {
    throw fail(
      "The guideline source text contains unexpected binary data.",
      "TEXT_DECODING_FAILED",
    );
  }
  return text;
}

function boundedText(text, maximum) {
  if (!text) {
    throw fail(
      "The guideline source did not contain usable text.",
      "EMPTY_CONTENT",
    );
  }
  if (text.length > maximum) {
    throw fail(
      "The cleaned guideline source exceeds the configured text limit.",
      "TEXT_TOO_LARGE",
    );
  }
  return text;
}

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleFromPath(url) {
  const segment = url.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const decoded = safeDecodeUriComponent(segment)
    .replace(/\.(?:html?|php|aspx?|txt|pdf)$/iu, "")
    .replaceAll(/[_-]+/gu, " ");
  return normalizeExtractedText(decoded) || "Publication guideline";
}

function titleFromContentDisposition(value) {
  if (!value) return "";
  const encoded =
    /filename\*\s*=\s*(?:utf-8)?'[^']*'([^;]+)/iu.exec(value)?.[1];
  const quoted = /filename\s*=\s*"([^"]+)"/iu.exec(value)?.[1];
  const bare = /filename\s*=\s*([^;\s]+)/iu.exec(value)?.[1];
  const fileName = encoded
    ? safeDecodeUriComponent(encoded.trim().replace(/^"|"$/gu, ""))
    : quoted ?? bare ?? "";
  return normalizeExtractedText(
    fileName
      .replace(/\.(?:txt|pdf)$/iu, "")
      .replaceAll(/[_-]+/gu, " "),
  );
}

function boundedTitle(value, fallback) {
  const title = normalizeExtractedText(value) || normalizeExtractedText(fallback);
  if (title.length <= GUIDELINE_SOURCE_LIMITS.maxTitleCharacters) return title;
  return `${title.slice(
    0,
    GUIDELINE_SOURCE_LIMITS.maxTitleCharacters - 1,
  )}…`;
}

function titleFromPlainText(text, url) {
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";
  const candidate =
    firstLine.length <= GUIDELINE_SOURCE_LIMITS.maxTitleCharacters
      ? firstLine.replace(/^#{1,6}\s*/u, "")
      : "";
  return boundedTitle(candidate, titleFromPath(url));
}

function hasPdfHeader(bytes) {
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
  const limit = Math.min(bytes.byteLength - header.length + 1, 1_024);
  for (let offset = 0; offset < limit; offset += 1) {
    let matches = true;
    for (let index = 0; index < header.length; index += 1) {
      if (bytes[offset + index] !== header[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw fail(
      "Web Crypto is unavailable in this runtime.",
      "CRYPTO_UNAVAILABLE",
    );
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  let result = "";
  for (const byte of digest) result += byte.toString(16).padStart(2, "0");
  return result;
}

function isoTimestamp(now) {
  let date;
  try {
    const value = now();
    date = value instanceof Date ? value : new Date(value);
  } catch {
    throw fail("now must return a valid date or timestamp.", "INVALID_CONFIG");
  }
  if (!Number.isFinite(date.getTime())) {
    throw fail("now must return a valid date or timestamp.", "INVALID_CONFIG");
  }
  return date.toISOString();
}

function validatedFetchOptions(options) {
  assertPlainOptions(options, FETCH_OPTION_KEYS, "Guideline fetch options");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw fail(
      "A Web Fetch API implementation is required.",
      "INVALID_CONFIG",
    );
  }
  const now = options.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw fail("now must be a function.", "INVALID_CONFIG");
  }
  return {
    allowedDomains: allowedDomainSet(options.extraDomains ?? []),
    fetchImpl,
    maxBytes: boundedInteger(
      options.maxBytes ?? GUIDELINE_SOURCE_LIMITS.defaultMaxBytes,
      "maxBytes",
      1,
      GUIDELINE_SOURCE_LIMITS.maxBytes,
    ),
    maxRedirects: boundedInteger(
      options.maxRedirects ?? GUIDELINE_SOURCE_LIMITS.maxRedirects,
      "maxRedirects",
      0,
      GUIDELINE_SOURCE_LIMITS.maxRedirects,
    ),
    maxTextCharacters: boundedInteger(
      options.maxTextCharacters ??
        GUIDELINE_SOURCE_LIMITS.defaultMaxTextCharacters,
      "maxTextCharacters",
      1,
      GUIDELINE_SOURCE_LIMITS.maxTextCharacters,
    ),
    now,
    timeoutMs: boundedInteger(
      options.timeoutMs ?? GUIDELINE_SOURCE_LIMITS.defaultTimeoutMs,
      "timeoutMs",
      1,
      GUIDELINE_SOURCE_LIMITS.maxTimeoutMs,
    ),
  };
}

async function fetchValidatedResponse(initialUrl, config, signal) {
  let currentUrl = initialUrl;
  let redirects = 0;

  while (true) {
    let response;
    try {
      response = await config.fetchImpl(currentUrl.href, {
        credentials: "omit",
        headers: {
          Accept: "text/html, text/plain;q=0.95, application/pdf;q=0.9",
        },
        method: "GET",
        redirect: "manual",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch {
      if (signal.aborted) {
        throw fail(
          "The guideline source request timed out.",
          "FETCH_TIMEOUT",
        );
      }
      throw fail(
        "The guideline source could not be retrieved.",
        "FETCH_FAILED",
      );
    }
    if (
      !response ||
      !Number.isInteger(response.status) ||
      typeof response?.headers?.get !== "function"
    ) {
      throw fail(
        "The fetch implementation returned an invalid response.",
        "FETCH_PROTOCOL_ERROR",
      );
    }
    if (response.redirected === true) {
      await cancelResponseBody(response);
      throw fail(
        "The fetch implementation followed a redirect automatically.",
        "FETCH_PROTOCOL_ERROR",
      );
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = responseHeader(response, "location");
      await cancelResponseBody(response);
      if (!location) {
        throw fail(
          "The guideline source returned a redirect without a Location header.",
          "REDIRECT_INVALID",
        );
      }
      if (redirects >= config.maxRedirects) {
        throw fail(
          "The guideline source exceeded the redirect limit.",
          "REDIRECT_LIMIT",
        );
      }
      currentUrl = validateRedirectTarget(
        location,
        currentUrl,
        config.allowedDomains,
      );
      redirects += 1;
      continue;
    }

    if (response.status !== 200) {
      await cancelResponseBody(response);
      throw fail(
        `The guideline source returned HTTP ${response.status}.`,
        "HTTP_STATUS_ERROR",
      );
    }
    return { currentUrl, response };
  }
}

async function retrieveGuidelineSource(initialUrl, config, signal) {
  const { currentUrl, response } = await fetchValidatedResponse(
    initialUrl,
    config,
    signal,
  );

  let contentType;
  let encoding;
  let declaredLength;
  try {
    contentType = parsedContentType(responseHeader(response, "content-type"));
    encoding = parsedContentEncoding(
      responseHeader(response, "content-encoding"),
    );
    declaredLength = parsedContentLength(
      responseHeader(response, "content-length"),
      config.maxBytes,
    );
  } catch (error) {
    await cancelResponseBody(response);
    throw error;
  }

  const bytes = await readBoundedBody(
    response,
    config.maxBytes,
    declaredLength,
    encoding,
    signal,
  );
  const common = {
    finalUrl: currentUrl.href,
    mime: contentType.mime,
    retrievedAt: isoTimestamp(config.now),
    sha256: await sha256Hex(bytes),
    byteLength: bytes.byteLength,
  };

  if (contentType.mime === "application/pdf") {
    if (!hasPdfHeader(bytes)) {
      throw fail(
        "The source declared a PDF Content-Type but did not contain a PDF header.",
        "INVALID_PDF",
      );
    }
    const dispositionTitle = titleFromContentDisposition(
      responseHeader(response, "content-disposition"),
    );
    return {
      ...common,
      title: boundedTitle(dispositionTitle, titleFromPath(currentUrl)),
      bytes,
    };
  }

  const decoded = decodeText(bytes, contentType.charset);
  if (contentType.mime === "text/html") {
    const text = boundedText(
      cleanedHtmlText(decoded),
      config.maxTextCharacters,
    );
    return {
      ...common,
      title: boundedTitle(htmlTitle(decoded), titleFromPath(currentUrl)),
      text,
    };
  }

  const text = boundedText(
    normalizeExtractedText(decodeHtmlEntities(decoded)),
    config.maxTextCharacters,
  );
  return {
    ...common,
    title: titleFromPlainText(text, currentUrl),
    text,
  };
}

/**
 * Retrieve one exact official guideline document as untrusted source data.
 *
 * The Web Fetch API implementation is injectable for deterministic tests. All
 * redirects are followed manually and validated against the same domain policy.
 * The returned hash covers the bounded response bytes exposed by Fetch (normally
 * after HTTP content decoding).
 *
 * @param {unknown} sourceUrl
 * @param {{
 *   extraDomains?: string[],
 *   fetchImpl?: typeof fetch,
 *   maxBytes?: number,
 *   maxRedirects?: number,
 *   maxTextCharacters?: number,
 *   now?: () => Date | string | number,
 *   timeoutMs?: number
 * }} [options]
 */
export async function fetchGuidelineSource(sourceUrl, options = {}) {
  const config = validatedFetchOptions(options);
  const initialUrl = validateUrlAgainstDomains(
    sourceUrl,
    config.allowedDomains,
  );
  const controller = new AbortController();
  const timeoutError = fail(
    "The guideline source request timed out.",
    "FETCH_TIMEOUT",
  );
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, config.timeoutMs);
  });

  try {
    return await Promise.race([
      retrieveGuidelineSource(initialUrl, config, controller.signal),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
