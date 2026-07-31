import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { POST } from "../app/api/discovery/route.ts";

const originalFetch = globalThis.fetch;
const originalGithubToken = process.env.GITHUB_TOKEN;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnvironment("GITHUB_TOKEN", originalGithubToken);
  restoreEnvironment("BRAVE_SEARCH_API_KEY", originalBraveKey);
});

function request(arxivUrl, extra = {}) {
  return new Request("https://reader.example/api/discovery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arxivUrl, ...extra }),
  });
}

function arxivFeed() {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <id>https://arxiv.org/abs/2401.01234v2</id>
        <updated>2024-02-03T00:00:00Z</updated>
        <published>2024-01-03T00:00:00Z</published>
        <title>Reliable Diagnostic Models for Clinical Imaging</title>
        <summary>We study reliable diagnostic models.</summary>
        <author><name>Alice Example</name></author>
        <author><name>Bo Researcher</name></author>
        <arxiv:primary_category term="cs.CV"/>
        <category term="cs.CV"/>
      </entry>
    </feed>`;
}

test("rejects invalid and oversized input without fetching a user-controlled URL", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("fetch must not be called");
  };

  const invalid = await POST(request("http://127.0.0.1/private"));
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  assert.match((await invalid.json()).error, /valid arXiv/);

  const extraField = await POST(
    request("https://arxiv.org/abs/2401.01234", {
      fetchThisInstead: "https://169.254.169.254/latest/meta-data/",
    }),
  );
  assert.equal(extraField.status, 400);
  assert.equal(calls, 0);
  assert.match((await extraField.json()).error, /not supported/);

  const oversized = await POST(
    new Request("https://reader.example/api/discovery", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        arxivUrl: `https://arxiv.org/abs/${"1".repeat(4_200)}`,
      }),
    }),
  );
  assert.equal(oversized.status, 400);
  assert.equal(calls, 0);
  assert.equal(
    oversized.headers.get("cache-control"),
    "no-store, max-age=0",
  );
});

test("discovers a Nature subjournal peer-review PDF, GitHub files, Crossref records, and bounded Brave leads", async () => {
  process.env.GITHUB_TOKEN = "github-unit-secret";
  process.env.BRAVE_SEARCH_API_KEY = "brave-unit-secret";
  const requested = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requested.push({
      url: url.toString(),
      authorization:
        init.headers?.Authorization ?? init.headers?.authorization ?? "",
      braveKey:
        init.headers?.["X-Subscription-Token"] ??
        init.headers?.["x-subscription-token"] ??
        "",
    });

    if (url.hostname === "export.arxiv.org") {
      assert.equal(url.pathname, "/api/query");
      assert.equal(url.searchParams.get("id_list"), "2401.01234v2");
      return new Response(arxivFeed(), {
        headers: { "Content-Type": "application/atom+xml" },
      });
    }

    if (
      url.hostname === "api.crossref.org" &&
      url.searchParams.get("filter") === "prefix:10.1038"
    ) {
      return Response.json({
        message: {
          items: [
            {
              DOI: "10.1038/s41591-024-01234-5",
              title: [
                "Reliable Diagnostic Models for Clinical Imaging",
              ],
              author: [
                { given: "Alice", family: "Example" },
                { given: "Bo", family: "Researcher" },
              ],
              URL: "https://doi.org/10.1038/s41591-024-01234-5",
            },
          ],
        },
      });
    }

    if (
      url.hostname === "api.crossref.org" &&
      url.searchParams.get("filter")?.startsWith("relation.type:")
    ) {
      return Response.json({
        message: {
          items: [
            {
              DOI: "10.1038/s41591-024-01234-5.r1",
              title: ["Reviewer report"],
              URL: "https://doi.org/10.1038/s41591-024-01234-5.r1",
            },
          ],
        },
      });
    }

    if (
      url.hostname === "www.nature.com" &&
      url.pathname === "/articles/s41591-024-01234-5"
    ) {
      return new Response(
        `<!doctype html><html><body>
          <a href="https://static-content.springer.com/esm/art%3A10.1038%2Fs41591-024-01234-5/MediaObjects/41591_2024_1234_MOESM2_ESM.pdf">
            Peer Review File
          </a>
          <a href="/articles/s41591-024-01234-5.pdf">Download article PDF</a>
        </body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    }

    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/search/repositories"
    ) {
      return Response.json({
        items: [
          {
            full_name: "alice/clinical-imaging-paper",
            name: "clinical-imaging-paper",
            description:
              "Reliable Diagnostic Models for Clinical Imaging rebuttal",
            html_url:
              "https://github.com/alice/clinical-imaging-paper",
            default_branch: "main",
          },
        ],
      });
    }

    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/search/code"
    ) {
      return Response.json({
        items: [
          {
            name: "rebuttal.pdf",
            path: "docs/rebuttal.pdf",
            html_url:
              "https://github.com/alice/clinical-imaging-paper/blob/main/docs/rebuttal.pdf",
            repository: {
              full_name: "alice/clinical-imaging-paper",
            },
          },
        ],
      });
    }

    if (
      url.hostname === "api.github.com" &&
      url.pathname.includes("/git/trees/")
    ) {
      return Response.json({
        tree: [
          { type: "blob", path: "README.md" },
          { type: "blob", path: "supplementary/author_response.pdf" },
        ],
      });
    }

    if (url.hostname === "api.search.brave.com") {
      return Response.json({
        web: {
          results: [
            {
              title:
                "Reliable Diagnostic Models for Clinical Imaging — Author Response",
              url: "https://example.edu/papers/clinical-author-response",
              description:
                "Public author response and response to reviewers.",
            },
            {
              title: "Unrelated page",
              url: "javascript:alert(1)",
              description: "rebuttal",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };

  const response = await POST(
    request("https://arxiv.org/abs/2401.01234v2"),
  );
  const text = await response.text();
  const body = JSON.parse(text);

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store, max-age=0",
  );
  assert.equal(body.paper.id, "2401.01234v2");
  assert.equal(
    body.paper.title,
    "Reliable Diagnostic Models for Clinical Imaging",
  );
  assert.equal(body.paper.authors.length, 2);
  assert.ok(
    body.candidates.some(
      (item) =>
        item.provider === "nature" &&
        item.kind === "peer_review_file" &&
        item.confidence === "verified" &&
        item.url.includes("static-content.springer.com"),
    ),
  );
  assert.ok(
    body.candidates.some(
      (item) =>
        item.provider === "github" &&
        item.kind === "rebuttal_file" &&
        item.url.includes("rebuttal.pdf"),
    ),
  );
  assert.ok(
    body.candidates.some(
      (item) =>
        item.provider === "crossref" &&
        item.kind === "peer_review_record",
    ),
  );
  assert.ok(
    body.candidates.some(
      (item) =>
        item.provider === "brave" && item.kind === "web_result",
    ),
  );
  assert.ok(body.candidates.length <= 20);
  assert.equal(body.manualSearchUrls.length, 3);
  assert.ok(
    body.providers.some(
      (provider) =>
        provider.id === "github" &&
        provider.status === "searched" &&
        provider.configured === true,
    ),
  );
  assert.ok(
    requested.some(
      (entry) =>
        entry.url.startsWith("https://export.arxiv.org/api/query?") &&
        !entry.url.includes("reader.example"),
    ),
  );
  assert.ok(
    requested.some(
      (entry) =>
        entry.authorization === "Bearer github-unit-secret",
    ),
  );
  assert.ok(
    requested.some(
      (entry) => entry.braveKey === "brave-unit-secret",
    ),
  );
  assert.doesNotMatch(text, /github-unit-secret|brave-unit-secret/);
});

test("degrades safely without optional keys and on GitHub rate limits", async () => {
  delete process.env.GITHUB_TOKEN;
  delete process.env.BRAVE_SEARCH_API_KEY;

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (
      url.hostname === "api.crossref.org" &&
      url.searchParams.get("filter") === "prefix:10.1038"
    ) {
      return Response.json({ message: { items: [] } });
    }
    if (
      url.hostname === "api.github.com" &&
      url.pathname === "/search/repositories"
    ) {
      return Response.json(
        { message: "API rate limit exceeded" },
        { status: 429 },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  // The arXiv metadata is served from the route's bounded 24-hour memory cache.
  const response = await POST(request("2401.01234v2"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.ok(
    body.providers.some(
      (provider) =>
        provider.id === "github" &&
        provider.status === "partial" &&
        provider.configured === false,
    ),
  );
  assert.ok(
    body.providers.some(
      (provider) =>
        provider.id === "brave" &&
        provider.status === "skipped" &&
        provider.configured === false,
    ),
  );
  assert.ok(
    body.providers.some(
      (provider) =>
        provider.id === "nature" && provider.status === "searched",
    ),
  );
});
