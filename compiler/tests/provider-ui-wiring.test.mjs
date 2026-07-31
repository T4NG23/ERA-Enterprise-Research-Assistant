import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspaceSource = readFileSync(
  new URL("../../app/components/manuscript-workspace.tsx", import.meta.url),
  "utf8",
);

test("the workspace consumes the explicit provider privacy contract", () => {
  assert.match(
    workspaceSource,
    /provider: "oci" \| "local_llama" \| "invalid"/u,
  );
  assert.match(
    workspaceSource,
    /mode: "cloud_testing" \| "isolated" \| "invalid"/u,
  );
  assert.match(
    workspaceSource,
    /health\.provider === "local_llama" && health\.mode === "isolated"/u,
  );
  assert.match(
    workspaceSource,
    /health\.provider === "oci" && health\.mode === "cloud_testing"/u,
  );
});
test("OCI mode is visibly described as external cloud testing", () => {
  assert.match(
    workspaceSource,
    /Cloud testing mode: OCI Generative AI/u,
  );
  assert.match(
    workspaceSource,
    /Paper inputs and uploaded guideline text are sent to Oracle Cloud Infrastructure/u,
  );
  assert.match(
    workspaceSource,
    /This is cloud testing mode, not closed isolation/u,
  );
  assert.match(
    workspaceSource,
    /OCI cloud testing · Research materials leave this app/u,
  );
});

test("provider-neutral output copy does not mislabel OCI results as local", () => {
  assert.match(
    workspaceSource,
    /Generated with \{result\.metadata\.model\}/u,
  );
  assert.doesNotMatch(workspaceSource, /Generated locally with/u);
  assert.doesNotMatch(
    workspaceSource,
    /Local Llama only · Zero live web retrieval/u,
  );
});
