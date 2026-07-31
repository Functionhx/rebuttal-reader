import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EUROPE_PMC_SEARCH_URL =
  "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const EUROPE_PMC_DOCS_URL = "https://europepmc.org/RestfulWebService";
const CONFIG_PATH = new URL("../config/nature-journals.json", import.meta.url);
const DEFAULT_OUTPUT_DIR = new URL("../public/data/nature/", import.meta.url);
const QUERY_PHRASE = "Peer Review file";
const USER_AGENT =
  "rebuttal-reader/0.5 (+https://github.com/Functionhx/rebuttal-reader; metadata-only manual update)";
const ARTICLE_LICENSE = "Article-specific open-access license (see source)";
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const MAX_SHARD_BYTES = 10 * 1024 * 1024;
const SHARD_CONTENT_BUDGET = 9 * 1024 * 1024;

function wait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePmcid(value) {
  const pmcid = cleanText(value).toUpperCase();
  return /^PMC[1-9]\d{0,11}$/.test(pmcid) ? pmcid : "";
}

function normalizeDoi(value) {
  const doi = cleanText(value).toLowerCase();
  return /^10\.1038\/[-._;()/:a-z0-9]+$/i.test(doi) ? doi : "";
}

function normalizeDate(value) {
  const date = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? ""
    : date;
}

function escapeQueryPhrase(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function compareText(left, right) {
  const a = String(left ?? "").toLowerCase();
  const b = String(right ?? "").toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortNaturePapers(papers) {
  return [...papers].sort(
    (left, right) =>
      right.year - left.year ||
      compareText(right.nature?.publishedAt, left.nature?.publishedAt) ||
      compareText(left.venue, right.venue) ||
      compareText(left.title, right.title) ||
      compareText(left.id, right.id),
  );
}

export function splitPapersByByteBudget(
  papers,
  byteBudget = SHARD_CONTENT_BUDGET,
) {
  const chunks = [];
  let chunk = [];
  let chunkBytes = 0;
  for (const paper of papers) {
    const paperBytes = Buffer.byteLength(JSON.stringify(paper), "utf8") + 1;
    if (chunk.length > 0 && chunkBytes + paperBytes > byteBudget) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(paper);
    chunkBytes += paperBytes;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export function buildSearchQuery({
  journal,
  fromYear = null,
  toYear = null,
  fullTextCreatedFrom = null,
  fullTextCreatedTo = null,
}) {
  const clauses = [
    `JOURNAL:"${escapeQueryPhrase(journal.europePmcJournal)}"`,
  ];
  if (fromYear !== null || toYear !== null) {
    const start = fromYear === null ? "*" : `${fromYear}-01-01`;
    const end = toYear === null ? "*" : `${toYear}-12-31`;
    clauses.push(`FIRST_PDATE:[${start} TO ${end}]`);
  }
  if (fullTextCreatedFrom || fullTextCreatedTo) {
    clauses.push(
      `FT_CDATE:[${fullTextCreatedFrom || "*"} TO ${fullTextCreatedTo || "*"}]`,
    );
  }
  clauses.push(
    `"${QUERY_PHRASE}"`,
    "OPEN_ACCESS:Y",
  );
  return clauses.join(" AND ");
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.min(Math.max(0, at - Date.now()), 30_000);
    }
  }
  return Math.min(750 * 2 ** attempt, 15_000);
}

export async function fetchJsonWithRetry(
  url,
  {
    fetchImpl = fetch,
    sleep = wait,
    maxRetries = 8,
    timeoutMs = 45_000,
  } = {},
) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(
          `Europe PMC request failed with HTTP ${response.status}.`,
        );
        error.status = response.status;
        if (!RETRYABLE_STATUS.has(response.status) || attempt === maxRetries) {
          throw error;
        }
        await response.body?.cancel?.();
        await sleep(retryDelay(response, attempt));
        continue;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const status = Number(error?.status);
      const retryable =
        !Number.isFinite(status) || RETRYABLE_STATUS.has(status);
      if (!retryable || attempt === maxRetries) throw error;
      await sleep(retryDelay(response, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new Error("Europe PMC request failed.");
}

export function normalizeSearchResult(result, journal, retrievedAt) {
  const pmcid = normalizePmcid(result?.pmcid);
  const title = cleanText(result?.title);
  const publishedAt = normalizeDate(result?.firstPublicationDate);
  const year = Number(
    publishedAt.slice(0, 4) || cleanText(result?.pubYear) || 0,
  );
  if (!pmcid || !title || year < 1900 || year > 2200) return null;

  const doi = normalizeDoi(result?.doi);
  const europePmcUrl = `https://europepmc.org/articles/${pmcid}`;
  const articleUrl = doi ? `https://doi.org/${doi}` : europePmcUrl;
  const authorString = cleanText(result?.authorString);

  return {
    id: `nature:${pmcid}`,
    title,
    titleKind: "paper_title",
    venue: journal.name,
    year,
    decision: "Published",
    accepted: true,
    topics: ["Transparent peer review"],
    scoreBefore: [],
    scoreAfter: [],
    reviewCount: 0,
    rebuttalRanges: [],
    reviewRange: null,
    paperZip: null,
    reviewBench: null,
    openReviewArchive: null,
    iclrArchive: null,
    nature: {
      pmcid,
      doi,
      articleUrl,
      europePmcUrl,
      publishedAt: publishedAt || null,
      authorString,
      journal: journal.name,
    },
    detailUrl: null,
    source: {
      type: "nature_peer_review",
      label: "Europe PMC · Transparent peer review",
      url: europePmcUrl,
      originalUrl: articleUrl,
      license: ARTICLE_LICENSE,
      retrievedAt,
    },
  };
}

export async function fetchJournalIndex({
  journal,
  fromYear = null,
  toYear = null,
  fullTextCreatedFrom = null,
  fullTextCreatedTo = null,
  retrievedAt,
  pageSize = 1000,
  delayMs = 150,
  fetchJson = fetchJsonWithRetry,
  sleep = wait,
  onPage = null,
}) {
  const query = buildSearchQuery({
    journal,
    fromYear,
    toYear,
    fullTextCreatedFrom,
    fullTextCreatedTo,
  });
  const papers = new Map();
  let cursorMark = "*";
  let hitCount = 0;
  let pageCount = 0;

  for (;;) {
    const url = new URL(EUROPE_PMC_SEARCH_URL);
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("resultType", "lite");
    url.searchParams.set("pageSize", String(pageSize));
    url.searchParams.set("cursorMark", cursorMark);
    url.searchParams.set("synonym", "false");

    const payload = await fetchJson(url);
    pageCount += 1;
    hitCount = Number(payload?.hitCount) || hitCount;
    const results = Array.isArray(payload?.resultList?.result)
      ? payload.resultList.result
      : [];
    for (const result of results) {
      const paper = normalizeSearchResult(result, journal, retrievedAt);
      if (paper) papers.set(paper.id, paper);
    }
    onPage?.({
      journal,
      pageCount,
      hitCount,
      indexedCount: papers.size,
    });

    const nextCursorMark = cleanText(payload?.nextCursorMark);
    if (
      results.length === 0 ||
      !nextCursorMark ||
      nextCursorMark === cursorMark
    ) {
      break;
    }
    cursorMark = nextCursorMark;
    if (pageCount > 100_000) {
      throw new Error(`Europe PMC cursor did not terminate for ${journal.id}.`);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  return {
    query,
    hitCount,
    pageCount,
    papers: sortNaturePapers(papers.values()),
  };
}

function safeInteger(value, label, { min, max }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

export function parseArguments(argv, currentYear = new Date().getUTCFullYear()) {
  const valueAfter = (name) => {
    const index = argv.indexOf(name);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value.`);
    }
    return value;
  };
  const full = argv.includes("--full");
  const incremental = argv.includes("--incremental");
  if (full && incremental) {
    throw new Error("--full and --incremental cannot be used together.");
  }

  const fromYearValue = valueAfter("--from-year");
  const toYearValue = valueAfter("--to-year");
  const pageSizeValue = valueAfter("--page-size");
  const delayValue = valueAfter("--delay-ms");
  const journalValue = valueAfter("--journals");

  return {
    requestedMode: full ? "full" : incremental ? "incremental" : "auto",
    allYears: argv.includes("--all-years"),
    fromYear:
      fromYearValue === null
        ? null
        : safeInteger(fromYearValue, "--from-year", {
            min: 1900,
            max: currentYear + 1,
          }),
    toYear:
      toYearValue === null
        ? currentYear
        : safeInteger(toYearValue, "--to-year", {
            min: 1900,
            max: currentYear + 1,
          }),
    pageSize:
      pageSizeValue === null
        ? null
        : safeInteger(pageSizeValue, "--page-size", {
            min: 1,
            max: 1000,
          }),
    delayMs:
      delayValue === null
        ? null
        : safeInteger(delayValue, "--delay-ms", {
            min: 0,
            max: 60_000,
          }),
    journalIds: journalValue
      ? journalValue
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : null,
  };
}

export function resolveCoverage({
  cli,
  mode,
  existingCoverage = null,
  defaultFromYear,
}) {
  const inheritsAllYears =
    mode === "incremental" &&
    cli.fromYear === null &&
    !cli.allYears &&
    existingCoverage?.allYears === true;
  const allYears = cli.allYears || inheritsAllYears;
  const inheritedFromYear =
    mode === "incremental" &&
    cli.fromYear === null &&
    !cli.allYears &&
    Number.isInteger(existingCoverage?.fromYear)
      ? existingCoverage.fromYear
      : null;
  return {
    allYears,
    fromYear: allYears
      ? null
      : (cli.fromYear ?? inheritedFromYear ?? defaultFromYear),
  };
}

function dateDaysBefore(isoDate, days, minimumYear) {
  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.valueOf())) return `${minimumYear}-01-01`;
  parsed.setUTCDate(parsed.getUTCDate() - days);
  const minimum = new Date(`${minimumYear}-01-01T00:00:00.000Z`);
  return (parsed < minimum ? minimum : parsed).toISOString().slice(0, 10);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadExisting(outputDir) {
  try {
    const manifest = await readJson(join(outputDir, "index.json"));
    const papers = Array.isArray(manifest.papers) ? [...manifest.papers] : [];
    for (const shard of manifest?.meta?.shards ?? []) {
      const relativeFile =
        cleanText(shard.file) || `by-year/${basename(cleanText(shard.url))}`;
      if (
        !/^by-year\/(?:\d{4}|unknown)(?:-\d{3})?\.json$/.test(relativeFile) ||
        relativeFile.includes("..")
      ) {
        throw new Error(`Unsafe Nature shard path: ${relativeFile}`);
      }
      const file = await readJson(join(outputDir, relativeFile));
      if (Array.isArray(file.papers)) papers.push(...file.papers);
    }
    return { manifest, papers };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, path);
}

function journalForPaper(paper, journals) {
  return journals.find(
    (journal) =>
      paper?.venue === journal.name ||
      paper?.nature?.journal === journal.name,
  );
}

export async function writeNatureIndex({
  outputDir,
  papers,
  generatedAt,
  mode,
  fromYear,
  toYear,
  allYears,
  journals,
  queries,
  hitCount,
  overlapDays,
}) {
  const sorted = sortNaturePapers(papers);
  const byYear = new Map();
  for (const paper of sorted) {
    const year = String(paper.year || "unknown");
    const values = byYear.get(year) ?? [];
    values.push(paper);
    byYear.set(year, values);
  }

  const shardDir = join(outputDir, "by-year");
  await mkdir(shardDir, { recursive: true });
  const shards = [];
  for (const [year, yearPapers] of [...byYear.entries()].sort(([a], [b]) =>
    b.localeCompare(a),
  )) {
    const chunks = splitPapersByByteBudget(yearPapers);
    for (const [chunkIndex, chunkPapers] of chunks.entries()) {
      const part = chunkIndex + 1;
      const file = `by-year/${year}-${String(part).padStart(3, "0")}.json`;
      const url = `/data/nature/${file}`;
      const payload = {
        meta: {
          generatedAt,
          source: `Europe PMC · Nature Portfolio (${year})`,
          sourceUrl: EUROPE_PMC_DOCS_URL,
          license: ARTICLE_LICENSE,
          paperCount: chunkPapers.length,
          conversationCount: 0,
          detailStorage: "metadata_only_remote_peer_review_file",
          year: year === "unknown" ? null : Number(year),
          part,
          partCount: chunks.length,
        },
        papers: chunkPapers,
      };
      const byteLength = Buffer.byteLength(
        `${JSON.stringify(payload)}\n`,
        "utf8",
      );
      if (byteLength >= MAX_SHARD_BYTES) {
        throw new Error(
          `Nature shard ${file} is ${byteLength} bytes; the limit is ${MAX_SHARD_BYTES - 1}.`,
        );
      }
      await writeJsonAtomic(join(outputDir, file), payload);
      shards.push({
        file,
        url,
        year: year === "unknown" ? null : Number(year),
        part,
        partCount: chunks.length,
        byteLength,
        paperCount: chunkPapers.length,
        conversationCount: 0,
      });
    }
  }

  const expectedShardNames = new Set(
    shards.map((shard) => basename(shard.file)),
  );
  for (const file of await readdir(shardDir)) {
    if (
      /^(?:\d{4}|unknown)(?:-\d{3})?\.json$/.test(file) &&
      !expectedShardNames.has(file)
    ) {
      await unlink(join(shardDir, file));
    }
  }

  const journalCounts = journals.map((journal) => ({
    id: journal.id,
    name: journal.name,
    europePmcJournal: journal.europePmcJournal,
    paperCount: sorted.filter(
      (paper) => journalForPaper(paper, [journal]) !== undefined,
    ).length,
  }));
  await writeJsonAtomic(join(outputDir, "index.json"), {
    meta: {
      schemaVersion: 1,
      generatedAt,
      source: "Europe PMC · Nature Portfolio peer-review file candidates",
      sourceUrl: EUROPE_PMC_DOCS_URL,
      license: ARTICLE_LICENSE,
      paperCount: sorted.length,
      conversationCount: 0,
      detailStorage: "metadata_only_remote_peer_review_file",
      updateMode: mode,
      coverage: {
        allYears,
        fromYear,
        toYear,
        journals: journalCounts,
      },
      discovery: {
        queryPhrase: QUERY_PHRASE,
        openAccessOnly: true,
        rawHitCount: hitCount,
        queries,
        incrementalOverlapDays: overlapDays,
      },
      shards,
    },
    papers: [],
  });
  return { papers: sorted, shards, journalCounts };
}

async function loadConfig() {
  const config = await readJson(CONFIG_PATH);
  if (
    config?.schemaVersion !== 1 ||
    !Array.isArray(config.journals) ||
    config.journals.length === 0
  ) {
    throw new Error("config/nature-journals.json is invalid.");
  }
  const ids = new Set();
  for (const journal of config.journals) {
    if (
      !/^[a-z0-9-]+$/.test(journal.id) ||
      !cleanText(journal.name) ||
      !cleanText(journal.europePmcJournal) ||
      ids.has(journal.id)
    ) {
      throw new Error(`Invalid or duplicate Nature journal: ${journal.id}`);
    }
    ids.add(journal.id);
  }
  return config;
}

export async function runUpdate({
  argv = process.argv.slice(2),
  outputDir = fileURLToPath(DEFAULT_OUTPUT_DIR),
  now = new Date(),
  fetchJson = fetchJsonWithRetry,
  sleep = wait,
  logger = console,
} = {}) {
  const config = await loadConfig();
  const cli = parseArguments(argv, now.getUTCFullYear());
  const existing = await loadExisting(outputDir);
  let mode =
    cli.requestedMode === "auto"
      ? existing
        ? "incremental"
        : "full"
      : cli.requestedMode;
  if (mode === "incremental" && !existing) {
    logger.warn("No existing Nature index was found; running a full update.");
    mode = "full";
  }

  const { allYears, fromYear } = resolveCoverage({
    cli,
    mode,
    existingCoverage: existing?.manifest?.meta?.coverage,
    defaultFromYear: config.defaultFromYear,
  });
  const toYear = cli.toYear;
  if (fromYear !== null && fromYear > toYear) {
    throw new Error("--from-year must not be later than --to-year.");
  }

  let journals = config.journals;
  if (cli.journalIds) {
    const requested = new Set(cli.journalIds);
    journals = config.journals.filter((journal) => requested.has(journal.id));
    const missing = [...requested].filter(
      (id) => !journals.some((journal) => journal.id === id),
    );
    if (missing.length) {
      throw new Error(`Unknown Nature journal id(s): ${missing.join(", ")}`);
    }
  }

  const retrievedAt = now.toISOString();
  const overlapDays = Number(config.incrementalOverlapDays) || 45;
  const fullTextCreatedFrom =
    mode === "incremental"
      ? dateDaysBefore(
          existing?.manifest?.meta?.generatedAt,
          overlapDays,
          fromYear ?? 1900,
        )
      : null;
  const fullTextCreatedTo =
    mode === "incremental" ? retrievedAt.slice(0, 10) : null;
  const pageSize = cli.pageSize ?? Number(config.pageSize) ?? 1000;
  const delayMs = cli.delayMs ?? Number(config.requestDelayMs) ?? 150;

  await mkdir(outputDir, { recursive: true });
  const fetched = [];
  let rawHitCount = 0;
  const queries = [];
  for (const journal of journals) {
    logger.log(
      `Europe PMC: indexing ${journal.name} (${mode}, ${
        fromYear ?? "all years"
      }–${toYear})…`,
    );
    const result = await fetchJournalIndex({
      journal,
      fromYear,
      toYear,
      fullTextCreatedFrom,
      fullTextCreatedTo,
      retrievedAt,
      pageSize,
      delayMs,
      fetchJson,
      sleep,
      onPage: ({ pageCount, hitCount: journalHitCount, indexedCount }) => {
        if (pageCount === 1 || pageCount % 10 === 0) {
          logger.log(
            `  ${journal.name}: ${indexedCount.toLocaleString()} / ${journalHitCount.toLocaleString()}`,
          );
        }
      },
    });
    fetched.push(...result.papers);
    rawHitCount += result.hitCount;
    queries.push({
      journalId: journal.id,
      query: result.query,
      hitCount: result.hitCount,
      pageCount: result.pageCount,
      indexedCount: result.papers.length,
    });
  }

  const selectedNames = new Set(journals.map((journal) => journal.name));
  const existingPapers =
    mode === "incremental"
      ? (existing?.papers ?? []).filter((paper) => {
          const inYear =
            (fromYear === null || paper.year >= fromYear) &&
            paper.year <= toYear;
          const knownJournal = config.journals.some(
            (journal) => journal.name === paper.venue,
          );
          const selectedOrPreserved =
            selectedNames.has(paper.venue) ||
            (cli.journalIds !== null && knownJournal);
          return inYear && selectedOrPreserved;
        })
      : [];
  const merged = new Map(existingPapers.map((paper) => [paper.id, paper]));
  for (const paper of fetched) merged.set(paper.id, paper);

  const outputJournals =
    mode === "incremental" && cli.journalIds
      ? config.journals.filter((journal) =>
          [...merged.values()].some((paper) => paper.venue === journal.name),
        )
      : journals;
  const result = await writeNatureIndex({
    outputDir,
    papers: merged.values(),
    generatedAt: retrievedAt,
    mode,
    fromYear,
    toYear,
    allYears,
    journals: outputJournals,
    queries,
    hitCount: rawHitCount,
    overlapDays,
  });
  logger.log(
    `Nature index: ${result.papers.length.toLocaleString()} metadata records across ${result.shards.length} year shard(s).`,
  );
  return result;
}

const isDirectExecution =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  runUpdate().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
