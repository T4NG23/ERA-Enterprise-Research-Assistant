import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const setupScript = fileURLToPath(
  new URL("../../scripts/ollama-setup.mjs", import.meta.url),
);

test("Ollama setup creates private local configuration without a model path", () => {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "scholar-flow-ollama-setup-"),
  );
  try {
    execFileSync(process.execPath, [setupScript, "qwen2.5:7b"], {
      cwd: directory,
      stdio: "pipe",
    });

    const environmentPath = path.join(directory, ".env.ollama.local");
    const contents = readFileSync(environmentPath, "utf8");
    assert.match(contents, /^SCHOLAR_FLOW_AI_PROVIDER=local_llama$/mu);
    assert.match(contents, /^SCHOLAR_FLOW_MODE=offline$/mu);
    assert.match(
      contents,
      /^SCHOLAR_FLOW_OLLAMA_BASE_URL=http:\/\/127\.0\.0\.1:11434\/v1$/mu,
    );
    assert.match(contents, /^SCHOLAR_FLOW_OLLAMA_MODEL=qwen2\.5:7b$/mu);
    assert.match(contents, /^SCHOLAR_FLOW_OLLAMA_CONTEXT_TOKENS=32768$/mu);
    assert.match(contents, /^SCHOLAR_FLOW_OLLAMA_MAX_OUTPUT_TOKENS=8192$/mu);
    assert.doesNotMatch(contents, /MODEL_PATH/u);
    assert.equal(lstatSync(environmentPath).mode & 0o777, 0o600);
    assert.equal(
      readlinkSync(path.join(directory, ".env.local")),
      ".env.ollama.local",
    );

    execFileSync(process.execPath, [setupScript, "different-model"], {
      cwd: directory,
      stdio: "pipe",
    });
    assert.equal(readFileSync(environmentPath, "utf8"), contents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
