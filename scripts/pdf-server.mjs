import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  compilerChildEnvironment,
  loadActiveEnvironmentFile,
} from "./provider-env.mjs";

loadActiveEnvironmentFile();
const child = spawn(process.execPath, ["compiler/server.mjs"], {
  env: compilerChildEnvironment(process.env),
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

const [code, signal] = await once(child, "exit");
process.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
