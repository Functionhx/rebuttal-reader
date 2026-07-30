import { openReviewGeneratedAt, openReviewPapers } from "@/lib/library";
import { ReaderApp } from "./reader-app";

export default function Home() {
  return (
    <ReaderApp
      seedPapers={openReviewPapers}
      seedGeneratedAt={openReviewGeneratedAt}
    />
  );
}
