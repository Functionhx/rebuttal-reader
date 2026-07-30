import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isPublic,
  normalizeForum,
} from "../scripts/lib/openreview.mjs";

const registry = JSON.parse(
  await readFile(
    new URL("../config/venues.json", import.meta.url),
    "utf8",
  ),
);

test("public gate only accepts notes readable by everyone", () => {
  assert.equal(isPublic({ readers: ["everyone"] }), true);
  assert.equal(isPublic({ readers: ["Everyone"] }), true);
  assert.equal(isPublic({ readers: ["ICLR.cc/2025/Reviewers"] }), false);
});

test("normalizer builds a review-response-follow-up chain", () => {
  const root = {
    id: "paper-1",
    domain: "ICLR.cc/2025/Conference",
    readers: ["everyone"],
    license: "CC BY 4.0",
    content: {
      title: { value: "A Public Paper" },
      authors: { value: ["Author One", "Author Two"] },
      abstract: { value: "Abstract text." },
    },
    details: {
      replies: [
        {
          id: "review-1",
          forum: "paper-1",
          replyto: "paper-1",
          readers: ["everyone"],
          invitations: [
            "ICLR.cc/2025/Conference/-/Official_Review",
          ],
          cdate: 1,
          content: {
            title: { value: "Main concern" },
            review: { value: "The evidence is incomplete." },
            rating: { value: "5: marginal" },
          },
        },
        {
          id: "response-1",
          forum: "paper-1",
          replyto: "review-1",
          readers: ["everyone"],
          signatures: ["ICLR.cc/2025/Conference/Paper1/Authors"],
          invitations: [
            "ICLR.cc/2025/Conference/-/Author_Response",
          ],
          cdate: 2,
          content: {
            response: { value: "We added the requested experiment." },
          },
        },
        {
          id: "followup-1",
          forum: "paper-1",
          replyto: "response-1",
          readers: ["everyone"],
          signatures: ["ICLR.cc/2025/Conference/Reviewers"],
          invitations: [
            "ICLR.cc/2025/Conference/-/Official_Comment",
          ],
          cdate: 3,
          content: {
            comment: { value: "The new evidence resolves my concern." },
            rating: { value: "7: accept" },
          },
        },
        {
          id: "meta-1",
          forum: "paper-1",
          replyto: "paper-1",
          readers: ["everyone"],
          invitations: ["ICLR.cc/2025/Conference/-/Meta_Review"],
          cdate: 4,
          content: {
            metareview: { value: "The discussion resolved the main issue." },
          },
        },
        {
          id: "decision-1",
          forum: "paper-1",
          replyto: "paper-1",
          readers: ["everyone"],
          invitations: ["ICLR.cc/2025/Conference/-/Decision"],
          cdate: 5,
          content: { decision: { value: "Accept (Poster)" } },
        },
      ],
    },
  };

  const paper = normalizeForum(root, registry, "2026-07-30T00:00:00.000Z");
  assert.equal(paper.title, "A Public Paper");
  assert.equal(paper.decision, "Accept (Poster)");
  assert.equal(paper.metaReview, "The discussion resolved the main issue.");
  assert.equal(paper.threads.length, 1);
  assert.deepEqual(
    paper.threads[0].messages.map((message) => message.kind),
    ["review", "author_response", "reviewer_followup"],
  );
  assert.equal(paper.threads[0].initialScore, 5);
  assert.equal(paper.threads[0].finalScore, 7);
});
