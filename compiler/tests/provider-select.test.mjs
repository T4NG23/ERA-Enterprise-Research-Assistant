import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ociScript = fileURLToPath(
  new URL("../../scripts/select-oci-provider.mjs", import.meta.url),
);
const localScript = fileURLToPath(
  new URL("../../scripts/offline-setup.mjs", import.meta.url),
);

test("provider selection preserves OCI credentials and switches without fallback", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "scholar-flow-provider-select-"),
  );
  try {
    const activePath = path.join(directory, ".env.local");
    writeFileSync(
      activePath,
      [
        "ORESOLVE_GENAI_API_KEY=private-test-key",
        "ORESOLVE_GENAI_REGION=us-ashburn-1",
        "ORESOLVE_GENAI_MODEL=google.gemini-2.5-flash",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    execFileSync(process.execPath, [ociScript], {
      cwd: directory,
      stdio: "pipe",
    });

    const ociPath = path.join(directory, ".env.oci.local");
    const firstOciContents = readFileSync(ociPath, "utf8");
    assert.match(
      firstOciContents,
      /^SCHOLAR_FLOW_AI_PROVIDER=oci$/mu,
    );
    assert.match(
      firstOciContents,
      /^ORESOLVE_GENAI_API_KEY=private-test-key$/mu,
    );
    assert.match(
      firstOciContents,
      /^SCHOLAR_FLOW_GUIDELINE_SIGNING_SECRET=.{32,}$/mu,
    );
    assert.match(
      firstOciContents,
      /^SCHOLAR_FLOW_CORPUS_SIGNING_SECRET=.{32,}$/mu,
    );
    assert.equal(lstatSync(ociPath).mode & 0o777, 0o600);
    assert.equal(readlinkSync(activePath), ".env.oci.local");
    assert.equal(
      readFileSync(
        path.join(directory, ".env.cloud-disabled.backup"),
        "utf8",
      ).includes("private-test-key"),
      true,
    );

    execFileSync(process.execPath, [localScript], {
      cwd: directory,
      stdio: "pipe",
    });
    assert.equal(readlinkSync(activePath), ".env.offline.local");
    assert.match(
      readFileSync(path.join(directory, ".env.offline.local"), "utf8"),
      /^SCHOLAR_FLOW_AI_PROVIDER=local_llama$/mu,
    );

    execFileSync(process.execPath, [ociScript], {
      cwd: directory,
      stdio: "pipe",
    });
    assert.equal(readlinkSync(activePath), ".env.oci.local");
    assert.equal(readFileSync(ociPath, "utf8"), firstOciContents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
