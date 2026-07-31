import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const importRoute = readFileSync(
  new URL(
    "../../app/api/venue-guidelines/import/route.ts",
    import.meta.url,
  ),
  "utf8",
);
const extractor = readFileSync(
  new URL("../../lib/venue-guideline-extractor.ts", import.meta.url),
  "utf8",
);
const workspace = readFileSync(
  new URL(
    "../../app/components/manuscript-workspace.tsx",
    import.meta.url,
  ),
  "utf8",
);
const nextConfig = readFileSync(
  new URL("../../next.config.ts", import.meta.url),
  "utf8",
);
const compilerRoute = readFileSync(
  new URL("../../app/api/compile/route.ts", import.meta.url),
  "utf8",
);

test("exact venue rules enter through a bounded file snapshot and selected provider", () => {
  assert.match(importRoute, /multipart\/form-data/u);
  assert.match(importRoute, /formData\.getAll\("guidelineFile"\)/u);
  assert.match(importRoute, /MAX_GUIDELINE_BYTES = 10 \* 1024 \* 1024/u);
  assert.match(importRoute, /crypto\.subtle\.digest\("SHA-256"/u);
  assert.match(importRoute, /extractPdfTextForChat/u);
  assert.match(importRoute, /getAiProviderRuntime\(\)/u);
  assert.match(importRoute, /extractVenueGuidelinesWithProvider\(/u);
  assert.match(
    importRoute,
    /http:\/\/127\.0\.0\.1\/offline-guideline\//u,
  );
  assert.doesNotMatch(importRoute, /fetchGuidelineSource/u);
  assert.doesNotMatch(importRoute, /GUIDELINE_ALLOWED_DOMAINS/u);
  assert.doesNotMatch(importRoute, /https:\/\/[^"']+/u);
});

test("guideline extraction has fixed local and OCI chat paths", () => {
  assert.match(extractor, /localLlamaChatJson\(input\.config/u);
  assert.match(
    extractor,
    /jsonSchema: GUIDELINE_EXTRACTION_JSON_SCHEMA/u,
  );
  assert.match(extractor, /MAX_EXTRACTION_OUTPUT_TOKENS = 4_096/u);
  assert.match(extractor, /OfflineRuntimeConfig/u);
  assert.match(extractor, /ociHeaders\(input\.config, true, false\)/u);
  assert.match(
    extractor,
    /`\$\{input\.config\.baseUrl\}\/chat\/completions`/u,
  );
  assert.doesNotMatch(
    extractor,
    /`\$\{input\.config\.baseUrl\}\/(?:files|responses)/u,
  );
  assert.equal(
    [...extractor.matchAll(/\bfetch\s*\(/gu)].length,
    1,
  );
});

test("the browser workflow has no live guideline URL importer", () => {
  assert.match(workspace, /Official guideline file/u);
  assert.match(workspace, /Extract local rules/u);
  assert.match(workspace, /No external link is stored or opened/u);
  assert.doesNotMatch(workspace, /Official source URL/u);
});

test("browser and compiler networking are limited to self and loopback", () => {
  assert.match(
    nextConfig,
    /connect-src 'self' http:\/\/127\.0\.0\.1:3101 http:\/\/localhost:3101/u,
  );
  assert.match(compilerRoute, /!isLoopbackHostname\(url\.hostname\)/u);
  assert.match(
    compilerRoute,
    /Closed-isolation mode requires a loopback-only PDF compiler URL/u,
  );
});
