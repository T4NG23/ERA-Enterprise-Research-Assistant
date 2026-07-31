FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gzip tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/compiler
COPY compiler/setup.mjs ./setup.mjs
COPY compiler/supported-packages.mjs ./supported-packages.mjs
COPY compiler/fixtures ./fixtures

# Downloads a pinned, SHA-256-verified Tectonic release and caches the TeX bundle.
RUN node ./setup.mjs

COPY compiler/safety.mjs ./safety.mjs
COPY compiler/diagnostics.mjs ./diagnostics.mjs
COPY compiler/latex-structure.mjs ./latex-structure.mjs
COPY compiler/pdf-page-count.mjs ./pdf-page-count.mjs
COPY compiler/publication-template.mjs ./publication-template.mjs
COPY lib/submission-types.mjs /opt/lib/submission-types.mjs
COPY lib/page-limits.mjs /opt/lib/page-limits.mjs
COPY lib/venue-contract-artifact.mjs /opt/lib/venue-contract-artifact.mjs
COPY lib/venue-contract-secret.mjs /opt/lib/venue-contract-secret.mjs
COPY lib/venue-guidelines.mjs /opt/lib/venue-guidelines.mjs
COPY compiler/server.mjs ./server.mjs

RUN chown -R node:node /opt/compiler
USER node

ENV HOST=127.0.0.1 \
    PORT=3101 \
    TECTONIC_BIN=/opt/compiler/.bin/tectonic \
    TECTONIC_CACHE_DIR=/opt/compiler/.cache \
    TECTONIC_ONLY_CACHED=1 \
    COMPILER_MAX_CONCURRENCY=2 \
    NODE_ENV=production

# The compiler is intentionally not exposed. If containerized, run it in the
# same network namespace as the Scholar Flow app and keep that namespace
# disconnected from external networks.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3101/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.mjs"]
