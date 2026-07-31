import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  GET,
  POST,
} from "../app/api/assistant/route.ts";

const originalFetch = globalThis.fetch;
const originalKey = process.env.DEEPSEEK_API_KEY;
const originalModel = process.env.DEEPSEEK_MODEL;
const originalAllowPublic = process.env.DEEPSEEK_ALLOW_PUBLIC;

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnvironment("DEEPSEEK_API_KEY", originalKey);
  restoreEnvironment("DEEPSEEK_MODEL", originalModel);
  restoreEnvironment("DEEPSEEK_ALLOW_PUBLIC", originalAllowPublic);
});

function localRequest(payload) {
  return new Request("http://localhost/api/assistant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const basicPayload = {
  mode: "read",
  locale: "zh-CN",
  currentPaper: {
    id: "paper-1",
    title: "A Paper",
    venue: "ICLR 2026",
    threads: [
      {
        label: "Reviewer 1",
        messages: [
          {
            role: "reviewer",
            kind: "review",
            body: "Please clarify the ablation.",
          },
          {
            role: "author",
            kind: "author_response",
            body: "We clarify the existing ablation in Table 2.",
          },
        ],
      },
    ],
  },
  evidence: [],
  question: "What remains unresolved?",
};

test("GET reports safe configuration metadata without exposing a key", async () => {
  process.env.DEEPSEEK_API_KEY = "unit-test-secret";
  process.env.DEEPSEEK_MODEL = "not-an-allowed-model";
  delete process.env.DEEPSEEK_ALLOW_PUBLIC;

  const response = await GET(
    new Request("http://localhost/api/assistant"),
  );
  const text = await response.text();
  const body = JSON.parse(text);

  assert.deepEqual(body, {
    configured: true,
    model: "deepseek-v4-flash",
    localOnly: true,
  });
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.doesNotMatch(text, /unit-test-secret/);
});

test("GET hides a configured key from public hosts without explicit opt-in", async () => {
  process.env.DEEPSEEK_API_KEY = "unit-test-secret";
  delete process.env.DEEPSEEK_ALLOW_PUBLIC;

  const response = await GET(
    new Request("https://reader.example/api/assistant"),
  );

  assert.deepEqual(await response.json(), {
    configured: false,
    model: "deepseek-v4-flash",
    localOnly: true,
  });
});

test("POST refuses non-local use unless it is explicitly enabled", async () => {
  process.env.DEEPSEEK_API_KEY = "unit-test-secret";
  delete process.env.DEEPSEEK_ALLOW_PUBLIC;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };

  const response = await POST(
    new Request("https://reader.example/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(basicPayload),
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(called, false);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.doesNotMatch(await response.text(), /unit-test-secret/);
});

test("POST calls DeepSeek with grounded prompts and thinking disabled", async () => {
  process.env.DEEPSEEK_API_KEY = "unit-test-secret";
  process.env.DEEPSEEK_MODEL = "deepseek-v4-pro";
  delete process.env.DEEPSEEK_ALLOW_PUBLIC;

  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init, body: JSON.parse(init.body) };
    return Response.json({
      choices: [
        {
          message: {
            content: "仍未解决的是消融设置的说明。[Current]",
          },
        },
      ],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 24,
        total_tokens: 144,
      },
    });
  };

  const response = await POST(localRequest(basicPayload));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    model: "deepseek-v4-pro",
    content: "仍未解决的是消融设置的说明。[Current]",
    usage: {
      promptTokens: 120,
      completionTokens: 24,
      totalTokens: 144,
    },
  });
  assert.equal(upstreamRequest.url, "https://api.deepseek.com/chat/completions");
  assert.equal(
    upstreamRequest.init.headers.Authorization,
    "Bearer unit-test-secret",
  );
  assert.equal(upstreamRequest.body.stream, false);
  assert.deepEqual(upstreamRequest.body.thinking, { type: "disabled" });
  assert.equal(upstreamRequest.body.max_tokens, 1_400);
  assert.equal(upstreamRequest.body.model, "deepseek-v4-pro");
  assert.match(
    upstreamRequest.body.messages[0].content,
    /Never invent experiments, results, scores, citations/,
  );
  assert.match(
    upstreamRequest.body.messages[0].content,
    /Write in Simplified Chinese/,
  );
  assert.match(
    upstreamRequest.body.messages[1].content,
    /What remains unresolved\?/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.doesNotMatch(JSON.stringify(body), /unit-test-secret/);
});

test("POST validates modes, nested fields, and the evidence limit", async () => {
  process.env.DEEPSEEK_API_KEY = "unit-test-secret";
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("fetch should not run");
  };

  const tooMuchEvidence = Array.from({ length: 6 }, (_, index) => ({
    id: `paper-${index}`,
  }));
  const response = await POST(
    localRequest({
      ...basicPayload,
      evidence: tooMuchEvidence,
    }),
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /at most 5 items/);
  assert.equal(called, false);

  const nestedResponse = await POST(
    localRequest({
      ...basicPayload,
      currentPaper: {
        id: "paper-1",
        unexpectedLargeField: "not accepted",
      },
    }),
  );
  assert.equal(nestedResponse.status, 400);
  assert.match(
    (await nestedResponse.json()).error,
    /unexpectedLargeField is not supported/,
  );
  assert.equal(called, false);
});

test("POST permits a public request only after explicit opt-in", async () => {
  process.env.DEEPSEEK_API_KEY = "unit-test-secret";
  process.env.DEEPSEEK_ALLOW_PUBLIC = "true";
  globalThis.fetch = async () =>
    Response.json({
      choices: [{ message: { content: "Grounded response." } }],
    });

  const response = await POST(
    new Request("https://reader.example/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...basicPayload,
        mode: "draft",
        locale: "en",
        reviewerComment: "Please add evidence.",
        draft: "We will address this.",
      }),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, "Grounded response.");
});
