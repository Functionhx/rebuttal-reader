import { readFile, writeFile } from "node:fs/promises";
import { normalizeForum } from "./lib/openreview.mjs";

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const forumId = flag("--forum");
const venueId = flag("--venue");
const requestedLimit = Number(flag("--limit") ?? 25);
const limit = Math.min(Math.max(requestedLimit, 1), 200);

if (!forumId && !venueId) {
  console.log(`Usage:
  npm run update:openreview -- --forum <forum-id>
  npm run update:openreview -- --venue <venue-id> --limit 50`);
  process.exit(0);
}

const registry = JSON.parse(
  await readFile(new URL("../config/venues.json", import.meta.url), "utf8"),
);

const headers = {
  Accept: "application/json",
  "User-Agent": "rebuttal-reader/0.1 (manual public-data update)",
};

if (process.env.OPENREVIEW_TOKEN) {
  headers.Authorization = `Bearer ${process.env.OPENREVIEW_TOKEN}`;
}

const query = new URLSearchParams({ details: "replies" });
if (forumId) {
  query.set("id", forumId);
} else {
  query.set("venueid", venueId);
  query.set("limit", String(limit));
}

const response = await fetch(`https://api2.openreview.net/notes?${query}`, {
  headers,
});
const payload = await response.json();

if (!response.ok) {
  if (response.status === 403 && /challenge/i.test(payload.message ?? "")) {
    throw new Error(
      "OpenReview requested challenge verification. Complete verification on openreview.net, or provide an OPENREVIEW_TOKEN, then run the command again.",
    );
  }
  throw new Error(
    `OpenReview request failed (${response.status}): ${payload.message ?? "unknown error"}`,
  );
}

const retrievedAt = new Date().toISOString();
const normalized = [];
const skipped = [];

for (const note of payload.notes ?? []) {
  try {
    normalized.push(normalizeForum(note, registry, retrievedAt));
  } catch (error) {
    skipped.push(error.message);
  }
}

const outputUrl = new URL("../data/openreview.generated.json", import.meta.url);
const existing = JSON.parse(await readFile(outputUrl, "utf8"));
const byId = new Map(existing.papers.map((paper) => [paper.id, paper]));
for (const paper of normalized) byId.set(paper.id, paper);
const papers = Array.from(byId.values()).sort((a, b) => b.year - a.year);

await writeFile(
  outputUrl,
  `${JSON.stringify(
    {
      meta: {
        generatedAt: retrievedAt,
        source: "OpenReview API",
        sourceUrl: "https://openreview.net/",
        license: "Per-note license",
        paperCount: papers.length,
      },
      papers,
    },
    null,
    2,
  )}\n`,
);

console.log(
  `OpenReview update complete: ${normalized.length} imported, ${skipped.length} private or unsupported forum(s) skipped.`,
);
if (skipped.length) {
  console.log(skipped.slice(0, 5).map((message) => `- ${message}`).join("\n"));
}
