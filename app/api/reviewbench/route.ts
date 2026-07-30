import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";
import type {
  MaterialType,
  MessageKind,
  PaperRecord,
  ReviewBenchPointer,
  ReviewThread,
  ThreadMessage,
} from "@/lib/types";

export const runtime = "edge";

const DATASET_URL =
  "https://huggingface.co/datasets/Samarth0710/reviewbench";
const FILE_PATTERN =
  /^(neurips|iclr|icml|tmlr|emnlp|corl|colm)-\d{5}-of-\d{5}\.parquet$/;
const DETAIL_COLUMNS = [
  "forum_id",
  "conference",
  "year",
  "track",
  "venue_id",
  "title",
  "abstract",
  "authors",
  "keywords",
  "tldr",
  "primary_area",
  "venue",
  "decision",
  "decision_comment",
  "author_rebuttal",
  "num_reviews",
  "reviews_json",
];

interface DetailRequest {
  paperId?: unknown;
  pointer?: Partial<ReviewBenchPointer>;
}

interface ReviewBenchReview {
  review_id?: unknown;
  reviewer?: unknown;
  rating?: unknown;
  confidence?: unknown;
  rebuttal?: unknown;
  was_revised?: unknown;
  final_justification?: unknown;
  [key: string]: unknown;
}

interface ReviewBenchRow {
  forum_id?: unknown;
  conference?: unknown;
  year?: unknown;
  track?: unknown;
  venue_id?: unknown;
  title?: unknown;
  abstract?: unknown;
  authors?: unknown;
  keywords?: unknown;
  tldr?: unknown;
  primary_area?: unknown;
  venue?: unknown;
  decision?: unknown;
  decision_comment?: unknown;
  author_rebuttal?: unknown;
  num_reviews?: unknown;
  reviews_json?: unknown;
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function hasText(value: unknown) {
  const text = cleanText(value);
  return Boolean(text && !/^(?:null|none|n\/a)$/i.test(text));
}

function numericScore(value: unknown) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseReviews(value: unknown): ReviewBenchReview[] {
  if (Array.isArray(value)) return value as ReviewBenchReview[];
  if (!hasText(value)) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function addSection(
  sections: string[],
  seen: Set<string>,
  label: string,
  value: unknown,
) {
  const text = cleanText(value);
  if (!hasText(text) || seen.has(text)) return;
  seen.add(text);
  sections.push(`### ${label}\n${text}`);
}

function reviewBody(review: ReviewBenchReview) {
  const main =
    cleanText(review.review_text) ||
    cleanText(review.main_review) ||
    cleanText(review.comments);
  if (main) return main;

  const sections: string[] = [];
  const seen = new Set<string>();
  const fields: Array<[string, string]> = [
    ["Summary", "summary"],
    ["Summary", "summary_of_paper"],
    ["Summary", "summary_of_the_paper"],
    ["Summary", "summary_of_the_review"],
    ["Contributions", "paper_topic_and_main_contributions"],
    ["Strengths", "strengths"],
    ["Strengths", "reasons_to_accept"],
    ["Weaknesses", "weaknesses"],
    ["Weaknesses", "reasons_to_reject"],
    ["Strengths and weaknesses", "strengths_and_weaknesses"],
    ["Strengths and weaknesses", "strength_and_weaknesses"],
    ["Questions", "questions"],
    ["Questions", "questions_for_authors"],
    ["Questions", "questions_to_authors"],
    ["Questions", "questions_for_rebuttal"],
    ["Claims and evidence", "claims_and_evidence"],
    ["Methods and evaluation", "methods_and_evaluation_criteria"],
    ["Theoretical claims", "theoretical_claims"],
    ["Experimental design", "experimental_designs_or_analyses"],
    ["Relation to literature", "relation_to_broader_scientific_literature"],
    ["Limitations", "limitations"],
    ["Limitations", "limitations_and_societal_impact"],
    ["Other comments", "other_comments_or_suggestions"],
  ];

  for (const [label, field] of fields) {
    addSection(sections, seen, label, review[field]);
  }
  return sections.join("\n\n");
}

function conferenceLabel(value: unknown) {
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

function displayVenue(row: ReviewBenchRow) {
  const base = conferenceLabel(row.conference);
  if (base === "TMLR") return base;
  const track = cleanText(row.track);
  const suffix =
    track && !/^main$/i.test(track)
      ? ` ${track.replaceAll("_", " ")}`
      : "";
  return `${base} ${Number(row.year) || ""}${suffix}`.trim();
}

function message(
  id: string,
  role: "reviewer" | "author",
  kind: MessageKind,
  title: string,
  body: unknown,
): ThreadMessage {
  return {
    id,
    role,
    kind,
    title,
    body: cleanText(body),
  };
}

function normalizeRow(row: ReviewBenchRow, paperId: string): PaperRecord {
  const reviews = parseReviews(row.reviews_json);
  const threads: ReviewThread[] = reviews
    .map((review, index) => {
      const reviewId =
        cleanText(review.review_id) || `${paperId}-review-${index + 1}`;
      const body = reviewBody(review);
      const response = cleanText(review.rebuttal);
      const followup = cleanText(review.final_justification);
      const messages: ThreadMessage[] = [];

      if (body) {
        messages.push(
          message(
            reviewId,
            "reviewer",
            "review",
            "Official review",
            body,
          ),
        );
      }
      if (response) {
        messages.push(
          message(
            `${reviewId}-response`,
            "author",
            "author_response",
            "Author response",
            response,
          ),
        );
      }
      if (followup) {
        messages.push(
          message(
            `${reviewId}-followup`,
            "reviewer",
            "reviewer_followup",
            review.was_revised
              ? "Revised reviewer justification"
              : "Reviewer follow-up",
            followup,
          ),
        );
      }

      const currentScore = numericScore(review.rating);
      return {
        id: reviewId,
        label: `Reviewer ${String.fromCharCode(65 + (index % 26))}`,
        initialScore: null,
        finalScore: currentScore,
        initialScoreLabel: null,
        finalScoreLabel: hasText(review.rating)
          ? cleanText(review.rating)
          : null,
        messages,
      };
    })
    .filter((thread) => thread.messages.length > 0);

  const generalResponse = cleanText(row.author_rebuttal);
  if (generalResponse) {
    threads.push({
      id: `${paperId}-general-response`,
      label: "全体 Reviewer",
      initialScore: null,
      finalScore: null,
      initialScoreLabel: null,
      finalScoreLabel: null,
      messages: [
        message(
          `${paperId}-general-response-message`,
          "author",
          "author_response",
          "General author rebuttal",
          generalResponse,
        ),
      ],
    });
  }

  if (
    !threads.some((thread) =>
      thread.messages.some((item) => item.kind === "author_response"),
    )
  ) {
    throw new Error("This archive row does not contain an author response.");
  }

  const ratings = reviews
    .map((review) => numericScore(review.rating))
    .filter((value): value is number => value !== null);
  const authors = Array.isArray(row.authors)
    ? row.authors.map(cleanText).filter(Boolean)
    : [];
  const keywords = Array.isArray(row.keywords)
    ? row.keywords.map(cleanText).filter(Boolean)
    : [];
  const primaryArea = cleanText(row.primary_area);
  const topics = Array.from(
    new Set([primaryArea, ...keywords].filter(Boolean)),
  ).slice(0, 6);
  const decision = cleanText(row.decision) || "Decision not recorded";
  const conference = conferenceLabel(row.conference);
  const materialType: MaterialType =
    conference === "TMLR"
      ? "response_to_reviewers"
      : "conference_rebuttal";

  return {
    id: paperId,
    title: cleanText(row.title) || `OpenReview paper ${paperId}`,
    titleKind: "paper_title",
    authors,
    venue: displayVenue(row),
    year: Number(row.year) || 0,
    materialType,
    decision,
    accepted:
      /accept|poster|spotlight|oral|published/i.test(decision) &&
      !/reject|withdraw|desk/i.test(decision),
    abstract: cleanText(row.abstract),
    topics,
    scoreBefore: [],
    scoreAfter: ratings,
    metaReview: cleanText(row.decision_comment) || null,
    threads,
    source: {
      type: "openreview_archive",
      label: "ReviewBench / OpenReview public archive",
      url: DATASET_URL,
      originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(
        paperId,
      )}`,
      license: "CC BY 4.0; original note terms apply",
      retrievedAt: new Date().toISOString(),
    },
  };
}

function validPointer(
  value: DetailRequest["pointer"],
): value is ReviewBenchPointer {
  return Boolean(
    value &&
      typeof value.split === "string" &&
      typeof value.file === "string" &&
      value.file.startsWith(`${value.split}-`) &&
      FILE_PATTERN.test(value.file) &&
      typeof value.byteLength === "number" &&
      Number.isSafeInteger(value.byteLength) &&
      value.byteLength > 1_000 &&
      value.byteLength < 400_000_000 &&
      typeof value.row === "number" &&
      Number.isSafeInteger(value.row) &&
      value.row >= 0 &&
      value.row < 100_000,
  );
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
    !validPointer(payload.pointer)
  ) {
    return Response.json({ error: "Invalid detail request." }, { status: 400 });
  }

  const pointer = payload.pointer;
  const sourceUrl = `${DATASET_URL}/resolve/main/data/${pointer.file}?download=true`;

  try {
    const file = await asyncBufferFromUrl({
      url: sourceUrl,
      byteLength: pointer.byteLength,
    });
    const rows = (await parquetReadObjects({
      file,
      columns: DETAIL_COLUMNS,
      rowStart: pointer.row,
      rowEnd: pointer.row + 1,
    })) as ReviewBenchRow[];
    const row = rows[0];

    if (!row || cleanText(row.forum_id) !== payload.paperId) {
      return Response.json(
        { error: "Source row did not match the requested paper." },
        { status: 409 },
      );
    }

    return Response.json(
      { paper: normalizeRow(row, payload.paperId) },
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
            : "Unable to retrieve the archived OpenReview record.",
      },
      { status: 502 },
    );
  }
}
