import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LATEX_PACKAGES } from "./supported-packages.mjs";

const VERSION = "0.16.9";
const RELEASE_BASE =
  "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.16.9";
const artifacts = Object.freeze({
  "darwin-arm64": {
    archive: "tectonic-0.16.9-aarch64-apple-darwin.tar.gz",
    sha256: "edb67c61aba768289f6da441c9e6f523cfaff4f8b2a5708523ef29c543f8e88e",
  },
  "darwin-x64": {
    archive: "tectonic-0.16.9-x86_64-apple-darwin.tar.gz",
    sha256: "79d8839fa3594bfea9b2bf2ac0a0455bcc4d0de956a5e5c403107e9a72f79e86",
  },
  "linux-arm64": {
    archive: "tectonic-0.16.9-aarch64-unknown-linux-musl.tar.gz",
    sha256: "f9aa39017dbd51f111fdb93dda222178cbe51c8193508fc567b523cc74fff9c1",
  },
  "linux-x64": {
    archive: "tectonic-0.16.9-x86_64-unknown-linux-musl.tar.gz",
    sha256: "60b13a0826ae7ad9ce34b4a2df06bff2cfcfa6dda8a915477c0cbb84e1a4a902",
  },
});

const compilerDirectory = path.dirname(fileURLToPath(import.meta.url));
const binDirectory = path.join(compilerDirectory, ".bin");
const cacheDirectory = path.join(compilerDirectory, ".cache");
const binaryPath = path.join(binDirectory, "tectonic");
const force = process.argv.includes("--force");
const skipWarm = process.argv.includes("--skip-warm");

const platformKey = `${process.platform}-${process.arch}`;
const artifact = artifacts[platformKey];
if (!artifact) {
  throw new Error(
    `No pinned Tectonic build is configured for ${platformKey}. Use macOS or Linux on arm64/x64.`,
  );
}

await fs.mkdir(binDirectory, { recursive: true, mode: 0o700 });
await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });

if (!force && (await hasPinnedBinary(binaryPath))) {
  process.stdout.write(`Tectonic ${VERSION} is already installed.\n`);
} else {
  await installBinary(artifact);
}

if (!skipWarm) {
  await warmAndVerifyBundle();
} else {
  process.stdout.write("Skipped bundle warm-up. Runtime compilation will need a populated cache.\n");
}

async function installBinary(selectedArtifact) {
  const stagingDirectory = await fs.mkdtemp(path.join(compilerDirectory, ".setup-"));
  const archivePath = path.join(stagingDirectory, selectedArtifact.archive);
  try {
    const url = `${RELEASE_BASE}/${selectedArtifact.archive}`;
    process.stdout.write(`Downloading ${url}\n`);
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 64 * 1024 * 1024) {
      throw new Error("The release archive exceeds the 64 MB safety limit.");
    }
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length === 0 || archive.length > 64 * 1024 * 1024) {
      throw new Error("The release archive has an invalid size.");
    }
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== selectedArtifact.sha256) {
      throw new Error(`Checksum mismatch for ${selectedArtifact.archive}.`);
    }
    await fs.writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });

    const listing = await run("tar", ["-tzf", archivePath], { timeoutMs: 20_000 });
    if (listing.code !== 0) throw new Error(`Could not inspect archive: ${listing.output}`);
    for (const entry of listing.output.split(/\r?\n/).filter(Boolean)) {
      if (entry.startsWith("/") || entry.split("/").includes("..")) {
        throw new Error("The release archive contains an unsafe path.");
      }
    }

    const extractedDirectory = path.join(stagingDirectory, "extracted");
    await fs.mkdir(extractedDirectory, { mode: 0o700 });
    const extraction = await run("tar", ["-xzf", archivePath, "-C", extractedDirectory], {
      timeoutMs: 30_000,
    });
    if (extraction.code !== 0) throw new Error(`Could not extract archive: ${extraction.output}`);

    const extractedBinary = await findFile(extractedDirectory, "tectonic");
    if (!extractedBinary) throw new Error("The Tectonic binary was not present in the archive.");
    const temporaryBinary = `${binaryPath}.new`;
    await fs.copyFile(extractedBinary, temporaryBinary);
    await fs.chmod(temporaryBinary, 0o755);
    await fs.rename(temporaryBinary, binaryPath);

    if (!(await hasPinnedBinary(binaryPath))) {
      throw new Error(`The downloaded executable is not Tectonic ${VERSION}.`);
    }
    process.stdout.write(`Installed Tectonic ${VERSION} at ${binaryPath}\n`);
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function warmAndVerifyBundle() {
  const fixtureDirectory = path.join(compilerDirectory, "fixtures");
  const fixtures = (await fs.readdir(fixtureDirectory))
    .filter((name) => name.endsWith(".tex"))
    .sort();
  if (fixtures.length === 0) throw new Error("No compiler fixtures were found.");

  const fixtureSources = await Promise.all(
    fixtures.map((fixture) =>
      fs.readFile(path.join(fixtureDirectory, fixture), "utf8"),
    ),
  );
  const explicitlyWarmedPackages = new Set(
    fixtureSources.flatMap((source) =>
      [...source.matchAll(/\\usepackage(?:\s*\[[^\]]*\])?\s*\{([^}]+)\}/g)]
        .flatMap((match) => match[1].split(","))
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  );
  const missingFixtures = SUPPORTED_LATEX_PACKAGES.filter(
    (name) => !explicitlyWarmedPackages.has(name),
  );
  if (missingFixtures.length) {
    throw new Error(
      `Supported packages are missing cache fixtures: ${missingFixtures.join(", ")}.`,
    );
  }

  const outputDirectory = await fs.mkdtemp(path.join(compilerDirectory, ".setup-output-"));
  try {
    for (const fixture of fixtures) {
      process.stdout.write(`Verifying ${fixture}\n`);
      const result = await run(
        binaryPath,
        ["--untrusted", "--outdir", outputDirectory, path.join(fixtureDirectory, fixture)],
        {
          timeoutMs: 180_000,
          env: compilerEnvironment(),
          cwd: fixtureDirectory,
        },
      );
      if (result.code !== 0) {
        throw new Error(`Tectonic could not compile ${fixture}:\n${result.output.slice(-4_000)}`);
      }
      const cachedResult = await run(
        binaryPath,
        [
          "--untrusted",
          "--only-cached",
          "--outdir",
          outputDirectory,
          path.join(fixtureDirectory, fixture),
        ],
        {
          timeoutMs: 180_000,
          env: compilerEnvironment(),
          cwd: fixtureDirectory,
        },
      );
      if (cachedResult.code !== 0) {
        throw new Error(
          `Tectonic could not replay ${fixture} from cache only:\n${cachedResult.output.slice(-4_000)}`,
        );
      }
    }
  } finally {
    await fs.rm(outputDirectory, { recursive: true, force: true });
  }
  process.stdout.write(
    "Tectonic bundle is cached; all publisher classes and supported package fixtures compile offline.\n",
  );
}

async function hasPinnedBinary(file) {
  try {
    await fs.access(file, fs.constants.X_OK);
    const result = await run(file, ["--version"], { timeoutMs: 10_000 });
    return result.code === 0 && result.output.includes(VERSION);
  } catch {
    return false;
  }
}

async function findFile(directory, filename) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = await findFile(candidate, filename);
      if (nested) return nested;
    }
  }
  return null;
}

function compilerEnvironment() {
  return {
    HOME: cacheDirectory,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    XDG_CACHE_HOME: cacheDirectory,
    TECTONIC_UNTRUSTED_MODE: "1",
    SOURCE_DATE_EPOCH: "0",
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const capture = (chunk) => {
      if (output.length < 128 * 1024) {
        output += chunk.toString("utf8", 0, 128 * 1024 - output.length);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs || 30_000);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, timedOut });
    });
  });
}
