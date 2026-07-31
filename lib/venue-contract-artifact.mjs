const VERSION = "1";
const TOKEN_CHARACTERS = 45;
const MAX_SECRET_CHARACTERS = 16_384;
const MAX_CANONICAL_CONTRACT_CHARACTERS = 100_000;
const MAX_CANONICAL_DEPTH = 32;
const MAX_TOTAL_OBJECT_KEYS = 4_096;
const MAX_TOTAL_ARRAY_ITEMS = 4_096;
const MAX_TOTAL_VALUES = 8_192;

const TOKEN_PATTERN = /^1\.[A-Za-z0-9_-]{43}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const textEncoder = new TextEncoder();

export class VenueContractArtifactError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "VenueContractArtifactError";
    this.code = code;
  }
}

function invalidInput(message) {
  return new VenueContractArtifactError(
    message,
    "VENUE_CONTRACT_ARTIFACT_INVALID_INPUT",
  );
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

function assertExactInputKeys(value, expectedKeys, name) {
  assertPlainRecord(value, name);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidInput(
      `${name} must contain exactly: ${expectedKeys.join(", ")}.`,
    );
  }
}

function validatedSecret(secret) {
  if (
    typeof secret !== "string" ||
    secret.length === 0 ||
    secret.length > MAX_SECRET_CHARACTERS
  ) {
    throw invalidInput(
      `secret must be a non-empty string no longer than ${MAX_SECRET_CHARACTERS.toLocaleString("en-US")} characters.`,
    );
  }
  return secret;
}

function descriptorValue(object, key, path) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (
    !descriptor ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, "value")
  ) {
    throw invalidInput(
      `${path} must contain only enumerable JSON data properties.`,
    );
  }
  return descriptor.value;
}

function boundedCanonicalResult(result, path) {
  if (result.length > MAX_CANONICAL_CONTRACT_CHARACTERS) {
    throw invalidInput(
      `${path} exceeds the ${MAX_CANONICAL_CONTRACT_CHARACTERS.toLocaleString("en-US")}-character canonical JSON limit.`,
    );
  }
  return result;
}

function canonicalJson(
  value,
  path,
  depth,
  state,
  ancestors,
) {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw invalidInput(`${path} is nested too deeply.`);
  }
  state.values += 1;
  if (state.values > MAX_TOTAL_VALUES) {
    throw invalidInput("contract contains too many JSON values.");
  }

  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return boundedCanonicalResult(JSON.stringify(value), path);
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
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) => {
          if (key === "length") {
            return false;
          }
          if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key)) {
            return true;
          }
          const index = Number(key);
          return (
            !Number.isSafeInteger(index) ||
            index < 0 ||
            index >= value.length ||
            String(index) !== key
          );
        })
      ) {
        throw invalidInput(
          `${path} must not contain symbols or named array properties.`,
        );
      }
      if (value.length > MAX_TOTAL_ARRAY_ITEMS - state.arrayItems) {
        throw invalidInput("contract contains too many array items.");
      }
      state.arrayItems += value.length;

      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw invalidInput(`${path} must not contain sparse arrays.`);
        }
        const entryPath = `${path}[${index}]`;
        entries.push(
          canonicalJson(
            descriptorValue(value, String(index), entryPath),
            entryPath,
            depth + 1,
            state,
            ancestors,
          ),
        );
      }
      return boundedCanonicalResult(`[${entries.join(",")}]`, path);
    }

    assertPlainRecord(value, path);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw invalidInput(`${path} must not contain symbol-keyed properties.`);
    }
    if (ownKeys.length > MAX_TOTAL_OBJECT_KEYS - state.objectKeys) {
      throw invalidInput("contract contains too many object keys.");
    }
    state.objectKeys += ownKeys.length;

    const keys = ownKeys.sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const entries = keys.map((key) => {
      const keyPath = `${path}.${key}`;
      const child = canonicalJson(
        descriptorValue(value, key, keyPath),
        keyPath,
        depth + 1,
        state,
        ancestors,
      );
      return `${JSON.stringify(key)}:${child}`;
    });
    return boundedCanonicalResult(`{${entries.join(",")}}`, path);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalContract(contract) {
  assertPlainRecord(contract, "contract");
  const result = canonicalJson(
    contract,
    "contract",
    0,
    { objectKeys: 0, arrayItems: 0, values: 0 },
    new WeakSet(),
  );
  if (result.length > MAX_CANONICAL_CONTRACT_CHARACTERS) {
    throw invalidInput("The canonical venue contract is too large to sign.");
  }
  return result;
}

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new VenueContractArtifactError(
      "Web Crypto is unavailable in this server runtime.",
      "VENUE_CONTRACT_ARTIFACT_CRYPTO_UNAVAILABLE",
    );
  }
  return subtle;
}

async function hmacKey(secret) {
  return subtleCrypto().importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
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
  if (!SIGNATURE_PATTERN.test(value)) return null;
  const base64 = `${value.replaceAll("-", "+").replaceAll("_", "/")}=`;
  try {
    const binary = atob(base64);
    if (binary.length !== 32) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return base64UrlEncode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function parseArtifact(artifact) {
  if (
    typeof artifact !== "string" ||
    artifact.length !== TOKEN_CHARACTERS ||
    !TOKEN_PATTERN.test(artifact)
  ) {
    return null;
  }
  return base64UrlDecode(artifact.slice(2));
}

function signingMessage(contract) {
  return `scholar-flow.venue-contract-artifact\n${VERSION}\n${contract}`;
}

async function signatureFor(secret, contract) {
  const key = await hmacKey(secret);
  return new Uint8Array(
    await subtleCrypto().sign(
      "HMAC",
      key,
      textEncoder.encode(signingMessage(contract)),
    ),
  );
}

function constantTimeEqual(left, right) {
  if (
    !(left instanceof Uint8Array) ||
    !(right instanceof Uint8Array) ||
    left.length !== 32 ||
    right.length !== 32
  ) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/**
 * Signs every JSON field in one confirmed venue contract. The token deliberately
 * contains no timestamp or expiry so a generated paper can retain its compile
 * contract. Object keys are recursively sorted; JSON values are otherwise
 * preserved exactly.
 */
export async function signVenueContractArtifact(input) {
  assertExactInputKeys(input, ["contract", "secret"], "sign input");
  const secret = validatedSecret(input.secret);
  const contract = canonicalContract(input.contract);
  const signature = await signatureFor(secret, contract);
  return `${VERSION}.${base64UrlEncode(signature)}`;
}

/**
 * Returns false for a malformed token, invalid contract, invalid secret, or any
 * contract-field mismatch. Well-formed signatures are compared over all 32 bytes.
 */
export async function verifyVenueContractArtifact(input) {
  try {
    assertExactInputKeys(
      input,
      ["artifact", "contract", "secret"],
      "verify input",
    );
    const suppliedSignature = parseArtifact(input.artifact);
    if (!suppliedSignature) return false;
    const secret = validatedSecret(input.secret);
    const contract = canonicalContract(input.contract);
    const expectedSignature = await signatureFor(secret, contract);
    return constantTimeEqual(suppliedSignature, expectedSignature);
  } catch {
    return false;
  }
}

export const VENUE_CONTRACT_ARTIFACT_VERSION = 1;
