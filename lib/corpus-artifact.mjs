const VERSION = "2";
const DEFAULT_TTL_SECONDS = 15 * 60;
const MAX_TTL_SECONDS = 30 * 60;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MIN_TOKEN_CHARACTERS = 49;
const MAX_TOKEN_CHARACTERS = 160;
const MAX_SECRET_CHARACTERS = 16_384;
const MAX_REPORT_CHARACTERS = 100_000;
const MAX_CANONICAL_ARTIFACT_CHARACTERS = 500_000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_OBJECT_KEYS = 5_000;

const TOKEN_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_TIME_PATTERN = /^(?:0|[1-9]\d{0,12})$/u;
const textEncoder = new TextEncoder();

export class CorpusArtifactError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "CorpusArtifactError";
    this.code = code;
  }
}

function invalidInput(message) {
  return new CorpusArtifactError(message, "CORPUS_ARTIFACT_INVALID_INPUT");
}

function boundedString(value, name, maximum, { trim = false, required = false } = {}) {
  if (typeof value !== "string") {
    throw invalidInput(`${name} must be a string.`);
  }
  const normalized = value.replaceAll(/\r\n?/g, "\n");
  const result = trim ? normalized.trim() : normalized;
  if (required && !result) {
    throw invalidInput(`${name} must not be blank.`);
  }
  if (result.length > maximum) {
    throw invalidInput(`${name} must be ${maximum.toLocaleString("en-US")} characters or less.`);
  }
  return result;
}

function assertPlainRecord(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(`${name} must be a JSON object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidInput(`${name} must be a plain JSON object.`);
  }
}

function canonicalJson(value, path, depth = 0, ancestors = new WeakSet()) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw invalidInput(`${path} is nested too deeply.`);
  }
  if (value === null) return "null";

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalidInput(`${path} must contain only finite JSON numbers.`);
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw invalidInput(`${path} contains a value that JSON cannot represent.`);
  }
  if (ancestors.has(value)) {
    throw invalidInput(`${path} must not contain circular references.`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw invalidInput(`${path} must not contain sparse arrays.`);
        }
        entries.push(canonicalJson(value[index], `${path}[${index}]`, depth + 1, ancestors));
      }
      return `[${entries.join(",")}]`;
    }

    assertPlainRecord(value, path);
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (keys.length > MAX_OBJECT_KEYS) {
      throw invalidInput(`${path} contains too many object keys.`);
    }
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`, depth + 1, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalArtifact(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput("The corpus artifact input must be an object.");
  }

  const title = boundedString(input.title, "title", 300, {
    trim: true,
    required: true,
  });
  const targetVenue = boundedString(input.targetVenue, "targetVenue", 240, {
    trim: true,
  });
  const submissionType = boundedString(
    input.submissionType,
    "submissionType",
    120,
    {
      trim: true,
      required: true,
    },
  );
  const manuscript = boundedString(input.manuscript, "manuscript", 160_000);
  const packet = boundedString(input.packet, "packet", 220_000);
  assertPlainRecord(input.report, "report");
  const report = canonicalJson(input.report, "report");
  if (report.length > MAX_REPORT_CHARACTERS) {
    throw invalidInput(
      `report must serialize to ${MAX_REPORT_CHARACTERS.toLocaleString("en-US")} characters or less.`,
    );
  }

  const artifact = canonicalJson(
    {
      manuscript,
      packet,
      report: input.report,
      submissionType,
      targetVenue,
      title,
    },
    "artifact",
  );
  if (artifact.length > MAX_CANONICAL_ARTIFACT_CHARACTERS) {
    throw invalidInput("The normalized corpus artifact is too large to sign.");
  }
  return artifact;
}

function validatedSecret(secret) {
  if (typeof secret !== "string" || !secret || secret.length > MAX_SECRET_CHARACTERS) {
    throw invalidInput(
      `secret must be a non-empty string no longer than ${MAX_SECRET_CHARACTERS.toLocaleString("en-US")} characters.`,
    );
  }
  return secret;
}

function validatedNowSeconds(nowMs) {
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isSafeInteger(Math.floor(nowMs))) {
    throw invalidInput("nowMs must be a non-negative, finite millisecond timestamp.");
  }
  return Math.floor(nowMs / 1_000);
}

function validatedInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidInput(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new CorpusArtifactError(
      "Web Crypto is unavailable in this server runtime.",
      "CORPUS_ARTIFACT_CRYPTO_UNAVAILABLE",
    );
  }
  return subtle;
}

async function hmacKey(secret, usage) {
  return subtleCrypto().importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value) {
  if (!TOKEN_SIGNATURE_PATTERN.test(value)) return null;
  const base64 = `${value.replaceAll("-", "+").replaceAll("_", "/")}=`;
  try {
    const binary = atob(base64);
    if (binary.length !== 32) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function signingMessage(issuedAt, expiresAt, artifact) {
  return `scholar-flow.corpus-artifact\n${VERSION}\n${issuedAt}\n${expiresAt}\n${artifact}`;
}

function parseToken(token) {
  if (
    typeof token !== "string" ||
    token.length < MIN_TOKEN_CHARACTERS ||
    token.length > MAX_TOKEN_CHARACTERS
  ) {
    return null;
  }
  const parts = token.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== VERSION ||
    !TOKEN_TIME_PATTERN.test(parts[1]) ||
    !TOKEN_TIME_PATTERN.test(parts[2])
  ) {
    return null;
  }

  const issuedAt = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  const signature = base64UrlDecode(parts[3]);
  if (
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_TTL_SECONDS ||
    !signature
  ) {
    return null;
  }
  return { issuedAt, expiresAt, signature };
}

/**
 * Signs one normalized corpus evidence artifact. Text line endings are normalized
 * to LF; title, venue, and submission type also have surrounding whitespace
 * removed. Report object keys are recursively sorted before signing.
 */
export async function signCorpusArtifactToken({
  secret,
  title,
  targetVenue,
  submissionType,
  manuscript,
  packet,
  report,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  nowMs = Date.now(),
}) {
  const normalizedSecret = validatedSecret(secret);
  const lifetime = validatedInteger(ttlSeconds, "ttlSeconds", 1, MAX_TTL_SECONDS);
  const issuedAt = validatedNowSeconds(nowMs);
  const expiresAt = issuedAt + lifetime;
  if (!Number.isSafeInteger(expiresAt)) {
    throw invalidInput("The artifact expiration timestamp is out of range.");
  }
  const artifact = canonicalArtifact({
    title,
    targetVenue,
    submissionType,
    manuscript,
    packet,
    report,
  });
  const message = signingMessage(issuedAt, expiresAt, artifact);
  const key = await hmacKey(normalizedSecret, "sign");
  const signature = new Uint8Array(
    await subtleCrypto().sign("HMAC", key, textEncoder.encode(message)),
  );
  return `${VERSION}.${issuedAt}.${expiresAt}.${base64UrlEncode(signature)}`;
}

/**
 * Returns false for malformed, expired, mismatched, or unverifiable tokens. This
 * intentionally does not reveal which bound field failed verification.
 */
export async function verifyCorpusArtifactToken({
  token,
  secret,
  title,
  targetVenue,
  submissionType,
  manuscript,
  packet,
  report,
  nowMs = Date.now(),
  clockSkewSeconds = DEFAULT_CLOCK_SKEW_SECONDS,
}) {
  try {
    const parsed = parseToken(token);
    if (!parsed) return false;

    const now = validatedNowSeconds(nowMs);
    const skew = validatedInteger(
      clockSkewSeconds,
      "clockSkewSeconds",
      0,
      MAX_CLOCK_SKEW_SECONDS,
    );
    if (parsed.issuedAt > now + skew || now > parsed.expiresAt + skew) {
      return false;
    }

    const normalizedSecret = validatedSecret(secret);
    const artifact = canonicalArtifact({
      title,
      targetVenue,
      submissionType,
      manuscript,
      packet,
      report,
    });
    const message = signingMessage(parsed.issuedAt, parsed.expiresAt, artifact);
    const key = await hmacKey(normalizedSecret, "verify");
    return await subtleCrypto().verify(
      "HMAC",
      key,
      parsed.signature,
      textEncoder.encode(message),
    );
  } catch {
    return false;
  }
}

export const CORPUS_ARTIFACT_MAX_TTL_SECONDS = MAX_TTL_SECONDS;
export const CORPUS_ARTIFACT_VERSION = 1;
