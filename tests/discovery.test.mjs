import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalArxivUrl,
  extractNaturePeerReviewLinks,
  isGitHubRebuttalPath,
  matchLocalPapers,
  normalizedTitleSimilarity,
  parseArxivAtom,
  parseArxivAtomFeed,
  parseArxivId,
  safeCandidateUrl,
} from "../lib/discovery.ts";

function paper(overrides = {}) {
  const id = overrides.id ?? "paper";
  return {
    id,
    title: overrides.title ?? `Paper ${id}`,
    titleKind: overrides.titleKind ?? "paper_title",
    venue: overrides.venue ?? "Nature Communications",
    year: overrides.year ?? 2024,
    decision: "Published",
    accepted: true,
    topics: overrides.topics ?? [],
    scoreBefore: [],
    scoreAfter: [],
    reviewCount: 1,
    rebuttalRanges: [],
    reviewRange: null,
    paperZip: null,
    source: {
      type: "openreview_api",
      label: "Source",
      url: "https://example.org",
      originalUrl: "https://example.org",
      license: "CC BY 4.0",
      retrievedAt: "2026-07-31",
    },
    ...overrides,
  };
}

test("arXiv IDs parse from modern bare, prefixed, abs, pdf, and html forms", () => {
  const expected = {
    id: "2401.12345v2",
    baseId: "2401.12345",
    version: 2,
    canonicalArxivUrl: "https://arxiv.org/abs/2401.12345v2",
  };

  for (const input of [
    "2401.12345v2",
    "arXiv: 2401.12345v2",
    "https://arxiv.org/abs/2401.12345v2",
    "https://www.arxiv.org/pdf/2401.12345v2.pdf?download=1",
    "https://arxiv.org/html/2401.12345v2#section",
  ]) {
    assert.deepEqual(parseArxivId(input), expected);
  }
  assert.equal(
    canonicalArxivUrl("https://arxiv.org/pdf/2401.12345.pdf"),
    "https://arxiv.org/abs/2401.12345",
  );
});

test("legacy arXiv IDs and encoded legacy URL paths parse safely", () => {
  assert.deepEqual(parseArxivId("hep-th/9901001v3"), {
    id: "hep-th/9901001v3",
    baseId: "hep-th/9901001",
    version: 3,
    canonicalArxivUrl: "https://arxiv.org/abs/hep-th/9901001v3",
  });
  assert.equal(
    parseArxivId("https://arxiv.org/abs/math.GT%2F0309136")?.baseId,
    "math.GT/0309136",
  );
});

test("arXiv parser rejects lookalike hosts, credentials, unsafe paths, malformed IDs, and bad months", () => {
  for (const input of [
    "",
    "https://arxiv.org.evil.example/abs/2401.12345",
    "https://evil.example/arxiv.org/abs/2401.12345",
    "https://user@arxiv.org/abs/2401.12345",
    "ftp://arxiv.org/abs/2401.12345",
    "https://arxiv.org/search/?query=2401.12345",
    "https://arxiv.org/abs/2401.12345/extra",
    "https://arxiv.org/abs/%E0%A4%A",
    "2413.12345",
    "2400.12345",
    "2401.123",
    "2401.123456",
    "2401.12345v0",
    "hep-th/9913001",
    "../2401.12345",
  ]) {
    assert.equal(parseArxivId(input), null, input);
  }
});

const atomFeed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>arXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2401.12345v2</id>
    <updated>2024-02-03T04:05:06Z</updated>
    <published>2024-01-22T00:00:00Z</published>
    <title>
      Learning &amp; Reasoning: A &#x3B2; Test
    </title>
    <summary><![CDATA[ First line.
      Second <em>line</em>. ]]></summary>
    <author><name>Alice Example</name><arxiv:affiliation>Lab</arxiv:affiliation></author>
    <author><name>Bob &amp; Carol</name></author>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term='stat.ML'/>
    <arxiv:primary_category term="cs.LG"/>
    <arxiv:doi>10.1000/example.1</arxiv:doi>
    <arxiv:journal_ref>Nature Machine Intelligence 6, 1–8</arxiv:journal_ref>
  </entry>
  <entry>
    <id>https://arxiv.org/abs/hep-th/9901001</id>
    <title>Second paper</title>
    <summary>Second abstract</summary>
    <author><name>Delta</name></author>
    <category term="hep-th"/>
  </entry>
</feed>`;

test("Atom parsing extracts complete arXiv metadata and decodes text", () => {
  const metadata = parseArxivAtom(atomFeed);
  assert.ok(metadata);
  assert.equal(metadata.id, "2401.12345v2");
  assert.equal(metadata.baseId, "2401.12345");
  assert.equal(metadata.version, 2);
  assert.equal(metadata.title, "Learning & Reasoning: A β Test");
  assert.equal(metadata.abstract, "First line. Second line.");
  assert.deepEqual(metadata.authors, ["Alice Example", "Bob & Carol"]);
  assert.deepEqual(metadata.categories, ["cs.LG", "stat.ML"]);
  assert.equal(metadata.primaryCategory, "cs.LG");
  assert.equal(metadata.doi, "10.1000/example.1");
  assert.equal(metadata.journalRef, "Nature Machine Intelligence 6, 1–8");
  assert.equal(metadata.published, "2024-01-22T00:00:00Z");
  assert.equal(metadata.updated, "2024-02-03T04:05:06Z");
  assert.equal(metadata.canonicalArxivUrl, "https://arxiv.org/abs/2401.12345v2");

  const all = parseArxivAtomFeed(atomFeed);
  assert.equal(all.length, 2);
  assert.equal(all[1].baseId, "hep-th/9901001");
  assert.equal(all[1].primaryCategory, "hep-th");
  assert.equal(all[1].doi, null);
  assert.equal(all[1].published, null);
});

test("Atom parser ignores feed metadata, invalid entries, external entity declarations, and malformed input", () => {
  const xml = `<!DOCTYPE feed [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
    <feed>
      <title>Feed title must not win</title>
      <entry><id>https://evil.example/abs/2401.12345</id><title>Bad</title></entry>
      <entry><id>https://arxiv.org/abs/2502.00001</id><title>&xxe;</title></entry>
    </feed>`;
  const parsed = parseArxivAtom(xml);
  assert.ok(parsed);
  assert.equal(parsed.title, "&xxe;");
  assert.equal(parseArxivAtom("not xml"), null);
  assert.deepEqual(parseArxivAtomFeed(""), []);
});

test("normalized title similarity is case, punctuation, accent, and order independent", () => {
  assert.equal(
    normalizedTitleSimilarity(
      "Robust Transformers for Médical Images",
      "Medical images: robust-transformers",
    ),
    1,
  );
  assert.equal(normalizedTitleSimilarity("", "A Paper"), 0);
  assert.equal(
    normalizedTitleSimilarity("Graph Calibration", "Diffusion Alignment"),
    0,
  );
});

test("local matching favors exact titles, explains matches, and ignores year-only or identifier titles", () => {
  const metadata = {
    title: "Robust Transformers for Medical Image Classification",
    categories: ["cs.LG"],
    published: "2024-01-22T00:00:00Z",
  };
  const exact = paper({
    id: "exact",
    title: "Robust Transformers for Medical Image Classification",
    year: 2024,
    topics: ["cs.LG"],
  });
  const close = paper({
    id: "close",
    title: "Robust Transformer Classification of Medical Images",
    year: 2023,
  });
  const weak = paper({
    id: "weak",
    title: "Robust Optimization",
    year: 2024,
  });
  const identifier = paper({
    id: "identifier",
    title: "Robust Transformers for Medical Image Classification",
    titleKind: "identifier",
  });
  const yearOnly = paper({
    id: "year",
    title: "Quantum Geometry and Topology",
    year: 2024,
  });

  const matches = matchLocalPapers(
    metadata,
    [yearOnly, close, identifier, weak, exact],
    10,
  );
  assert.deepEqual(
    matches.map((match) => match.paper.id),
    ["exact", "close"],
  );
  assert.equal(matches[0].titleSimilarity, 1);
  assert.ok(matches[0].score > matches[1].score);
  assert.match(matches[0].reasons.join(" "), /Title similarity: 100%/u);
  assert.match(matches[0].reasons.join(" "), /Same publication year: 2024/u);
  assert.match(matches[0].reasons.join(" "), /Shared subject: cs lg/u);
  assert.deepEqual(matchLocalPapers(metadata, [exact], 0), []);
  assert.deepEqual(matchLocalPapers({ ...metadata, title: "" }, [exact]), []);
});

test("local match tie-breaking is deterministic and limit is bounded", () => {
  const metadata = {
    title: "Calibration under Distribution Shift",
    categories: [],
    published: null,
  };
  const alpha = paper({
    id: "alpha",
    title: "Calibration under Shift",
  });
  const beta = paper({
    id: "beta",
    title: "Calibration under Shift",
  });
  assert.deepEqual(
    matchLocalPapers(metadata, [beta, alpha], 1).map((match) => match.paper.id),
    ["alpha"],
  );
  assert.deepEqual(
    matchLocalPapers(metadata, [alpha, beta], Number.NaN),
    [],
  );
});

test("Nature extraction recognizes data-test, tracking label, and visible text markers", () => {
  const html = `
    <a data-test="peer-review-file" href="/articles/s41467-024-00001/peer-review">
      Download
    </a>
    <a data-track-label="Peer review file"
       href="//media.springernature.com/full/springer-static/image/art%3A10/file.pdf#page=1">
      Peer-review file
    </a>
    <a href="https://www.nature.com/articles/example/peer-review">
      Transparent peer review
    </a>
    <a href="/articles/unrelated">Supplementary information</a>`;

  assert.deepEqual(
    extractNaturePeerReviewLinks(
      html,
      "https://www.nature.com/articles/s41467-024-00001",
    ),
    [
      {
        url: "https://www.nature.com/articles/s41467-024-00001/peer-review",
        label: "Download",
      },
      {
        url: "https://media.springernature.com/full/springer-static/image/art%3A10/file.pdf",
        label: "Peer-review file",
      },
      {
        url: "https://www.nature.com/articles/example/peer-review",
        label: "Transparent peer review",
      },
    ],
  );
});

test("Nature extraction rejects unlabelled, insecure, credentialed, and lookalike-host links", () => {
  const html = `
    <a data-test="peer-review-file" href="http://www.nature.com/review.pdf">HTTP</a>
    <a data-test="peer-review-file" href="https://nature.com.evil.example/review.pdf">Lookalike</a>
    <a data-test="peer-review-file" href="https://user@nature.com/review.pdf">Credentials</a>
    <a data-test="peer-review-file" href="javascript:alert(1)">Script</a>
    <a href="https://www.nature.com/review.pdf">Unlabelled</a>`;
  assert.deepEqual(extractNaturePeerReviewLinks(html), []);
  assert.deepEqual(
    extractNaturePeerReviewLinks(
      `<a data-test="peer-review-file" href="/review.pdf">Review</a>`,
      "https://evil.example/article",
    ),
    [],
  );
});

test("safe candidate URLs require HTTPS public hosts and enforce allowlists", () => {
  assert.equal(
    safeCandidateUrl(
      "https://www.nature.com/article?x=1#section",
      ["nature.com"],
    ),
    "https://www.nature.com/article?x=1",
  );
  assert.equal(
    safeCandidateUrl("https://github.com/org/repo/blob/main/rebuttal.pdf", [
      "github.com",
    ]),
    "https://github.com/org/repo/blob/main/rebuttal.pdf",
  );

  for (const url of [
    "http://nature.com/review.pdf",
    "https://user:pass@nature.com/review.pdf",
    "https://localhost/review.pdf",
    "https://127.0.0.1/review.pdf",
    "https://169.254.169.254/latest/meta-data",
    "https://192.168.1.1/review.pdf",
    "https://[::1]/review.pdf",
    "https://nature.com.evil.example/review.pdf",
    "javascript:alert(1)",
  ]) {
    assert.equal(safeCandidateUrl(url, ["nature.com"]), null, url);
  }
});

test("GitHub path detection covers common rebuttal and response file names", () => {
  for (const path of [
    "rebuttal.pdf",
    "docs/final_rebuttal.tex",
    "supplementary/rebuttal/response.md",
    "author_response.md",
    "Author-Response-Final.PDF",
    "response_to_reviewers.pdf",
    "response-to-the-reviewer.tex",
    "review_response.txt",
    "official-response.html",
    "https://github.com/org/repo/blob/main/docs/response%20letter.pdf?raw=1",
  ]) {
    assert.equal(isGitHubRebuttalPath(path), true, path);
  }
});

test("GitHub path detection rejects unrelated and non-document assets", () => {
  for (const path of [
    "",
    "README.md",
    "review.pdf",
    "response.json",
    "api/response.ts",
    "supplementary/rebuttal/figure.png",
    ".github/ISSUE_TEMPLATE/rebuttal.yml",
    "https://github.com/org/repo/blob/main/results/reviewer_scores.csv",
    "%E0%A4%A",
  ]) {
    assert.equal(isGitHubRebuttalPath(path), false, path);
  }
});
