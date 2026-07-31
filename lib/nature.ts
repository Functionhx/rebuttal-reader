/**
 * Pure helpers for discovering Nature Portfolio transparent peer-review files
 * in Europe PMC full-text XML.
 *
 * This module never performs network requests and never trusts an attachment
 * URL supplied by the XML. It accepts only a plain PDF filename and constructs
 * the public Europe PMC URL from a validated PMCID.
 */

export interface NaturePeerReviewFile {
  label: string;
  filename: string;
  url: string;
}

const PMCID_PATTERN = /^PMC[1-9]\d{0,11}$/u;
const SAFE_PDF_FILENAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._()+ -]{0,238}\.pdf$/iu;
const PEER_REVIEW_CAPTION_PATTERN =
  /(?:\btransparent\s+peer[\s-]+review(?:\s+file)?\b|\bpeer[\s-]+review\s+file\b)/iu;

export function isValidPmcid(value: unknown): value is string {
  return typeof value === "string" && PMCID_PATTERN.test(value);
}

export function europePmcArticleUrl(pmcid: string): string {
  if (!isValidPmcid(pmcid)) {
    throw new TypeError("Invalid PMCID");
  }
  return `https://europepmc.org/articles/${pmcid}`;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9A-Fa-f]+)|([A-Za-z]+));/gu,
    (
      entity,
      decimal: string | undefined,
      hexadecimal: string | undefined,
      named: string | undefined,
    ) => {
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

      const codePoint = Number.parseInt(
        decimal ?? hexadecimal ?? "",
        hexadecimal ? 16 : 10,
      );
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
  return decodeXmlEntities(
    value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
      .replace(/<!--[\s\S]*?-->/gu, " ")
      .replace(/<[^>]*>/gu, " "),
  )
    .replace(/\s+/gu, " ")
    .trim();
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

function extractCaption(fragment: string): string {
  const match = fragment.match(
    /<(?:[A-Za-z_][\w.-]*:)?caption\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?caption\s*>/iu,
  );
  return match ? textFromMarkup(match[1]) : "";
}

function safePeerReviewFilename(href: string): string | null {
  const candidate = decodeXmlEntities(href).trim();
  if (
    !candidate ||
    candidate !== candidate.normalize("NFC") ||
    candidate.includes("/") ||
    candidate.includes("\\") ||
    candidate.includes("%") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    candidate === "." ||
    candidate === ".." ||
    /[\u0000-\u001F\u007F]/u.test(candidate) ||
    !SAFE_PDF_FILENAME_PATTERN.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function peerReviewFileUrl(pmcid: string, filename: string): string | null {
  if (!isValidPmcid(pmcid)) return null;
  const safeFilename = safePeerReviewFilename(filename);
  if (!safeFilename) return null;

  const url = new URL(
    `/articles/${pmcid}/bin/${encodeURIComponent(safeFilename)}`,
    "https://europepmc.org",
  );
  const expectedPath = `/articles/${pmcid}/bin/${encodeURIComponent(safeFilename)}`;
  if (
    url.protocol !== "https:" ||
    url.hostname !== "europepmc.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== expectedPath ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url.toString();
}

/**
 * Extracts only PDF media elements whose surrounding supplementary-material
 * caption explicitly identifies a transparent peer-review file.
 */
export function parseNaturePeerReviewFiles(
  xml: string,
  pmcid: string,
): NaturePeerReviewFile[] {
  if (!isValidPmcid(pmcid) || typeof xml !== "string" || !xml) return [];

  const files: NaturePeerReviewFile[] = [];
  const seen = new Set<string>();
  const supplementaryPattern =
    /<(?:[A-Za-z_][\w.-]*:)?supplementary-material\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?supplementary-material\s*>/giu;

  for (const supplementaryMatch of xml.matchAll(supplementaryPattern)) {
    const fragment = supplementaryMatch[1];
    const label = extractCaption(fragment);
    if (!label || !PEER_REVIEW_CAPTION_PATTERN.test(label)) continue;

    const mediaPattern = /<(?:[A-Za-z_][\w.-]*:)?media\b[^>]*\/?>/giu;
    for (const mediaMatch of fragment.matchAll(mediaPattern)) {
      const attributes = parseTagAttributes(mediaMatch[0]);
      const href =
        attributes.get("xlink:href") ??
        attributes.get("href") ??
        "";
      const filename = safePeerReviewFilename(href);
      if (!filename) continue;

      const url = peerReviewFileUrl(pmcid, filename);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      files.push({
        label: Array.from(label).slice(0, 160).join(""),
        filename,
        url,
      });
    }
  }

  return files;
}
