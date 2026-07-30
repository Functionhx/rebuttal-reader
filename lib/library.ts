import openReviewData from "@/data/openreview.generated.json";
import type { LibraryFile, PaperRecord } from "@/lib/types";

const openReview = openReviewData as LibraryFile;

export const openReviewPapers: PaperRecord[] = [...openReview.papers].sort((a, b) => {
  if (a.year !== b.year) return b.year - a.year;
  return a.title.localeCompare(b.title);
});

export const openReviewGeneratedAt = openReview.meta.generatedAt;
