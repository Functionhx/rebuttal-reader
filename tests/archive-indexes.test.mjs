import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

async function json(relativePath) {
  return JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );
}

test("OpenReview public archive is complete and split into bounded indexes", async () => {
  const manifest = await json("public/data/openreview-archive/index.json");
  assert.equal(manifest.meta.completedFiles, manifest.meta.totalFiles);
  assert.ok(manifest.meta.paperCount > 30_000);
  assert.equal(manifest.papers.length, 0);
  assert.ok(manifest.meta.shards.length >= 8);
  assert.equal(
    manifest.meta.shards.reduce(
      (sum, shard) => sum + shard.paperCount,
      0,
    ),
    manifest.meta.paperCount,
  );

  for (const shard of manifest.meta.shards) {
    const path = `public${shard.url}`;
    const file = await json(path);
    const fileStat = await stat(new URL(`../${path}`, import.meta.url));
    assert.equal(file.papers.length, shard.paperCount);
    assert.ok(fileStat.size < 12 * 1024 * 1024);
    for (const paper of file.papers.slice(0, 25)) {
      assert.equal(
        paper.openReviewArchive.dataset,
        "Jasonpicky/openreview_raw",
      );
      assert.match(
        paper.source.originalUrl,
        /^https:\/\/openreview\.net\/forum\?id=/,
      );
    }
  }
});

test("ICLR 2026 index stores byte pointers rather than discussion bodies", async () => {
  const index = await json("public/data/iclr-archive/index.json");
  assert.equal(index.meta.complete, true);
  assert.ok(index.meta.paperCount > 5_000);
  assert.equal(index.papers.length, index.meta.paperCount);

  for (const paper of index.papers.slice(0, 250)) {
    const pointer = paper.iclrArchive;
    assert.equal(pointer.dataset, "MlouisBE/iclr-rebuttal-analysis");
    assert.equal(pointer.year, 2026);
    assert.ok(pointer.start >= 0);
    assert.ok(pointer.end > pointer.start);
    assert.ok(pointer.end <= pointer.byteLength);
    assert.ok(pointer.end - pointer.start < 16 * 1024 * 1024);
    assert.equal(paper.source.type, "openreview_archive");
  }
});

test("ReviewBench index keeps only remote parquet row pointers", async () => {
  const index = await json("public/data/reviewbench/index.json");
  assert.ok(index.meta.paperCount > 5_000);
  assert.equal(index.papers.length, index.meta.paperCount);

  for (const paper of index.papers.slice(0, 250)) {
    assert.ok(paper.reviewBench.row >= 0);
    assert.ok(paper.reviewBench.byteLength > 0);
    assert.match(paper.reviewBench.file, /\.parquet$/);
    assert.equal(paper.source.type, "openreview_archive");
  }
});
