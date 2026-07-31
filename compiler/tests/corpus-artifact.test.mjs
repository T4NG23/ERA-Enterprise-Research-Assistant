import assert from "node:assert/strict";
import test from "node:test";

import {
  CORPUS_ARTIFACT_MAX_TTL_SECONDS,
  signCorpusArtifactToken,
  verifyCorpusArtifactToken,
} from "../../lib/corpus-artifact.mjs";

const SECRET = "test-only-oci-api-key-secret-0123456789";
const NOW_MS = 1_800_000_000_000;

function artifact(overrides = {}) {
  return {
    title: "Deterministic Evidence Selection",
    targetVenue: "IEEE IGARSS 2026",
    submissionType: "Full paper · Initial review",
    manuscript: "Abstract\nA bounded manuscript.",
    packet: "<<<EVIDENCE id=source-01-chunk-0001>>>\nMeasured evidence.",
    report: {
      enabled: true,
      strategy: "lexical-relevance-v1",
      sourceCount: 1,
      totalCharacters: 18,
      totalChunks: 1,
      selectedChunks: 1,
      selectedCharacters: 18,
      omittedChunks: 0,
      packetCharacters: 61,
      sources: [
        {
          fileName: "study.md",
          characters: 18,
          chunks: 1,
          selectedChunks: 1,
          selectedCharacters: 18,
        },
      ],
    },
    ...overrides,
  };
}

async function signedToken(value = artifact(), options = {}) {
  return signCorpusArtifactToken({
    secret: SECRET,
    ...value,
    nowMs: NOW_MS,
    ttlSeconds: 120,
    ...options,
  });
}

async function verifies(token, value = artifact(), options = {}) {
  return verifyCorpusArtifactToken({
    token,
    secret: SECRET,
    ...value,
    nowMs: NOW_MS,
    clockSkewSeconds: 0,
    ...options,
  });
}

test("signs and verifies a compact version-two corpus artifact token", async () => {
  const token = await signedToken();
  assert.match(token, /^2\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(await verifies(token), true);
});

test("canonicalizes report object keys recursively", async () => {
  const original = artifact();
  const token = await signedToken(original);
  const source = original.report.sources[0];
  const reordered = artifact({
    report: {
      sources: [
        {
          selectedCharacters: source.selectedCharacters,
          selectedChunks: source.selectedChunks,
          chunks: source.chunks,
          characters: source.characters,
          fileName: source.fileName,
        },
      ],
      packetCharacters: original.report.packetCharacters,
      omittedChunks: original.report.omittedChunks,
      selectedCharacters: original.report.selectedCharacters,
      selectedChunks: original.report.selectedChunks,
      totalChunks: original.report.totalChunks,
      totalCharacters: original.report.totalCharacters,
      sourceCount: original.report.sourceCount,
      strategy: original.report.strategy,
      enabled: original.report.enabled,
    },
  });

  assert.equal(await verifies(token, reordered), true);
});

test("normalizes multipart-style CRLF without weakening other text binding", async () => {
  const token = await signedToken();
  assert.equal(
    await verifies(
      token,
      artifact({
        manuscript: "Abstract\r\nA bounded manuscript.",
        packet: "<<<EVIDENCE id=source-01-chunk-0001>>>\r\nMeasured evidence.",
      }),
    ),
    true,
  );
});

test("rejects every bound artifact field when tampered", async (t) => {
  const original = artifact();
  const token = await signedToken(original);
  const cases = [
    ["title", { title: `${original.title} changed` }],
    ["venue", { targetVenue: `${original.targetVenue} Workshop` }],
    ["submission type", { submissionType: "Review article" }],
    ["manuscript", { manuscript: `${original.manuscript}\nUnsupported claim.` }],
    ["packet", { packet: `${original.packet}\nAltered evidence.` }],
    [
      "report",
      {
        report: {
          ...original.report,
          selectedCharacters: original.report.selectedCharacters + 1,
        },
      },
    ],
  ];

  for (const [name, change] of cases) {
    await t.test(name, async () => {
      assert.equal(await verifies(token, artifact(change)), false);
    });
  }
});

test("rejects expired and not-yet-valid tokens with configurable clock skew", async () => {
  const token = await signedToken();
  assert.equal(
    await verifies(token, artifact(), {
      nowMs: NOW_MS + 121_000,
      clockSkewSeconds: 0,
    }),
    false,
  );
  assert.equal(
    await verifies(token, artifact(), {
      nowMs: NOW_MS - 31_000,
      clockSkewSeconds: 30,
    }),
    false,
  );
  assert.equal(
    await verifies(token, artifact(), {
      nowMs: NOW_MS + 149_000,
      clockSkewSeconds: 30,
    }),
    true,
  );
});

test("enforces the thirty-minute maximum lifetime", async () => {
  await assert.rejects(
    () =>
      signedToken(artifact(), {
        ttlSeconds: CORPUS_ARTIFACT_MAX_TTL_SECONDS + 1,
      }),
    /ttlSeconds must be an integer/i,
  );
});

test("rejects malformed or signature-tampered tokens without throwing", async () => {
  const token = await signedToken();
  const last = token.at(-1);
  const changedLast = last === "A" ? "B" : "A";
  assert.equal(await verifies(`${token.slice(0, -1)}${changedLast}`), false);
  assert.equal(await verifies(`${token}.extra`), false);
  assert.equal(await verifies("2.0.1.invalid"), false);
  assert.equal(await verifies(""), false);
});
