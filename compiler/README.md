# Scholar Flow local PDF compiler

This loopback-only service compiles Scholar Flow's generated LaTeX using a
pinned Tectonic binary. It is separate from the web server because uploaded and
model-generated LaTeX must be treated as untrusted input.

The compiler does not contact Ollama, OCI, or any other AI provider. It only
receives the current LaTeX source and explicitly planned PNG/JPEG figures.

## Local setup

From the repository root:

```bash
npm ci
npm run pdf:setup
npm run dev
```

`pdf:setup` downloads the platform-specific Tectonic release, verifies it, and
warms the approved TeX package cache. It is a one-time networked provisioning
step. Runtime compilation uses only the cache and fails closed on a cache miss.

`npm run dev` starts this service on `127.0.0.1:3101` beside the web app. To
run it alone, use:

```bash
npm run pdf:server
```

Keep these local defaults:

```dotenv
SCHOLAR_FLOW_LATEX_COMPILER_URL=http://127.0.0.1:3101/compile
TECTONIC_ONLY_CACHED=1
```

The supported provisioning script currently targets macOS and Linux on x64 or
arm64. Native Windows support is not bundled.

## Safety boundaries

- The service binds to loopback by default.
- Runtime Tectonic jobs use fixed arguments, bounded input/output, temporary
  job directories, package allowlists, and cached-only package resolution.
- A successful PDF means only that TeX compiled. Inspect content, layout,
  figures, fonts, references, and venue rules before submission.
- Do not expose this development service to the internet or use it as the
  production sandbox for untrusted LaTeX.

## Tests

Run the complete compiler and integration suite from the repository root:

```bash
npm test
```
