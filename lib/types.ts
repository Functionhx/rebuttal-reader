export type MaterialType =
  | "conference_rebuttal"
  | "response_to_reviewers"
  | "public_discussion";

export type SourceType =
  | "derived_dataset"
  | "openreview_api"
  | "author_upload";

export type MessageKind =
  | "review"
  | "author_response"
  | "reviewer_followup"
  | "public_comment";

export interface ThreadMessage {
  id: string;
  role: "reviewer" | "author";
  kind: MessageKind;
  title: string;
  body: string;
}

export interface ReviewThread {
  id: string;
  label: string;
  initialScore: number | null;
  finalScore: number | null;
  initialScoreLabel: string | null;
  finalScoreLabel: string | null;
  messages: ThreadMessage[];
}

export interface PaperSource {
  type: SourceType;
  label: string;
  url: string;
  originalUrl: string;
  license: string;
  retrievedAt: string;
}

export interface PaperRecord {
  id: string;
  title: string;
  authors: string[];
  venue: string;
  year: number;
  materialType: MaterialType;
  decision: string;
  accepted: boolean;
  abstract: string;
  topics: string[];
  scoreBefore: number[];
  scoreAfter: number[];
  metaReview: string | null;
  threads: ReviewThread[];
  source: PaperSource;
}

export interface LibraryFile {
  meta: {
    generatedAt: string | null;
    source: string;
    sourceUrl: string;
    license: string;
    paperCount: number;
  };
  papers: PaperRecord[];
}
