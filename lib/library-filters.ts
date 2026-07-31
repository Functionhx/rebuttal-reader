export interface VenueYearRecord {
  venue: string;
  year: number;
}

export function compactVenue(venue: string) {
  return venue.replace(/\s+Conference$/i, "");
}

export function venueOptionsForYear(
  papers: readonly VenueYearRecord[],
  year: string,
) {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    if (year !== "全部" && paper.year !== Number(year)) continue;
    const label = compactVenue(paper.venue);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [
    "全部",
    ...Array.from(counts)
      .sort(
        ([venueA, countA], [venueB, countB]) =>
          countB - countA || venueB.localeCompare(venueA),
      )
      .map(([label]) => label),
  ];
}

export function yearOptions(papers: readonly VenueYearRecord[]) {
  return [
    "全部",
    ...Array.from(new Set(papers.map((paper) => paper.year)))
      .sort((a, b) => b - a)
      .map(String),
  ];
}

export function venueExistsInYear(
  papers: readonly VenueYearRecord[],
  venue: string,
  year: string,
) {
  if (venue === "全部" || year === "全部") return true;
  return papers.some(
    (paper) =>
      paper.year === Number(year) && compactVenue(paper.venue) === venue,
  );
}
