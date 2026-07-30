import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const library = JSON.parse(
  await readFile(
    new URL("../public/data/re2/index.json", import.meta.url),
    "utf8",
  ),
);

test("full library keeps provenance and byte-range pointers", () => {
  assert.ok(library.meta.paperCount > 10_000);
  assert.ok(library.meta.conversationCount > 50_000);
  assert.equal(library.papers.length, library.meta.paperCount);

  for (const paper of library.papers.slice(0, 250)) {
    assert.equal(paper.source.type, "derived_dataset");
    assert.match(
      paper.source.originalUrl,
      /^https:\/\/openreview\.net\/forum\?id=/,
    );
    assert.ok(paper.reviewCount > 0);
    assert.equal(paper.rebuttalRanges.length, paper.reviewCount);
    for (const range of paper.rebuttalRanges) {
      assert.ok(range.start >= 0);
      assert.ok(range.end >= range.start);
    }
  }
});
