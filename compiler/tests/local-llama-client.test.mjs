import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  LocalLlamaPublicError,
  localLlamaChatJson,
} from "../../lib/local-llama-client.mjs";

const localClientSource = readFileSync(
  new URL("../../lib/local-llama-client.mjs", import.meta.url),
  "utf8",
);
const generationServerSource = readFileSync(
  new URL("../../lib/oci-server.ts", import.meta.url),
  "utf8",
);
const providerServerSource = readFileSync(
  new URL("../../lib/ai-provider-server.ts", import.meta.url),
  "utf8",
);
const generateRouteSource = readFileSync(
  new URL("../../app/api/generate/route.ts", import.meta.url),
  "utf8",
);

const baseConfig = Object.freeze({
  baseUrl: "http://127.0.0.1:8080/v1",
  model: "local-test-model",
});

async function withFetchSpy(run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"ok":true}' },
          },
        ],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function request() {
  return {
    messages: [
      { role: "system", content: "Return one JSON object." },
      { role: "user", content: "Prepare the bounded test result." },
    ],
    temperature: 0,
    maxTokens: 2_048,
    timeoutMs: 5_000,
  };
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("posts only a JSON chat completion to the configured loopback server", async () => {
  await withFetchSpy(async (calls) => {
    const result = await localLlamaChatJson(baseConfig, request());

    assert.equal(calls.length, 1);
    const [target, init] = calls[0];
    assert.equal(target, "http://127.0.0.1:8080/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.deepEqual(init.headers, {
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), [
      "max_tokens",
      "messages",
      "model",
      "response_format",
      "temperature",
    ]);
    assert.equal(body.model, baseConfig.model);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(JSON.stringify(body).includes("file_id"), false);
    assert.match(result.responseText, /"choices"/u);
  });
});

test("passes a bounded schema to llama.cpp grammar-constrained JSON mode", async () => {
  const jsonSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean" },
    },
    required: ["ok"],
  };
  await withFetchSpy(async (calls) => {
    await localLlamaChatJson(baseConfig, {
      ...request(),
      jsonSchema,
    });

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0][1].body);
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      schema: jsonSchema,
    });
  });
});

test("rejects malformed and oversized local JSON schemas before fetch", async () => {
  for (const jsonSchema of [
    null,
    [],
    "object",
    { description: "x".repeat(250_001) },
  ]) {
    await withFetchSpy(async (calls) => {
      await assert.rejects(
        localLlamaChatJson(baseConfig, {
          ...request(),
          jsonSchema,
        }),
        /jsonSchema/u,
      );
      assert.equal(calls.length, 0);
    });
  }
});

test("accepts only exact loopback /v1 bases and rejects others before fetch", async () => {
  const accepted = [
    "http://127.0.0.1:8080/v1",
    "http://localhost:8080/v1/",
    "http://[::1]:8080/v1",
  ];
  for (const baseUrl of accepted) {
    await withFetchSpy(async (calls) => {
      await localLlamaChatJson({ ...baseConfig, baseUrl }, request());
      assert.equal(calls.length, 1, baseUrl);
      assert.equal(new URL(calls[0][0]).pathname, "/v1/chat/completions");
    });
  }

  const rejected = [
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8080/v1/extra",
    "http://127.0.0.1:8080/v1?target=remote",
    "http://127.0.0.1:8080/v1#fragment",
    "http://user:password@127.0.0.1:8080/v1",
    "http://127.0.0.2:8080/v1",
    "http://0.0.0.0:8080/v1",
    "http://192.168.1.10:8080/v1",
    "http://host.docker.internal:8080/v1",
    "http://localhost.example.com:8080/v1",
    "http://127.1:8080/v1",
    "http://2130706433:8080/v1",
    "http://0x7f000001:8080/v1",
    "http://localhost.:8080/v1",
    "https://127.0.0.1:8443/v1",
    "https://inference.generativeai.us-ashburn-1.oci.oraclecloud.com/openai/v1",
  ];
  for (const baseUrl of rejected) {
    await withFetchSpy(async (calls) => {
      await assert.rejects(
        localLlamaChatJson({ ...baseConfig, baseUrl }, request()),
        (error) =>
          error instanceof LocalLlamaPublicError &&
          error.code === "LOCAL_LLAMA_INVALID_CONFIGURATION",
        baseUrl,
      );
      assert.equal(calls.length, 0, baseUrl);
    });
  }
});

test("the local client source exposes no alternate generation or upload path", () => {
  assert.doesNotMatch(localClientSource, /["'`]\/?files(?:\/|["'`])/u);
  assert.doesNotMatch(localClientSource, /["'`]\/?responses["'`]/u);
  assert.equal(
    [...localClientSource.matchAll(/\bfetch\s*\(/gu)].length,
    1,
  );
  assert.match(
    localClientSource,
    /return `\$\{url\.origin\}\/v1\/chat\/completions`/u,
  );
});

test("paper generation enters the exact provider dispatcher", () => {
  assert.match(
    generateRouteSource,
    /const providerRuntime = getAiProviderRuntime\(\)/u,
  );
  assert.match(
    generateRouteSource,
    /const result = await generatePaperWithProvider\(providerRuntime, \{/u,
  );
  assert.match(
    generateRouteSource,
    /secret: providerRuntime\.corpusSigningSecret/u,
  );
  assert.doesNotMatch(
    generateRouteSource,
    /generateWithLocalLlama\(|generateWithOci\(/u,
  );
  assert.match(
    generateRouteSource,
    /\^llj-\[a-z0-9\]\{10\}\$/u,
  );
  assert.match(
    generateRouteSource,
    /\^oj-\[a-z0-9\]\{10\}\$/u,
  );

  const providerDispatch = sourceBetween(
    providerServerSource,
    "export async function generatePaperWithProvider",
    "export async function extractVenueGuidelinesWithProvider",
  );
  assert.match(
    providerDispatch,
    /selected\.provider === "local_llama"\s+\? generateWithLocalLlama/u,
  );
  assert.match(providerDispatch, /: generateWithOci/u);
  assert.doesNotMatch(providerDispatch, /catch|fallback/iu);

  const localEntry = sourceBetween(
    generationServerSource,
    "export async function generateWithLocalLlama",
    "export async function generateWithOci",
  );
  assert.match(localEntry, /return generateWithChat\(input,/u);
  assert.match(localEntry, /backend: "local_llama"/u);
  assert.match(
    localEntry,
    /createLocalLlamaChatCompletion\(/u,
  );
  assert.match(
    generationServerSource,
    /jsonSchema: responseJsonSchema\(input\.profile\)/u,
  );
  assert.doesNotMatch(localEntry, /generateWithOciResponses/u);
  assert.doesNotMatch(localEntry, /uploadPdf|deleteOciFile/u);
  assert.match(
    generationServerSource,
    /diagnosticId: `llj-\$\{diagnostic\.diagnosticId\.slice\(3\)\}`/u,
  );

  const sharedChat = sourceBetween(
    generationServerSource,
    "async function generateWithChat",
    "async function generateWithOciChat",
  );
  assert.match(
    sharedChat,
    /completion = await provider\.createCompletion\(/u,
  );
  assert.doesNotMatch(sharedChat, /generateWithOciResponses/u);
  assert.doesNotMatch(sharedChat, /uploadPdf|deleteOciFile/u);

  const visionGate = sharedChat.indexOf("if (!provider.visionEnabled)");
  const imageDataPart = sharedChat.indexOf('type: "image_url"');
  assert.ok(visionGate >= 0);
  assert.ok(imageDataPart > visionGate);
  assert.match(
    sharedChat,
    /LOCAL_LLAMA_VISION_DISABLED/u,
  );
  assert.match(
    localEntry,
    /visionEnabled: input\.config\.vision/u,
  );
});
