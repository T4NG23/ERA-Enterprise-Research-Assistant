import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  compilerChildEnvironment,
  loadActiveEnvironmentFile,
  selectedProvider,
  webChildEnvironment,
} from "./provider-env.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const loaded = loadActiveEnvironmentFile();
const provider = selectedProvider(process.env);
const children = [
  spawn(process.execPath, ["compiler/server.mjs"], {
    env: compilerChildEnvironment(process.env),
    stdio: "inherit",
  }),
  spawn(npmCommand, ["run", "dev:web"], {
    env: webChildEnvironment(process.env, { HOST: "127.0.0.1" }),
    stdio: "inherit",
  }),
];

console.log(
  loaded
    ? `Scholar Flow loaded its explicit ${provider} provider configuration from ${loaded}.`
    : "No .env.local file found. Select and configure a provider before generation.",
);
console.log(
  provider === "local_llama"
    ? "Isolated mode: cloud credentials are removed and model/compiler traffic is restricted to loopback."
    : "OCI testing mode: research material is sent to the configured OCI Generative AI endpoint; the local compiler does not receive the OCI credential.",
);

let stopping = false;

function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopChildren(signal));
}

const exits = children.map(async (child) => {
  const [code, signal] = await once(child, "exit");
  return {
    code: typeof code === "number" ? code : signal ? 1 : 0,
    pid: child.pid,
  };
});

const firstExit = await Promise.race(exits);
stopChildren();
await Promise.allSettled(exits);
process.exitCode = firstExit.code;
