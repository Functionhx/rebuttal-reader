import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const library = JSON.parse(
  await readFile(
    new URL("../data/re2.generated.json", import.meta.url),
    "utf8",
  ),
);

test("curated library keeps provenance and causal threads", () => {
  assert.equal(library.meta.paperCount, 6);
  assert.equal(library.papers.length, 6);

  for (const paper of library.papers) {
    assert.equal(paper.materialType, "conference_rebuttal");
    assert.equal(paper.source.type, "derived_dataset");
    assert.match(paper.source.originalUrl, /^https:\/\/openreview\.net\/forum\?id=/);
    assert.ok(paper.threads.length > 0);
    assert.ok(
      paper.threads.some((thread) =>
        thread.messages.some((message) => message.kind === "author_response"),
      ),
    );
  }
});
