import {
  extractNaturePeerReviewLinks,
  isGitHubRebuttalPath,
  normalizedTitleSimilarity,
  parseArxivAtom,
  parseArxivId,
  safeCandidateUrl,
} from "../../../lib/discovery.ts";

export const runtime = "edge";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};
const MAX_REQUEST_BYTES = 4_096;
const MAX_ARXIV_BYTES = 768_000;
const MAX_JSON_BYTES = 1_500_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_CANDIDATES = 20;
const ARXIV_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const ARXIV_CACHE_LIMIT = 64;
const ARXIV_REQUEST_INTERVAL_MS = 3_000;
const APP_USER_AGENT =
  "RebuttalReader/0.1 (+https://github.com/Functionhx/rebuttal-reader)";

type ProviderId = "nature" | "github" | "crossref" | "brave";
type CandidateKind =
  | "peer_review_file"
  | "rebuttal_file"
  | "repository"
  | "peer_review_record"
  | "web_result";
type Confidence = "verified" | "likely" | "lead";
type ProviderState = "searched" | "partial" | "skipped" | "error";
type JsonRecord = Record<string, unknown>;

interface DiscoveryPaper {
  id: string;
  version?: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  published?: string;
  updated?: string;
  doi?: string;
  journalRef?: string;
  canonicalUrl: string;
}

interface DiscoveryCandidate {
  id: string;
  provider: ProviderId;
  kind: CandidateKind;
  title: string;
  url: string;
  contextUrl?: string;
  description?: string;
  confidence: Confidence;
  matchedBy: string[];
}

interface ProviderStatus {
  id: ProviderId;
  label: string;
  status: ProviderState;
  detail: string;
  configured?: boolean;
}

interface ManualSearchUrl {
  label: string;
  url: string;
}

interface DiscoveryGroup {
  candidates: DiscoveryCandidate[];
  providers: ProviderStatus[];
}

interface ArxivCacheEntry {
  expiresAt: number;
  paper: DiscoveryPaper;
}

class ValidationError extends Error {}

class UpstreamError extends Error {
  readonly status: number;
  readonly kind:
    | "http"
    | "timeout"
    | "too_large"
    | "invalid_response"
    | "network";

  constructor(
    status: number,
    kind:
      | "http"
      | "timeout"
      | "too_large"
      | "invalid_response"
      | "network",
  ) {
    super(kind);
    this.status = status;
    this.kind = kind;
  }
}

const arxivCache = new Map<string, ArxivCacheEntry>();
let arxivQueue: Promise<void> = Promise.resolve();
let nextArxivRequestAt = 0;

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, cap: number) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return Array.from(cleaned).slice(0, cap).join("");
}

function stringArray(value: unknown, maxItems: number, itemCap: number) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, itemCap))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeDoi(value: unknown) {
  return cleanText(value, 200)
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .toLocaleLowerCase("en-US");
}

function parsePaper(value: unknown): DiscoveryPaper {
  if (!isRecord(value)) {
    throw new UpstreamError(502, "invalid_response");
  }
  const title = cleanText(value.title, 600);
  if (!title) {
    throw new UpstreamError(502, "invalid_response");
  }

  const parsedIdentifier = parseArxivId(cleanText(value.id, 180));
  if (!parsedIdentifier) {
    throw new UpstreamError(502, "invalid_response");
  }
  const parsedId = parsedIdentifier.id;
  const authors = stringArray(value.authors, 80, 180);
  const doi = normalizeDoi(value.doi);
  const versionMatch = parsedId.match(/v([1-9]\d*)$/u);

  return {
    id: parsedId,
    version: versionMatch ? `v${versionMatch[1]}` : undefined,
    title,
    authors,
    abstract: cleanText(value.abstract ?? value.summary, 6_000),
    categories: stringArray(value.categories, 50, 100),
    published: cleanText(value.published, 80) || undefined,
    updated: cleanText(value.updated, 80) || undefined,
    doi: doi || undefined,
    journalRef: cleanText(value.journalRef, 500) || undefined,
    canonicalUrl: parsedIdentifier.canonicalArxivUrl,
  };
}

async function readTextBounded(response: Response, byteCap: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > byteCap) {
    throw new UpstreamError(502, "too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let output = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > byteCap) {
        await reader.cancel();
        throw new UpstreamError(502, "too_large");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function fetchText(
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    byteCap: number;
    allowedFinalHosts?: readonly string[];
  },
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      redirect: "follow",
      signal: controller.signal,
    });
    if (response.url) {
      const initialHost = new URL(url).hostname;
      const finalUrl = safeCandidateUrl(
        response.url,
        options.allowedFinalHosts ?? [initialHost],
      );
      if (!finalUrl) {
        throw new UpstreamError(502, "invalid_response");
      }
    }
    if (!response.ok) {
      throw new UpstreamError(response.status, "http");
    }
    return await readTextBounded(response, options.byteCap);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (controller.signal.aborted) {
      throw new UpstreamError(504, "timeout");
    }
    throw new UpstreamError(502, "network");
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  byteCap = MAX_JSON_BYTES,
) {
  const text = await fetchText(
    url,
    {
      ...init,
      headers: {
        Accept: "application/json",
        "User-Agent": APP_USER_AGENT,
        ...init.headers,
      },
    },
    { timeoutMs: 8_000, byteCap },
  );
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new UpstreamError(502, "invalid_response");
  }
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function queuedArxivFetch(url: string) {
  let resolveTurn!: () => void;
  const previous = arxivQueue;
  arxivQueue = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });

  await previous;
  try {
    const delay = Math.max(0, nextArxivRequestAt - Date.now());
    if (delay > 0) await wait(delay);
    nextArxivRequestAt = Date.now() + ARXIV_REQUEST_INTERVAL_MS;
    return await fetchText(
      url,
      {
        headers: {
          Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
          "User-Agent": APP_USER_AGENT,
        },
      },
      { timeoutMs: 10_000, byteCap: MAX_ARXIV_BYTES },
    );
  } finally {
    resolveTurn();
  }
}

function pruneArxivCache(now: number) {
  for (const [key, value] of arxivCache) {
    if (value.expiresAt <= now) arxivCache.delete(key);
  }
  while (arxivCache.size >= ARXIV_CACHE_LIMIT) {
    const oldest = arxivCache.keys().next().value;
    if (typeof oldest !== "string") break;
    arxivCache.delete(oldest);
  }
}

async function resolveArxivPaper(arxivId: string) {
  const now = Date.now();
  const cached = arxivCache.get(arxivId);
  if (cached && cached.expiresAt > now) {
    return cached.paper;
  }

  const endpoint = new URL("https://export.arxiv.org/api/query");
  endpoint.searchParams.set("id_list", arxivId);
  endpoint.searchParams.set("max_results", "1");
  const atom = await queuedArxivFetch(endpoint.toString());
  const paper = parsePaper(parseArxivAtom(atom));

  pruneArxivCache(now);
  arxivCache.set(arxivId, {
    expiresAt: now + ARXIV_CACHE_TTL_MS,
    paper,
  });
  return paper;
}

function crossrefWorks(value: unknown) {
  if (!isRecord(value) || !isRecord(value.message)) return [];
  const items = value.message.items;
  return Array.isArray(items) ? items.filter(isRecord).slice(0, 10) : [];
}

function crossrefTitle(item: JsonRecord) {
  return stringArray(item.title, 1, 600)[0] ?? "";
}

function crossrefAuthors(item: JsonRecord) {
  if (!Array.isArray(item.author)) return [];
  return item.author
    .filter(isRecord)
    .map((author) =>
      cleanText(
        author.family ||
          [cleanText(author.given, 100), cleanText(author.family, 100)]
            .filter(Boolean)
            .join(" "),
        180,
      ),
    )
    .filter(Boolean)
    .slice(0, 80);
}

function normalizedNameParts(value: string) {
  return new Set(
    value
      .normalize("NFKD")
      .replace(/\p{Mark}+/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{Letter}\p{Number}]{2,}/gu) ?? [],
  );
}

function authorOverlap(left: readonly string[], right: readonly string[]) {
  const leftParts = new Set(
    left.flatMap((author) => Array.from(normalizedNameParts(author))),
  );
  return right.some((author) =>
    Array.from(normalizedNameParts(author)).some((part) =>
      leftParts.has(part),
    ),
  );
}

function natureArticleUrl(doi: string) {
  if (!doi.startsWith("10.1038/")) return null;
  const suffix = doi.slice("10.1038/".length);
  if (!/^[a-z0-9][a-z0-9._()-]{2,180}$/iu.test(suffix)) return null;
  return `https://www.nature.com/articles/${encodeURIComponent(suffix)}`;
}

function candidate(
  provider: ProviderId,
  kind: CandidateKind,
  index: number,
  fields: Omit<
    DiscoveryCandidate,
    "id" | "provider" | "kind"
  >,
): DiscoveryCandidate {
  return {
    id: `${provider}:${kind}:${index + 1}`,
    provider,
    kind,
    ...fields,
  };
}

function peerReviewLinks(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") {
      const url = safeCandidateUrl(item);
      return url ? [{ title: "Peer Review File", url }] : [];
    }
    if (!isRecord(item)) return [];
    const url = safeCandidateUrl(cleanText(item.url ?? item.href, 2_000));
    if (!url) return [];
    return [
      {
        title:
          cleanText(item.title ?? item.label ?? item.text, 300) ||
          "Peer Review File",
        url,
      },
    ];
  });
}

function crossrefRelationCandidate(
  item: JsonRecord,
  index: number,
): DiscoveryCandidate | null {
  const doi = normalizeDoi(item.DOI);
  const rawUrl =
    cleanText(item.URL, 2_000) ||
    (doi ? `https://doi.org/${encodeURIComponent(doi)}` : "");
  const url = safeCandidateUrl(rawUrl);
  if (!url) return null;
  const title = crossrefTitle(item) || "Crossref peer-review record";
  return candidate("crossref", "peer_review_record", index, {
    title,
    url,
    description: doi ? `DOI ${doi}` : undefined,
    confidence: "verified",
    matchedBy: ["Crossref is-review-of relation"],
  });
}

async function discoverCrossrefPeerReviews(doi: string) {
  const endpoint = new URL("https://api.crossref.org/works");
  endpoint.searchParams.set(
    "filter",
    `relation.type:is-review-of,relation.object:${doi}`,
  );
  endpoint.searchParams.set("rows", "10");
  const response = await fetchJson(endpoint.toString());
  return crossrefWorks(response)
    .map(crossrefRelationCandidate)
    .filter((item): item is DiscoveryCandidate => Boolean(item));
}

async function discoverNatureAndCrossref(
  paper: DiscoveryPaper,
): Promise<DiscoveryGroup> {
  const providers: ProviderStatus[] = [];
  const candidates: DiscoveryCandidate[] = [];
  let resolvedDoi =
    paper.doi?.startsWith("10.1038/") ? paper.doi : undefined;
  let natureMatch:
    | {
        doi: string;
        title: string;
        titleScore: number;
        authorsMatch: boolean;
      }
    | undefined;

  try {
    if (!resolvedDoi) {
      const endpoint = new URL("https://api.crossref.org/works");
      endpoint.searchParams.set("query.title", paper.title);
      endpoint.searchParams.set("filter", "prefix:10.1038");
      endpoint.searchParams.set("rows", "8");
      const response = await fetchJson(endpoint.toString());
      const matches = crossrefWorks(response)
        .map((item) => {
          const doi = normalizeDoi(item.DOI);
          const title = crossrefTitle(item);
          return {
            doi,
            title,
            titleScore: normalizedTitleSimilarity(paper.title, title),
            authorsMatch: authorOverlap(
              paper.authors,
              crossrefAuthors(item),
            ),
          };
        })
        .filter(
          (item) =>
            item.doi.startsWith("10.1038/") &&
            item.titleScore >= 0.78 &&
            (paper.authors.length === 0 || item.authorsMatch),
        )
        .sort((left, right) => right.titleScore - left.titleScore);
      natureMatch = matches[0];
      resolvedDoi = natureMatch?.doi;
    } else {
      natureMatch = {
        doi: resolvedDoi,
        title: paper.title,
        titleScore: 1,
        authorsMatch: true,
      };
    }

    if (!resolvedDoi || !natureMatch) {
      providers.push({
        id: "nature",
        label: "Nature Portfolio",
        status: "searched",
        detail: "No matching Nature Portfolio article was found.",
        configured: true,
      });
      if (paper.doi) {
        try {
          const related = await discoverCrossrefPeerReviews(
            paper.doi,
          );
          candidates.push(...related);
          providers.push({
            id: "crossref",
            label: "Crossref peer review",
            status: "searched",
            detail: related.length
              ? `Found ${related.length} related record${related.length === 1 ? "" : "s"}.`
              : "No peer-review relation was deposited for this DOI.",
            configured: true,
          });
        } catch {
          providers.push({
            id: "crossref",
            label: "Crossref peer review",
            status: "partial",
            detail:
              "Crossref peer-review relations were temporarily unavailable.",
            configured: true,
          });
        }
      } else {
        providers.push({
          id: "crossref",
          label: "Crossref peer review",
          status: "skipped",
          detail: "No published DOI was available for relation lookup.",
          configured: true,
        });
      }
      return { candidates, providers };
    }

    const articleUrl = natureArticleUrl(resolvedDoi);
    if (!articleUrl) {
      throw new UpstreamError(502, "invalid_response");
    }
    const articleFetchUrl = new URL(articleUrl);
    articleFetchUrl.searchParams.set(
      "error",
      "cookies_not_supported",
    );

    const [natureResult, crossrefResult] = await Promise.allSettled([
      fetchText(
        articleFetchUrl.toString(),
        {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": APP_USER_AGENT,
          },
        },
        {
          timeoutMs: 10_000,
          byteCap: MAX_HTML_BYTES,
          allowedFinalHosts: ["nature.com"],
        },
      ),
      discoverCrossrefPeerReviews(paper.doi ?? resolvedDoi),
    ]);

    if (natureResult.status === "fulfilled") {
      const links = peerReviewLinks(
        extractNaturePeerReviewLinks(natureResult.value, articleUrl),
      );
      for (const [index, link] of links.entries()) {
        candidates.push(
          candidate("nature", "peer_review_file", index, {
            title: link.title,
            url: link.url,
            contextUrl: articleUrl,
            description: natureMatch.title,
            confidence: "verified",
            matchedBy: [
              "Nature DOI and article matched",
              "Actual peer-review link found on article page",
            ],
          }),
        );
      }
      providers.push({
        id: "nature",
        label: "Nature Portfolio",
        status: "searched",
        detail: links.length
          ? `Found ${links.length} public peer-review file${links.length === 1 ? "" : "s"}.`
          : "Article matched, but no public peer-review file was exposed.",
        configured: true,
      });
    } else {
      providers.push({
        id: "nature",
        label: "Nature Portfolio",
        status: "error",
        detail: "The Nature article page could not be checked right now.",
        configured: true,
      });
    }

    if (crossrefResult.status === "fulfilled") {
      candidates.push(...crossrefResult.value);
      providers.push({
        id: "crossref",
        label: "Crossref peer review",
        status: "searched",
        detail: crossrefResult.value.length
          ? `Found ${crossrefResult.value.length} related record${crossrefResult.value.length === 1 ? "" : "s"}.`
          : "No peer-review relation was deposited for this DOI.",
        configured: true,
      });
    } else {
      providers.push({
        id: "crossref",
        label: "Crossref peer review",
        status: "partial",
        detail: "Crossref peer-review relations were temporarily unavailable.",
        configured: true,
      });
    }
  } catch {
    providers.push({
      id: "nature",
      label: "Nature Portfolio",
      status: "error",
      detail: "Nature discovery was temporarily unavailable.",
      configured: true,
    });
    providers.push({
      id: "crossref",
      label: "Crossref peer review",
      status: "partial",
      detail: "Crossref or DOI resolution was temporarily unavailable.",
      configured: true,
    });
  }

  return { candidates, providers };
}

function githubHeaders(token?: string) {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": APP_USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function searchTitle(title: string) {
  const words =
    title.match(/[\p{Letter}\p{Number}][\p{Letter}\p{Number}':-]*/gu) ?? [];
  return words.slice(0, 12).join(" ").slice(0, 180);
}

function githubRepositoryCandidates(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.filter(isRecord).slice(0, 5);
}

function githubRepositoryCandidate(
  item: JsonRecord,
  paper: DiscoveryPaper,
  index: number,
): DiscoveryCandidate | null {
  const url = safeCandidateUrl(cleanText(item.html_url, 2_000), [
    "github.com",
  ]);
  if (!url) return null;
  const name = cleanText(item.full_name ?? item.name, 300);
  const description = cleanText(item.description, 600);
  const similarity = normalizedTitleSimilarity(
    paper.title,
    `${name} ${description}`,
  );
  return candidate("github", "repository", index, {
    title: name || "Potential paper repository",
    url,
    description: description || undefined,
    confidence: similarity >= 0.7 ? "likely" : "lead",
    matchedBy: ["GitHub repository metadata search", "Paper title query"],
  });
}

function githubCodeCandidates(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.filter(isRecord).slice(0, 10);
}

function githubCodeCandidate(
  item: JsonRecord,
  index: number,
): DiscoveryCandidate | null {
  const path = cleanText(item.path ?? item.name, 800);
  if (!isGitHubRebuttalPath(path)) return null;
  const url = safeCandidateUrl(cleanText(item.html_url, 2_000), [
    "github.com",
  ]);
  if (!url) return null;
  const repository = isRecord(item.repository)
    ? cleanText(item.repository.full_name, 300)
    : "";
  return candidate("github", "rebuttal_file", index, {
    title: path,
    url,
    description: repository || undefined,
    confidence: "likely",
    matchedBy: ["Rebuttal-like repository path", "Authenticated code search"],
  });
}

function githubTreeCandidates(
  value: unknown,
  repository: JsonRecord,
  startIndex: number,
) {
  if (!isRecord(value) || !Array.isArray(value.tree)) return [];
  const fullName = cleanText(repository.full_name, 300);
  const branch = cleanText(repository.default_branch, 200);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName) || !branch) {
    return [];
  }

  return value.tree
    .filter(isRecord)
    .filter((entry) => cleanText(entry.type, 20) === "blob")
    .map((entry) => cleanText(entry.path, 800))
    .filter(isGitHubRebuttalPath)
    .slice(0, 8)
    .map((path, index) =>
      candidate("github", "rebuttal_file", startIndex + index, {
        title: path,
        url: `https://github.com/${fullName}/blob/${encodeURIComponent(branch)}/${path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        contextUrl: `https://github.com/${fullName}`,
        description: fullName,
        confidence: "likely",
        matchedBy: [
          "Repository metadata matched paper query",
          "Rebuttal-like path in repository tree",
        ],
      }),
    );
}

async function discoverGitHub(
  paper: DiscoveryPaper,
): Promise<DiscoveryGroup> {
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers = githubHeaders(token);
  const queryTitle = searchTitle(paper.title);
  const repositoryEndpoint = new URL(
    "https://api.github.com/search/repositories",
  );
  repositoryEndpoint.searchParams.set(
    "q",
    `"${queryTitle}" rebuttal in:name,description,readme`,
  );
  repositoryEndpoint.searchParams.set("sort", "best-match");
  repositoryEndpoint.searchParams.set("per_page", "5");

  try {
    const repositoriesResponse = await fetchJson(
      repositoryEndpoint.toString(),
      { headers },
      900_000,
    );
    const repositories = githubRepositoryCandidates(repositoriesResponse);
    const candidates = repositories
      .map((item, index) =>
        githubRepositoryCandidate(item, paper, index),
      )
      .filter((item): item is DiscoveryCandidate => Boolean(item));

    if (!token) {
      return {
        candidates,
        providers: [
          {
            id: "github",
            label: "GitHub",
            status: candidates.length ? "partial" : "searched",
            detail: candidates.length
              ? "Repository metadata was searched. Add GITHUB_TOKEN locally for code and tree inspection."
              : "No repository metadata match was found. Add GITHUB_TOKEN locally for deeper code search.",
            configured: false,
          },
        ],
      };
    }

    const codeEndpoint = new URL("https://api.github.com/search/code");
    codeEndpoint.searchParams.set(
      "q",
      `"${queryTitle}" rebuttal OR "author response" in:file`,
    );
    codeEndpoint.searchParams.set("per_page", "10");

    const deeperRequests: Array<Promise<unknown>> = [
      fetchJson(codeEndpoint.toString(), { headers }, 900_000),
    ];
    for (const repository of repositories.slice(0, 2)) {
      const fullName = cleanText(repository.full_name, 300);
      const branch = cleanText(repository.default_branch, 200);
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName) ||
        !/^[A-Za-z0-9._/-]{1,200}$/u.test(branch)
      ) {
        continue;
      }
      const [owner, repo] = fullName.split("/");
      const treeEndpoint = new URL(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(branch)}`,
      );
      treeEndpoint.searchParams.set("recursive", "1");
      deeperRequests.push(
        fetchJson(treeEndpoint.toString(), { headers }, MAX_JSON_BYTES),
      );
    }

    const deeperResults = await Promise.allSettled(deeperRequests);
    const codeResult = deeperResults[0];
    if (codeResult?.status === "fulfilled") {
      candidates.push(
        ...githubCodeCandidates(codeResult.value)
          .map((item, index) =>
            githubCodeCandidate(item, candidates.length + index),
          )
          .filter((item): item is DiscoveryCandidate => Boolean(item)),
      );
    }

    for (const [index, result] of deeperResults.slice(1).entries()) {
      if (result.status !== "fulfilled") continue;
      candidates.push(
        ...githubTreeCandidates(
          result.value,
          repositories[index],
          candidates.length,
        ),
      );
    }

    const failures = deeperResults.filter(
      (result) => result.status === "rejected",
    ).length;
    return {
      candidates,
      providers: [
        {
          id: "github",
          label: "GitHub",
          status: failures ? "partial" : "searched",
          detail: failures
            ? "Repository search succeeded; some authenticated deep checks were rate-limited or unavailable."
            : `Repository, code, and tree searches completed with ${candidates.length} lead${candidates.length === 1 ? "" : "s"}.`,
          configured: true,
        },
      ],
    };
  } catch (error) {
    const rateLimited =
      error instanceof UpstreamError &&
      (error.status === 403 || error.status === 429);
    return {
      candidates: [],
      providers: [
        {
          id: "github",
          label: "GitHub",
          status: rateLimited ? "partial" : "error",
          detail: rateLimited
            ? "GitHub search is rate-limited right now; use the manual link or retry later."
            : "GitHub search was temporarily unavailable.",
          configured: Boolean(token),
        },
      ],
    };
  }
}

function braveResults(value: unknown) {
  if (!isRecord(value) || !isRecord(value.web)) return [];
  return Array.isArray(value.web.results)
    ? value.web.results.filter(isRecord).slice(0, 10)
    : [];
}

async function discoverBrave(
  paper: DiscoveryPaper,
): Promise<DiscoveryGroup> {
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!key) {
    return {
      candidates: [],
      providers: [
        {
          id: "brave",
          label: "Brave Search",
          status: "skipped",
          detail: "Set BRAVE_SEARCH_API_KEY locally to include broader web leads.",
          configured: false,
        },
      ],
    };
  }

  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set(
    "q",
    `"${searchTitle(paper.title)}" (rebuttal OR "author response" OR "peer review")`,
  );
  endpoint.searchParams.set("count", "10");
  endpoint.searchParams.set("safesearch", "moderate");

  try {
    const response = await fetchJson(
      endpoint.toString(),
      {
        headers: {
          "X-Subscription-Token": key,
        },
      },
      1_000_000,
    );
    const candidates = braveResults(response).flatMap((item, index) => {
      const url = safeCandidateUrl(cleanText(item.url, 2_000));
      if (!url) return [];
      const title = cleanText(item.title, 500) || "Web search result";
      const description = cleanText(item.description, 900);
      const haystack = `${title} ${description} ${url}`;
      const mentionsMaterial =
        /rebuttal|author.?response|response.?to.?review|peer.?review/iu.test(
          haystack,
        );
      const titleScore = normalizedTitleSimilarity(paper.title, haystack);
      if (!mentionsMaterial || titleScore < 0.36) return [];
      return [
        candidate("brave", "web_result", index, {
          title,
          url,
          description: description || undefined,
          confidence: titleScore >= 0.75 ? "likely" : "lead",
          matchedBy: [
            "Web result mentions review response material",
            "Paper-title terms matched",
          ],
        }),
      ];
    });

    return {
      candidates,
      providers: [
        {
          id: "brave",
          label: "Brave Search",
          status: "searched",
          detail: `Broader web search completed with ${candidates.length} lead${candidates.length === 1 ? "" : "s"}.`,
          configured: true,
        },
      ],
    };
  } catch (error) {
    const rateLimited =
      error instanceof UpstreamError &&
      (error.status === 403 || error.status === 429);
    return {
      candidates: [],
      providers: [
        {
          id: "brave",
          label: "Brave Search",
          status: rateLimited ? "partial" : "error",
          detail: rateLimited
            ? "Brave Search is rate-limited right now."
            : "Broader web search was temporarily unavailable.",
          configured: true,
        },
      ],
    };
  }
}

function dedupeCandidates(groups: readonly DiscoveryGroup[]) {
  const seen = new Set<string>();
  const confidenceOrder: Record<Confidence, number> = {
    verified: 0,
    likely: 1,
    lead: 2,
  };

  return groups
    .flatMap((group) => group.candidates)
    .filter((item) => {
      const url = safeCandidateUrl(item.url);
      if (!url) return false;
      const key = url
        .replace(/^http:/u, "https:")
        .replace(/[?#].*$/u, "")
        .replace(/\/+$/u, "")
        .toLocaleLowerCase("en-US");
      if (seen.has(key)) return false;
      seen.add(key);
      item.url = url;
      return true;
    })
    .sort(
      (left, right) =>
        confidenceOrder[left.confidence] -
        confidenceOrder[right.confidence],
    )
    .slice(0, MAX_CANDIDATES)
    .map((item, index) => ({
      ...item,
      id: `${item.provider}:${item.kind}:${index + 1}`,
      matchedBy: item.matchedBy.slice(0, 5),
    }));
}

function manualSearchUrls(paper: DiscoveryPaper): ManualSearchUrl[] {
  const quotedTitle = `"${paper.title}"`;
  const google = new URL("https://www.google.com/search");
  google.searchParams.set(
    "q",
    `${quotedTitle} rebuttal OR "author response" OR "response to reviewers"`,
  );
  const github = new URL("https://github.com/search");
  github.searchParams.set("q", `${quotedTitle} rebuttal`);
  github.searchParams.set("type", "code");
  const scholar = new URL("https://scholar.google.com/scholar");
  scholar.searchParams.set("q", `${quotedTitle} "author response"`);

  return [
    { label: "Search the web", url: google.toString() },
    { label: "Search GitHub code", url: github.toString() },
    { label: "Search Google Scholar", url: scholar.toString() },
  ];
}

async function parseRequest(request: Request) {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw new ValidationError("Request body must not exceed 4 KB.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw new ValidationError("Request body must not exceed 4 KB.");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
  if (!isRecord(value)) {
    throw new ValidationError("Request body must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (key !== "arxivUrl") {
      throw new ValidationError(`${key} is not supported.`);
    }
  }
  if (typeof value.arxivUrl !== "string") {
    throw new ValidationError("arxivUrl is required.");
  }
  const raw = value.arxivUrl.trim();
  if (!raw || raw.length > 500) {
    throw new ValidationError(
      "arxivUrl must be a valid arXiv URL or identifier.",
    );
  }
  const parsed = parseArxivId(raw);
  if (!parsed) {
    throw new ValidationError(
      "arxivUrl must be a valid arXiv URL or identifier.",
    );
  }
  return parsed.id;
}

export async function POST(request: Request) {
  try {
    const arxivId = await parseRequest(request);
    const paper = await resolveArxivPaper(arxivId);
    const groups = await Promise.all([
      discoverNatureAndCrossref(paper),
      discoverGitHub(paper),
      discoverBrave(paper),
    ]);

    return json({
      paper,
      candidates: dedupeCandidates(groups),
      providers: groups.flatMap((group) => group.providers),
      manualSearchUrls: manualSearchUrls(paper),
      searchedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, 400);
    }
    if (error instanceof UpstreamError) {
      const status = error.status === 404 ? 404 : 502;
      return json(
        {
          error:
            status === 404
              ? "No arXiv record was found for that identifier."
              : "The arXiv record could not be resolved right now.",
        },
        status,
      );
    }
    return json(
      { error: "The arXiv record could not be resolved right now." },
      502,
    );
  }
}
