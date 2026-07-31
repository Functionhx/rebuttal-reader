import type { PaperIndexRecord, PaperRecord } from "@/lib/types";

/**
 * Metadata-only retrieval for the reader.
 *
 * This module deliberately does not call an embedding service or imply semantic
 * similarity. Every result is backed by a visible, deterministic metadata
 * signal that can be explained in the UI.
 */

export interface RankedPaper {
  paper: PaperIndexRecord;
  score: number;
  reasons: string[];
}

const TITLE_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "as",
  "at",
  "based",
  "be",
  "been",
  "being",
  "between",
  "by",
  "can",
  "does",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "learning",
  "method",
  "methods",
  "model",
  "models",
  "new",
  "of",
  "on",
  "or",
  "our",
  "paper",
  "study",
  "that",
  "the",
  "their",
  "these",
  "this",
  "through",
  "to",
  "toward",
  "towards",
  "using",
  "via",
  "we",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "without",
]);

const VENUE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bNEURAL INFORMATION PROCESSING SYSTEMS\b/u, "NEURIPS"],
  [/\bNIPS\b/u, "NEURIPS"],
  [/\bINTERNATIONAL CONFERENCE ON LEARNING REPRESENTATIONS\b/u, "ICLR"],
  [/\bINTERNATIONAL CONFERENCE ON MACHINE LEARNING\b/u, "ICML"],
  [/\bTRANSACTIONS ON MACHINE LEARNING RESEARCH\b/u, "TMLR"],
  [/\bASSOCIATION FOR COMPUTATIONAL LINGUISTICS\b/u, "ACL"],
  [/\bCOMPUTER VISION AND PATTERN RECOGNITION\b/u, "CVPR"],
];

const VENUE_NOISE = new Set([
  "CC",
  "CONFERENCE",
  "CONFERENCES",
  "JOURNAL",
  "MAIN",
  "MEETING",
  "PROCEEDINGS",
  "SYMPOSIUM",
  "TRACK",
  "WORKSHOP",
  "WORKSHOPS",
]);

const MAX_REASON_VALUES = 4;
const MAX_EVIDENCE_CHARACTERS = 16_000;
const MAX_EVIDENCE_MESSAGES = 12;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function truncateCharacters(value: string, cap: number): string {
  if (cap <= 0) return "";

  const characters = Array.from(value);
  if (characters.length <= cap) return value;
  if (cap === 1) return "…";
  return `${characters.slice(0, cap - 1).join("").trimEnd()}…`;
}

function normalizedWords(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{Mark}+/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{Letter}\p{Number}]+/gu) ?? []
  );
}

/**
 * Returns normalized, de-duplicated title tokens suitable for exact matching.
 * Synthetic identifier titles intentionally yield no tokens.
 */
export function normalizedTitleTokens(
  title: string,
  titleKind: PaperIndexRecord["titleKind"] = "paper_title",
): string[] {
  if (titleKind === "identifier") return [];

  return Array.from(
    new Set(
      normalizedWords(title).filter((token) => {
        if (token.length < 3 || token.length > 32) return false;
        if (TITLE_STOPWORDS.has(token)) return false;
        if (/^\p{Number}+$/u.test(token)) return false;

        // Long mixed alpha-numeric strings are usually forum IDs, not concepts.
        if (
          token.length >= 10 &&
          /\p{Letter}/u.test(token) &&
          /\p{Number}/u.test(token)
        ) {
          return false;
        }

        return true;
      }),
    ),
  ).sort(compareText);
}

function normalizedTopic(topic: string): string {
  return normalizedWords(topic).join(" ");
}

/**
 * Removes year/track decoration so venue identity can be compared across years.
 */
export function compactVenue(venue: string): string {
  const normalized = venue
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[_./-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleUpperCase("en-US");

  if (!normalized) return "";

  for (const [pattern, alias] of VENUE_ALIASES) {
    if (pattern.test(normalized)) return alias;
  }

  const words = normalized
    .split(" ")
    .filter(Boolean)
    .filter((word) => !/^(?:19|20)\d{2}$/u.test(word))
    .filter((word) => !VENUE_NOISE.has(word));

  return words.slice(0, 5).join(" ");
}

function sharedValues(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((value) => rightSet.has(value)))).sort(
    compareText,
  );
}

function displayList(values: readonly string[]): string {
  const visible = values.slice(0, MAX_REASON_VALUES);
  const hiddenCount = values.length - visible.length;
  return hiddenCount > 0
    ? `${visible.join("、")} 等 ${values.length} 项`
    : visible.join("、");
}

interface ScoredPaper extends RankedPaper {
  topicMatches: number;
  titleMatches: number;
  yearDistance: number;
  normalizedTitle: string;
}

interface RetrievalFeatures {
  topics: string[];
  titleTokens: string[];
  venue: string;
  year: number;
}

function retrievalFeatures(paper: PaperIndexRecord): RetrievalFeatures {
  return {
    topics: paper.topics.map(normalizedTopic).filter(Boolean),
    titleTokens: normalizedTitleTokens(paper.title, paper.titleKind),
    venue: compactVenue(paper.venue),
    year: paper.year,
  };
}

function scorePaper(
  selected: RetrievalFeatures,
  candidate: PaperIndexRecord,
): ScoredPaper | null {
  const candidateFeatures = retrievalFeatures(candidate);
  const topics = sharedValues(selected.topics, candidateFeatures.topics);
  const titleTokens = sharedValues(
    selected.titleTokens,
    candidateFeatures.titleTokens,
  );

  const sameVenue =
    selected.venue.length > 0 && selected.venue === candidateFeatures.venue;

  // Year is a reranking signal, not sufficient evidence on its own.
  if (topics.length === 0 && titleTokens.length === 0 && !sameVenue) return null;

  const yearDistance =
    Number.isFinite(selected.year) && Number.isFinite(candidateFeatures.year)
      ? Math.abs(selected.year - candidate.year)
      : Number.POSITIVE_INFINITY;

  const topicScore = Math.min(topics.length, 3) * 8;
  const titleScore = Math.min(titleTokens.length, 5) * 2;
  const venueScore = sameVenue ? 3 : 0;
  const yearScore =
    yearDistance === 0
      ? 2
      : yearDistance === 1
        ? 1.5
        : yearDistance === 2
          ? 1
          : yearDistance === 3
            ? 0.5
            : 0;

  const reasons: string[] = [];
  if (topics.length > 0) {
    reasons.push(`共同主题标签：${displayList(topics)}`);
  }
  if (titleTokens.length > 0) {
    reasons.push(`标题共同词：${displayList(titleTokens)}`);
  }
  if (sameVenue) {
    reasons.push(`同一会议或期刊：${selected.venue}`);
  }
  if (yearScore > 0) {
    reasons.push(
      yearDistance === 0
        ? `同一年份：${candidate.year}`
        : `年份接近：${candidate.year}（相差 ${yearDistance} 年）`,
    );
  }

  return {
    paper: candidate,
    score: topicScore + titleScore + venueScore + yearScore,
    reasons,
    topicMatches: topics.length,
    titleMatches: titleTokens.length,
    yearDistance,
    normalizedTitle: normalizedWords(candidate.title).join(" "),
  };
}

/**
 * Ranks related papers using only exact, inspectable metadata signals.
 *
 * The selected record is excluded by ID. Results with no shared topic, title
 * token, or venue are omitted; a nearby year only adjusts an already-supported
 * result. Ties are resolved without depending on input order.
 */
export function rankSimilarPapers(
  selected: PaperIndexRecord,
  allPapers: readonly PaperIndexRecord[],
  limit = 6,
): RankedPaper[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(50, Math.floor(limit)))
    : 0;
  if (safeLimit === 0) return [];

  const selectedFeatures = retrievalFeatures(selected);
  const ranked = allPapers
    .filter((paper) => paper.id !== selected.id)
    .map((paper) => scorePaper(selectedFeatures, paper))
    .filter((paper): paper is ScoredPaper => paper !== null)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.topicMatches !== left.topicMatches) {
        return right.topicMatches - left.topicMatches;
      }
      if (right.titleMatches !== left.titleMatches) {
        return right.titleMatches - left.titleMatches;
      }
      if (left.yearDistance !== right.yearDistance) {
        return left.yearDistance - right.yearDistance;
      }
      const titleOrder = compareText(
        left.normalizedTitle,
        right.normalizedTitle,
      );
      if (titleOrder !== 0) return titleOrder;
      return compareText(left.paper.id, right.paper.id);
    });

  // Multiple indexes can occasionally contain the same forum. Keep only the
  // highest-ranked deterministic occurrence.
  const seenIds = new Set<string>();
  const results: RankedPaper[] = [];

  for (const item of ranked) {
    if (seenIds.has(item.paper.id)) continue;
    seenIds.add(item.paper.id);
    results.push({
      paper: item.paper,
      score: item.score,
      reasons: item.reasons,
    });
    if (results.length === safeLimit) break;
  }

  return results;
}

/**
 * Removes transport markup and direct contact/link data before public review
 * text is placed in an AI prompt. It is a safety baseline, not a claim that
 * arbitrary private input has been anonymized.
 */
export function sanitizePublicEvidence(value: string): string {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/gu, "$1")
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[email]",
    )
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/giu, "[link]")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Builds a prompt-ready excerpt from public review and author-response text.
 * Reviewer follow-ups, public comments, author names, and meta-review fields
 * are intentionally excluded. The returned string never exceeds `characterCap`
 * Unicode characters.
 */
export function buildEvidenceExcerpt(
  paper: PaperRecord,
  characterCap = 6_000,
): string {
  if (!Number.isFinite(characterCap) || characterCap <= 0) return "";

  const cap = Math.min(
    MAX_EVIDENCE_CHARACTERS,
    Math.max(1, Math.floor(characterCap)),
  );
  const messages = paper.threads
    .flatMap((thread) => thread.messages)
    .filter(
      (message) =>
        message.kind === "review" || message.kind === "author_response",
    )
    .map((message) => ({
      kind: message.kind,
      text: sanitizePublicEvidence(message.body),
    }))
    .filter((message) => message.text.length > 0);

  if (messages.length === 0) return "";

  // Keep review/response pairs visible under smaller budgets instead of letting
  // one long review consume the entire excerpt.
  const targetCount = Math.min(
    messages.length,
    MAX_EVIDENCE_MESSAGES,
    Math.max(2, Math.floor(cap / 320)),
  );
  const selectedMessages = messages.slice(0, targetCount);
  let reviewNumber = 0;
  let responseNumber = 0;
  const labels = selectedMessages.map((message) => {
    if (message.kind === "review") {
      reviewNumber += 1;
      return `Review ${reviewNumber}`;
    }
    responseNumber += 1;
    return `Author response ${responseNumber}`;
  });
  const separatorCharacters = Math.max(0, selectedMessages.length - 1) * 2;
  const labelCharacters = labels.reduce(
    (sum, label) => sum + characterLength(label) + 1,
    0,
  );
  const bodyBudget = Math.max(
    0,
    cap - separatorCharacters - labelCharacters,
  );
  const baseBodyCap = Math.floor(bodyBudget / selectedMessages.length);
  let remainder = bodyBudget % selectedMessages.length;

  const blocks = selectedMessages.map((message, index) => {
    const messageCap = baseBodyCap + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const body = truncateCharacters(message.text, messageCap);
    return `${labels[index]}:\n${body}`;
  });

  return truncateCharacters(blocks.join("\n\n"), cap);
}
