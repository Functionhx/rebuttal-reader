import {
  europePmcArticleUrl,
  isValidPmcid,
  parseNaturePeerReviewFiles,
} from "../../../lib/nature.ts";

export const runtime = "edge";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
};
const MAX_REQUEST_BYTES = 1_024;
const MAX_XML_BYTES = 12_000_000;
const UPSTREAM_TIMEOUT_MS = 10_000;
const EUROPE_PMC_API_ORIGIN = "https://www.ebi.ac.uk";
const APP_USER_AGENT =
  "RebuttalReader/0.1 (+https://github.com/Functionhx/rebuttal-reader)";

class NatureApiError extends Error {
  readonly status: number;
  readonly code:
    | "http"
    | "invalid_response"
    | "network"
    | "timeout"
    | "too_large";

  constructor(
    status: number,
    code:
      | "http"
      | "invalid_response"
      | "network"
      | "timeout"
      | "too_large",
  ) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: NO_STORE_HEADERS,
  });
}

async function readTextBounded(
  stream: ReadableStream<Uint8Array> | null,
  declaredLength: string | null,
  byteCap: number,
) {
  const length = Number(declaredLength);
  if (Number.isFinite(length) && length > byteCap) {
    throw new NatureApiError(502, "too_large");
  }
  if (!stream) return "";

  const reader = stream.getReader();
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
        throw new NatureApiError(502, "too_large");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

async function readRequestBody(request: Request) {
  try {
    return await readTextBounded(
      request.body,
      request.headers.get("content-length"),
      MAX_REQUEST_BYTES,
    );
  } catch (error) {
    if (error instanceof NatureApiError && error.code === "too_large") {
      throw new TypeError("Request body is too large.");
    }
    throw error;
  }
}

async function fetchEuropePmcXml(pmcid: string) {
  const endpoint = new URL(
    `/europepmc/webservices/rest/${pmcid}/fullTextXML`,
    EUROPE_PMC_API_ORIGIN,
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/xml, text/xml;q=0.9",
        "User-Agent": APP_USER_AGENT,
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (
      response.url &&
      (new URL(response.url).origin !== EUROPE_PMC_API_ORIGIN ||
        new URL(response.url).pathname !== endpoint.pathname ||
        new URL(response.url).search ||
        new URL(response.url).hash)
    ) {
      throw new NatureApiError(502, "invalid_response");
    }
    if (!response.ok) {
      throw new NatureApiError(response.status, "http");
    }

    return await readTextBounded(
      response.body,
      response.headers.get("content-length"),
      MAX_XML_BYTES,
    );
  } catch (error) {
    if (error instanceof NatureApiError) throw error;
    if (controller.signal.aborted) {
      throw new NatureApiError(504, "timeout");
    }
    throw new NatureApiError(502, "network");
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    const rawBody = await readRequestBody(request);
    body = JSON.parse(rawBody) as unknown;
  } catch (error) {
    const message =
      error instanceof TypeError && error.message === "Request body is too large."
        ? error.message
        : "Send a valid JSON body.";
    return json({ error: message }, 400);
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !Object.hasOwn(body, "pmcid")
  ) {
    return json({ error: "Only the pmcid field is supported." }, 400);
  }

  const pmcid = (body as { pmcid?: unknown }).pmcid;
  if (!isValidPmcid(pmcid)) {
    return json(
      { error: "pmcid must be an uppercase identifier such as PMC11997106." },
      400,
    );
  }

  const europePmcUrl = europePmcArticleUrl(pmcid);
  try {
    const xml = await fetchEuropePmcXml(pmcid);
    const peerReviewFiles = parseNaturePeerReviewFiles(xml, pmcid);
    if (peerReviewFiles.length === 0) {
      return json(
        {
          error: "No transparent peer-review PDF was found in Europe PMC.",
          pmcid,
          europePmcUrl,
          peerReviewFiles,
        },
        404,
      );
    }

    return json({
      pmcid,
      europePmcUrl,
      peerReviewFiles,
    });
  } catch (error) {
    if (error instanceof NatureApiError) {
      const status =
        error.code === "timeout" ? 504 : error.code === "http" && error.status === 404 ? 404 : 502;
      const message =
        error.code === "timeout"
          ? "Europe PMC took too long to respond."
          : error.code === "too_large"
            ? "The Europe PMC XML response exceeded the safety limit."
            : error.code === "http" && error.status === 404
              ? "Europe PMC has no full-text XML for this PMCID."
              : "Europe PMC could not be queried safely.";
      return json(
        {
          error: message,
          code: error.code,
          pmcid,
          europePmcUrl,
          peerReviewFiles: [],
        },
        status,
      );
    }
    return json(
      {
        error: "Europe PMC could not be queried safely.",
        pmcid,
        europePmcUrl,
        peerReviewFiles: [],
      },
      502,
    );
  }
}
