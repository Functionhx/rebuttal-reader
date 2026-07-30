import { libraryMeta, papers } from "@/lib/library";
import { ReaderApp } from "./reader-app";

export default function Home() {
  return <ReaderApp initialPapers={papers} libraryMeta={libraryMeta} />;
}
