import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const CACHE_DIR = new URL("../.cache/re2/", import.meta.url);
const REVIEW_URL =
  "https://huggingface.co/datasets/Daoze/ReviewRebuttal/resolve/main/REVIEWS_test.json?download=true";
const REBUTTAL_URL =
  "https://huggingface.co/datasets/Daoze/ReviewRebuttal/resolve/main/REBUTTAL_test.json?download=true";
const force = process.argv.includes("--refresh");

const catalog = {
  "tUMr0Iox8XW": {
    title:
      "Efficient Computation of Deep Nonlinear Infinite-Width Neural Networks that Learn Features",
    authors: ["Greg Yang", "Michael Santacroce", "Edward J. Hu"],
    abstract:
      "A feature-learning infinite-width limit for deep nonlinear networks, with an emphasis on making the limit practical to compute.",
    topics: ["理论澄清", "方法有效性", "多轮追问"],
  },
  "7QfLW-XZTl": {
    title: "Energy-Inspired Molecular Conformation Optimization",
    authors: [
      "Jiaqi Guan",
      "Wesley Wei Qian",
      "Qiang Liu",
      "Wei-Ying Ma",
      "Jianzhu Ma",
      "Jian Peng",
    ],
    abstract:
      "The paper casts molecular conformation prediction as neural energy minimization and derives SE(3)-equivariant architectures from assumptions about the energy function.",
    topics: ["实验公平性", "方法澄清", "低分异议"],
  },
  HxzSxSxLOJZ: {
    title: "ResNet After All: Neural ODEs and Their Numerical Solution",
    authors: [
      "Katharina Ott",
      "Prateek Katiyar",
      "Philipp Hennig",
      "Michael Tiemann",
    ],
    abstract:
      "An investigation of how neural ODEs can exploit numerical discretization, and when their learned dynamics stop behaving like continuous ODEs.",
    topics: ["反例讨论", "理论边界", "Reviewer 被说服"],
  },
  hLbeJ6jObDD: {
    title: "Collaborative Pure Exploration in Kernel Bandit",
    authors: ["Yihan Du", "Wei Chen", "Yuko Kuroki", "Longbo Huang"],
    abstract:
      "A collaborative kernel-bandit model with fixed-confidence and fixed-budget algorithms, plus near-matching sampling and communication bounds.",
    topics: ["理论证明", "复杂度说明", "长讨论"],
  },
  "0eTTKOOOQkV": {
    title:
      "HiCLIP: Contrastive Language-Image Pretraining with Hierarchy-aware Attention",
    authors: [
      "Shijie Geng",
      "Jianbo Yuan",
      "Yu Tian",
      "Yuxiao Chen",
      "Yongfeng Zhang",
    ],
    abstract:
      "A hierarchy-aware attention mechanism for both visual and language branches of CLIP, designed to discover semantic hierarchies layer by layer.",
    topics: ["实验补充", "结构澄清", "迟到回复"],
  },
  "99RpBVpLiX": {
    title: "Distilling Model Failures as Directions in Latent Space",
    authors: [
      "Saachi Jain",
      "Hannah Lawrence",
      "Ankur Moitra",
      "Aleksander Madry",
    ],
    abstract:
      "A method for finding consistent failure modes as directions in feature space, then using them to caption hard subpopulations and generate targeted data.",
    topics: ["失败模式", "证据组织", "高分案例"],
  },
};

async function fetchCached(url, filename) {
  const target = new URL(filename, CACHE_DIR);
  if (!force && existsSync(target)) return JSON.parse(await readFile(target));

  const response = await fetch(url, {
    headers: {
      "User-Agent": "rebuttal-reader/0.1 (manual dataset update)",
    },
  });
  if (!response.ok) {
    throw new Error(`Dataset download failed (${response.status}) for ${filename}`);
  }
  const text = await response.text();
  await writeFile(target, text);
  return JSON.parse(text);
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function score(value) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function splitTitle(body, fallback) {
  const text = cleanText(body);
  const [firstLine, ...rest] = text.split("\n");
  if (/^title\s*:/i.test(firstLine)) {
    return {
      title: firstLine.replace(/^title\s*:\s*/i, "").trim() || fallback,
      body: rest.join("\n").trim(),
    };
  }
  return { title: fallback, body: text };
}

function normalizeThread(conversation, review, index) {
  const discussion = conversation.messages.slice(2);
  let reviewerTurns = 0;
  const messages = discussion.map((message, messageIndex) => {
    const author = message.role === "user";
    const firstReview = !author && reviewerTurns === 0;
    if (!author) reviewerTurns += 1;

    const kind = author
      ? "author_response"
      : firstReview
        ? "review"
        : "reviewer_followup";
    const fallback = author
      ? "Author response"
      : firstReview
        ? "Initial review"
        : "Reviewer follow-up";
    const parsed = splitTitle(message.content, fallback);

    return {
      id: `${conversation.paper_id}-${index + 1}-${messageIndex + 1}`,
      role: author ? "author" : "reviewer",
      kind,
      title: parsed.title,
      body: parsed.body,
    };
  });

  return {
    id: `${conversation.paper_id}-reviewer-${index + 1}`,
    label: `Reviewer ${String.fromCharCode(65 + index)}`,
    initialScore: score(review?.initial_score?.rating),
    finalScore: score(review?.final_score?.rating),
    initialScoreLabel:
      review?.initial_score?.rating && review.initial_score.rating !== "null"
        ? review.initial_score.rating
        : null,
    finalScoreLabel:
      review?.final_score?.rating && review.final_score.rating !== "null"
        ? review.final_score.rating
        : null,
    messages,
  };
}

await mkdir(CACHE_DIR, { recursive: true });
console.log("Refreshing the curated Re² rebuttal sample…");

const [reviews, rebuttals] = await Promise.all([
  fetchCached(REVIEW_URL, "REVIEWS_test.json"),
  fetchCached(REBUTTAL_URL, "REBUTTAL_test.json"),
]);

const reviewsByPaper = new Map(reviews.map((paper) => [paper.paper_id, paper]));
const conversationsByPaper = Map.groupBy(
  rebuttals.filter((item) => catalog[item.paper_id]),
  (item) => item.paper_id,
);
const retrievedAt = new Date().toISOString();

const papers = Object.entries(catalog)
  .map(([paperId, metadata]) => {
    const reviewRecord = reviewsByPaper.get(paperId);
    const conversations = conversationsByPaper.get(paperId) ?? [];
    if (!reviewRecord || conversations.length === 0) return null;

    const threads = conversations.map((conversation, index) =>
      normalizeThread(conversation, reviewRecord.reviews[index], index),
    );
    const yearMatch = reviewRecord.conference_year_track.match(/(?:19|20)\d{2}/);
    const before = reviewRecord.review_initial_ratings_unified ?? [];
    const after = reviewRecord.review_final_ratings_unified ?? [];

    return {
      id: paperId,
      title: metadata.title,
      authors: metadata.authors,
      venue: reviewRecord.conference_year_track,
      year: yearMatch ? Number(yearMatch[0]) : 0,
      materialType: "conference_rebuttal",
      decision: reviewRecord.decision,
      accepted: /accept|poster|spotlight|oral/i.test(reviewRecord.decision),
      abstract: metadata.abstract,
      topics: metadata.topics,
      scoreBefore: before,
      scoreAfter: after,
      metaReview: cleanText(reviewRecord.metareview) || null,
      threads,
      source: {
        type: "derived_dataset",
        label: "ReviewRebuttal / Re²",
        url: "https://huggingface.co/datasets/Daoze/ReviewRebuttal",
        originalUrl: `https://openreview.net/forum?id=${paperId}`,
        license: "Apache-2.0 dataset; original forum terms may vary",
        retrievedAt,
      },
    };
  })
  .filter(Boolean)
  .sort((a, b) => b.year - a.year || a.title.localeCompare(b.title));

await writeFile(
  new URL("../data/re2.generated.json", import.meta.url),
  `${JSON.stringify(
    {
      meta: {
        generatedAt: retrievedAt,
        source: "ReviewRebuttal / Re²",
        sourceUrl: "https://huggingface.co/datasets/Daoze/ReviewRebuttal",
        license: "Apache-2.0",
        paperCount: papers.length,
      },
      papers,
    },
    null,
    2,
  )}\n`,
);

console.log(`Re² update complete: ${papers.length} curated papers written.`);
