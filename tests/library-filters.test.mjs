import assert from "node:assert/strict";
import test from "node:test";

import {
  compactVenue,
  venueExistsInYear,
  venueOptionsForYear,
  yearOptions,
} from "../lib/library-filters.ts";

const papers = [
  { venue: "ICLR 2026 Conference", year: 2026 },
  { venue: "ICLR 2026 Conference", year: 2026 },
  { venue: "Nature Communications", year: 2026 },
  { venue: "ICLR 2025 Conference", year: 2025 },
  { venue: "CVPR 2025", year: 2025 },
];

test("year is the primary facet and narrows the venue list", () => {
  assert.deepEqual(venueOptionsForYear(papers, "2026"), [
    "全部",
    "ICLR 2026",
    "Nature Communications",
  ]);
  assert.deepEqual(venueOptionsForYear(papers, "2025"), [
    "全部",
    "ICLR 2025",
    "CVPR 2025",
  ]);
  assert.deepEqual(venueOptionsForYear(papers, "全部"), [
    "全部",
    "ICLR 2026",
    "Nature Communications",
    "ICLR 2025",
    "CVPR 2025",
  ]);
});

test("the year list remains global so users can always switch years", () => {
  assert.deepEqual(yearOptions(papers), ["全部", "2026", "2025"]);
});

test("an incompatible venue is reset when the authoritative year changes", () => {
  assert.equal(
    venueExistsInYear(papers, "Nature Communications", "2026"),
    true,
  );
  assert.equal(
    venueExistsInYear(papers, "Nature Communications", "2025"),
    false,
  );
  assert.equal(venueExistsInYear(papers, "全部", "2025"), true);
  assert.equal(venueExistsInYear(papers, "CVPR 2025", "全部"), true);
  assert.equal(compactVenue("ICLR 2026 Conference"), "ICLR 2026");
});
