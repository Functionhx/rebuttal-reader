/**
 * Helpers for discovering Nature Portfolio transparent peer-review files in
 * Europe PMC full-text XML.
 *
 * The browser fallback fetches only Europe PMC's fixed XML endpoint. Attachment
 * URLs from the XML are never trusted: the parser accepts only a plain PDF
 * filename and constructs the public URL from a validated PMCID.
 */

export interface NaturePeerReviewFile {
  label: string;
  filename: string;
  url: string;
}

export const MAX_EUROPE_PMC_XML_BYTES = 12_000_000;

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

async function readResponseTextBounded(response: Response, byteCap: number) {
  if (!Number.isFinite(byteCap) || byteCap <= 0) {
    throw new TypeError("byteCap must be a positive finite number.");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > byteCap) {
      throw new Error("Europe PMC XML exceeded the safety limit.");
    }
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
        await reader.cancel().catch(() => undefined);
        throw new Error("Europe PMC XML exceeded the safety limit.");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

export async function fetchNaturePeerReviewFilesDirect(
  pmcid: string,
  {
    fetchImpl = fetch,
    signal,
    byteCap = MAX_EUROPE_PMC_XML_BYTES,
  }: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    byteCap?: number;
  } = {},
) {
  if (!isValidPmcid(pmcid)) {
    throw new TypeError("Invalid PMCID");
  }
  const endpoint = new URL(
    `/europepmc/webservices/rest/${pmcid}/fullTextXML`,
    "https://www.ebi.ac.uk",
  );
  const response = await fetchImpl(endpoint, {
    headers: { Accept: "application/xml, text/xml;q=0.9" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Europe PMC HTTP ${response.status}`);
  }
  if (response.url) {
    const responseUrl = new URL(response.url);
    if (
      responseUrl.origin !== endpoint.origin ||
      responseUrl.pathname !== endpoint.pathname ||
      responseUrl.search ||
      responseUrl.hash
    ) {
      throw new Error("Europe PMC returned an unexpected URL.");
    }
  }
  const xml = await readResponseTextBounded(response, byteCap);
  return parseNaturePeerReviewFiles(xml, pmcid);
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
