import assert from "node:assert/strict";
import test from "node:test";

import {
  createOciJsonDiagnostic,
  nextOciChatRetryReason,
  ociJsonHealthPassed,
  parseOciJsonWithRecovery,
  OCI_CHAT_MAX_GENERATION_ATTEMPTS,
  OCI_JSON_DIAGNOSTIC_WINDOW_LIMIT,
  OCI_JSON_RECOVERY_AUTHOR_WARNING,
  OCI_VALID_JSON_REGENERATION_INSTRUCTION,
} from "../../lib/oci-json-diagnostics.mjs";

test("accepts only the exact health object from string or split text content", () => {
  const stringBody = {
    choices: [
      {
        finish_reason: "stop",
        message: { content: ' \n {"ok":true}\t ' },
      },
    ],
  };
  const partsBody = {
    choices: [
      {
        finish_reason: "stop",
        message: {
          content: [
            { type: "output_text", text: '{"ok":' },
            { type: "text", text: "true}" },
          ],
        },
      },
    ],
  };
  const originalStringBody = structuredClone(stringBody);
  const originalPartsBody = structuredClone(partsBody);

  assert.equal(ociJsonHealthPassed(stringBody), true);
  assert.equal(ociJsonHealthPassed(partsBody), true);
  assert.deepEqual(stringBody, originalStringBody);
  assert.deepEqual(partsBody, originalPartsBody);
});

test("rejects malformed, incorrect, refused, and incomplete health output", () => {
  const rejectedBodies = [
    null,
    {},
    { choices: [] },
    { choices: [{ message: { content: "" } }] },
    { choices: [{ message: { content: '{"ok":' } }] },
    { choices: [{ message: { content: "```json\n{\"ok\":true}\n```" } }] },
    { choices: [{ message: { content: '{"ok":false}' } }] },
    { choices: [{ message: { content: '{"ok":true,"extra":1}' } }] },
    { choices: [{ message: { content: '[{"ok":true}]' } }] },
    {
      choices: [
        {
          finish_reason: "length",
          message: { content: '{"ok":true}' },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: '{"ok":true}',
            refusal: "Cannot comply.",
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "content-filter",
          message: { content: '{"ok":true}' },
        },
      ],
    },
  ];

  for (const body of rejectedBodies) {
    assert.equal(ociJsonHealthPassed(body), false);
  }
});

test("captures bounded OCI metadata while redacting malformed LaTeX JSON", () => {
  const output =
    '{"latex":"\\documentclass{private-study-name}","paper":{"title":"secret words"}';
  let parseError;
  try {
    JSON.parse(output);
  } catch (error) {
    parseError = error;
  }

  const diagnostic = createOciJsonDiagnostic({
    responseHeaders: new Headers({
      "content-type": "application/json; charset=utf-8",
      "opc-request-id": "req-ABC_123/part:4",
    }),
    body: {
      choices: [
        {
          finish_reason: "MAX-TOKENS",
          message: { content: output },
        },
      ],
      usage: {
        prompt_tokens: 12_345,
        completion_tokens: 6_789,
        total_tokens: 19_134,
        completion_tokens_details: { reasoning_tokens: 456 },
        prompt_tokens_details: { cached_tokens: 321 },
      },
    },
    parseError,
  });

  assert.match(diagnostic.diagnosticId, /^oj-[a-z0-9]{10}$/u);
  assert.equal(diagnostic.requestId, "req-ABC_123/part:4");
  assert.equal(diagnostic.responseContentType, "application/json");
  assert.equal(diagnostic.finishReason, "max_tokens");
  assert.deepEqual(diagnostic.usage, {
    inputTokens: 12_345,
    outputTokens: 6_789,
    totalTokens: 19_134,
    reasoningTokens: 456,
    cachedInputTokens: 321,
  });
  assert.deepEqual(diagnostic.content, {
    kind: "string",
    partCount: 1,
    partTypes: ["text"],
    characterLength: output.length,
  });
  assert.equal(diagnostic.json.category, "invalid_escape");
  assert.equal(typeof diagnostic.json.offset, "number");
  assert.ok(
    diagnostic.json.window.syntax.length <= OCI_JSON_DIAGNOSTIC_WINDOW_LIMIT,
  );
  assert.match(diagnostic.json.window.syntax, /\\\?/u);

  const serialized = JSON.stringify(diagnostic);
  for (const forbidden of [
    "documentclass",
    "private-study-name",
    "secret words",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "iu"));
  }
});

test("reports content parts and replaces unknown upstream labels with other", () => {
  const diagnostic = createOciJsonDiagnostic({
    responseHeaders: { "Content-Type": "application/vnd.private+json" },
    body: {
      choices: [
        {
          finish_reason: "private-customer-status",
          message: {
            content: [
              { type: "output_text", text: '{"ok":' },
              { type: "private-secret-part", text: "false}" },
              { type: "reasoning", summary: "must not appear" },
            ],
          },
        },
      ],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        total_tokens: 120,
        output_tokens_details: { reasoning_tokens: 7 },
      },
    },
  });

  assert.equal(diagnostic.responseContentType, "other");
  assert.equal(diagnostic.finishReason, "other");
  assert.deepEqual(diagnostic.content, {
    kind: "parts",
    partCount: 3,
    partTypes: ["output_text", "other", "reasoning"],
    characterLength: 12,
  });
  assert.equal(diagnostic.json.category, "valid");
  assert.equal(diagnostic.usage.reasoningTokens, 7);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|customer|secret/iu);
});

test("rejects unsafe request IDs and ignores invalid numeric usage", () => {
  const diagnostic = createOciJsonDiagnostic({
    responseHeaders: {
      "opc-request-id": "unsafe request id containing words",
      "x-request-id": "safe-fallback.123",
    },
    body: {
      choices: [{ finish_reason: "stop", message: { content: "{" } }],
      usage: {
        prompt_tokens: "400",
        completion_tokens: -1,
        total_tokens: Number.POSITIVE_INFINITY,
        reasoning_tokens: 1_000_000_001,
      },
    },
  });

  assert.equal(diagnostic.requestId, "safe-fallback.123");
  assert.equal(diagnostic.finishReason, "stop");
  assert.deepEqual(diagnostic.usage, {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
  });
});

test("derives an offset from line and column without retaining error prose", () => {
  const output = '{\n  "safe": 1,\n  "private": }';
  const diagnostic = createOciJsonDiagnostic({
    outputText: output,
    parseError: new SyntaxError(
      "private upstream prose at line 3 column 14",
    ),
  });

  assert.equal(diagnostic.json.offset, output.indexOf("}"));
  assert.equal(diagnostic.json.window.errorOffsetInWindow, diagnostic.json.offset);
  assert.ok(diagnostic.json.window.syntax.includes("{\n  \""));
  assert.doesNotMatch(JSON.stringify(diagnostic), /safe|private|upstream|prose/iu);
});

test("classifies fenced and trailing output with syntax-only windows", () => {
  const fenced = createOciJsonDiagnostic({
    outputText: '```json\n{"patient":"Alice Example"}\n```',
  });
  assert.equal(fenced.json.category, "markdown_fence");
  assert.doesNotMatch(
    fenced.json.window.syntax,
    /json|patient|alice|example/iu,
  );

  const trailing = createOciJsonDiagnostic({
    outputText: '{"ok":true}\nprivate explanation',
  });
  assert.ok(
    ["trailing_content", "unexpected_token"].includes(trailing.json.category),
  );
  assert.match(trailing.json.window.syntax, /^\{"••":••••\}\n/u);
  assert.doesNotMatch(JSON.stringify(trailing), /true|private|explanation/iu);
});

test("strict OCI JSON parsing remains the first and lossless path", () => {
  const source =
    '{"claim":"line one\\nline two","latex":"\\\\begin{document}","count":7}';
  const result = parseOciJsonWithRecovery(source);

  assert.equal(result.ok, true);
  assert.equal(result.recovery, "none");
  assert.equal(result.syntaxRepaired, false);
  assert.equal(result.wrapperRemoved, false);
  assert.deepEqual(result.value, {
    claim: "line one\nline two",
    latex: "\\begin{document}",
    count: 7,
  });
});

test("removes one JSON markdown fence or one balanced object wrapper", () => {
  const fenced = parseOciJsonWithRecovery(
    '```json\n{"claim":"braces { stay } in this string"}\n```',
  );
  assert.equal(fenced.ok, true);
  assert.equal(fenced.recovery, "markdown_fence");
  assert.equal(fenced.syntaxRepaired, false);
  assert.deepEqual(fenced.value, {
    claim: "braces { stay } in this string",
  });

  const extracted = parseOciJsonWithRecovery(
    'Here is the requested package:\n{"paper":{"title":"Exact"}}\nEnd.',
  );
  assert.equal(extracted.ok, true);
  assert.equal(extracted.recovery, "object_extraction");
  assert.equal(extracted.syntaxRepaired, false);
  assert.deepEqual(extracted.value, { paper: { title: "Exact" } });
});

test("rejects multiple objects and structural JSON rewriting", () => {
  const multiple = parseOciJsonWithRecovery(
    'first {"claim":"one"} then {"claim":"two"}',
  );
  assert.equal(multiple.ok, false);

  const missingComma = parseOciJsonWithRecovery(
    '{"claim":"one" "evidence":"two"}',
  );
  assert.equal(missingComma.ok, false);

  const unterminated = parseOciJsonWithRecovery(
    '{"claim":"unfinished}',
  );
  assert.equal(unterminated.ok, false);
});

test("repairs only forbidden string encoding while preserving decoded text", () => {
  const malformed = `{"latex":"\\documentclass{article}\\unknown","claim":"alpha
beta	gamma","unicode":"\\u12G4"}`;
  const result = parseOciJsonWithRecovery(malformed);

  assert.equal(result.ok, true);
  assert.equal(result.recovery, "string_encoding");
  assert.equal(result.syntaxRepaired, true);
  assert.equal(result.wrapperRemoved, false);
  assert.deepEqual(result.value, {
    latex: "\\documentclass{article}\\unknown",
    claim: "alpha\nbeta\tgamma",
    unicode: "\\u12G4",
  });
  assert.match(OCI_JSON_RECOVERY_AUTHOR_WARNING, /author must review/iu);
  assert.match(OCI_JSON_RECOVERY_AUTHOR_WARNING, /same schema.*security/iu);
});

test("repairs JSON-valid single escapes for known commands only in latex", () => {
  const source =
    '{"paper":{"title":"Keep \\\\title literal outside latex"},"latex":"\\begin{document}\\n\\title{Exact Title}\\n\\newcommand{\\\\R}{\\\\mathbb{R}}\\nBody\\n\\\\end{document}"}';
  const result = parseOciJsonWithRecovery(source);

  assert.equal(result.ok, true);
  assert.equal(result.recovery, "latex_string_encoding");
  assert.equal(result.syntaxRepaired, true);
  assert.deepEqual(result.value, {
    paper: { title: "Keep \\title literal outside latex" },
    latex:
      "\\begin{document}\n\\title{Exact Title}\n\\newcommand{\\R}{\\mathbb{R}}\nBody\n\\end{document}",
  });
});

test("preserves proper JSON newline, tab, and carriage escapes in latex", () => {
  const source =
    '{"latex":"First line\\nIntroduction\\tcell\\r\\nResults"}';
  const result = parseOciJsonWithRecovery(source);

  assert.equal(result.ok, true);
  assert.equal(result.recovery, "none");
  assert.equal(result.syntaxRepaired, false);
  assert.equal(result.value.latex, "First line\nIntroduction\tcell\r\nResults");
});

test("recovery failure diagnostics never retain manuscript canaries", () => {
  const canary = "NEVER_LOG_PATIENT_OR_STUDY_NAME";
  const malformed = `preface {"claim":"${canary}" "missing":"comma"} tail`;
  const recovery = parseOciJsonWithRecovery(malformed);
  assert.equal(recovery.ok, false);

  const diagnostic = createOciJsonDiagnostic({
    outputText: malformed,
    parseError: recovery.parseError,
  });
  const serialized = JSON.stringify(diagnostic);
  assert.doesNotMatch(serialized, new RegExp(canary, "u"));
  assert.doesNotMatch(serialized, /patient|study_name|comma|claim/iu);
});

test("allows at most one retry per OCI truncation or malformed JSON failure", () => {
  assert.equal(OCI_CHAT_MAX_GENERATION_ATTEMPTS, 3);
  assert.equal(
    nextOciChatRetryReason({
      failure: "malformed_json",
      attemptsRemaining: true,
      usedOutputLimitRetry: false,
      usedMalformedJsonRetry: false,
    }),
    "malformed_json",
  );
  assert.equal(
    nextOciChatRetryReason({
      failure: "malformed_json",
      attemptsRemaining: true,
      usedOutputLimitRetry: false,
      usedMalformedJsonRetry: true,
    }),
    null,
  );
  assert.equal(
    nextOciChatRetryReason({
      failure: "output_limit",
      attemptsRemaining: true,
      usedOutputLimitRetry: false,
      usedMalformedJsonRetry: true,
    }),
    "output_limit",
  );
  assert.equal(
    nextOciChatRetryReason({
      failure: "output_limit",
      attemptsRemaining: true,
      usedOutputLimitRetry: true,
      usedMalformedJsonRetry: true,
    }),
    null,
  );
  assert.equal(
    nextOciChatRetryReason({
      failure: "malformed_json",
      attemptsRemaining: false,
      usedOutputLimitRetry: false,
      usedMalformedJsonRetry: false,
    }),
    null,
  );
  assert.equal(
    nextOciChatRetryReason({
      failure: "response_envelope",
      attemptsRemaining: true,
      usedOutputLimitRetry: false,
      usedMalformedJsonRetry: false,
    }),
    null,
  );
});

test("trusted malformed-JSON retry instruction requests a fresh escaped object", () => {
  assert.match(
    OCI_VALID_JSON_REGENERATION_INSTRUCTION,
    /start over.*one new.*complete JSON object/isu,
  );
  assert.match(
    OCI_VALID_JSON_REGENERATION_INSTRUCTION,
    /escape every backslash.*two backslashes/isu,
  );
  assert.match(
    OCI_VALID_JSON_REGENERATION_INSTRUCTION,
    /escape literal control characters/iu,
  );
  assert.match(
    OCI_VALID_JSON_REGENERATION_INSTRUCTION,
    /do not add markdown fences or prose outside/iu,
  );
});
