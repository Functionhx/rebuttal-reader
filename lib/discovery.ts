import type { PaperIndexRecord } from "@/lib/types";

/**
 * Pure parsing and ranking helpers for rebuttal discovery.
 *
 * Nothing in this module performs a network request. In particular,
 * `parseArxivId` treats a user-supplied URL as data and never opens it.
 */

export interface ArxivIdentifier {
  /** Identifier including an optional version suffix. */
  id: string;
  /** Identifier without a version suffix. */
  baseId: string;
  version: number | null;
  canonicalArxivUrl: string;
}

export interface ArxivMetadata extends ArxivIdentifier {
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  primaryCategory: string | null;
  doi: string | null;
  journalRef: string | null;
  published: string | null;
  updated: string | null;
}

export interface LocalPaperMatch {
  paper: PaperIndexRecord;
  /** Deterministic ranking score; useful for ordering, not a probability. */
  score: number;
  /** Normalized value in the inclusive range 0–1. */
  titleSimilarity: number;
  reasons: string[];
}

export interface NaturePeerReviewLink {
  url: string;
  label: string;
}

export type DiscoveryCandidateSource =
  | "arxiv"
  | "local_index"
  | "nature"
  | "github";

export type DiscoveryCandidateKind =
  | "article"
  | "peer_review_file"
  | "rebuttal"
  | "author_response"
  | "response_to_reviewers";

export interface DiscoveryCandidate {
  source: DiscoveryCandidateSource;
  kind: DiscoveryCandidateKind;
  url: string;
  label: string;
  reason: string;
}

const ARXIV_URL_HOSTS = new Set([
  "arxiv.org",
  "www.arxiv.org",
  "export.arxiv.org",
]);

const NATURE_URL_HOSTS = [
  "nature.com",
  "media.springernature.com",
  "static-content.springer.com",
] as const;

const DOCUMENT_EXTENSIONS = new Set([
  "doc",
  "docx",
  "htm",
  "html",
  "markdown",
  "md",
  "pdf",
  "tex",
  "txt",
  "zip",
]);

const REBUTTAL_PATH_PHRASES = [
  /\brebuttal\b/u,
  /\bauthor(?:s)? response\b/u,
  /\bofficial response\b/u,
  /\breply to (?:the )?reviewers?\b/u,
  /\bresponse letter\b/u,
  /\bresponse to (?:the )?reviewers?\b/u,
  /\breview response\b/u,
  /\breviewer response\b/u,
] as const;

// Kept in step with the metadata-only title matching convention in lib/rag.ts:
// remove academic glue words before computing exact, explainable overlap.
const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "based",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "learning",
  "method",
  "methods",
  "model",
  "models",
  "of",
  "on",
  "or",
  "our",
  "paper",
  "study",
  "that",
  "the",
  "their",
  "this",
  "through",
  "to",
  "using",
  "via",
  "we",
  "with",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeArxivIdentifier(candidate: string): ArxivIdentifier | null {
  const trimmed = candidate.trim();
  const versionMatch = trimmed.match(/v([1-9]\d*)$/u);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  const baseId = versionMatch
    ? trimmed.slice(0, versionMatch.index)
    : trimmed;

  const modernMatch = baseId.match(/^(\d{2})(\d{2})\.(\d{4,5})$/u);
  if (modernMatch) {
    const month = Number(modernMatch[2]);
    if (month < 1 || month > 12) return null;
  } else {
    const legacyMatch = baseId.match(
      /^([A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)*)\/(\d{2})(\d{2})(\d{3})$/u,
    );
    if (!legacyMatch) return null;

    const month = Number(legacyMatch[3]);
    if (month < 1 || month > 12) return null;
  }

  if (version !== null && !Number.isSafeInteger(version)) return null;

  const id = `${baseId}${version === null ? "" : `v${version}`}`;
  return {
    id,
    baseId,
    version,
    canonicalArxivUrl: `https://arxiv.org/abs/${id}`,
  };
}

/**
 * Parses modern and legacy arXiv identifiers from bare IDs and official
 * `/abs`, `/pdf`, and `/html` URLs. URL parsing is entirely local.
 */
export function parseArxivId(input: string): ArxivIdentifier | null {
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001F\u007F]/u.test(trimmed)) {
    return null;
  }

  const prefixed = trimmed.match(/^arxiv:\s*(.+)$/iu);
  if (prefixed) return normalizeArxivIdentifier(prefixed[1]);

  if (/^https?:\/\//iu.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }

    const hostname = parsed.hostname.toLocaleLowerCase("en-US");
    if (
      !ARXIV_URL_HOSTS.has(hostname) ||
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      (parsed.port &&
        !(
          (parsed.protocol === "https:" && parsed.port === "443") ||
          (parsed.protocol === "http:" && parsed.port === "80")
        ))
    ) {
      return null;
    }

    const pathMatch = parsed.pathname.match(
      /^\/(?:abs|html|pdf)\/(.+?)\/?$/iu,
    );
    if (!pathMatch) return null;

    let pathIdentifier: string;
    try {
      pathIdentifier = decodeURIComponent(pathMatch[1]);
    } catch {
      return null;
    }

    if (/\/pdf\//iu.test(parsed.pathname)) {
      pathIdentifier = pathIdentifier.replace(/\.pdf$/iu, "");
    }
    return normalizeArxivIdentifier(pathIdentifier);
  }

  return normalizeArxivIdentifier(trimmed);
}

export function canonicalArxivUrl(input: string): string | null {
  return parseArxivId(input)?.canonicalArxivUrl ?? null;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9A-Fa-f]+)|([A-Za-z]+));/gu,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (named) {
        const replacements: Record<string, string> = {
          amp: "&",
          apos: "'",
          gt: ">",
          lt: "<",
          quot: '"',
        };
        return replacements[named] ?? entity;
      }

      const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", hexadecimal ? 16 : 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint <= 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return "\uFFFD";
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

function textFromMarkup(value: string): string {
  return normalizeWhitespace(
    decodeXmlEntities(
      value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
        .replace(/<!--[\s\S]*?-->/gu, " ")
        .replace(/<[^>]*>/gu, " "),
    ),
  ).replace(/\s+([,.;:!?])/gu, "$1");
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function elementValues(fragment: string, localName: string): string[] {
  const name = escapedRegExp(localName);
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${name}\\s*>`,
    "giu",
  );
  return Array.from(fragment.matchAll(pattern), (match) =>
    textFromMarkup(match[1]),
  ).filter(Boolean);
}

function parseTagAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern =
    /([^\s"'=<>`/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;

  for (const match of tag.matchAll(pattern)) {
    attributes.set(
      match[1].toLocaleLowerCase("en-US"),
      decodeXmlEntities(match[2] ?? match[3] ?? match[4] ?? ""),
    );
  }
  return attributes;
}

function attributeValues(fragment: string, localName: string, attribute: string): string[] {
  const name = escapedRegExp(localName);
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${name}\\b[^>]*\\/?>`,
    "giu",
  );

  return Array.from(fragment.matchAll(pattern), (match) =>
    normalizeWhitespace(parseTagAttributes(match[0]).get(attribute) ?? ""),
  ).filter(Boolean);
}

function firstValue(values: readonly string[]): string | null {
  return values.find(Boolean) ?? null;
}

function parseArxivEntry(entry: string): ArxivMetadata | null {
  const identifier = parseArxivId(firstValue(elementValues(entry, "id")) ?? "");
  if (!identifier) return null;

  const authorBlocks = Array.from(
    entry.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?author\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?author\s*>/giu,
    ),
    (match) => match[1],
  );
  const authors = authorBlocks
    .map((block) => firstValue(elementValues(block, "name")) ?? "")
    .filter(Boolean);

  const categories = Array.from(
    new Set(attributeValues(entry, "category", "term")),
  );
  const primaryCategory =
    firstValue(attributeValues(entry, "primary_category", "term")) ??
    categories[0] ??
    null;

  return {
    ...identifier,
    title: firstValue(elementValues(entry, "title")) ?? "",
    authors,
    abstract: firstValue(elementValues(entry, "summary")) ?? "",
    categories,
    primaryCategory,
    doi: firstValue(elementValues(entry, "doi")),
    journalRef: firstValue(elementValues(entry, "journal_ref")),
    published: firstValue(elementValues(entry, "published")),
    updated: firstValue(elementValues(entry, "updated")),
  };
}

/** Parses every valid entry in an arXiv Atom response. */
export function parseArxivAtomFeed(xml: string): ArxivMetadata[] {
  if (typeof xml !== "string" || !xml.trim()) return [];

  const entries = Array.from(
    xml.matchAll(
      /<(?:[A-Za-z_][\w.-]*:)?entry\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?entry\s*>/giu,
    ),
    (match) => match[1],
  );

  return entries
    .map(parseArxivEntry)
    .filter((entry): entry is ArxivMetadata => entry !== null);
}

/** Parses the first valid entry in an arXiv Atom response. */
export function parseArxivAtom(xml: string): ArxivMetadata | null {
  return parseArxivAtomFeed(xml)[0] ?? null;
}

function fallbackTitleWords(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{Mark}+/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{Letter}\p{Number}]+/gu) ?? []
  );
}

function titleWords(value: string): string[] {
  const informative = fallbackTitleWords(value).filter(
    (word) =>
      word.length >= 3 &&
      word.length <= 32 &&
      !TITLE_STOPWORDS.has(word) &&
      !/^\p{Number}+$/u.test(word),
  );
  return informative.length > 0 ? informative : fallbackTitleWords(value);
}

function sharedStrings(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return Array.from(new Set(left.filter((value) => rightSet.has(value)))).sort();
}

/**
 * Order-independent Sørensen–Dice similarity over normalized title terms.
 */
export function normalizedTitleSimilarity(left: string, right: string): number {
  const leftWords = Array.from(new Set(titleWords(left)));
  const rightWords = Array.from(new Set(titleWords(right)));
  if (leftWords.length === 0 || rightWords.length === 0) return 0;

  if (leftWords.join("\u0000") === rightWords.join("\u0000")) return 1;
  const shared = sharedStrings(leftWords, rightWords).length;
  return (2 * shared) / (leftWords.length + rightWords.length);
}

function publicationYear(published: string | null): number | null {
  if (!published) return null;
  const match = published.match(/^(\d{4})-/u);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

function normalizedSubject(value: string): string {
  return normalizeWhitespace(
    value
      .normalize("NFKD")
      .replace(/\p{Mark}+/gu, "")
      .replace(/[._/-]+/gu, " ")
      .toLocaleLowerCase("en-US"),
  );
}

/**
 * Matches arXiv metadata against the existing local paper index. A publication
 * year can rerank a title match but can never create a match by itself.
 */
export function matchLocalPapers(
  metadata: Pick<ArxivMetadata, "title" | "categories" | "published">,
  papers: readonly PaperIndexRecord[],
  limit = 5,
): LocalPaperMatch[] {
  if (!Number.isFinite(limit) || limit <= 0 || !metadata.title.trim()) return [];

  const sourceWords = titleWords(metadata.title);
  const sourceYear = publicationYear(metadata.published);
  const sourceSubjects = metadata.categories.map(normalizedSubject).filter(Boolean);

  const matches = papers.flatMap<LocalPaperMatch>((paper) => {
    if (paper.titleKind === "identifier") return [];

    const candidateWords = titleWords(paper.title);
    const shared = sharedStrings(sourceWords, candidateWords);
    const titleSimilarity = normalizedTitleSimilarity(metadata.title, paper.title);
    const exactNormalizedTitle =
      fallbackTitleWords(metadata.title).join(" ") ===
      fallbackTitleWords(paper.title).join(" ");

    const sufficientlySpecific =
      exactNormalizedTitle ||
      (shared.length >= 2 && titleSimilarity >= 0.45) ||
      (shared.length >= 3 && titleSimilarity >= 0.32);
    if (!sufficientlySpecific) return [];

    const candidateSubjects = paper.topics.map(normalizedSubject).filter(Boolean);
    const sharedSubjects = sharedStrings(sourceSubjects, candidateSubjects);
    const sameYear = sourceYear !== null && paper.year === sourceYear;
    const reasons = [
      `Title similarity: ${Math.round(titleSimilarity * 100)}%`,
      ...(shared.length > 0
        ? [`Shared title terms: ${shared.slice(0, 5).join(", ")}`]
        : []),
      ...(sameYear ? [`Same publication year: ${paper.year}`] : []),
      ...(sharedSubjects.length > 0
        ? [`Shared subject: ${sharedSubjects.slice(0, 3).join(", ")}`]
        : []),
    ];

    return [
      {
        paper,
        score:
          titleSimilarity * 100 +
          (exactNormalizedTitle ? 25 : 0) +
          (sameYear ? 3 : 0) +
          Math.min(sharedSubjects.length, 2) * 2,
        titleSimilarity,
        reasons,
      },
    ];
  });

  return matches
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.titleSimilarity - left.titleSimilarity ||
        left.paper.id.localeCompare(right.paper.id, "en"),
    )
    .slice(0, Math.min(25, Math.floor(limit)));
}

function normalizedHostname(hostname: string): string {
  return hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
}

function hostMatches(hostname: string, allowedHost: string): boolean {
  const host = normalizedHostname(hostname);
  const allowed = normalizedHostname(allowedHost);
  return host === allowed || host.endsWith(`.${allowed}`);
}

function isUnsafeIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function isUnsafeHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return (
    !host.includes(".") ||
    host.includes(":") ||
    isUnsafeIpv4(host) ||
    /(?:^|\.)(?:home|internal|invalid|lan|local|localhost|test)$/u.test(host)
  );
}

/**
 * Performs a syntax/host-policy check for a candidate link.
 *
 * It is intentionally limited to HTTPS and strips fragments. Callers that will
 * fetch arbitrary hosts still need DNS/IP checks at request time to prevent DNS
 * rebinding. Passing `allowedHosts` is recommended for every known source.
 */
export function safeCandidateUrl(
  rawUrl: string,
  allowedHosts: readonly string[] = [],
): string | null {
  if (
    typeof rawUrl !== "string" ||
    !rawUrl.trim() ||
    rawUrl.length > 4_096 ||
    /[\u0000-\u001F\u007F]/u.test(rawUrl)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== "443")
  ) {
    return null;
  }

  const hostname = normalizedHostname(parsed.hostname);
  if (
    isUnsafeHostname(hostname) ||
    (allowedHosts.length > 0 &&
      !allowedHosts.some((allowedHost) => hostMatches(hostname, allowedHost)))
  ) {
    return null;
  }

  parsed.hash = "";
  return parsed.toString();
}

function peerReviewMarker(value: string): boolean {
  const normalized = normalizeWhitespace(
    value
      .replace(/[_-]+/gu, " ")
      .toLocaleLowerCase("en-US"),
  );
  return (
    /\bpeer review\b/u.test(normalized) ||
    /\btransparent review\b/u.test(normalized) ||
    /\breview (?:file|history|reports?)\b/u.test(normalized) ||
    /\bauthor response\b/u.test(normalized)
  );
}

/**
 * Extracts explicitly labelled peer-review links from a Nature article page.
 * Relative links are resolved only against a trusted Nature base URL.
 */
export function extractNaturePeerReviewLinks(
  html: string,
  baseUrl = "https://www.nature.com/",
): NaturePeerReviewLink[] {
  if (typeof html !== "string" || !html.trim()) return [];

  const safeBase = safeCandidateUrl(baseUrl, NATURE_URL_HOSTS);
  if (!safeBase) return [];

  const results: NaturePeerReviewLink[] = [];
  const seen = new Set<string>();
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/giu;

  for (const match of html.matchAll(anchorPattern)) {
    const attributes = parseTagAttributes(match[1]);
    const href = attributes.get("href");
    if (!href) continue;

    const visibleText = textFromMarkup(match[2]);
    const dataTest = attributes.get("data-test") ?? "";
    const trackLabel = attributes.get("data-track-label") ?? "";
    if (
      !peerReviewMarker(dataTest) &&
      !peerReviewMarker(trackLabel) &&
      !peerReviewMarker(visibleText)
    ) {
      continue;
    }

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(href, safeBase).toString();
    } catch {
      continue;
    }

    const url = safeCandidateUrl(absoluteUrl, NATURE_URL_HOSTS);
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const fallbackLabel = textFromMarkup(trackLabel || dataTest);
    results.push({
      url,
      label: (visibleText || fallbackLabel || "Peer review file").slice(0, 200),
    });
  }

  return results;
}

/**
 * Detects likely author-response documents in a GitHub repository path.
 * This is a conservative path classifier, not proof that a file is genuine.
 */
export function isGitHubRebuttalPath(pathOrUrl: string): boolean {
  if (
    typeof pathOrUrl !== "string" ||
    !pathOrUrl.trim() ||
    pathOrUrl.length > 2_048 ||
    /[\u0000-\u001F\u007F]/u.test(pathOrUrl)
  ) {
    return false;
  }

  let path = pathOrUrl.trim();
  if (/^https?:\/\//iu.test(path)) {
    let parsed: URL;
    try {
      parsed = new URL(path);
    } catch {
      return false;
    }
    path = parsed.pathname;
  } else {
    path = path.split(/[?#]/u, 1)[0];
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }

  const segments = path
    .replace(/\\/gu, "/")
    .split("/")
    .filter(Boolean);
  if (segments.length === 0) return false;

  const finalSegment = segments.at(-1) ?? "";
  const extensionMatch = finalSegment.match(/\.([A-Za-z0-9]+)$/u);
  if (
    extensionMatch &&
    !DOCUMENT_EXTENSIONS.has(extensionMatch[1].toLocaleLowerCase("en-US"))
  ) {
    return false;
  }

  const normalizedPath = segments
    .map((segment) =>
      segment
        .normalize("NFKD")
        .replace(/\p{Mark}+/gu, "")
        .replace(/[^A-Za-z0-9]+/gu, " ")
        .toLocaleLowerCase("en-US")
        .trim(),
    )
    .join(" / ");

  return REBUTTAL_PATH_PHRASES.some((pattern) => pattern.test(normalizedPath));
}
