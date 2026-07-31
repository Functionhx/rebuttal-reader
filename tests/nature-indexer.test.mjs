import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSearchQuery,
  fetchJsonWithRetry,
  fetchJournalIndex,
  MAX_SHARD_BYTES,
  normalizeSearchResult,
  parseArguments,
  resolveCoverage,
  splitPapersByByteBudget,
  writeNatureIndex,
} from "../scripts/update-nature.mjs";

const journal = {
  id: "nature-communications",
  name: "Nature Communications",
  europePmcJournal: "Nat Commun",
};

function response(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("Europe PMC query is bounded to open full-text candidates and supports incremental deposit dates", () => {
  const query = buildSearchQuery({
    journal,
    fromYear: 2023,
    toYear: 2026,
    fullTextCreatedFrom: "2026-06-01",
    fullTextCreatedTo: "2026-07-31",
  });
  assert.match(query, /JOURNAL:"Nat Commun"/);
  assert.match(query, /FIRST_PDATE:\[2023-01-01 TO 2026-12-31\]/);
  assert.match(query, /FT_CDATE:\[2026-06-01 TO 2026-07-31\]/);
  assert.match(query, /"Peer Review file"/);
  assert.doesNotMatch(query, /PUB_TYPE/);
  assert.match(query, /OPEN_ACCESS:Y/);
});

test("cursor pagination normalizes, de-duplicates, and stably sorts metadata without fetching PDFs", async () => {
  const requested = [];
  const pages = [
    {
      hitCount: 3,
      nextCursorMark: "page-2",
      resultList: {
        result: [
          {
            pmcid: "PMC10002",
            doi: "10.1038/s41467-025-2",
            title: "Later paper",
            authorString: "B Author",
            pubYear: "2025",
            firstPublicationDate: "2025-05-02",
          },
          {
            pmcid: "PMC10001",
            doi: "10.1038/s41467-025-1",
            title: "Earlier paper",
            authorString: "A Author",
            pubYear: "2025",
            firstPublicationDate: "2025-04-01",
          },
        ],
      },
    },
    {
      hitCount: 3,
      nextCursorMark: "page-2",
      resultList: {
        result: [
          {
            pmcid: "PMC10001",
            doi: "10.1038/s41467-025-1",
            title: "Earlier paper (updated)",
            authorString: "A Author",
            pubYear: "2025",
            firstPublicationDate: "2025-04-01",
          },
        ],
      },
    },
  ];
  const result = await fetchJournalIndex({
    journal,
    fromYear: 2023,
    toYear: 2026,
    retrievedAt: "2026-07-31T00:00:00.000Z",
    delayMs: 0,
    fetchJson: async (url) => {
      requested.push(url);
      return pages.shift();
    },
  });

  assert.equal(requested.length, 2);
  assert.equal(requested[0].searchParams.get("cursorMark"), "*");
  assert.equal(requested[1].searchParams.get("cursorMark"), "page-2");
  assert.equal(requested[0].searchParams.get("resultType"), "lite");
  assert.ok(requested.every((url) => url.pathname.endsWith("/search")));
  assert.deepEqual(
    result.papers.map((paper) => paper.id),
    ["nature:PMC10002", "nature:PMC10001"],
  );
  assert.equal(result.papers[1].title, "Earlier paper (updated)");
  assert.ok(
    result.papers.every(
      (paper) =>
        !JSON.stringify(paper).includes(".pdf") &&
        paper.source.type === "nature_peer_review",
    ),
  );
});

test("retryable Europe PMC errors honor retry and eventually return JSON", async () => {
  let calls = 0;
  const waits = [];
  const result = await fetchJsonWithRetry("https://example.test/search", {
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response(429, {}, { "Retry-After": "0" })
        : response(200, { hitCount: 7 });
    },
    sleep: async (milliseconds) => waits.push(milliseconds),
    timeoutMs: 1000,
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [0]);
  assert.equal(result.hitCount, 7);
});

test("normalization rejects unusable identifiers and keeps only compact metadata", () => {
  assert.equal(
    normalizeSearchResult(
      { pmcid: "../../etc/passwd", title: "Unsafe", pubYear: "2025" },
      journal,
      "2026-07-31T00:00:00.000Z",
    ),
    null,
  );
  const paper = normalizeSearchResult(
    {
      pmcid: "pmc12345",
      doi: "10.1038/s41467-025-123",
      title: "<i>Useful</i> &amp; public",
      authorString: "One A, Two B",
      firstPublicationDate: "2025-07-01",
      abstractText: "This deliberately must not be copied into the index.",
    },
    journal,
    "2026-07-31T00:00:00.000Z",
  );
  assert.equal(paper.title, "Useful & public");
  assert.equal(paper.nature.pmcid, "PMC12345");
  assert.equal(paper.nature.abstract, undefined);
  assert.equal(paper.reviewCount, 0);
  assert.equal(paper.source.originalUrl, "https://doi.org/10.1038/s41467-025-123");
});

test("writer creates a metadata-only manifest and bounded year shards", async (t) => {
  const outputDir = await mkdtemp(join(tmpdir(), "rebuttal-nature-index-"));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const retrievedAt = "2026-07-31T00:00:00.000Z";
  const papers = [
    normalizeSearchResult(
      {
        pmcid: "PMC20001",
        doi: "10.1038/s41467-025-1",
        title: "Paper 2025",
        pubYear: "2025",
        firstPublicationDate: "2025-03-01",
      },
      journal,
      retrievedAt,
    ),
    normalizeSearchResult(
      {
        pmcid: "PMC20002",
        doi: "10.1038/s41467-026-2",
        title: "Paper 2026",
        pubYear: "2026",
        firstPublicationDate: "2026-03-01",
      },
      journal,
      retrievedAt,
    ),
  ];
  await writeNatureIndex({
    outputDir,
    papers,
    generatedAt: retrievedAt,
    mode: "full",
    fromYear: 2023,
    toYear: 2026,
    allYears: false,
    journals: [journal],
    queries: [],
    hitCount: 2,
    overlapDays: 45,
  });

  const manifest = JSON.parse(
    await readFile(join(outputDir, "index.json"), "utf8"),
  );
  assert.equal(manifest.meta.paperCount, 2);
  assert.equal(manifest.meta.conversationCount, 0);
  assert.equal(manifest.papers.length, 0);
  assert.deepEqual(
    manifest.meta.shards.map((shard) => shard.url),
    [
      "/data/nature/by-year/2026-001.json",
      "/data/nature/by-year/2025-001.json",
    ],
  );
  const shard = JSON.parse(
    await readFile(join(outputDir, "by-year/2026-001.json"), "utf8"),
  );
  assert.equal(shard.papers[0].nature.pmcid, "PMC20002");
  assert.equal(shard.meta.conversationCount, 0);
  assert.equal(shard.meta.detailStorage, "metadata_only_remote_peer_review_file");
  assert.ok(!JSON.stringify(shard).includes("abstractText"));
});

test("byte-budget splitting preserves every record in stable chunks", () => {
  const papers = Array.from({ length: 11 }, (_, index) => ({
    id: `nature:PMC${10000 + index}`,
    title: `Paper ${String(index).padStart(2, "0")} ${"x".repeat(80)}`,
  }));
  const chunks = splitPapersByByteBudget(papers, 500);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat(), papers);
  assert.ok(
    chunks.every(
      (chunk) =>
        chunk.reduce(
          (bytes, paper) =>
            bytes + Buffer.byteLength(JSON.stringify(paper), "utf8") + 1,
          0,
        ) <= 500,
    ),
  );
});

test("CLI supports explicit full and incremental modes with validated bounds", () => {
  assert.deepEqual(parseArguments(["--full", "--from-year", "2024"], 2026), {
    requestedMode: "full",
    allYears: false,
    fromYear: 2024,
    toYear: 2026,
    pageSize: null,
    delayMs: null,
    journalIds: null,
  });
  assert.throws(
    () => parseArguments(["--full", "--incremental"], 2026),
    /cannot be used together/,
  );
  assert.throws(
    () => parseArguments(["--page-size", "1001"], 2026),
    /between 1 and 1000/,
  );
});

test("ordinary incremental updates inherit an existing all-years coverage", () => {
  const cli = parseArguments([], 2026);
  assert.deepEqual(
    resolveCoverage({
      cli,
      mode: "incremental",
      existingCoverage: { allYears: true, fromYear: null, toYear: 2026 },
      defaultFromYear: 2023,
    }),
    { allYears: true, fromYear: null },
  );
  assert.deepEqual(
    resolveCoverage({
      cli,
      mode: "incremental",
      existingCoverage: { allYears: false, fromYear: 2020, toYear: 2026 },
      defaultFromYear: 2023,
    }),
    { allYears: false, fromYear: 2020 },
  );
});

test("committed Nature catalog is complete, metadata-only, and uses bounded shards", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../public/data/nature/index.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(manifest.meta.paperCount > 60_000);
  assert.equal(manifest.meta.conversationCount, 0);
  assert.equal(manifest.meta.coverage.allYears, true);
  assert.ok(manifest.meta.coverage.journals.length >= 11);
  assert.equal(
    manifest.meta.shards.reduce(
      (sum, shard) => sum + shard.paperCount,
      0,
    ),
    manifest.meta.paperCount,
  );

  let actualPaperCount = 0;
  for (const shardPointer of manifest.meta.shards) {
    const path = new URL(`../public${shardPointer.url}`, import.meta.url);
    const fileStat = await stat(path);
    assert.ok(fileStat.size < MAX_SHARD_BYTES);
    assert.equal(fileStat.size, shardPointer.byteLength);
    const shard = JSON.parse(await readFile(path, "utf8"));
    assert.equal(shard.papers.length, shardPointer.paperCount);
    assert.equal(shard.meta.conversationCount, 0);
    assert.ok(shard.papers.every((paper) => paper.reviewCount === 0));
    assert.ok(
      shard.papers.every(
        (paper) =>
          paper.source.type === "nature_peer_review" &&
          !JSON.stringify(paper).includes(".pdf"),
      ),
    );
    actualPaperCount += shard.papers.length;
  }
  assert.equal(actualPaperCount, manifest.meta.paperCount);
});
