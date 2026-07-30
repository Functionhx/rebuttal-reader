import type {
  MessageKind,
  OpenReviewArchivePointer,
  PaperRecord,
  ReviewThread,
  ThreadMessage,
} from "@/lib/types";

export const runtime = "edge";

const DATASET = "Jasonpicky/openreview_raw";
const DATASET_URL = `https://huggingface.co/datasets/${DATASET}`;
const FILTER_URL = "https://datasets-server.huggingface.co/filter";
const PAPER_ID_PATTERN = /^[A-Za-z0-9_-]{3,100}$/;

interface DetailRequest {
  paperId?: unknown;
  pointer?: Partial<OpenReviewArchivePointer>;
}

interface ArchiveRow {
  forum_id?: unknown;
  forum_title?: unknown;
  forum_authors?: unknown;
  forum_abstract?: unknown;
  forum_keywords?: unknown;
  forum_pdf_url?: unknown;
  forum_url?: unknown;
  note_id?: unknown;
  note_type?: unknown;
  note_created?: unknown;
  note_replyto?: unknown;
  note_readers?: unknown;
  note_signatures?: unknown;
  venue?: unknown;
  year?: unknown;
  note_text?: unknown;
}

interface FilterResponse {
  rows?: Array<{ row?: ArchiveRow }>;
  num_rows_total?: number;
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map(cleanText).filter(Boolean) : [];
}

function publicRow(row: ArchiveRow) {
  return strings(row.note_readers).some(
    (reader) => reader.toLowerCase() === "everyone",
  );
}

function authorRow(row: ArchiveRow) {
  return strings(row.note_signatures).some((signature) =>
    /(?:^|\/)authors?(?:$|\/|_)/i.test(signature),
  );
}

function rowType(row: ArchiveRow) {
  return cleanText(row.note_type).toLowerCase();
}

function reviewRow(row: ArchiveRow) {
  const type = rowType(row);
  return (
    type.includes("review") &&
    !type.includes("meta") &&
    !type.includes("response") &&
    !type.includes("rebuttal")
  );
}

function metaReviewRow(row: ArchiveRow) {
  const type = rowType(row);
  return type.includes("meta") && type.includes("review");
}

function decisionRow(row: ArchiveRow) {
  return rowType(row).includes("decision");
}

function authorResponseRow(row: ArchiveRow) {
  return (
    authorRow(row) &&
    /comment|response|rebuttal|discussion|review/.test(rowType(row))
  );
}

function fieldValue(text: unknown, field: string) {
  const pattern = new RegExp(
    `(?:^|\\n)${field}:\\s*([^\\n]+)`,
    "i",
  );
  return cleanText(text).match(pattern)?.[1]?.trim() ?? "";
}

function numericScore(text: unknown) {
  const rating =
    fieldValue(text, "rating") ||
    fieldValue(text, "recommendation") ||
    fieldValue(text, "overall_score") ||
    fieldValue(text, "score");
  const match = rating.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function bodyAndTitle(row: ArchiveRow, fallback: string) {
  const text = cleanText(row.note_text);
  const title = fieldValue(text, "title") || fallback;
  return {
    title,
    body: text.replace(/^title:\s*[^\n]*\n?/i, "").trim(),
  };
}

function message(
  row: ArchiveRow,
  role: "reviewer" | "author",
  kind: MessageKind,
  fallback: string,
): ThreadMessage {
  const parsed = bodyAndTitle(row, fallback);
  return {
    id: cleanText(row.note_id),
    role,
    kind,
    title: parsed.title,
    body: parsed.body,
  };
}

function noteDate(row: ArchiveRow) {
  return Number(row.note_created) || 0;
}

function nearestReviewId(
  row: ArchiveRow,
  byId: Map<string, ArchiveRow>,
  reviewIds: Set<string>,
  rootId: string,
) {
  let current: ArchiveRow | undefined = row;
  const visited = new Set<string>();
  while (current) {
    const parent = cleanText(current.note_replyto);
    if (!parent || parent === rootId || visited.has(parent)) break;
    if (reviewIds.has(parent)) return parent;
    visited.add(parent);
    current = byId.get(parent);
  }
  return null;
}

function venueLabel(venueId: string, year: number) {
  const known: Array<[RegExp, string]> = [
    [/ICLR\.cc/i, "ICLR"],
    [/NeurIPS\.cc/i, "NeurIPS"],
    [/ICML\.cc/i, "ICML"],
    [/COLM/i, "COLM"],
    [/CoRL/i, "CoRL"],
    [/TMLR/i, "TMLR"],
  ].find(([pattern]) => pattern.test(venueId));
  if (!known) return venueId || `OpenReview ${year || ""}`.trim();
  return known[1] === "TMLR"
    ? known[1]
    : `${known[1]} ${year || ""}`.trim();
}

function normalize(rows: ArchiveRow[], paperId: string): PaperRecord {
  const publicRows = rows.filter(publicRow);
  if (!publicRows.length) {
    throw new Error("This forum has no publicly readable notes.");
  }

  const first = publicRows[0];
  const byId = new Map(
    publicRows.map((row) => [cleanText(row.note_id), row]),
  );
  const reviews = publicRows.filter(reviewRow);
  const reviewIds = new Set(reviews.map((row) => cleanText(row.note_id)));
  const assigned = new Set<string>();

  const threads: ReviewThread[] = reviews.map((review, index) => {
    const reviewId = cleanText(review.note_id);
    const descendants = publicRows
      .filter(
        (row) =>
          cleanText(row.note_id) !== reviewId &&
          nearestReviewId(row, byId, reviewIds, paperId) === reviewId,
      )
      .filter((row) => !metaReviewRow(row) && !decisionRow(row))
      .sort((a, b) => noteDate(a) - noteDate(b));
    const messages: ThreadMessage[] = [
      message(review, "reviewer", "review", "Official review"),
      ...descendants.map((row) => {
        const author = authorResponseRow(row);
        return message(
          row,
          author ? "author" : "reviewer",
          author ? "author_response" : "reviewer_followup",
          author ? "Author response" : "Reviewer follow-up",
        );
      }),
    ].filter((item) => item.body);
    for (const item of messages) assigned.add(item.id);
    const scoreRows = [review, ...descendants].filter(
      (row) => numericScore(row.note_text) !== null,
    );
    const lastScore = scoreRows.at(-1);

    return {
      id: reviewId,
      label: `Reviewer ${String.fromCharCode(65 + (index % 26))}`,
      initialScore: numericScore(review.note_text),
      finalScore: lastScore ? numericScore(lastScore.note_text) : null,
      initialScoreLabel:
        fieldValue(review.note_text, "rating") ||
        fieldValue(review.note_text, "recommendation") ||
        null,
      finalScoreLabel: lastScore
        ? fieldValue(lastScore.note_text, "rating") ||
          fieldValue(lastScore.note_text, "recommendation") ||
          null
        : null,
      messages,
    };
  });

  const generalResponses = publicRows
    .filter((row) => !assigned.has(cleanText(row.note_id)))
    .filter(authorResponseRow)
    .filter((row) => !metaReviewRow(row) && !decisionRow(row))
    .sort((a, b) => noteDate(a) - noteDate(b));
  if (generalResponses.length) {
    threads.push({
      id: `${paperId}-general-response`,
      label: "全体 Reviewer",
      initialScore: null,
      finalScore: null,
      initialScoreLabel: null,
      finalScoreLabel: null,
      messages: generalResponses
        .map((row) =>
          message(
            row,
            "author",
            "author_response",
            "General author response",
          ),
        )
        .filter((item) => item.body),
    });
  }

  if (
    !threads.some((thread) =>
      thread.messages.some(
        (item) => item.kind === "author_response" && item.body,
      ),
    )
  ) {
    throw new Error("This public forum does not contain an author response.");
  }

  const meta = publicRows.find(metaReviewRow);
  const decisionNote = publicRows.find(decisionRow);
  const decision =
    fieldValue(decisionNote?.note_text, "decision") ||
    fieldValue(decisionNote?.note_text, "recommendation") ||
    (decisionNote ? cleanText(decisionNote.note_text) : "") ||
    "Decision not recorded";
  const year = Number(first.year) || 0;
  const venueId = cleanText(first.venue);
  const hasExplicitResponse = publicRows.some((row) =>
    /author.?response|rebuttal|response.?to.?review/i.test(rowType(row)),
  );
  const initialScores = threads
    .map((thread) => thread.initialScore)
    .filter((value): value is number => value !== null);
  const finalScores = threads
    .map((thread) => thread.finalScore)
    .filter((value): value is number => value !== null);

  return {
    id: paperId,
    title: cleanText(first.forum_title) || `OpenReview paper ${paperId}`,
    titleKind: "paper_title",
    authors: strings(first.forum_authors),
    venue: venueLabel(venueId, year),
    year,
    materialType: /TMLR/i.test(venueId)
      ? "response_to_reviewers"
      : hasExplicitResponse
        ? "conference_rebuttal"
        : "public_discussion",
    decision,
    accepted:
      /accept|poster|spotlight|oral|published/i.test(decision) &&
      !/reject|withdraw|desk/i.test(decision),
    abstract: cleanText(first.forum_abstract),
    topics: strings(first.forum_keywords).slice(0, 6),
    scoreBefore: initialScores,
    scoreAfter: finalScores,
    metaReview: meta ? cleanText(meta.note_text) : null,
    threads,
    source: {
      type: "openreview_archive",
      label: "OpenReview Raw public archive",
      url: DATASET_URL,
      originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(
        paperId,
      )}`,
      license: "OpenReview public comments: CC BY 4.0",
      retrievedAt: new Date().toISOString(),
    },
  };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchPage(paperId: string, offset: number, attempt = 0) {
  const where = `"forum_id"='${paperId}'`;
  const url = new URL(FILTER_URL);
  url.searchParams.set("dataset", DATASET);
  url.searchParams.set("config", "default");
  url.searchParams.set("split", "train");
  url.searchParams.set("where", where);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", "100");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "rebuttal-reader/0.4",
      },
      cache: "force-cache",
    });
    if (
      (response.status === 408 ||
        response.status === 429 ||
        response.status >= 500) &&
      attempt < 4
    ) {
      await response.body?.cancel();
      await wait(400 * 2 ** attempt);
      return fetchPage(paperId, offset, attempt + 1);
    }
    if (!response.ok) {
      throw new Error(`Public archive returned HTTP ${response.status}.`);
    }
    return (await response.json()) as FilterResponse;
  } catch (error) {
    if (attempt >= 4) throw error;
    await wait(400 * 2 ** attempt);
    return fetchPage(paperId, offset, attempt + 1);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as DetailRequest;
    const paperId = cleanText(body.paperId);
    if (
      !PAPER_ID_PATTERN.test(paperId) ||
      body.pointer?.dataset !== DATASET
    ) {
      return Response.json(
        { error: "Invalid OpenReview archive pointer." },
        { status: 400 },
      );
    }

    const rows: ArchiveRow[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const page = await fetchPage(paperId, offset);
      const batch = (page.rows ?? [])
        .map((item) => item.row)
        .filter((row): row is ArchiveRow => Boolean(row));
      rows.push(...batch);
      total = Number(page.num_rows_total) || rows.length;
      if (!batch.length) break;
      offset += batch.length;
      if (offset > 2_000) {
        throw new Error("This forum exceeds the safe note limit.");
      }
    }

    if (!rows.length) {
      return Response.json(
        { error: "The public archive has no rows for this forum." },
        { status: 404 },
      );
    }

    return Response.json(
      { paper: normalize(rows, paperId) },
      {
        headers: {
          "Cache-Control":
            "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to read this public OpenReview forum.",
      },
      { status: 502 },
    );
  }
}
