import { mkdir, readFile, writeFile } from "node:fs/promises";

const DATASET = "MlouisBE/iclr-rebuttal-analysis";
const DATASET_URL = `https://huggingface.co/datasets/${DATASET}`;
const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const year = Number(flag("--year") ?? 2026);
if (!Number.isInteger(year) || year < 2023 || year > 2100) {
  throw new Error("Use --year with a supported four-digit ICLR year.");
}

const fileName = `ICLR.cc_${year}.json`;
const sourcePath = `data/raw/${fileName}`;
const sourceUrl = `${DATASET_URL}/resolve/main/${sourcePath}?download=true`;
const outputUrl = new URL(
  "../public/data/iclr-archive/index.json",
  import.meta.url,
);
const chunkSize = Number(flag("--chunk-bytes") ?? 32 * 1024 * 1024);
const concurrency = Math.max(
  1,
  Math.min(4, Number(flag("--concurrency") ?? 3)),
);
const textDecoder = new TextDecoder();

function cleanText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function unwrap(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, "value")
  ) {
    return value.value;
  }
  return value;
}

function contentText(note, ...fields) {
  for (const field of fields) {
    const value = unwrap(note?.content?.[field]);
    if (value !== undefined && value !== null && cleanText(value)) {
      return cleanText(value);
    }
  }
  return "";
}

function strings(value) {
  const unwrapped = unwrap(value);
  return Array.isArray(unwrapped)
    ? unwrapped.map(cleanText).filter(Boolean)
    : [];
}

function isPublic(note) {
  return (note?.readers ?? []).some(
    (reader) => cleanText(reader).toLowerCase() === "everyone",
  );
}

function invitationText(note) {
  return (note?.invitations ?? [note?.invitation].filter(Boolean)).join(" ");
}

function authorResponse(note) {
  const authorSigned = (note?.signatures ?? []).some((signature) =>
    /(?:^|\/)authors?(?:$|\/|_)/i.test(cleanText(signature)),
  );
  return (
    isPublic(note) &&
    authorSigned &&
    /author.response|official.comment|rebuttal|public.comment|comment/i.test(
      invitationText(note),
    )
  );
}

function officialReview(note) {
  const invitations = invitationText(note);
  return (
    isPublic(note) &&
    /official.review/i.test(invitations) &&
    !/meta.review|author.response/i.test(invitations)
  );
}

function numericScore(note) {
  const value = contentText(
    note,
    "rating",
    "recommendation",
    "overall_score",
    "score",
  );
  const match = value.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
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

const sizeResponse = await fetchWithRetry(sourceUrl, {
  headers: {
    Range: "bytes=0-0",
    "User-Agent": "rebuttal-reader/0.4 (manual public-data update)",
  },
});
const contentRange = sizeResponse.headers.get("content-range") ?? "";
await sizeResponse.body?.cancel();
const byteLength = Number(contentRange.match(/\/(\d+)$/)?.[1]);
if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
  throw new Error(`Unable to determine the byte length of ${fileName}.`);
}

async function fetchRange(start, end, attempt = 0) {
  try {
    const response = await fetchWithRetry(sourceUrl, {
      headers: {
        Range: `bytes=${start}-${end - 1}`,
        "User-Agent": "rebuttal-reader/0.4 (manual public-data update)",
      },
    });
    if (response.status !== 206) {
      throw new Error(
        `Expected a byte-range response for ${fileName}; received HTTP ${response.status}.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== end - start) {
      throw new Error(
        `Incomplete byte range for ${fileName}: expected ${
          end - start
        }, received ${bytes.byteLength}.`,
      );
    }
    return bytes;
  } catch (error) {
    if (attempt >= 8) throw error;
    await wait(Math.min(750 * 2 ** attempt, 15_000));
    return fetchRange(start, end, attempt + 1);
  }
}

await mkdir(new URL("../public/data/iclr-archive/", import.meta.url), {
  recursive: true,
});

let retrievedAt = new Date().toISOString();
let papers = [];
let parsedPapers = 0;
let scanStart = 0;

if (args.includes("--resume")) {
  try {
    const checkpoint = JSON.parse(await readFile(outputUrl, "utf8"));
    if (
      checkpoint.meta?.complete === false &&
      checkpoint.meta?.sourceByteLength === byteLength &&
      Number.isSafeInteger(checkpoint.meta?.scanOffset) &&
      checkpoint.meta.scanOffset > 0 &&
      Array.isArray(checkpoint.papers)
    ) {
      retrievedAt = checkpoint.meta.generatedAt;
      papers = checkpoint.papers;
      parsedPapers = Number(checkpoint.meta.scannedPapers) || 0;
      scanStart = checkpoint.meta.scanOffset;
      console.log(
        `Resuming at ${((scanStart / byteLength) * 100).toFixed(
          1,
        )}% with ${papers.length.toLocaleString()} indexed responses.`,
      );
    }
  } catch {
    console.log("No usable ICLR checkpoint was found; starting from byte 0.");
  }
}

let depth = scanStart > 0 ? 1 : 0;
let inString = false;
let escaped = false;
let objectStart = null;
let objectParts = [];
let lastCompleteOffset = scanStart;

function paperSummary(root, start, end) {
  if (!root?.id || !isPublic(root)) return null;
  const interactions = Array.isArray(root.interactions)
    ? root.interactions.filter(isPublic)
    : [];
  const responses = interactions.filter(authorResponse);
  if (!responses.length) return null;
  const reviews = interactions.filter(officialReview);
  const decisionNote = interactions.find((note) =>
    /decision/i.test(invitationText(note)),
  );
  const decision =
    contentText(decisionNote, "decision", "recommendation", "title") ||
    "Decision not recorded";
  const scores = reviews
    .map(numericScore)
    .filter((value) => value !== null);
  const title =
    contentText(root, "title") || `OpenReview paper ${cleanText(root.id)}`;

  return {
    id: cleanText(root.id),
    title,
    titleKind: "paper_title",
    venue: `ICLR ${year}`,
    year,
    decision,
    accepted:
      /accept|poster|spotlight|oral/i.test(decision) &&
      !/reject|withdraw|desk/i.test(decision),
    topics: strings(root.content?.keywords).slice(0, 6),
    scoreBefore: scores,
    scoreAfter: scores,
    reviewCount: reviews.length,
    rebuttalRanges: [],
    reviewRange: null,
    paperZip: null,
    reviewBench: null,
    openReviewArchive: null,
    iclrArchive: {
      dataset: DATASET,
      file: fileName,
      byteLength,
      start,
      end,
      year,
    },
    detailUrl: null,
    source: {
      type: "openreview_archive",
      label: `ICLR ${year} public OpenReview archive`,
      url: DATASET_URL,
      originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(
        root.id,
      )}`,
      license: String(root.license ?? "OpenReview public comments: CC BY 4.0"),
      retrievedAt,
    },
  };
}

function consumeObject(bytes, start, end) {
  const root = JSON.parse(textDecoder.decode(bytes));
  parsedPapers += 1;
  const summary = paperSummary(root, start, end);
  if (summary) papers.push(summary);
  lastCompleteOffset = end;
}

async function writeOutput(complete, scanOffset) {
  const sortedPapers = [...papers].sort(
    (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
  await writeFile(
    outputUrl,
    `${JSON.stringify({
      meta: {
        generatedAt: retrievedAt,
        source: `ICLR ${year} public OpenReview archive`,
        sourceUrl: DATASET_URL,
        license: "OpenReview public comments: CC BY 4.0",
        paperCount: sortedPapers.length,
        conversationCount: sortedPapers.reduce(
          (sum, paper) => sum + paper.reviewCount,
          0,
        ),
        detailStorage: "remote_json_range",
        scannedPapers: parsedPapers,
        sourceByteLength: byteLength,
        scanOffset,
        complete,
      },
      papers: sortedPapers,
    })}\n`,
  );
}

async function processChunk(chunkStart, chunkEnd, chunk) {
  let segmentStart = objectStart === null ? null : 0;

  for (let index = 0; index < chunk.byteLength; index += 1) {
    const byte = chunk[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte === 0x5c) {
        escaped = true;
      } else if (byte === 0x22) {
        inString = false;
      }
      continue;
    }

    if (byte === 0x22) {
      inString = true;
      continue;
    }

    if (byte === 0x7b) {
      if (depth === 1 && objectStart === null) {
        objectStart = chunkStart + index;
        segmentStart = index;
      }
      depth += 1;
      continue;
    }

    if (byte !== 0x7d) continue;
    if (depth === 2 && objectStart !== null && segmentStart !== null) {
      objectParts.push(chunk.slice(segmentStart, index + 1));
      const objectBytes =
        objectParts.length === 1
          ? objectParts[0]
          : Buffer.concat(objectParts.map((part) => Buffer.from(part)));
      consumeObject(objectBytes, objectStart, chunkStart + index + 1);
      objectStart = null;
      objectParts = [];
      segmentStart = null;
    }
    depth -= 1;
  }

  if (objectStart !== null && segmentStart !== null) {
    objectParts.push(chunk.slice(segmentStart));
  }

  console.log(
    `${((chunkEnd / byteLength) * 100).toFixed(1)}%: ${parsedPapers.toLocaleString()} papers parsed, ${papers.length.toLocaleString()} with public author responses`,
  );
  await writeOutput(false, lastCompleteOffset);
}

for (
  let batchStart = scanStart;
  batchStart < byteLength;
  batchStart += chunkSize * concurrency
) {
  const ranges = Array.from({ length: concurrency }, (_, index) => {
    const start = batchStart + index * chunkSize;
    const end = Math.min(byteLength, start + chunkSize);
    return start < byteLength ? { start, end } : null;
  }).filter(Boolean);
  const chunks = await Promise.all(
    ranges.map((range) => fetchRange(range.start, range.end)),
  );
  for (const [index, range] of ranges.entries()) {
    await processChunk(range.start, range.end, chunks[index]);
  }
}

if (objectStart !== null || depth !== 0 || inString) {
  throw new Error(`The ${fileName} JSON stream ended unexpectedly.`);
}

await writeOutput(true, byteLength);

console.log(
  `ICLR ${year} archive update complete: ${papers.length.toLocaleString()} public forums with author responses indexed from ${parsedPapers.toLocaleString()} papers.`,
);
