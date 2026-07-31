import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  loadActiveEnvironmentFile,
  selectedProvider,
  webChildEnvironment,
} from "./provider-env.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const loaded = loadActiveEnvironmentFile();
const provider = selectedProvider(process.env);
const child = spawn(npmCommand, ["run", "start:web"], {
  env: webChildEnvironment(process.env, {
    HOST: "127.0.0.1",
  }),
  stdio: "inherit",
});

console.log(
  loaded
    ? `Scholar Flow loaded its explicit ${provider} provider configuration from ${loaded}.`
    : "No .env.local file found. Select and configure a provider first.",
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const [code, signal] = await once(child, "exit");
process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
