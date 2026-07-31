import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchGuidelineSource,
  GUIDELINE_SOURCE_LIMITS,
  GuidelineSourceFetchError,
  OFFICIAL_SCHOLARLY_DOMAINS,
  validateGuidelineSourceUrl,
} from "../../lib/guideline-source-fetch.mjs";

const FIXED_TIME = "2026-07-28T14:15:16.000Z";
const fixedNow = () => new Date(FIXED_TIME);
const encoder = new TextEncoder();

function response(body, contentType, init = {}) {
  const headers = new Headers(init.headers);
  if (contentType) headers.set("content-type", contentType);
  return new Response(body, {
    ...init,
    headers,
  });
}

async function rejectsWithCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof GuidelineSourceFetchError);
    assert.equal(error.code, code);
    return true;
  });
}

test("publishes a transparent, suffix-safe official scholarly allowlist", () => {
  for (const expected of [
    "ieee.org",
    "ieeeigarss.org",
    "acm.org",
    "springer.com",
    "nature.com",
    "elsevier.com",
    "wiley.com",
    "tandfonline.com",
    "sagepub.com",
    "plos.org",
    "frontiersin.org",
    "mdpi.com",
    "oup.com",
    "cambridge.org",
    "aps.org",
    "aip.org",
    "acs.org",
    "rsc.org",
    "iop.org",
    "thecvf.com",
    "neurips.cc",
    "icml.cc",
    "aaai.org",
    "aclweb.org",
    "usenix.org",
    "spie.org",
    "optica.org",
    "asme.org",
  ]) {
    assert.ok(OFFICIAL_SCHOLARLY_DOMAINS.includes(expected), expected);
  }

  assert.equal(
    validateGuidelineSourceUrl(
      "https://2026.ieeeigarss.org/papers/paper_kit.php?track=spc",
    ),
    "https://2026.ieeeigarss.org/papers/paper_kit.php?track=spc",
  );
  assert.equal(
    validateGuidelineSourceUrl("https://journals.acm.org/author-guidance"),
    "https://journals.acm.org/author-guidance",
  );
});

test("rejects unsafe URL forms before making a request", async (t) => {
  const cases = [
    ["HTTP", "http://ieee.org/guidelines", "INVALID_URL"],
    ["credentials", "https://user:secret@ieee.org/guidelines", "INVALID_URL"],
    ["explicit default port", "https://ieee.org:443/guidelines", "INVALID_URL"],
    ["fragment", "https://ieee.org/guidelines#format", "INVALID_URL"],
    ["IPv4", "https://127.0.0.1/guidelines", "INVALID_URL"],
    ["short IPv4", "https://127.1/guidelines", "INVALID_URL"],
    ["IPv6", "https://[::1]/guidelines", "INVALID_URL"],
    ["localhost", "https://localhost/guidelines", "INVALID_URL"],
    ["private suffix", "https://publisher.internal/guidelines", "INVALID_URL"],
    [
      "suffix confusion",
      "https://ieee.org.attacker.example.net/guidelines",
      "DOMAIN_NOT_ALLOWED",
    ],
    [
      "prefix confusion",
      "https://notieee.org/guidelines",
      "DOMAIN_NOT_ALLOWED",
    ],
    [
      "unapproved public host",
      "https://publisher.example.edu/guidelines",
      "DOMAIN_NOT_ALLOWED",
    ],
  ];

  for (const [name, url, code] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      await rejectsWithCode(
        () =>
          fetchGuidelineSource(url, {
            fetchImpl: async () => {
              calls += 1;
              return response("never", "text/plain");
            },
          }),
        code,
      );
      assert.equal(calls, 0);
    });
  }
});

test("accepts narrowly scoped caller-provided public domain suffixes", () => {
  assert.equal(
    validateGuidelineSourceUrl(
      "https://guides.research-foundation.org/camera-ready",
      { extraDomains: ["research-foundation.org"] },
    ),
    "https://guides.research-foundation.org/camera-ready",
  );

  for (const domain of [
    "localhost",
    "publisher.local",
    "publisher.internal",
    "*.example.org",
    "https://example.org",
    "example.org?scope=all",
    "com",
  ]) {
    assert.throws(
      () =>
        validateGuidelineSourceUrl("https://ieee.org/guide", {
          extraDomains: [domain],
        }),
      (error) =>
        error instanceof GuidelineSourceFetchError &&
        error.code === "INVALID_CONFIG",
      domain,
    );
  }
});

test("fetches and cleans HTML without executing or retaining active content", async () => {
  const html = `<!doctype html>
<html>
  <head>
    <title>Author &amp; Paper Guide</title>
    <style>.hidden { display: none }</style>
    <script>globalThis.compromised = true</script>
  </head>
  <body>
    <header>Publisher navigation</header>
    <nav>Unrelated links</nav>
    <main>
      <h1>Submission Rules</h1>
      <p>Use &lt;official templates&gt; &amp; cite prior work&#46;</p>
      <ul><li>Four pages</li><li>Two columns</li></ul>
      <table>
        <tr><th>Track</th><th>Deadline</th></tr>
        <tr><td>SPC</td><td>17 January 2026</td></tr>
      </table>
      <form><label>Do not retain this form</label></form>
    </main>
    <footer>Boilerplate footer</footer>
  </body>
</html>`;
  const calls = [];
  const result = await fetchGuidelineSource(
    "https://2026.ieeeigarss.org/papers/paper_kit.php",
    {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return response(html, "text/html; charset=UTF-8");
      },
      now: fixedNow,
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://2026.ieeeigarss.org/papers/paper_kit.php",
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.referrerPolicy, "no-referrer");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.match(calls[0].init.headers.Accept, /application\/pdf/u);

  assert.equal(
    result.finalUrl,
    "https://2026.ieeeigarss.org/papers/paper_kit.php",
  );
  assert.equal(result.mime, "text/html");
  assert.equal(result.retrievedAt, FIXED_TIME);
  assert.equal(result.title, "Author & Paper Guide");
  assert.equal(result.byteLength, encoder.encode(html).byteLength);
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
  assert.match(result.text, /^Submission Rules/u);
  assert.match(result.text, /Use <official templates> & cite prior work\./u);
  assert.match(result.text, /- Four pages\n- Two columns/u);
  assert.match(result.text, /Track\tDeadline\n+SPC\t17 January 2026/u);
  assert.doesNotMatch(
    result.text,
    /compromised|display: none|navigation|Unrelated|form|footer/iu,
  );
  assert.equal(globalThis.compromised, undefined);
});

test("follows no more than three manual redirects and validates each target", async () => {
  const targets = new Map([
    [
      "https://ieee.org/start",
      response(null, null, {
        status: 302,
        headers: { location: "/author-guide" },
      }),
    ],
    [
      "https://ieee.org/author-guide",
      response(null, null, {
        status: 307,
        headers: { location: "https://www.acm.org/publications/guide" },
      }),
    ],
    [
      "https://www.acm.org/publications/guide",
      response(null, null, {
        status: 301,
        headers: {
          location: "https://link.springer.com/submission-guidelines",
        },
      }),
    ],
    [
      "https://link.springer.com/submission-guidelines",
      response("Final author rules", "text/plain"),
    ],
  ]);
  const calls = [];
  const result = await fetchGuidelineSource("https://ieee.org/start", {
    fetchImpl: async (url, init) => {
      calls.push({ url, redirect: init.redirect });
      return targets.get(url);
    },
    now: fixedNow,
  });

  assert.deepEqual(
    calls.map(({ url }) => url),
    [...targets.keys()],
  );
  assert.ok(calls.every(({ redirect }) => redirect === "manual"));
  assert.equal(
    result.finalUrl,
    "https://link.springer.com/submission-guidelines",
  );
  assert.equal(result.text, "Final author rules");

  let redirectCalls = 0;
  await rejectsWithCode(
    () =>
      fetchGuidelineSource("https://ieee.org/loop", {
        fetchImpl: async () => {
          redirectCalls += 1;
          return response(null, null, {
            status: 302,
            headers: { location: `/loop-${redirectCalls}` },
          });
        },
      }),
    "REDIRECT_LIMIT",
  );
  assert.equal(redirectCalls, GUIDELINE_SOURCE_LIMITS.maxRedirects + 1);
});

test("rejects unsafe redirect targets before requesting them", async (t) => {
  const cases = [
    [
      "unapproved host",
      "https://attacker.example.net/rules",
      "DOMAIN_NOT_ALLOWED",
    ],
    ["HTTP downgrade", "http://ieee.org/rules", "INVALID_URL"],
    ["credentials", "https://user@ieee.org/rules", "INVALID_URL"],
    ["explicit default port", "https://ieee.org:443/rules", "INVALID_URL"],
    ["fragment", "https://ieee.org/rules#format", "INVALID_URL"],
    ["backslash", String.raw`/rules\alternate`, "INVALID_URL"],
    ["whitespace", "/rules next", "INVALID_URL"],
  ];
  for (const [name, location, code] of cases) {
    await t.test(name, async () => {
      const calls = [];
      await rejectsWithCode(
        () =>
          fetchGuidelineSource("https://ieee.org/start", {
            fetchImpl: async (url) => {
              calls.push(url);
              return response(null, null, {
                status: 302,
                headers: { location },
              });
            },
          }),
        code,
      );
      assert.deepEqual(calls, ["https://ieee.org/start"]);
    });
  }
});

test("requires an exact supported MIME type and successful complete response", async (t) => {
  const cases = [
    [
      "missing Content-Type",
      () => new Response(encoder.encode("rules")),
      "MIME_NOT_ALLOWED",
    ],
    [
      "JSON Content-Type",
      () => response('{"rules":[]}', "application/json"),
      "MIME_NOT_ALLOWED",
    ],
    [
      "ambiguous Content-Type",
      () => response("rules", "text/plain, text/html"),
      "MIME_NOT_ALLOWED",
    ],
    [
      "empty charset",
      () => response("rules", "text/plain; charset="),
      "TEXT_DECODING_FAILED",
    ],
    [
      "HTTP error",
      () => response("missing", "text/plain", { status: 404 }),
      "HTTP_STATUS_ERROR",
    ],
    [
      "partial response",
      () => response("partial", "text/plain", { status: 206 }),
      "HTTP_STATUS_ERROR",
    ],
  ];
  for (const [name, buildResponse, code] of cases) {
    await t.test(name, async () => {
      await rejectsWithCode(
        () =>
          fetchGuidelineSource("https://ieee.org/guide", {
            fetchImpl: async () => buildResponse(),
          }),
        code,
      );
    });
  }
});

test("bounds streamed bytes and validates length and encoding metadata", async (t) => {
  const cases = [
    [
      "declared too large",
      response("123456", "text/plain", {
        headers: { "content-length": "6" },
      }),
      { maxBytes: 5 },
      "CONTENT_TOO_LARGE",
    ],
    [
      "streamed too large",
      response("123456", "text/plain"),
      { maxBytes: 5 },
      "CONTENT_TOO_LARGE",
    ],
    [
      "identity length mismatch",
      response("123456", "text/plain", {
        headers: { "content-length": "5" },
      }),
      {},
      "CONTENT_LENGTH_MISMATCH",
    ],
    [
      "ambiguous length",
      response("123456", "text/plain", {
        headers: { "content-length": "6, 6" },
      }),
      {},
      "CONTENT_LENGTH_INVALID",
    ],
    [
      "unsupported encoding",
      response("123456", "text/plain", {
        headers: { "content-encoding": "compress" },
      }),
      {},
      "CONTENT_ENCODING_INVALID",
    ],
    [
      "multiple encodings",
      response("123456", "text/plain", {
        headers: { "content-encoding": "gzip, br" },
      }),
      {},
      "CONTENT_ENCODING_INVALID",
    ],
  ];

  for (const [name, sourceResponse, options, code] of cases) {
    await t.test(name, async () => {
      await rejectsWithCode(
        () =>
          fetchGuidelineSource("https://ieee.org/guide", {
            ...options,
            fetchImpl: async () => sourceResponse,
          }),
        code,
      );
    });
  }

  const decoded = await fetchGuidelineSource("https://ieee.org/guide", {
    fetchImpl: async () =>
      response("123456", "text/plain", {
        // Fetch exposes decoded bytes, while this value can describe the wire
        // representation. Actual decoded bytes remain independently bounded.
        headers: {
          "content-encoding": "gzip",
          "content-length": "4",
        },
      }),
  });
  assert.equal(decoded.byteLength, 6);
});

test("returns bounded cleaned plain text and rejects malformed text", async (t) => {
  const result = await fetchGuidelineSource("https://usenix.org/author-guide.txt", {
    fetchImpl: async () =>
      response(
        "# Camera-ready guide\r\n\r\nUse&nbsp;the official template.\u0007",
        "text/plain; charset=utf-8",
      ),
    now: fixedNow,
  });
  assert.equal(result.title, "Camera-ready guide");
  assert.equal(
    result.text,
    "# Camera-ready guide\n\nUse the official template.",
  );

  await t.test("cleaned text limit", async () => {
    await rejectsWithCode(
      () =>
        fetchGuidelineSource("https://ieee.org/guide", {
          fetchImpl: async () => response("<p>123456</p>", "text/html"),
          maxTextCharacters: 5,
        }),
      "TEXT_TOO_LARGE",
    );
  });
  await t.test("malformed UTF-8", async () => {
    await rejectsWithCode(
      () =>
        fetchGuidelineSource("https://ieee.org/guide", {
          fetchImpl: async () =>
            response(
              new Uint8Array([0xc3, 0x28]),
              "text/plain; charset=utf-8",
            ),
        }),
      "TEXT_DECODING_FAILED",
    );
  });
  await t.test("binary NUL in text", async () => {
    await rejectsWithCode(
      () =>
        fetchGuidelineSource("https://ieee.org/guide", {
          fetchImpl: async () =>
            response(
              new Uint8Array([0x72, 0x75, 0x6c, 0x65, 0x00]),
              "text/plain; charset=utf-8",
            ),
        }),
      "TEXT_DECODING_FAILED",
    );
  });
});

test("hashes the exact fetched bytes rather than normalized text", async () => {
  const result = await fetchGuidelineSource("https://ieee.org/abc.txt", {
    fetchImpl: async () => response("abc", "text/plain"),
    now: fixedNow,
  });
  assert.equal(
    result.sha256,
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(result.text, "abc");
});

test("drops void active tags and all content after an unclosed script", async () => {
  const result = await fetchGuidelineSource("https://ieee.org/malformed", {
    fetchImpl: async () =>
      response(
        '<embed src="plugin"><h1>Rules remain</h1><script>secret text',
        "text/html",
      ),
  });
  assert.equal(result.title, "Rules remain");
  assert.equal(result.text, "Rules remain");
});

test("returns verified PDF bytes with a safe derived title", async () => {
  const bytes = encoder.encode(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF",
  );
  const result = await fetchGuidelineSource(
    "https://ieee.org/publications/paper-kit.pdf",
    {
      fetchImpl: async () =>
        response(bytes, "application/pdf", {
          headers: {
            "content-disposition":
              "attachment; filename*=UTF-8''IGARSS%202026%20Paper%20Kit.pdf",
            "content-length": String(bytes.byteLength),
          },
        }),
      now: fixedNow,
    },
  );

  assert.equal(result.mime, "application/pdf");
  assert.equal(result.title, "IGARSS 2026 Paper Kit");
  assert.equal(result.retrievedAt, FIXED_TIME);
  assert.equal(result.byteLength, bytes.byteLength);
  assert.deepEqual(result.bytes, bytes);
  assert.equal("text" in result, false);
  assert.match(result.sha256, /^[0-9a-f]{64}$/u);
});

test("rejects a non-PDF body advertised as PDF", async () => {
  await rejectsWithCode(
    () =>
      fetchGuidelineSource("https://ieee.org/fake.pdf", {
        fetchImpl: async () =>
          response("<html>not a PDF</html>", "application/pdf"),
      }),
    "INVALID_PDF",
  );
});

test("enforces a total fetch timeout even when an injected fetch stalls", async () => {
  const started = Date.now();
  await rejectsWithCode(
    () =>
      fetchGuidelineSource("https://ieee.org/slow", {
        fetchImpl: async () => new Promise(() => {}),
        timeoutMs: 10,
      }),
    "FETCH_TIMEOUT",
  );
  assert.ok(Date.now() - started < 1_000);
});

test("maps network failures without exposing implementation errors", async () => {
  await rejectsWithCode(
    () =>
      fetchGuidelineSource("https://ieee.org/unavailable", {
        fetchImpl: async () => {
          throw new Error("socket details that should not escape");
        },
      }),
    "FETCH_FAILED",
  );
});

test("maps response stream failures and rejects automatic redirect handling", async (t) => {
  await t.test("response stream failure", async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("raw stream failure"));
      },
    });
    await rejectsWithCode(
      () =>
        fetchGuidelineSource("https://ieee.org/stream-error", {
          fetchImpl: async () =>
            response(body, "text/plain; charset=utf-8"),
        }),
      "FETCH_FAILED",
    );
  });

  await t.test("automatic redirect", async () => {
    const redirected = response("rules", "text/plain");
    Object.defineProperty(redirected, "redirected", { value: true });
    await rejectsWithCode(
      () =>
        fetchGuidelineSource("https://ieee.org/redirected", {
          fetchImpl: async () => redirected,
        }),
      "FETCH_PROTOCOL_ERROR",
    );
  });
});
