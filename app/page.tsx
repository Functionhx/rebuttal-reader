import { openReviewGeneratedAt } from "@/lib/library";
import { ReaderApp } from "./reader-app";

export default function Home() {
  return (
    <ReaderApp
      seedPapers={[]}
      seedGeneratedAt={openReviewGeneratedAt}
    />
  );
}
