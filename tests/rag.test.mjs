import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvidenceExcerpt,
  compactVenue,
  normalizedTitleTokens,
  rankSimilarPapers,
  sanitizePublicEvidence,
} from "../lib/rag.ts";

function paper(overrides = {}) {
  const id = overrides.id ?? "paper";
  return {
    id,
    title: overrides.title ?? `Paper ${id}`,
    titleKind: overrides.titleKind ?? "paper_title",
    venue: overrides.venue ?? "ICLR 2026",
    year: overrides.year ?? 2026,
    decision: overrides.decision ?? "Accept",
    accepted: overrides.accepted ?? true,
    topics: overrides.topics ?? [],
    scoreBefore: [],
    scoreAfter: [],
    reviewCount: 1,
    rebuttalRanges: [],
    reviewRange: null,
    paperZip: null,
    source: {
      type: "openreview_api",
      label: "OpenReview",
      url: `https://openreview.net/forum?id=${id}`,
      originalUrl: `https://openreview.net/forum?id=${id}`,
      license: "CC BY 4.0",
      retrievedAt: "2026-07-31",
    },
    ...overrides,
  };
}

test("title normalization removes common academic noise and identifiers", () => {
  assert.deepEqual(
    normalizedTitleTokens(
      "A Robust, ROBUST Method for Transformer-Based Models",
    ),
    ["robust", "transformer"],
  );
  assert.deepEqual(
    normalizedTitleTokens("ICLR 2026 · s344pGE2JA", "identifier"),
    [],
  );
});

test("venue compaction matches decorated venues across years", () => {
  assert.equal(compactVenue("ICLR.cc/2025/Conference"), "ICLR");
  assert.equal(
    compactVenue("International Conference on Learning Representations 2026"),
    "ICLR",
  );
  assert.equal(compactVenue("NeurIPS 2024 Main Conference"), "NEURIPS");
  assert.equal(compactVenue("NIPS 2018"), "NEURIPS");
  assert.equal(compactVenue("AutoML 2023 Conference"), "AUTOML");
});

test("metadata retrieval is explainable, excludes the selected paper, and ranks strong evidence first", () => {
  const selected = paper({
    id: "selected",
    title: "Robust Transformers for Medical Image Classification",
    topics: ["Robustness", "Medical_Imaging"],
    venue: "ICLR.cc/2026/Conference",
    year: 2026,
  });
  const strongest = paper({
    id: "strongest",
    title: "Robust Transformer Classification for Medical Images",
    topics: ["robustness", "medical imaging"],
    venue: "ICLR 2025",
    year: 2025,
  });
  const sharedTopic = paper({
    id: "topic",
    title: "Auditing Distribution Shift",
    topics: ["ROBUSTNESS"],
    venue: "ICML 2024",
    year: 2024,
  });
  const venueOnly = paper({
    id: "venue",
    title: "Unrelated Optimization Questions",
    topics: ["optimization"],
    venue: "ICLR 2019 Conference",
    year: 2019,
  });
  const yearOnly = paper({
    id: "year-only",
    title: "Unrelated Graph Theory",
    topics: ["graphs"],
    venue: "AAAI 2026",
    year: 2026,
  });

  const results = rankSimilarPapers(
    selected,
    [yearOnly, venueOnly, selected, sharedTopic, strongest],
    10,
  );

  assert.deepEqual(
    results.map((result) => result.paper.id),
    ["strongest", "topic", "venue"],
  );
  assert.ok(results[0].score > results[1].score);
  assert.match(results[0].reasons.join(" "), /共同主题标签：/);
  assert.match(results[0].reasons.join(" "), /标题共同词：/);
  assert.match(results[0].reasons.join(" "), /同一会议或期刊：ICLR/);
  assert.match(results[0].reasons.join(" "), /年份接近：2025/);
  assert.doesNotMatch(
    results.flatMap((result) => result.reasons).join(" "),
    /semantic|语义/iu,
  );
});

test("ranking ties are deterministic and independent of input order", () => {
  const selected = paper({
    id: "selected",
    title: "Understanding Calibration",
    topics: ["calibration"],
  });
  const alpha = paper({
    id: "alpha",
    title: "Alpha Calibration",
    topics: ["calibration"],
    year: 2025,
  });
  const beta = paper({
    id: "beta",
    title: "Beta Calibration",
    topics: ["calibration"],
    year: 2025,
  });

  assert.deepEqual(
    rankSimilarPapers(selected, [beta, alpha], 2).map(
      (result) => result.paper.id,
    ),
    ["alpha", "beta"],
  );
  assert.deepEqual(
    rankSimilarPapers(selected, [alpha, beta], 2).map(
      (result) => result.paper.id,
    ),
    ["alpha", "beta"],
  );
  assert.deepEqual(rankSimilarPapers(selected, [alpha, beta], 0), []);
});

test("evidence excerpts contain only bounded, sanitized review-response text", () => {
  const detail = {
    ...paper({ id: "detail" }),
    authors: ["Private Author"],
    materialType: "conference_rebuttal",
    abstract: "Private abstract",
    metaReview: "Meta review must not be copied.",
    threads: [
      {
        id: "thread-1",
        label: "Reviewer One",
        initialScore: 3,
        finalScore: 7,
        initialScoreLabel: "3",
        finalScoreLabel: "7",
        messages: [
          {
            id: "review",
            role: "reviewer",
            kind: "review",
            title: "Concern",
            body:
              "<b>The evidence is incomplete.</b> Contact me@example.com or https://private.example/path. " +
              "x".repeat(500),
          },
          {
            id: "response",
            role: "author",
            kind: "author_response",
            title: "Response",
            body:
              "We added the requested experiment. [Artifact](https://example.com). " +
              "y".repeat(500),
          },
          {
            id: "followup",
            role: "reviewer",
            kind: "reviewer_followup",
            title: "Follow-up",
            body: "FOLLOWUP_SHOULD_NOT_APPEAR",
          },
          {
            id: "comment",
            role: "author",
            kind: "public_comment",
            title: "Comment",
            body: "COMMENT_SHOULD_NOT_APPEAR",
          },
        ],
      },
    ],
  };

  const excerpt = buildEvidenceExcerpt(detail, 260);

  assert.ok(Array.from(excerpt).length <= 260);
  assert.match(excerpt, /Review 1:/);
  assert.match(excerpt, /Author response 1:/);
  assert.match(excerpt, /\[email\]/);
  assert.match(excerpt, /\[link\]|Artifact/);
  assert.doesNotMatch(excerpt, /<b>|example\.com|Private Author|Private abstract/);
  assert.doesNotMatch(
    excerpt,
    /Meta review|FOLLOWUP_SHOULD_NOT_APPEAR|COMMENT_SHOULD_NOT_APPEAR/,
  );
  assert.equal(buildEvidenceExcerpt(detail, 0), "");
  assert.deepEqual(
    rankSimilarPapers(paper({ id: "selected" }), [paper({ id: "other" })], NaN),
    [],
  );
});

test("public evidence sanitizer strips active markup and direct contact data", () => {
  const sanitized = sanitizePublicEvidence(
    "<script>alert(1)</script><p>Email a@b.com and visit www.example.org.</p>",
  );
  assert.equal(sanitized, "Email [email] and visit [link]");
});
