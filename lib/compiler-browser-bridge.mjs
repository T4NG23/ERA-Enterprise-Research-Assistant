const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Accepts URL and browser hostname forms, including the bracketed IPv6 value
 * returned by some browser implementations.
 *
 * @param {unknown} value
 */
export function isLoopbackHostname(value) {
  if (typeof value !== "string" || !value) return false;
  const normalized = value.toLowerCase().replace(/^\[([^\]]+)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalized);
}

/**
 * The direct browser bridge is only safe for Scholar Flow's tokenless,
 * unconfigured local default. A configured or authenticated compiler must
 * remain behind the same-origin server proxy.
 *
 * @param {{ requestHostname: unknown, configuredUrl: unknown, token: unknown }} input
 */
export function permitsLoopbackCompilerFallback(input) {
  return (
    isLoopbackHostname(input?.requestHostname) &&
    typeof input?.configuredUrl === "string" &&
    input.configuredUrl.length === 0 &&
    typeof input?.token === "string" &&
    input.token.length === 0
  );
}

/**
 * @param {{
 *   browserHostname: unknown,
 *   status: unknown,
 *   code: unknown,
 *   loopbackFallbackAllowed: unknown
 * }} input
 */
export function shouldUseDirectPdfCompiler(input) {
  if (
    !isLoopbackHostname(input?.browserHostname) ||
    input?.loopbackFallbackAllowed !== true
  ) {
    return false;
  }
  return (
    input.status === 502 && input.code === "PDF_COMPILER_UNAVAILABLE"
  );
}

/**
 * @param {{
 *   browserHostname: unknown,
 *   code: unknown,
 *   loopbackFallbackAllowed: unknown
 * }} input
 */
export function shouldUseDirectCompilerSmoke(input) {
  return (
    isLoopbackHostname(input?.browserHostname) &&
    input?.code === "LOCAL_COMPILER_UNAVAILABLE" &&
    input?.loopbackFallbackAllowed === true
  );
}

/**
 * @param {unknown} value
 * @param {unknown} responseOk
 */
export function supportsCompilerBridgeProtocol(value, responseOk) {
  if (
    responseOk !== true ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  return (
    value.protocolVersion === 4 &&
    value.submissionAwareContracts === true &&
    value.pageCountHeaders === true &&
    value.signedDynamicVenueContracts === true
  );
}

export function parseCompilerPageCount(value) {
  if (typeof value !== "string" || !/^[1-9]\d{0,4}$/.test(value)) {
    return null;
  }
  const pageCount = Number(value);
  return Number.isSafeInteger(pageCount) && pageCount <= 10_000
    ? pageCount
    : null;
}
