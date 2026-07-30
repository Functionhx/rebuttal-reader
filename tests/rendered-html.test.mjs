import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the rebuttal reader", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>答辩录 · Rebuttal Reader<\/title>/i);
  assert.match(html, /从质疑到决定/);
  assert.match(html, /Conference rebuttal/);
  assert.match(html, /已记录初评/);
  assert.match(html, /逐 Reviewer 因果链/);
  assert.match(html, /ReviewRebuttal/);
  assert.doesNotMatch(html, /codex-preview|Building your site|SkeletonPreview/);
});
