import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetReadObjects,
} from "hyparquet";

const DATASET = "Jasonpicky/openreview_raw";
const DATASET_URL = `https://huggingface.co/datasets/${DATASET}`;
const TREE_URL = `https://huggingface.co/api/datasets/${DATASET}/tree/main?recursive=true&expand=false`;
const OUTPUT_URL = new URL(
  "../public/data/openreview-archive/index.json",
  import.meta.url,
);
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const maxFiles = Number(flag("--max-files") ?? Number.POSITIVE_INFINITY);
const minYear = Number(flag("--min-year") ?? 0);

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function strings(value) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}

function isPublic(row) {
  return strings(row.note_readers).some(
    (reader) => reader.toLowerCase() === "everyone",
  );
}

function isReviewType(value) {
  const type = cleanText(value).toLowerCase();
  return (
    type.includes("review") &&
    !type.includes("meta") &&
    !type.includes("response") &&
    !type.includes("rebuttal")
  );
}

function isAuthorResponse(row) {
  const type = cleanText(row.note_type).toLowerCase();
  const authorSigned = strings(row.note_signatures).some((signature) =>
    /(?:^|\/)authors?(?:$|\/|_)/i.test(signature),
  );
  return (
    authorSigned &&
    cleanText(row.note_id) !== cleanText(row.forum_id) &&
    Boolean(cleanText(row.note_replyto)) &&
    /comment|response|rebuttal|discussion|review/.test(type)
  );
}

function venueLabel(venue, year) {
  const value = cleanText(venue);
  const known = [
    [/ICLR\.cc/i, "ICLR"],
    [/NeurIPS\.cc/i, "NeurIPS"],
    [/ICML\.cc/i, "ICML"],
    [/COLM/i, "COLM"],
    [/CoRL/i, "CoRL"],
    [/TMLR/i, "TMLR"],
  ].find(([pattern]) => pattern.test(value));
  if (known) {
    return known[1] === "TMLR"
      ? known[1]
      : `${known[1]} ${year || ""}`.trim();
  }
  return value || `OpenReview ${year || ""}`.trim();
}

function acceptedFromVenue(value) {
  const venue = cleanText(value);
  return (
    /accept|poster|spotlight|oral|published/i.test(venue) &&
    !/reject|withdraw|desk/i.test(venue)
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url, init, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, redirect: "follow" });
    if (
      (response.status === 408 ||
        response.status === 429 ||
        response.status >= 500) &&
      attempt < 8
    ) {
      await response.body?.cancel();
      await wait(Math.min(750 * 2 ** attempt, 15_000));
      return fetchWithRetry(url, init, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= 8) throw error;
    await wait(Math.min(750 * 2 ** attempt, 15_000));
    return fetchWithRetry(url, init, attempt + 1);
  }
}

async function writeShardedFiles(papers, meta) {
  const byYear = Map.groupBy(papers, (paper) =>
    paper.year > 0 ? String(paper.year) : "unknown",
  );
  const shards = [];
  await mkdir(
    new URL("../public/data/openreview-archive/by-year/", import.meta.url),
    { recursive: true },
  );
  for (const [year, yearPapers] of Array.from(byYear.entries()).sort(
    ([a], [b]) => b.localeCompare(a),
  )) {
    const conversationCount = yearPapers.reduce(
      (sum, paper) => sum + paper.reviewCount,
      0,
    );
    const url = `/data/openreview-archive/by-year/${year}.json`;
    await writeFile(
      new URL(
        `../public/data/openreview-archive/by-year/${year}.json`,
        import.meta.url,
      ),
      `${JSON.stringify({
        meta: {
          generatedAt: meta.generatedAt,
          source: `OpenReview Raw public archive (${year})`,
          sourceUrl: DATASET_URL,
          license: "OpenReview public comments: CC BY 4.0",
          paperCount: yearPapers.length,
          conversationCount,
          detailStorage: "remote_filter_query",
        },
        papers: yearPapers,
      })}\n`,
    );
    shards.push({
      url,
      paperCount: yearPapers.length,
      conversationCount,
    });
  }

  await writeFile(
    OUTPUT_URL,
    `${JSON.stringify({
      meta: {
        ...meta,
        paperCount: papers.length,
        conversationCount: papers.reduce(
          (sum, paper) => sum + paper.reviewCount,
          0,
        ),
        shards,
      },
      papers: [],
    })}\n`,
  );
}

if (args.includes("--shard-existing")) {
  const existing = JSON.parse(await readFile(OUTPUT_URL, "utf8"));
  if (!Array.isArray(existing.papers) || existing.papers.length === 0) {
    throw new Error("The existing archive index has no inline papers to shard.");
  }
  await writeShardedFiles(existing.papers, existing.meta);
  console.log(
    `Sharded ${existing.papers.length.toLocaleString()} existing OpenReview archive records by year.`,
  );
  process.exit(0);
}

const manifestResponse = await fetchWithRetry(TREE_URL, {
  headers: {
    Accept: "application/json",
    "User-Agent": "rebuttal-reader/0.4 (manual public-data update)",
  },
});
if (!manifestResponse.ok) {
  throw new Error(
    `Unable to read OpenReview archive manifest (${manifestResponse.status}).`,
  );
}

const manifest = await manifestResponse.json();
const files = manifest
  .filter(
    (item) =>
      item.type === "file" &&
      /^data\/train-\d{5}-of-\d{5}\.parquet$/.test(item.path),
  )
  .map((item) => ({
    path: item.path,
    filename: item.path.split("/").at(-1),
    size: Number(item.size),
  }))
  .sort((a, b) => a.path.localeCompare(b.path))
  .slice(0, maxFiles);

if (!files.length) {
  throw new Error("No OpenReview archive parquet files were found.");
}

await mkdir(new URL("../public/data/openreview-archive/", import.meta.url), {
  recursive: true,
});

const retrievedAt = new Date().toISOString();
const forums = new Map();
let scannedRows = 0;

function ensureForum(row) {
  const id = cleanText(row.forum_id);
  if (!id) return null;
  const year = Number(row.year) || 0;
  let forum = forums.get(id);
  if (!forum) {
    forum = {
      id,
      title: cleanText(row.forum_title) || `OpenReview paper ${id}`,
      authors: strings(row.forum_authors),
      abstract: cleanText(row.forum_abstract),
      topics: strings(row.forum_keywords).slice(0, 6),
      venueId: cleanText(row.venue),
      year,
      reviewCount: 0,
      responseCount: 0,
    };
    forums.set(id, forum);
  } else {
    if (!forum.title && row.forum_title) forum.title = cleanText(row.forum_title);
    if (!forum.venueId && row.venue) forum.venueId = cleanText(row.venue);
    if (!forum.year && year) forum.year = year;
  }
  return forum;
}

async function writeIndex(completedFiles) {
  const papers = Array.from(forums.values())
    .filter(
      (forum) => forum.responseCount > 0 && forum.year >= minYear,
    )
    .map((forum) => {
      const venue = venueLabel(forum.venueId, forum.year);
      return {
        id: forum.id,
        title: forum.title,
        titleKind: "paper_title",
        venue,
        year: forum.year,
        decision: "公开讨论",
        accepted: acceptedFromVenue(forum.venueId),
        topics: forum.topics,
        scoreBefore: [],
        scoreAfter: [],
        reviewCount: Math.max(1, forum.reviewCount),
        rebuttalRanges: [],
        reviewRange: null,
        paperZip: null,
        reviewBench: null,
        openReviewArchive: {
          dataset: DATASET,
        },
        detailUrl: null,
        source: {
          type: "openreview_archive",
          label: "OpenReview Raw public archive",
          url: DATASET_URL,
          originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(
            forum.id,
          )}`,
          license: "OpenReview public comments: CC BY 4.0",
          retrievedAt,
        },
      };
    })
    .sort(
      (a, b) =>
        b.year - a.year ||
        a.venue.localeCompare(b.venue) ||
        a.title.localeCompare(b.title),
    );

  await writeShardedFiles(papers, {
    generatedAt: retrievedAt,
    source: "OpenReview Raw public archive",
    sourceUrl: DATASET_URL,
    license: "OpenReview public comments: CC BY 4.0",
    detailStorage: "remote_filter_query",
    scannedRows,
    completedFiles,
    totalFiles: files.length,
  });
}

for (const [fileIndex, source] of files.entries()) {
  const url = `${DATASET_URL}/resolve/main/${source.path}?download=true`;
  const file = await asyncBufferFromUrl({
    url,
    byteLength: source.size,
    requestInit: {
      headers: {
        "User-Agent": "rebuttal-reader/0.4 (manual public-data update)",
      },
    },
    fetch: fetchWithRetry,
  });
  const metadata = await parquetMetadataAsync(file);
  let rowStart = 0;

  for (
    let groupIndex = 0;
    groupIndex < metadata.row_groups.length;
    groupIndex += 1
  ) {
    const rowCount = Number(metadata.row_groups[groupIndex].num_rows);
    const rowEnd = rowStart + rowCount;
    const rows = await parquetReadObjects({
      file,
      metadata,
      columns: [
        "forum_id",
        "forum_title",
        "forum_authors",
        "forum_abstract",
        "forum_keywords",
        "note_id",
        "note_type",
        "note_replyto",
        "note_readers",
        "note_signatures",
        "venue",
        "year",
      ],
      rowStart,
      rowEnd,
    });

    for (const row of rows) {
      scannedRows += 1;
      const forum = ensureForum(row);
      if (!forum || !isPublic(row)) continue;
      if (isReviewType(row.note_type)) forum.reviewCount += 1;
      if (isAuthorResponse(row)) forum.responseCount += 1;
    }

    console.log(
      `[${fileIndex + 1}/${files.length}] ${source.filename} row group ${
        groupIndex + 1
      }/${metadata.row_groups.length}: ${forums.size.toLocaleString()} forums scanned`,
    );
    rowStart = rowEnd;
  }

  await writeIndex(fileIndex + 1);
}

const responseForumCount = Array.from(forums.values()).filter(
  (forum) => forum.responseCount > 0 && forum.year >= minYear,
).length;
console.log(
  `OpenReview archive update complete: ${responseForumCount.toLocaleString()} public forums with author responses indexed from ${scannedRows.toLocaleString()} notes.`,
);
