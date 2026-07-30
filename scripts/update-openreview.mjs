import { mkdir, readFile, writeFile } from "node:fs/promises";
import { normalizeForum } from "./lib/openreview.mjs";

const args = process.argv.slice(2);
const API_URL = "https://api2.openreview.net";
const PAGE_SIZE = 1_000;
const INDEX_URL = new URL(
  "../public/data/openreview/index.json",
  import.meta.url,
);
const DETAIL_DIR = new URL(
  "../public/data/openreview/papers/",
  import.meta.url,
);
const META_URL = new URL(
  "../data/openreview.generated.json",
  import.meta.url,
);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const forumId = flag("--forum");
const venueId = flag("--venue");
const allVenues = args.includes("--all");
const requestedLimit = flag("--limit");
const maxPerVenue = requestedLimit
  ? Math.max(1, Number(requestedLimit))
  : Number.POSITIVE_INFINITY;

if (!forumId && !venueId && !allVenues) {
  console.log(`Usage:
  npm run update:openreview -- --forum <forum-id>
  npm run update:openreview -- --venue <venue-id>
  npm run update:openreview -- --all

Optional:
  --limit <n>    Stop after n submissions per venue.`);
  process.exit(0);
}

const registry = JSON.parse(
  await readFile(new URL("../config/venues.json", import.meta.url), "utf8"),
);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function loginToken() {
  if (process.env.OPENREVIEW_TOKEN) return process.env.OPENREVIEW_TOKEN;
  if (
    !process.env.OPENREVIEW_USERNAME ||
    !process.env.OPENREVIEW_PASSWORD
  ) {
    return null;
  }

  const response = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "rebuttal-reader/0.3 (manual public-data update)",
    },
    body: JSON.stringify({
      id: process.env.OPENREVIEW_USERNAME,
      password: process.env.OPENREVIEW_PASSWORD,
      expiresIn: 60 * 60 * 12,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.token) {
    throw new Error(
      `OpenReview login failed (${response.status}): ${
        payload.message ?? "unknown error"
      }`,
    );
  }
  return payload.token;
}

const token = await loginToken();
const headers = {
  Accept: "application/json",
  "User-Agent": "rebuttal-reader/0.3 (manual public-data update)",
};
if (token) {
  headers.Authorization = `Bearer ${token}`;
  headers.Cookie = `openreview.accessToken=${token}`;
}

async function fetchJson(query, attempt = 0) {
  let response;
  try {
    response = await fetch(`${API_URL}/notes?${query}`, { headers });
  } catch (error) {
    if (attempt >= 6) throw error;
    await wait(Math.min(750 * 2 ** attempt, 12_000));
    return fetchJson(query, attempt + 1);
  }
  const payload = await response.json();

  if (
    (response.status === 429 || response.status >= 500) &&
    attempt < 6
  ) {
    await wait(Math.min(750 * 2 ** attempt, 12_000));
    return fetchJson(query, attempt + 1);
  }
  if (!response.ok) {
    if (
      response.status === 403 &&
      /challenge/i.test(payload.message ?? "")
    ) {
      throw new Error(
        "OpenReview requires a verified API session for bulk updates. Set OPENREVIEW_TOKEN, or set OPENREVIEW_USERNAME and OPENREVIEW_PASSWORD locally, then run the command again. Site visitors never need these credentials.",
      );
    }
    throw new Error(
      `OpenReview request failed (${response.status}): ${
        payload.message ?? "unknown error"
      }`,
    );
  }
  return payload;
}

async function fetchForum(id) {
  const query = new URLSearchParams({
    id,
    details: "replies",
  });
  const payload = await fetchJson(query);
  return payload.notes ?? [];
}

async function fetchInvitation(invitation, limit) {
  const notes = [];
  let offset = 0;

  while (notes.length < limit) {
    const batchSize = Math.min(
      PAGE_SIZE,
      Number.isFinite(limit) ? limit - notes.length : PAGE_SIZE,
    );
    const query = new URLSearchParams({
      invitation,
      details: "replies",
      limit: String(batchSize),
      offset: String(offset),
    });
    const payload = await fetchJson(query);
    const batch = payload.notes ?? [];
    notes.push(...batch);
    console.log(
      `${invitation}: ${notes.length.toLocaleString()} submissions read`,
    );
    if (batch.length < batchSize) break;
    offset += batch.length;
  }
  return notes;
}

async function fetchVenue(id, limit) {
  const config = registry[id] ?? registry._fallback;
  const invitationNames = config.submission ?? [
    "Submission",
    "Blind_Submission",
  ];
  const byId = new Map();

  for (const name of invitationNames) {
    const invitation = `${id}/-/${name}`;
    const remaining = Number.isFinite(limit)
      ? Math.max(0, limit - byId.size)
      : Number.POSITIVE_INFINITY;
    if (remaining === 0) break;
    const notes = await fetchInvitation(invitation, remaining);
    for (const note of notes) byId.set(note.id, note);
  }
  return Array.from(byId.values());
}

let roots = [];
if (forumId) {
  roots = await fetchForum(forumId);
} else {
  const venues = allVenues
    ? Object.keys(registry).filter((key) => key !== "_fallback")
    : [venueId];
  const byId = new Map();
  for (const id of venues) {
    const notes = await fetchVenue(id, maxPerVenue);
    for (const note of notes) byId.set(note.id, note);
  }
  roots = Array.from(byId.values());
}

const retrievedAt = new Date().toISOString();
const normalized = [];
const skipped = [];

for (const note of roots) {
  try {
    normalized.push(normalizeForum(note, registry, retrievedAt));
  } catch (error) {
    skipped.push(error instanceof Error ? error.message : String(error));
  }
}

await mkdir(DETAIL_DIR, { recursive: true });
for (const paper of normalized) {
  const detailUrl = new URL(
    `${encodeURIComponent(paper.id)}.json`,
    DETAIL_DIR,
  );
  await writeFile(detailUrl, `${JSON.stringify(paper)}\n`);
}

let existingIndex;
try {
  existingIndex = JSON.parse(await readFile(INDEX_URL, "utf8"));
} catch {
  existingIndex = { papers: [] };
}

const summaries = normalized.map((paper) => ({
  id: paper.id,
  title: paper.title,
  titleKind: paper.titleKind ?? "paper_title",
  venue: paper.venue,
  year: paper.year,
  decision: paper.decision,
  accepted: paper.accepted,
  topics: paper.topics,
  scoreBefore: paper.scoreBefore,
  scoreAfter: paper.scoreAfter,
  reviewCount: paper.threads.filter((thread) =>
    thread.messages.some((message) => message.kind === "review"),
  ).length,
  rebuttalRanges: [],
  reviewRange: null,
  paperZip: null,
  reviewBench: null,
  detailUrl: `/data/openreview/papers/${encodeURIComponent(paper.id)}.json`,
  source: paper.source,
}));

const byId = new Map(
  (existingIndex.papers ?? []).map((paper) => [paper.id, paper]),
);
for (const paper of summaries) byId.set(paper.id, paper);
const papers = Array.from(byId.values()).sort(
  (a, b) =>
    b.year - a.year ||
    a.venue.localeCompare(b.venue) ||
    a.title.localeCompare(b.title),
);

await writeFile(
  INDEX_URL,
  `${JSON.stringify({
    meta: {
      generatedAt: retrievedAt,
      source: "OpenReview API",
      sourceUrl: "https://openreview.net/",
      license: "Per-note license",
      paperCount: papers.length,
      conversationCount: papers.reduce(
        (count, paper) => count + paper.reviewCount,
        0,
      ),
      detailStorage: "static_per_paper_json",
    },
    papers,
  })}\n`,
);

await writeFile(
  META_URL,
  `${JSON.stringify(
    {
      meta: {
        generatedAt: retrievedAt,
        source: "OpenReview API",
        sourceUrl: "https://openreview.net/",
        license: "Per-note license",
        paperCount: papers.length,
      },
      papers: [],
    },
    null,
    2,
  )}\n`,
);

console.log(
  `OpenReview update complete: ${normalized.length.toLocaleString()} papers imported, ${skipped.length.toLocaleString()} private, response-free, or unsupported forums skipped.`,
);
if (skipped.length) {
  console.log(skipped.slice(0, 8).map((message) => `- ${message}`).join("\n"));
}
