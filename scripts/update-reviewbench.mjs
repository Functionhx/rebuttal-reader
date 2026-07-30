import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  asyncBufferFromUrl,
  parquetMetadataAsync,
  parquetReadObjects,
} from "hyparquet";

const DATASET = "Samarth0710/reviewbench";
const DATASET_URL = `https://huggingface.co/datasets/${DATASET}`;
const TREE_URL = `https://huggingface.co/api/datasets/${DATASET}/tree/main?recursive=true&expand=false`;
const OUTPUT_URL = new URL(
  "../public/data/reviewbench/index.json",
  import.meta.url,
);
const args = process.argv.slice(2);
const supportedSplits = new Set([
  "neurips",
  "iclr",
  "icml",
  "tmlr",
  "emnlp",
  "corl",
  "colm",
]);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const requestedSplits = new Set(
  (flag("--split") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
const minYear = Number(flag("--min-year") ?? 0);
const maxFiles = Number(flag("--max-files") ?? Number.POSITIVE_INFINITY);

for (const split of requestedSplits) {
  if (!supportedSplits.has(split)) {
    throw new Error(`Unsupported ReviewBench split: ${split}`);
  }
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function parseReviews(value) {
  if (Array.isArray(value)) return value;
  if (!cleanText(value)) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function score(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function hasText(value) {
  const text = cleanText(value);
  return Boolean(text && !/^(?:null|none|n\/a)$/i.test(text));
}

function conferenceLabel(value) {
  const key = cleanText(value).toLowerCase();
  return (
    {
      neurips: "NeurIPS",
      iclr: "ICLR",
      icml: "ICML",
      tmlr: "TMLR",
      emnlp: "EMNLP",
      corl: "CoRL",
      colm: "COLM",
    }[key] ?? cleanText(value)
  );
}

function displayVenue(row) {
  const base = conferenceLabel(row.conference);
  if (base === "TMLR") return base;
  const track = cleanText(row.track);
  const trackSuffix =
    track && !/^main$/i.test(track)
      ? ` ${track.replaceAll("_", " ")}`
      : "";
  return `${base} ${Number(row.year) || ""}${trackSuffix}`.trim();
}

function topics(row) {
  const values = Array.isArray(row.keywords)
    ? row.keywords.map(cleanText).filter(Boolean)
    : [];
  const primaryArea = cleanText(row.primary_area);
  if (primaryArea) values.unshift(primaryArea);
  return Array.from(new Set(values)).slice(0, 4);
}

function summaryFromRow(row, pointer, retrievedAt) {
  const reviews = parseReviews(row.reviews_json);
  const perReviewResponses = reviews.filter((review) =>
    hasText(review?.rebuttal),
  ).length;
  const generalResponse = hasText(row.author_rebuttal) ? 1 : 0;
  const responseCount = perReviewResponses + generalResponse;
  if (responseCount === 0) return null;

  const ratings = reviews
    .map((review) => score(review?.rating))
    .filter((value) => value !== null);
  const decision = cleanText(row.decision) || "Decision not recorded";
  const venue = displayVenue(row);
  const year = Number(row.year) || 0;

  return {
    responseCount,
    paper: {
      id: cleanText(row.forum_id),
      title: cleanText(row.title) || `OpenReview paper ${row.forum_id}`,
      titleKind: "paper_title",
      venue,
      year,
      decision,
      accepted:
        /accept|poster|spotlight|oral|published/i.test(decision) &&
        !/reject|withdraw|desk/i.test(decision),
      topics: topics(row),
      scoreBefore: [],
      scoreAfter: ratings,
      reviewCount: reviews.length,
      rebuttalRanges: [],
      reviewRange: null,
      paperZip: null,
      reviewBench: pointer,
      detailUrl: null,
      source: {
        type: "openreview_archive",
        label: "ReviewBench / OpenReview public archive",
        url: DATASET_URL,
        originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(
          row.forum_id,
        )}`,
        license: "CC BY 4.0; original note terms apply",
        retrievedAt,
      },
    },
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url, init, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, redirect: "follow" });
    if (
      (response.status === 429 || response.status >= 500) &&
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

const manifestResponse = await fetchWithRetry(TREE_URL, {
  headers: {
    Accept: "application/json",
    "User-Agent": "rebuttal-reader/0.3 (manual public-data update)",
  },
});
if (!manifestResponse.ok) {
  throw new Error(
    `Unable to read ReviewBench manifest (${manifestResponse.status}).`,
  );
}

const manifest = await manifestResponse.json();
const files = manifest
  .filter(
    (item) =>
      item.type === "file" &&
      /^data\/(neurips|iclr|icml|tmlr|emnlp|corl|colm)-\d{5}-of-\d{5}\.parquet$/.test(
        item.path,
      ),
  )
  .map((item) => {
    const filename = item.path.split("/").at(-1);
    const split = filename.split("-")[0];
    return {
      path: item.path,
      filename,
      split,
      size: Number(item.size),
    };
  })
  .filter(
    (item) =>
      requestedSplits.size === 0 || requestedSplits.has(item.split),
  )
  .sort((a, b) => a.path.localeCompare(b.path))
  .slice(0, maxFiles);

if (files.length === 0) {
  throw new Error("No ReviewBench parquet files matched the requested scope.");
}

await mkdir(new URL("../public/data/reviewbench/", import.meta.url), {
  recursive: true,
});

const retrievedAt = new Date().toISOString();
const byId = new Map();
let conversationCount = 0;
let scannedRows = 0;

if (args.includes("--merge-existing")) {
  try {
    const existing = JSON.parse(await readFile(OUTPUT_URL, "utf8"));
    for (const paper of existing.papers ?? []) {
      const responseCount = Math.max(1, Number(paper.reviewCount) || 0);
      byId.set(paper.id, { paper, responseCount });
      conversationCount += responseCount;
    }
    console.log(
      `Loaded ${byId.size.toLocaleString()} existing ReviewBench records before scanning.`,
    );
  } catch {
    console.log("No existing ReviewBench index was available to merge.");
  }
}

async function writeIndex(completedFiles) {
  const papers = Array.from(byId.values())
    .map((item) => item.paper)
    .sort(
      (a, b) =>
        b.year - a.year ||
        a.venue.localeCompare(b.venue) ||
        a.title.localeCompare(b.title),
    );

  await writeFile(
    OUTPUT_URL,
    `${JSON.stringify({
      meta: {
        generatedAt: retrievedAt,
        source: "ReviewBench / OpenReview public archive",
        sourceUrl: DATASET_URL,
        license: "CC BY 4.0",
        paperCount: papers.length,
        conversationCount,
        detailStorage: "remote_parquet_range",
        scannedRows,
        completedFiles,
        totalFiles: files.length,
      },
      papers,
    })}\n`,
  );
}

for (const [fileIndex, source] of files.entries()) {
  const url = `${DATASET_URL}/resolve/main/${source.path}?download=true`;
  const file = await asyncBufferFromUrl({
    url,
    byteLength: source.size,
    requestInit: {
      headers: {
        "User-Agent": "rebuttal-reader/0.3 (manual public-data update)",
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
        "conference",
        "year",
        "track",
        "venue_id",
        "title",
        "keywords",
        "primary_area",
        "venue",
        "decision",
        "author_rebuttal",
        "num_reviews",
        "reviews_json",
      ],
      rowStart,
      rowEnd,
    });

    for (const [offset, row] of rows.entries()) {
      scannedRows += 1;
      if ((Number(row.year) || 0) < minYear) continue;
      const id = cleanText(row.forum_id);
      if (!id) continue;
      const normalized = summaryFromRow(
        row,
        {
          split: source.split,
          file: source.filename,
          byteLength: source.size,
          row: rowStart + offset,
        },
        retrievedAt,
      );
      if (!normalized) continue;

      const previous = byId.get(id);
      if (!previous || normalized.responseCount > previous.responseCount) {
        if (previous) conversationCount -= previous.responseCount;
        byId.set(id, normalized);
        conversationCount += normalized.responseCount;
      }
    }

    console.log(
      `[${fileIndex + 1}/${files.length}] ${source.filename} row group ${
        groupIndex + 1
      }/${metadata.row_groups.length}: ${byId.size.toLocaleString()} rebuttal papers indexed`,
    );
    rowStart = rowEnd;
  }

  await writeIndex(fileIndex + 1);
}

await writeIndex(files.length);

console.log(
  `ReviewBench update complete: ${byId.size.toLocaleString()} papers with ${conversationCount.toLocaleString()} author-response threads indexed from ${scannedRows.toLocaleString()} public papers.`,
);
