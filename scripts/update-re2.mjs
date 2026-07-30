import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

const DATASET = "Daoze/ReviewRebuttal";
const DATASET_BASE = `https://huggingface.co/datasets/${DATASET}`;
const CACHE_DIR = new URL("../.cache/re2/", import.meta.url);
const PUBLIC_DIR = new URL("../public/data/re2/", import.meta.url);
const force = process.argv.includes("--refresh");
const DOWNLOAD_CHUNK_SIZE = 16 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 8;

const sourceFiles = [
  {
    kind: "review",
    split: "train",
    path: "REVIEWS_train.json",
  },
  {
    kind: "review",
    split: "test",
    path: "REVIEWS_test.json",
  },
  {
    kind: "rebuttal",
    split: "train",
    path: "REBUTTAL_train.json",
  },
  {
    kind: "rebuttal",
    split: "test",
    path: "REBUTTAL_test.json",
  },
];

const knownPaperTitles = {
  "tUMr0Iox8XW":
    "Efficient Computation of Deep Nonlinear Infinite-Width Neural Networks that Learn Features",
  "7QfLW-XZTl": "Energy-Inspired Molecular Conformation Optimization",
  HxzSxSxLOJZ: "ResNet After All: Neural ODEs and Their Numerical Solution",
  hLbeJ6jObDD: "Collaborative Pure Exploration in Kernel Bandit",
  "0eTTKOOOQkV":
    "HiCLIP: Contrastive Language-Image Pretraining with Hierarchy-aware Attention",
  "99RpBVpLiX": "Distilling Model Failures as Directions in Latent Space",
};

function cacheUrl(name) {
  return new URL(name, CACHE_DIR);
}

function sourceUrl(path) {
  return `${DATASET_BASE}/resolve/main/${path}?download=true`;
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function scoreList(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => {
      const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    })
    .filter((value) => value !== null);
}

function splitTitle(body) {
  const text = cleanText(body);
  const [firstLine, ...rest] = text.split("\n");
  if (/^title\s*:/i.test(firstLine)) {
    return {
      title: firstLine.replace(/^title\s*:\s*/i, "").trim(),
      body: rest.join("\n").trim(),
    };
  }
  return { title: "", body: text };
}

function usableReviewHeading(value) {
  const heading = cleanText(value)
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    heading.length < 8 ||
    heading.length > 220 ||
    /^(initial|official|paper)?\s*review|null|none$/i.test(heading)
  ) {
    return "";
  }
  return heading;
}

function yearFromVenue(venue) {
  const match = String(venue ?? "").match(/(?:19|20)\d{2}/);
  return match ? Number(match[0]) : 0;
}

function compactVenue(venue) {
  return String(venue ?? "OpenReview")
    .replace(/\s+Conference$/i, "")
    .trim();
}

function addTopicSignals(topicCounts, text) {
  const rules = [
    ["实验与证据", /experiment|result|table|figure|ablation|evaluation/i],
    ["概念澄清", /clarif|misunder|specifically|definition|in fact/i],
    ["理论与证明", /proof|theorem|lemma|bound|complexity|convergence/i],
    ["数据与评测", /dataset|data split|benchmark|metric|sample size/i],
    ["基线与公平性", /baseline|fair comparison|comparison|competitor/i],
    ["创新性", /novel|novelty|contribution|original/i],
    ["表达与写作", /writing|readability|presentation|typo|reorganize/i],
    ["局限性", /limitation|failure case|weakness|scope/i],
  ];
  for (const [label, pattern] of rules) {
    if (pattern.test(text)) {
      topicCounts.set(label, (topicCounts.get(label) ?? 0) + 1);
    }
  }
}

async function fetchManifest() {
  const response = await fetch(
    `https://huggingface.co/api/datasets/${DATASET}/tree/main?recursive=true&expand=false`,
  );
  if (!response.ok) {
    throw new Error(`Unable to read dataset manifest (${response.status}).`);
  }
  return new Map(
    (await response.json()).map((item) => [item.path, Number(item.size)]),
  );
}

async function hasCompleteJsonFile(target, expectedSize) {
  try {
    const info = await stat(target);
    if (info.size !== expectedSize) return false;
    const handle = await open(target, "r");
    const first = Buffer.alloc(1);
    const last = Buffer.alloc(1);
    await handle.read(first, 0, 1, 0);
    await handle.read(last, 0, 1, expectedSize - 1);
    await handle.close();
    return first[0] === 0x5b && last[0] === 0x5d;
  } catch {
    return false;
  }
}

async function fetchRange(url, start, end, attempt = 0) {
  try {
    const response = await fetch(url, {
      headers: {
        Range: `bytes=${start}-${end}`,
        "User-Agent": "rebuttal-reader/0.2 (manual full dataset update)",
      },
      redirect: "follow",
    });
    if (response.status !== 206) {
      throw new Error(`HTTP ${response.status}, expected 206`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const expected = end - start + 1;
    if (buffer.length !== expected) {
      throw new Error(`received ${buffer.length} bytes, expected ${expected}`);
    }
    return buffer;
  } catch (error) {
    if (attempt >= 7) throw error;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(750 * 2 ** attempt, 12_000)),
    );
    return fetchRange(url, start, end, attempt + 1);
  }
}

async function downloadFileInRanges(url, target, expectedSize) {
  if (!force && (await hasCompleteJsonFile(target, expectedSize))) return;

  const progressUrl = new URL(`${target.pathname}.progress.json`, "file://");
  if (force) {
    await rm(target, { force: true });
    await rm(progressUrl, { force: true });
  }

  const chunkCount = Math.ceil(expectedSize / DOWNLOAD_CHUNK_SIZE);
  let completed = new Set();
  try {
    const progress = JSON.parse(await readFile(progressUrl, "utf8"));
    if (
      progress.expectedSize === expectedSize &&
      progress.chunkSize === DOWNLOAD_CHUNK_SIZE
    ) {
      completed = new Set(progress.completed);
    }
  } catch {
    completed = new Set();
  }

  let targetExists = false;
  try {
    targetExists = (await stat(target)).size === expectedSize;
  } catch {
    targetExists = false;
  }
  if (!targetExists || completed.size === 0) {
    const createHandle = await open(target, "w+");
    await createHandle.truncate(expectedSize);
    await createHandle.close();
    completed.clear();
  }

  const handle = await open(target, "r+");
  const queue = Array.from({ length: chunkCount }, (_, index) => index).filter(
    (index) => !completed.has(index),
  );
  let cursor = 0;
  let lastReported = -1;
  let saveQueue = Promise.resolve();

  const saveProgress = () => {
    const snapshot = {
      expectedSize,
      chunkSize: DOWNLOAD_CHUNK_SIZE,
      completed: Array.from(completed).sort((a, b) => a - b),
    };
    const temp = new URL(`${progressUrl.pathname}.tmp`, "file://");
    saveQueue = saveQueue.then(async () => {
      await writeFile(temp, JSON.stringify(snapshot));
      await rename(temp, progressUrl);
    });
    return saveQueue;
  };

  const worker = async () => {
    while (cursor < queue.length) {
      const index = queue[cursor++];
      const start = index * DOWNLOAD_CHUNK_SIZE;
      const end = Math.min(start + DOWNLOAD_CHUNK_SIZE, expectedSize) - 1;
      const bytes = await fetchRange(url, start, end);
      await handle.write(bytes, 0, bytes.length, start);
      completed.add(index);
      await saveProgress();

      const percent = Math.floor((completed.size / chunkCount) * 100);
      if (percent >= lastReported + 10 || percent === 100) {
        lastReported = percent;
        console.log(`  ${target.pathname.split("/").at(-1)}: ${percent}%`);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(DOWNLOAD_CONCURRENCY, queue.length) },
      worker,
    ),
  );
  await saveQueue;
  await handle.sync();
  await handle.close();
  await rm(progressUrl, { force: true });

  if (!(await hasCompleteJsonFile(target, expectedSize))) {
    throw new Error(`Downloaded file failed validation: ${target.pathname}`);
  }
}

async function scanJsonArray(fileUrl, onObject) {
  let fileOffset = 0;
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let parts = [];
  let objectCount = 0;

  for await (const chunk of createReadStream(fileUrl, {
    highWaterMark: 1024 * 1024,
  })) {
    let partStart = depth > 0 ? 0 : -1;

    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];

      if (depth === 0) {
        if (byte === 0x7b) {
          objectStart = fileOffset + index;
          depth = 1;
          inString = false;
          escaped = false;
          partStart = index;
        }
        continue;
      }

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
      } else if (byte === 0x7b || byte === 0x5b) {
        depth += 1;
      } else if (byte === 0x7d || byte === 0x5d) {
        depth -= 1;
        if (depth === 0) {
          parts.push(Buffer.from(chunk.subarray(partStart, index + 1)));
          const bytes = Buffer.concat(parts);
          const objectEnd = fileOffset + index;
          onObject(JSON.parse(bytes.toString("utf8")), objectStart, objectEnd);
          objectCount += 1;
          parts = [];
          partStart = -1;
        }
      }
    }

    if (depth > 0 && partStart >= 0) {
      parts.push(Buffer.from(chunk.subarray(partStart)));
    }
    fileOffset += chunk.length;
  }

  if (depth !== 0) {
    throw new Error(`Unterminated JSON object in ${fileUrl.pathname}`);
  }
  return objectCount;
}

function readZip64Value(extra, cursor, width) {
  const value =
    width === 8
      ? Number(extra.readBigUInt64LE(cursor))
      : extra.readUInt32LE(cursor);
  return [value, cursor + width];
}

function parsePaperZipIndex(buffer) {
  const papers = new Map();
  let position = 0;

  while (
    position + 46 <= buffer.length &&
    buffer.readUInt32LE(position) === 0x02014b50
  ) {
    const compressionMethod = buffer.readUInt16LE(position + 10);
    let compressedSize = buffer.readUInt32LE(position + 20);
    let uncompressedSize = buffer.readUInt32LE(position + 24);
    const filenameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const diskStart = buffer.readUInt16LE(position + 34);
    let localOffset = buffer.readUInt32LE(position + 42);
    const filenameStart = position + 46;
    const extraStart = filenameStart + filenameLength;
    const filename = buffer
      .subarray(filenameStart, extraStart)
      .toString("utf8");
    const extra = buffer.subarray(extraStart, extraStart + extraLength);

    let extraPosition = 0;
    while (extraPosition + 4 <= extra.length) {
      const tag = extra.readUInt16LE(extraPosition);
      const size = extra.readUInt16LE(extraPosition + 2);
      if (tag === 0x0001) {
        let cursor = extraPosition + 4;
        if (uncompressedSize === 0xffffffff) {
          [uncompressedSize, cursor] = readZip64Value(extra, cursor, 8);
        }
        if (compressedSize === 0xffffffff) {
          [compressedSize, cursor] = readZip64Value(extra, cursor, 8);
        }
        if (localOffset === 0xffffffff) {
          [localOffset, cursor] = readZip64Value(extra, cursor, 8);
        }
        if (diskStart === 0xffff) {
          [, cursor] = readZip64Value(extra, cursor, 4);
        }
        break;
      }
      extraPosition += 4 + size;
    }

    const match = filename.match(
      /\/([^/]+)\/Initial_manuscript_md\/Initial_manuscript\.md$/,
    );
    if (match) {
      papers.set(match[1], {
        localOffset,
        compressedSize,
        uncompressedSize,
        compressionMethod,
      });
    }

    position += 46 + filenameLength + extraLength + commentLength;
  }

  return papers;
}

async function ensurePaperZipDirectory(zipSize) {
  const tailLength = Math.min(zipSize, 1024 * 1024);
  const tail = await fetchRange(
    sourceUrl("papers.zip"),
    zipSize - tailLength,
    zipSize - 1,
  );
  const signature = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
  const zip64Offset = tail.lastIndexOf(signature);
  if (zip64Offset < 0) {
    throw new Error("Unable to locate the ZIP64 central-directory record.");
  }

  const centralSize = Number(tail.readBigUInt64LE(zip64Offset + 40));
  const centralOffset = Number(tail.readBigUInt64LE(zip64Offset + 48));
  const target = cacheUrl("papers-central-directory.bin");

  let existing = null;
  try {
    existing = await stat(target);
  } catch {
    existing = null;
  }
  if (!force && existing && existing.size >= centralSize) {
    const handle = await open(target, "r");
    const signatureBuffer = Buffer.alloc(4);
    await handle.read(signatureBuffer, 0, 4, 0);
    await handle.close();
    if (signatureBuffer.readUInt32LE(0) === 0x02014b50) {
      return (await readFile(target)).subarray(0, centralSize);
    }
  }

  console.log("Downloading the paper metadata directory…");
  const central = await fetchRange(
    sourceUrl("papers.zip"),
    centralOffset,
    centralOffset + centralSize - 1,
  );
  await writeFile(target, central);
  return central;
}

await mkdir(CACHE_DIR, { recursive: true });
await mkdir(PUBLIC_DIR, { recursive: true });

console.log("Reading the Re² source manifest…");
const manifest = await fetchManifest();

for (const file of sourceFiles) {
  const expectedSize = manifest.get(file.path);
  if (!expectedSize) {
    throw new Error(`Dataset manifest does not contain ${file.path}.`);
  }
  console.log(`Checking ${file.path}…`);
  await downloadFileInRanges(
    sourceUrl(file.path),
    cacheUrl(file.path),
    expectedSize,
  );
}

const zipSize = manifest.get("papers.zip");
const paperZipDirectory = zipSize
  ? await ensurePaperZipDirectory(zipSize)
  : null;
const paperZipById = paperZipDirectory
  ? parsePaperZipIndex(paperZipDirectory)
  : new Map();

console.log("Indexing review metadata…");
const reviewByPaper = new Map();
for (const file of sourceFiles.filter((item) => item.kind === "review")) {
  const count = await scanJsonArray(cacheUrl(file.path), (record, start, end) => {
    reviewByPaper.set(record.paper_id, {
      range: { split: file.split, start, end },
      venue: record.conference_year_track,
      decision: cleanText(record.decision) || "Decision not recorded",
      scoreBefore: scoreList(record.review_initial_ratings_unified),
      scoreAfter: scoreList(record.review_final_ratings_unified),
      reviewHeading: usableReviewHeading(record.reviews?.[0]?.review_title),
    });
  });
  console.log(`  ${file.path}: ${count.toLocaleString()} papers`);
}

console.log("Indexing every rebuttal conversation…");
const rebuttalByPaper = new Map();
let conversationCount = 0;
for (const file of sourceFiles.filter((item) => item.kind === "rebuttal")) {
  const count = await scanJsonArray(cacheUrl(file.path), (record, start, end) => {
    conversationCount += 1;
    let paper = rebuttalByPaper.get(record.paper_id);
    if (!paper) {
      paper = {
        id: record.paper_id,
        venue: record.conference_year_track,
        ranges: [],
        reviewHeading: "",
        topicCounts: new Map(),
      };
      rebuttalByPaper.set(record.paper_id, paper);
    }
    paper.ranges.push({ split: file.split, start, end });

    const discussion = Array.isArray(record.messages)
      ? record.messages.slice(2)
      : [];
    const initialReview = discussion.find(
      (message) => message.role === "assistant",
    );
    if (!paper.reviewHeading && initialReview) {
      paper.reviewHeading = usableReviewHeading(
        splitTitle(initialReview.content).title,
      );
    }
    for (const message of discussion) {
      if (message.role === "user") {
        addTopicSignals(paper.topicCounts, String(message.content ?? ""));
      }
    }
  });
  console.log(`  ${file.path}: ${count.toLocaleString()} conversations`);
}

const generatedAt = new Date().toISOString();
const papers = Array.from(rebuttalByPaper.values())
  .map((paper) => {
    const review = reviewByPaper.get(paper.id);
    const venue = review?.venue || paper.venue || "OpenReview";
    const knownTitle = knownPaperTitles[paper.id];
    const reviewHeading = paper.reviewHeading || review?.reviewHeading;
    const title = knownTitle
      ? knownTitle
      : reviewHeading || `${compactVenue(venue)} · ${paper.id}`;
    const titleKind = knownTitle
      ? "paper_title"
      : reviewHeading
        ? "review_heading"
        : "identifier";
    const decision = review?.decision || "Decision not recorded";
    const topics = Array.from(paper.topicCounts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([label]) => label);

    return {
      id: paper.id,
      title,
      titleKind,
      venue,
      year: yearFromVenue(venue),
      decision,
      accepted: /accept|poster|spotlight|oral/i.test(decision),
      topics: topics.length ? topics : ["多轮讨论"],
      scoreBefore: review?.scoreBefore ?? [],
      scoreAfter: review?.scoreAfter ?? [],
      reviewCount: paper.ranges.length,
      rebuttalRanges: paper.ranges,
      reviewRange: review?.range ?? null,
      paperZip: paperZipById.get(paper.id) ?? null,
      source: {
        type: "derived_dataset",
        label: "ReviewRebuttal / Re²",
        url: "https://huggingface.co/datasets/Daoze/ReviewRebuttal",
        originalUrl: `https://openreview.net/forum?id=${paper.id}`,
        license: "Apache-2.0 dataset; original forum terms may vary",
        retrievedAt: generatedAt,
      },
    };
  })
  .sort(
    (a, b) =>
      b.year - a.year ||
      a.venue.localeCompare(b.venue) ||
      a.title.localeCompare(b.title),
  );

const index = {
  meta: {
    generatedAt,
    source: "ReviewRebuttal / Re²",
    sourceUrl: "https://huggingface.co/datasets/Daoze/ReviewRebuttal",
    license: "Apache-2.0",
    paperCount: papers.length,
    conversationCount,
  },
  papers,
};

await writeFile(
  new URL("index.json", PUBLIC_DIR),
  `${JSON.stringify(index)}\n`,
);
await writeFile(
  new URL("../data/re2.generated.json", import.meta.url),
  `${JSON.stringify(
    {
      meta: index.meta,
      papers: [],
      indexUrl: "/data/re2/index.json",
    },
    null,
    2,
  )}\n`,
);

console.log(
  `Full Re² index complete: ${papers.length.toLocaleString()} papers and ${conversationCount.toLocaleString()} rebuttal conversations.`,
);
