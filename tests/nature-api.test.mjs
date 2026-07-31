import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { POST } from "../app/api/nature/route.ts";
import {
  fetchNaturePeerReviewFilesDirect,
  isValidPmcid,
  parseNaturePeerReviewFiles,
} from "../lib/nature.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(pmcid, extra = {}) {
  return new Request("https://reader.example/api/nature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pmcid, ...extra }),
  });
}

const normalXml = `<?xml version="1.0" encoding="UTF-8"?>
<article xmlns:xlink="http://www.w3.org/1999/xlink">
  <body>
    <supplementary-material id="MOESM1">
      <media xlink:href="supplementary_information.pdf">
        <caption><p>Supplementary Information</p></caption>
      </media>
    </supplementary-material>
    <supplementary-material id="MOESM2">
      <media xlink:href="41467_2025_58900_MOESM3_ESM.pdf">
        <caption><p>Transparent Peer Review file</p></caption>
      </media>
    </supplementary-material>
  </body>
</article>`;

test("validates strict uppercase PMC identifiers", () => {
  assert.equal(isValidPmcid("PMC11997106"), true);
  assert.equal(isValidPmcid("pmc11997106"), false);
  assert.equal(isValidPmcid("PMC011997106"), false);
  assert.equal(isValidPmcid("PMC11997106/path"), false);
  assert.equal(isValidPmcid("https://europepmc.org/PMC11997106"), false);
});

test("extracts a transparent peer-review PDF and constructs an official URL", () => {
  assert.deepEqual(parseNaturePeerReviewFiles(normalXml, "PMC11997106"), [
    {
      label: "Transparent Peer Review file",
      filename: "41467_2025_58900_MOESM3_ESM.pdf",
      url: "https://europepmc.org/articles/PMC11997106/bin/41467_2025_58900_MOESM3_ESM.pdf",
    },
  ]);
});

test("browser fallback fetches only the fixed Europe PMC XML endpoint", async () => {
  const calls = [];
  const files = await fetchNaturePeerReviewFilesDirect("PMC11997106", {
    fetchImpl: async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return new Response(normalXml, {
        headers: {
          "Content-Type": "application/xml",
          "Content-Length": String(Buffer.byteLength(normalXml)),
        },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://www.ebi.ac.uk");
  assert.equal(
    calls[0].url.pathname,
    "/europepmc/webservices/rest/PMC11997106/fullTextXML",
  );
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(files[0].filename, "41467_2025_58900_MOESM3_ESM.pdf");
});

test("browser fallback rejects oversized XML before parsing", async () => {
  await assert.rejects(
    fetchNaturePeerReviewFilesDirect("PMC11997106", {
      fetchImpl: async () =>
        new Response("not read", {
          headers: { "Content-Length": "12000001" },
        }),
    }),
    /exceeded the safety limit/,
  );
});

test("browser fallback enforces the byte cap while streaming", async () => {
  await assert.rejects(
    fetchNaturePeerReviewFilesDirect("PMC11997106", {
      byteCap: 5,
      fetchImpl: async () => new Response("123456"),
    }),
    /exceeded the safety limit/,
  );
});

test("rejects malicious, external, encoded, and non-PDF media hrefs", () => {
  const maliciousXml = `<article xmlns:xlink="http://www.w3.org/1999/xlink">
    <supplementary-material>
      <media xlink:href="../../private.pdf"><caption><p>Peer Review file</p></caption></media>
    </supplementary-material>
    <supplementary-material>
      <media xlink:href="https://evil.example/review.pdf"><caption><p>Peer Review file</p></caption></media>
    </supplementary-material>
    <supplementary-material>
      <media xlink:href="evil%2freview.pdf"><caption><p>Peer Review file</p></caption></media>
    </supplementary-material>
    <supplementary-material>
      <media xlink:href="review.pdf?next=https://evil.example"><caption><p>Peer Review file</p></caption></media>
    </supplementary-material>
    <supplementary-material>
      <media xlink:href="review.html"><caption><p>Transparent Peer Review file</p></caption></media>
    </supplementary-material>
    <supplementary-material>
      <media href="safe-review.pdf"><caption><p>Peer-Review File</p></caption></media>
    </supplementary-material>
  </article>`;

  assert.deepEqual(parseNaturePeerReviewFiles(maliciousXml, "PMC11997106"), [
    {
      label: "Peer-Review File",
      filename: "safe-review.pdf",
      url: "https://europepmc.org/articles/PMC11997106/bin/safe-review.pdf",
    },
  ]);
  assert.deepEqual(
    parseNaturePeerReviewFiles(maliciousXml, "PMC11997106/../../admin"),
    [],
  );
});

test("returns an empty list when the XML has no peer-review attachment", () => {
  assert.deepEqual(
    parseNaturePeerReviewFiles(
      `<article><supplementary-material><media href="data.pdf"><caption>Source Data</caption></media></supplementary-material></article>`,
      "PMC11997106",
    ),
    [],
  );
});

test("route fetches only the fixed Europe PMC fullTextXML endpoint", async () => {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return new Response(normalXml, {
      headers: { "Content-Type": "application/xml" },
    });
  };

  const response = await POST(request("PMC11997106"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, "https://www.ebi.ac.uk");
  assert.equal(
    calls[0].url.pathname,
    "/europepmc/webservices/rest/PMC11997106/fullTextXML",
  );
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(body.peerReviewFiles, [
    {
      label: "Transparent Peer Review file",
      filename: "41467_2025_58900_MOESM3_ESM.pdf",
      url: "https://europepmc.org/articles/PMC11997106/bin/41467_2025_58900_MOESM3_ESM.pdf",
    },
  ]);
});

test("route rejects invalid or expanded input without making a request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };

  const invalid = await POST(request("https://evil.example/PMC11997106"));
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);

  const extra = await POST(
    request("PMC11997106", {
      url: "http://169.254.169.254/latest/meta-data/",
    }),
  );
  assert.equal(extra.status, 400);
  assert.equal(calls, 0);
  assert.match((await extra.json()).error, /Only the pmcid/);
});

test("route reports missing peer-review files without returning unrelated PDFs", async () => {
  globalThis.fetch = async () =>
    new Response(
      `<article><supplementary-material><media href="paper.pdf"><caption>Article PDF</caption></media></supplementary-material></article>`,
      { headers: { "Content-Type": "application/xml" } },
    );

  const response = await POST(request("PMC11997106"));
  const body = await response.json();
  assert.equal(response.status, 404);
  assert.deepEqual(body.peerReviewFiles, []);
  assert.equal(
    body.europePmcUrl,
    "https://europepmc.org/articles/PMC11997106",
  );
});

test("route enforces the upstream XML size cap before reading the body", async () => {
  globalThis.fetch = async () =>
    new Response("not read", {
      headers: { "Content-Length": "12000001" },
    });

  const response = await POST(request("PMC11997106"));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.error, /exceeded the safety limit/);
  assert.deepEqual(body.peerReviewFiles, []);
});
