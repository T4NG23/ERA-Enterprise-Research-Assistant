import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const setupScript = fileURLToPath(
  new URL("../../scripts/offline-setup.mjs", import.meta.url),
);

test("offline setup preserves a prior environment and activates only local secrets", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "scholar-flow-offline-setup-"),
  );
  try {
    const priorEnvironment = path.join(directory, "prior-cloud.env");
    writeFileSync(priorEnvironment, "CLOUD_CANARY=must-stay-disabled\n");
    symlinkSync(priorEnvironment, path.join(directory, ".env.local"));

    execFileSync(process.execPath, [setupScript], {
      cwd: directory,
      stdio: "pipe",
    });

    const offlinePath = path.join(directory, ".env.offline.local");
    const firstOfflineContents = readFileSync(offlinePath, "utf8");
    assert.match(
      firstOfflineContents,
      /^SCHOLAR_FLOW_AI_PROVIDER=local_llama$/mu,
    );
    assert.match(firstOfflineContents, /^SCHOLAR_FLOW_MODE=offline$/mu);
    assert.match(
      firstOfflineContents,
      /^SCHOLAR_FLOW_LLAMA_BASE_URL=http:\/\/127\.0\.0\.1:8080\/v1$/mu,
    );
    assert.match(
      firstOfflineContents,
      /^SCHOLAR_FLOW_LLAMA_CONTEXT_TOKENS=32768$/mu,
    );
    assert.match(
      firstOfflineContents,
      /^SCHOLAR_FLOW_LLAMA_MAX_OUTPUT_TOKENS=8192$/mu,
    );
    assert.doesNotMatch(firstOfflineContents, /CLOUD_CANARY/u);
    const venueSecret = firstOfflineContents.match(
      /^SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET=(.+)$/mu,
    )?.[1];
    const corpusSecret = firstOfflineContents.match(
      /^SCHOLAR_FLOW_CORPUS_SIGNING_SECRET=(.+)$/mu,
    )?.[1];
    assert.ok(venueSecret && venueSecret.length >= 32);
    assert.ok(corpusSecret && corpusSecret.length >= 32);
    assert.notEqual(venueSecret, corpusSecret);
    assert.equal(lstatSync(offlinePath).mode & 0o777, 0o600);

    assert.equal(
      readlinkSync(path.join(directory, ".env.local")),
      ".env.offline.local",
    );
    assert.equal(
      readlinkSync(path.join(directory, ".env.cloud-disabled.backup")),
      priorEnvironment,
    );

    execFileSync(process.execPath, [setupScript], {
      cwd: directory,
      stdio: "pipe",
    });
    assert.equal(readFileSync(offlinePath, "utf8"), firstOfflineContents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
