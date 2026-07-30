import openReviewData from "@/data/openreview.generated.json";
import type { LibraryFile } from "@/lib/types";

const openReview = openReviewData as LibraryFile;

export const openReviewGeneratedAt = openReview.meta.generatedAt;
