import registry from "@/config/venues.json";
import type { IclrArchivePointer, PaperRecord } from "@/lib/types";
import { normalizeForum } from "@/scripts/lib/openreview.mjs";

export const runtime = "edge";

const DATASET = "MlouisBE/iclr-rebuttal-analysis";
const DATASET_URL = `https://huggingface.co/datasets/${DATASET}`;
const PAPER_ID_PATTERN = /^[A-Za-z0-9_-]{3,100}$/;
const FILE_PATTERN = /^ICLR\.cc_(20\d{2})\.json$/;
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;

interface DetailRequest {
  paperId?: unknown;
  pointer?: Partial<IclrArchivePointer>;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchWithRetry(url: string, init: RequestInit, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, redirect: "follow" });
    if (
      (response.status === 408 ||
        response.status === 429 ||
        response.status >= 500) &&
      attempt < 4
    ) {
      await response.body?.cancel();
      await wait(400 * 2 ** attempt);
      return fetchWithRetry(url, init, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= 4) throw error;
    await wait(400 * 2 ** attempt);
    return fetchWithRetry(url, init, attempt + 1);
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as DetailRequest;
    const paperId = cleanText(body.paperId);
    const pointer = body.pointer;
    const file = cleanText(pointer?.file);
    const fileMatch = file.match(FILE_PATTERN);
    const byteLength = Number(pointer?.byteLength);
    const start = Number(pointer?.start);
    const end = Number(pointer?.end);
    const year = Number(pointer?.year);

    if (
      !PAPER_ID_PATTERN.test(paperId) ||
      pointer?.dataset !== DATASET ||
      !fileMatch ||
      Number(fileMatch[1]) !== year ||
      !Number.isSafeInteger(byteLength) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > byteLength ||
      end - start > MAX_OBJECT_BYTES
    ) {
      return Response.json(
        { error: "Invalid ICLR archive pointer." },
        { status: 400 },
      );
    }

    const sourceUrl = `${DATASET_URL}/resolve/main/data/raw/${file}?download=true`;
    const response = await fetchWithRetry(sourceUrl, {
      headers: {
        Range: `bytes=${start}-${end - 1}`,
        "User-Agent": "rebuttal-reader/0.4",
      },
    });
    if (response.status !== 206) {
      throw new Error(
        `ICLR public archive returned HTTP ${response.status} instead of a byte range.`,
      );
    }

    const text = await response.text();
    const root = JSON.parse(text);
    if (cleanText(root?.id) !== paperId) {
      throw new Error("The archive range does not match the requested paper.");
    }
    root.domain = `ICLR.cc/${year}/Conference`;
    root.details = {
      ...(root.details ?? {}),
      replies: Array.isArray(root.interactions) ? root.interactions : [],
    };

    const paper = normalizeForum(
      root,
      registry,
      new Date().toISOString(),
    ) as PaperRecord;
    paper.source = {
      type: "openreview_archive",
      label: `ICLR ${year} public OpenReview archive`,
      url: DATASET_URL,
      originalUrl: `https://openreview.net/forum?id=${encodeURIComponent(
        paperId,
      )}`,
      license: String(
        root.license ?? "OpenReview public comments: CC BY 4.0",
      ),
      retrievedAt: new Date().toISOString(),
    };

    return Response.json(
      { paper },
      {
        headers: {
          "Cache-Control":
            "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        },
      },
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to read this ICLR public forum.",
      },
      { status: 502 },
    );
  }
}
