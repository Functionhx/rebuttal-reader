import type { DatasetRange, PaperZipRange } from "@/lib/types";

export const runtime = "edge";

const DATASET_BASE =
  "https://huggingface.co/datasets/Daoze/ReviewRebuttal/resolve/main";

const DATASET_FILES = {
  "rebuttal:train": {
    path: "REBUTTAL_train.json",
    maxSize: 700_000_000,
  },
  "rebuttal:test": {
    path: "REBUTTAL_test.json",
    maxSize: 20_000_000,
  },
  "review:train": {
    path: "REVIEWS_train.json",
    maxSize: 400_000_000,
  },
  "review:test": {
    path: "REVIEWS_test.json",
    maxSize: 25_000_000,
  },
} as const;

const PAPERS_ZIP_URL = `${DATASET_BASE}/papers.zip?download=true`;
const MAX_OBJECT_BYTES = 8_000_000;
const MAX_RANGES = 32;
const MAX_TOTAL_BYTES = 24_000_000;

interface DetailRequest {
  paperId: string;
  rebuttalRanges: DatasetRange[];
  reviewRange: DatasetRange | null;
  paperZip: PaperZipRange | null;
}

function isSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function validateRange(
  range: DatasetRange,
  kind: "rebuttal" | "review",
): string | null {
  if (!range || (range.split !== "train" && range.split !== "test")) {
    return "Invalid dataset split.";
  }
  if (!isSafeInteger(range.start) || !isSafeInteger(range.end)) {
    return "Invalid byte range.";
  }
  const file = DATASET_FILES[`${kind}:${range.split}`];
  const length = range.end - range.start + 1;
  if (
    range.end < range.start ||
    range.end >= file.maxSize ||
    length > MAX_OBJECT_BYTES
  ) {
    return "Dataset byte range is outside the allowed bounds.";
  }
  return null;
}

async function fetchRange(url: string, start: number, end: number) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json, application/octet-stream",
      Range: `bytes=${start}-${end}`,
    },
    redirect: "follow",
  });

  if (response.status !== 206) {
    throw new Error(`Source returned HTTP ${response.status}, expected 206.`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchDatasetObject(
  kind: "rebuttal" | "review",
  range: DatasetRange,
) {
  const file = DATASET_FILES[`${kind}:${range.split}`];
  const bytes = await fetchRange(
    `${DATASET_BASE}/${file.path}?download=true`,
    range.start,
    range.end,
  );
  return JSON.parse(new TextDecoder().decode(bytes));
}

function parseMarkdownMetadata(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const titleIndex = lines.findIndex((line) => /^#\s+\S/.test(line.trim()));
  const title =
    titleIndex >= 0 ? lines[titleIndex].replace(/^#\s+/, "").trim() : null;
  const abstractPattern = /^(?:#{1,3}\s*)?(?:\*\*)?abstract(?:\*\*)?\s*:?\s*/i;
  const abstractIndex = lines.findIndex((line) =>
    abstractPattern.test(line.trim()),
  );

  const authorLines =
    titleIndex >= 0 && abstractIndex > titleIndex
      ? lines
          .slice(titleIndex + 1, abstractIndex)
          .map((line) => line.trim())
          .filter(Boolean)
          .filter(
            (line) =>
              !/@|university|institute|institution|laboratory|department|affiliation/i.test(
                line,
              ),
          )
          .slice(0, 3)
      : [];

  let abstract = "";
  if (abstractIndex >= 0) {
    const nextHeading = lines.findIndex(
      (line, index) => index > abstractIndex && /^##\s+\S/.test(line.trim()),
    );
    const firstLine = lines[abstractIndex]
      .trim()
      .replace(abstractPattern, "")
      .trim();
    abstract = [
      firstLine,
      ...lines.slice(
        abstractIndex + 1,
        nextHeading >= 0 ? nextHeading : undefined,
      ),
    ]
      .join("\n")
      .trim();
  }

  return {
    title,
    authorsText: authorLines.join(" ").replace(/\s+/g, " ").trim(),
    abstract,
  };
}

async function decompressDeflateRaw(bytes: Uint8Array) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(
      new DecompressionStream(
        "deflate-raw" as ConstructorParameters<typeof DecompressionStream>[0],
      ),
    );
  return new Response(stream).text();
}

async function fetchPaperMetadata(range: PaperZipRange | null) {
  if (!range) return null;
  if (
    !isSafeInteger(range.localOffset) ||
    !isSafeInteger(range.compressedSize) ||
    !isSafeInteger(range.uncompressedSize) ||
    !isSafeInteger(range.compressionMethod) ||
    range.localOffset >= 12_500_000_000 ||
    range.compressedSize <= 0 ||
    range.compressedSize > 2_000_000 ||
    range.uncompressedSize > 12_000_000
  ) {
    return null;
  }

  const requestEnd =
    range.localOffset + range.compressedSize + 4096 - 1;
  const archiveSlice = await fetchRange(
    PAPERS_ZIP_URL,
    range.localOffset,
    requestEnd,
  );
  const view = new DataView(
    archiveSlice.buffer,
    archiveSlice.byteOffset,
    archiveSlice.byteLength,
  );

  if (view.getUint32(0, true) !== 0x04034b50) {
    throw new Error("Paper archive entry has an invalid local header.");
  }

  const method = view.getUint16(8, true);
  const filenameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataStart = 30 + filenameLength + extraLength;
  const compressed = archiveSlice.slice(
    dataStart,
    dataStart + range.compressedSize,
  );

  let markdown: string;
  if (method === 0) {
    markdown = new TextDecoder().decode(compressed);
  } else if (method === 8) {
    markdown = await decompressDeflateRaw(compressed);
  } else {
    throw new Error(`Unsupported ZIP compression method ${method}.`);
  }

  return parseMarkdownMetadata(markdown);
}

export async function POST(request: Request) {
  let payload: DetailRequest;
  try {
    payload = (await request.json()) as DetailRequest;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (
    typeof payload.paperId !== "string" ||
    payload.paperId.length < 3 ||
    payload.paperId.length > 100 ||
    !Array.isArray(payload.rebuttalRanges) ||
    payload.rebuttalRanges.length === 0 ||
    payload.rebuttalRanges.length > MAX_RANGES
  ) {
    return Response.json({ error: "Invalid detail request." }, { status: 400 });
  }

  for (const range of payload.rebuttalRanges) {
    const error = validateRange(range, "rebuttal");
    if (error) return Response.json({ error }, { status: 400 });
  }
  const totalBytes = payload.rebuttalRanges.reduce(
    (sum, range) => sum + (range.end - range.start + 1),
    0,
  );
  if (totalBytes > MAX_TOTAL_BYTES) {
    return Response.json(
      { error: "Requested discussion is larger than the allowed response." },
      { status: 400 },
    );
  }
  if (payload.reviewRange) {
    const error = validateRange(payload.reviewRange, "review");
    if (error) return Response.json({ error }, { status: 400 });
  }

  try {
    const [rebuttals, review, paperMetadata] = await Promise.all([
      Promise.all(
        payload.rebuttalRanges.map((range) =>
          fetchDatasetObject("rebuttal", range),
        ),
      ),
      payload.reviewRange
        ? fetchDatasetObject("review", payload.reviewRange)
        : Promise.resolve(null),
      fetchPaperMetadata(payload.paperZip).catch(() => null),
    ]);

    if (
      rebuttals.some(
        (record) =>
          typeof record !== "object" || record?.paper_id !== payload.paperId,
      ) ||
      (review && review.paper_id !== payload.paperId)
    ) {
      return Response.json(
        { error: "Source records did not match the requested paper." },
        { status: 409 },
      );
    }

    return Response.json(
      { rebuttals, review, paperMetadata },
      {
        headers: {
          "Cache-Control": "public, max-age=86400, s-maxage=604800",
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to retrieve the source records.",
      },
      { status: 502 },
    );
  }
}
