import re2Data from "@/data/re2.generated.json";
import openReviewData from "@/data/openreview.generated.json";
import type { LibraryFile, PaperRecord } from "@/lib/types";

const re2 = re2Data as LibraryFile;
const openReview = openReviewData as LibraryFile;

const byId = new Map<string, PaperRecord>();

for (const paper of [...re2.papers, ...openReview.papers]) {
  byId.set(paper.id, paper);
}

export const papers = Array.from(byId.values()).sort((a, b) => {
  if (a.year !== b.year) return b.year - a.year;
  return a.title.localeCompare(b.title);
});

export const libraryMeta = {
  generatedAt:
    [re2.meta.generatedAt, openReview.meta.generatedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null,
  sourceCount: [re2, openReview].filter((source) => source.papers.length > 0)
    .length,
  paperCount: papers.length,
};
