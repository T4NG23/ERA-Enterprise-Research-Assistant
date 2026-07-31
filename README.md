# Scholar Flow — Ollama test build

Scholar Flow turns author-supplied research material into a reviewable paper
package: a structured draft, LaTeX source, an optional compiled PDF, figure and
table placement suggestions, and a rule-by-rule checklist. It is a drafting
tool, not a submission or peer-review service; authors remain responsible for
accuracy, citations, permissions, disclosures, and final venue compliance.

This handoff is prepared for local testing with **Ollama**. It contains source,
tests, and reproducible dependency metadata only—no model files, credentials,
personal documents, compiler cache, build output, or installed dependencies.

## Quick start (macOS or Linux)

Requirements:

- Node.js 22.13 or newer (`.nvmrc` is included)
- npm
- Ollama, running on the same computer
- An Ollama model suitable for structured text generation

Choose an installed model name exactly as it appears in `ollama list`. The
default below is `llama3.2`; substitute a different exact name if needed.

```bash
npm ci
ollama pull llama3.2
npm run ollama:setup -- llama3.2
npm run ollama:check
```

`ollama:setup` creates a private `.env.ollama.local` file with fresh local
signing secrets and activates it as `.env.local`. It never copies or overwrites
an existing `.env.local`.

On macOS, Ollama usually runs as a background service. On Linux, start it in a
separate terminal if it is not already running:

```bash
ollama serve
```

For the complete app, including local PDF compilation, provision the compiler
once and then launch both processes:

```bash
npm run pdf:setup
npm run dev
```

Open the local URL printed by the development server. `npm run dev` starts the
web app and a loopback-only PDF compiler; Ollama stays a separate local service.

For a UI-only session without PDF compilation, use `npm run dev:web` after the
Ollama setup and check. PDF actions will not work in that mode.

## Important local-model notes

Scholar Flow connects only to the loopback OpenAI-compatible Ollama endpoint:

```dotenv
SCHOLAR_FLOW_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
SCHOLAR_FLOW_OLLAMA_MODEL=llama3.2
```

The model name must exactly match the ID shown by `ollama list`, often including
a tag such as `:latest` or `:7b`. `npm run ollama:check` verifies that exact
name. Update
`.env.ollama.local` and rerun the check if it differs. The older
`SCHOLAR_FLOW_LLAMA_*` configuration names are still accepted for an existing
local setup, but new configurations should use `SCHOLAR_FLOW_OLLAMA_*`.

`SCHOLAR_FLOW_OLLAMA_CONTEXT_TOKENS` is Scholar Flow's safety budget; it does
not reconfigure Ollama's model context. Create an Ollama model with an
appropriate `num_ctx` setting if a larger context is required. Ollama's
OpenAI-compatible chat endpoint, model discovery endpoint, and structured
response support are documented in the [Ollama API documentation](https://docs.ollama.com/api/openai-compatibility).

The archive intentionally does not include an Ollama model. `ollama pull` may
download several gigabytes, depending on the selected model.

## Validation

These checks do not make a real model request:

```bash
npm test
npm run typecheck
npm run lint
npm run build
npm run provider:audit
```

To confirm the local model connection before testing the UI, run:

```bash
npm run ollama:check
```

The app health indicator should report the configured Ollama model as ready.
Use the built-in synthetic fixtures for a safe functional test; review all
generated text before relying on it.

## Platform limits

`npm run pdf:setup` downloads a pinned Tectonic binary and warms its package
cache on first use. That step requires network access and currently supports
macOS or Linux on x64/arm64. Native Windows PDF compilation is not included in
this handoff; use a supported environment (for example, a separately verified
WSL setup) for the full PDF workflow.

## Project layout

- `app/` — user interface and HTTP routes
- `lib/` — generation, Ollama/OCI provider, validation, and policy logic
- `compiler/` — local Tectonic PDF service, fixtures, and tests
- `scripts/` — development, provider, PDF, and Ollama setup helpers
- `public/` — application assets

OCI test-provider code remains in the project but is inactive by default. This
archive includes no OCI configuration or credentials; Ollama is all that is
needed for the intended local test path.
