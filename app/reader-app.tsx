"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  LibraryIndexFile,
  MessageKind,
  PaperIndexRecord,
  PaperRecord,
  ReviewThread,
  ThreadMessage,
} from "@/lib/types";
import {
  compactVenue,
  venueExistsInYear,
  venueOptionsForYear,
  yearOptions,
} from "@/lib/library-filters";
import { AiAssistant } from "./ai-assistant";
import { NatureDetail } from "./components/nature-detail";
import { DiscoveryDialog } from "./discovery-dialog";

type ViewMode = "chain" | "responses" | "decision";

interface ReaderAppProps {
  seedPapers: PaperRecord[];
  seedGeneratedAt: string | null;
}

interface RawMessage {
  role: "assistant" | "user" | "system";
  content: string;
}

interface RawRebuttal {
  paper_id: string;
  reviewer_id?: string;
  messages?: RawMessage[];
}

interface RawReviewScore {
  rating?: string | null;
}

interface RawReview {
  reviewer_id?: string;
  initial_score?: RawReviewScore;
  final_score?: RawReviewScore;
}

interface RawReviewRecord {
  paper_id: string;
  reviews?: RawReview[];
  metareview?: string | null;
  decision?: string | null;
}

interface DetailPayload {
  rebuttals: RawRebuttal[];
  review: RawReviewRecord | null;
  paperMetadata: {
    title: string | null;
    authorsText: string;
    abstract: string;
  } | null;
}

interface ReviewBenchDetailPayload {
  paper: PaperRecord;
}

const PAGE_SIZE = 50;
const SHARD_CONCURRENCY = 3;
const NATURE_SHARD_CONCURRENCY = 2;

const INDEX_ROOTS = [
  { url: "/data/re2/index.json", priority: 0, nature: false },
  { url: "/data/reviewbench/index.json", priority: 1, nature: false },
  {
    url: "/data/openreview-archive/index.json",
    priority: 2,
    nature: false,
  },
  { url: "/data/iclr-archive/index.json", priority: 3, nature: false },
  { url: "/data/openreview/index.json", priority: 4, nature: false },
  { url: "/data/nature/index.json", priority: 5, nature: true },
] as const;

interface IndexTask {
  url: string;
  priority: number;
  nature: boolean;
  depth: number;
}

interface IndexProgress {
  label: string;
  completed: number;
  total: number;
  failed: number;
}

const materialLabels = {
  conference_rebuttal: "Conference rebuttal",
  response_to_reviewers: "Response to reviewers",
  public_discussion: "Public discussion",
};

const eventLabels: Record<MessageKind, string> = {
  review: "初始 Review",
  author_response: "Author Response",
  reviewer_followup: "Reviewer Follow-up",
  public_comment: "Public Comment",
};

const sourceLabels: Record<PaperRecord["source"]["type"], string> = {
  derived_dataset: "Re² 派生数据",
  openreview_api: "OpenReview API",
  openreview_archive: "OpenReview 公共归档",
  nature_peer_review: "Europe PMC 开放索引",
  author_upload: "作者公开上传",
};

function formatDate(value: string | null) {
  if (!value) return "尚未更新";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function cleanText(value: unknown) {
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

function score(value: unknown) {
  const match = String(value ?? "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function splitTitle(body: unknown, fallback: string) {
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

function average(scores: number[]) {
  if (!scores.length) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function scoreDelta(paper: Pick<PaperRecord, "scoreBefore" | "scoreAfter">) {
  if (
    paper.scoreBefore.length === 0 ||
    paper.scoreBefore.length !== paper.scoreAfter.length
  ) {
    return null;
  }
  const before = average(paper.scoreBefore);
  const after = average(paper.scoreAfter);
  if (before === null || after === null) return null;
  return after - before;
}

function scoreTone(delta: number | null) {
  if (delta === null || Math.abs(delta) < 0.05) return "flat";
  return delta > 0 ? "up" : "down";
}

function scoreLabel(
  delta: number | null,
  beforeCount?: number,
  afterCount?: number,
) {
  if (delta === null) {
    if (beforeCount !== undefined && afterCount !== undefined) {
      return `评分记录：${beforeCount} 初评 / ${afterCount} 终评`;
    }
    return "评分记录不完整";
  }
  if (Math.abs(delta) < 0.05) return "均分持平";
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} 均分`;
}

function responseSignals(body: string) {
  const signals: string[] = [];
  if (/thank|appreciate|agree/i.test(body)) signals.push("先接住问题");
  if (/clarif|misunder|in fact|specifically/i.test(body))
    signals.push("澄清边界");
  if (/experiment|result|table|figure|appendix/i.test(body))
    signals.push("引用证据");
  if (
    /we (?:have )?(?:add|revise|change|include|fix)|will (?:add|revise|change|include|fix)/i.test(
      body,
    )
  ) {
    signals.push("明确改动");
  }
  return signals.slice(0, 3);
}

function seedSummary(paper: PaperRecord): PaperIndexRecord {
  return {
    id: paper.id,
    title: paper.title,
    titleKind: paper.titleKind ?? "paper_title",
    venue: paper.venue,
    year: paper.year,
    decision: paper.decision,
    accepted: paper.accepted,
    topics: paper.topics,
    scoreBefore: paper.scoreBefore,
    scoreAfter: paper.scoreAfter,
    reviewCount: paper.threads.length,
    rebuttalRanges: [],
    reviewRange: null,
    paperZip: null,
    reviewBench: null,
    openReviewArchive: null,
    iclrArchive: null,
    nature: null,
    detailUrl: null,
    source: paper.source,
  };
}

function normalizeThread(
  conversation: RawRebuttal,
  review: RawReview | undefined,
  paperId: string,
  index: number,
): ReviewThread {
  const discussion = Array.isArray(conversation.messages)
    ? conversation.messages.slice(2)
    : [];
  let reviewerTurns = 0;
  const messages: ThreadMessage[] = discussion.map((message, messageIndex) => {
    const author = message.role === "user";
    const firstReview = !author && reviewerTurns === 0;
    if (!author) reviewerTurns += 1;
    const kind: MessageKind = author
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
      id: `${paperId}-${index + 1}-${messageIndex + 1}`,
      role: author ? "author" : "reviewer",
      kind,
      title: parsed.title,
      body: parsed.body,
    };
  });

  return {
    id: `${paperId}-reviewer-${index + 1}`,
    label: `Reviewer ${String.fromCharCode(65 + (index % 26))}`,
    initialScore: score(review?.initial_score?.rating),
    finalScore: score(review?.final_score?.rating),
    initialScoreLabel: cleanText(review?.initial_score?.rating) || null,
    finalScoreLabel: cleanText(review?.final_score?.rating) || null,
    messages,
  };
}

function hydratePaper(
  summary: PaperIndexRecord,
  payload: DetailPayload,
): PaperRecord {
  const reviews = payload.review?.reviews ?? [];
  const reviewById = new Map(
    reviews
      .filter((item) => item.reviewer_id)
      .map((item) => [item.reviewer_id as string, item]),
  );
  const threads = payload.rebuttals.map((conversation, index) =>
    normalizeThread(
      conversation,
      (conversation.reviewer_id
        ? reviewById.get(conversation.reviewer_id)
        : undefined) ?? reviews[index],
      summary.id,
      index,
    ),
  );
  const resolvedTitle = cleanText(payload.paperMetadata?.title);
  const authorsText = cleanText(payload.paperMetadata?.authorsText);
  const abstract = cleanText(payload.paperMetadata?.abstract);

  return {
    id: summary.id,
    title: resolvedTitle || summary.title,
    titleKind: resolvedTitle ? "paper_title" : summary.titleKind,
    authors: authorsText ? [authorsText] : [],
    venue: summary.venue,
    year: summary.year,
    materialType: "conference_rebuttal",
    decision: cleanText(payload.review?.decision) || summary.decision,
    accepted: summary.accepted,
    abstract,
    topics: summary.topics,
    scoreBefore: summary.scoreBefore,
    scoreAfter: summary.scoreAfter,
    metaReview: cleanText(payload.review?.metareview) || null,
    threads,
    source: summary.source,
  };
}

function detailRequestFor(summary: PaperIndexRecord) {
  if (summary.iclrArchive) {
    return {
      url: "/api/iclr-archive?schema=title-kind-v1",
      body: {
        paperId: summary.id,
        pointer: summary.iclrArchive,
      },
    };
  }
  if (summary.openReviewArchive) {
    return {
      url: "/api/openreview-archive",
      body: {
        paperId: summary.id,
        pointer: summary.openReviewArchive,
      },
    };
  }
  if (summary.reviewBench) {
    return {
      url: "/api/reviewbench",
      body: {
        paperId: summary.id,
        pointer: summary.reviewBench,
      },
    };
  }
  if (summary.detailUrl) {
    return { url: summary.detailUrl, body: null };
  }
  return {
    url: "/api/re2",
    body: {
      paperId: summary.id,
      rebuttalRanges: summary.rebuttalRanges,
      reviewRange: summary.reviewRange,
      paperZip: summary.paperZip,
    },
  };
}

async function fetchPaperDetail(
  summary: PaperIndexRecord,
  signal?: AbortSignal,
): Promise<PaperRecord> {
  const request = detailRequestFor(summary);
  const response = await fetch(request.url, {
    method: request.body ? "POST" : "GET",
    headers: request.body
      ? { "Content-Type": "application/json" }
      : undefined,
    body: request.body ? JSON.stringify(request.body) : undefined,
    signal,
  });
  const payload = (await response.json()) as
    | DetailPayload
    | ReviewBenchDetailPayload
    | PaperRecord
    | { error?: string };
  if (!response.ok) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : `HTTP ${response.status}`,
    );
  }
  const detailPayload = payload as
    | DetailPayload
    | ReviewBenchDetailPayload
    | PaperRecord;
  const rawDetail =
    "paper" in detailPayload
      ? detailPayload.paper
      : "rebuttals" in detailPayload
        ? hydratePaper(summary, detailPayload)
        : detailPayload;
  return {
    ...rawDetail,
    titleKind: rawDetail.titleKind ?? summary.titleKind,
  };
}

function PaperCard({
  paper,
  selected,
  onSelect,
}: {
  paper: PaperIndexRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  const isNature = paper.source.type === "nature_peer_review" && paper.nature;
  const delta = scoreDelta(paper);
  return (
    <button
      type="button"
      className={`paper-card ${selected ? "is-selected" : ""}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="paper-card-topline">
        <span>{compactVenue(paper.venue)}</span>
        <span className={`delta delta-${scoreTone(delta)}`}>
          {isNature
            ? "透明同行评议"
            : scoreLabel(
                delta,
                paper.scoreBefore.length,
                paper.scoreAfter.length,
              )}
        </span>
      </span>
      <strong>{paper.title}</strong>
      {paper.titleKind !== "paper_title" && (
        <span className="title-origin">
          {paper.titleKind === "review_heading"
            ? "Reviewer 主题 · 非论文标题"
            : "仅有 Forum ID"}
        </span>
      )}
      <span className="paper-card-footer">
        <span>
          {isNature
            ? paper.nature?.doi || paper.nature?.pmcid
            : paper.decision.replace(/^Accept:\s*/i, "")}
        </span>
        <span>{isNature ? "点击核验" : `${paper.reviewCount} 位 Reviewer`}</span>
      </span>
    </button>
  );
}

function ScoreDots({
  scores,
  emptyLabel,
  final = false,
}: {
  scores: number[];
  emptyLabel: string;
  final?: boolean;
}) {
  if (!scores.length) {
    return <span className="score-empty">{emptyLabel}</span>;
  }
  return (
    <span className="score-dots" aria-label={scores.join("，")}>
      {scores.map((value, index) => (
        <span
          className={`score-dot ${final ? "is-final" : ""}`}
          key={`${value}-${index}`}
        >
          {value}
        </span>
      ))}
    </span>
  );
}

function ThreadSelector({
  threads,
  selected,
  onSelect,
}: {
  threads: ReviewThread[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="thread-selector" aria-label="选择审稿人">
      {threads.map((thread, index) => (
        <button
          type="button"
          key={thread.id}
          className={selected === index ? "is-active" : ""}
          onClick={() => onSelect(index)}
        >
          <span>{thread.label}</span>
          <span className="thread-score">
            {thread.initialScore ?? "—"} <i>→</i> {thread.finalScore ?? "—"}
          </span>
        </button>
      ))}
    </div>
  );
}

function MessageCard({
  message,
  turn,
  threadLabel,
}: {
  message: ThreadMessage;
  turn: number;
  threadLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const isLong = message.body.length > 1250;
  const body =
    isLong && !expanded
      ? `${message.body.slice(0, 1250).trimEnd()}…`
      : message.body;
  const signals =
    message.kind === "author_response" ? responseSignals(message.body) : [];

  return (
    <article className={`message-card message-${message.kind}`}>
      <div className="message-rail" aria-hidden="true">
        <span />
      </div>
      <div className="message-card-inner">
        <div className="message-kicker">
          <span>{eventLabels[message.kind]}</span>
          <span>
            {threadLabel ? `${threadLabel} · ` : ""}
            Turn {turn}
          </span>
        </div>
        <h3>{message.title}</h3>
        {signals.length > 0 && (
          <div className="signal-row" aria-label="回复结构信号">
            {signals.map((signal) => (
              <span key={signal}>{signal}</span>
            ))}
          </div>
        )}
        <div className="message-body">{body || "（此条消息没有正文）"}</div>
        {isLong && (
          <button
            type="button"
            className="text-button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            {expanded ? "收起" : "展开全文"}
          </button>
        )}
      </div>
    </article>
  );
}

function ThreadTimeline({ thread }: { thread: ReviewThread }) {
  return (
    <div className="timeline">
      <div className="thread-intro">
        <div>
          <span>该线程评分</span>
          <strong>
            {thread.initialScore ?? "未记录"} <i>→</i>{" "}
            {thread.finalScore ?? "未记录"}
          </strong>
        </div>
        <p>“—” 表示数据源没有保存该时点评分，不把缺失值猜成未评分。</p>
      </div>
      {thread.messages.map((message, index) => (
        <MessageCard message={message} turn={index + 1} key={message.id} />
      ))}
    </div>
  );
}

function AuthorResponses({ paper }: { paper: PaperRecord }) {
  const responses = paper.threads.flatMap((thread) =>
    thread.messages
      .filter((message) => message.kind === "author_response")
      .map((message) => ({ message, threadLabel: thread.label })),
  );

  return (
    <div className="timeline">
      <div className="mode-intro">
        <span className="eyebrow">学习模式</span>
        <h2>只读作者怎么答</h2>
        <p>
          已把所有 Reviewer 下的作者回复汇总到一起。结构信号是扫读提示，不是对回复质量的自动评分。
        </p>
      </div>
      {responses.map(({ message, threadLabel }, index) => (
        <MessageCard
          message={message}
          threadLabel={threadLabel}
          turn={index + 1}
          key={message.id}
        />
      ))}
    </div>
  );
}

function DecisionView({ paper }: { paper: PaperRecord }) {
  return (
    <div className="decision-view">
      <div className="decision-stamp">
        <span>Final decision</span>
        <strong>{paper.decision}</strong>
        <p>
          {paper.scoreBefore.length} 个已记录初评分 · {paper.scoreAfter.length}{" "}
          个最终评分
        </p>
      </div>
      <section className="meta-review">
        <span className="eyebrow">Meta-review / decision context</span>
        <h2>最终判断依据</h2>
        <div className="message-body">
          {paper.metaReview || "该数据源没有保存 Meta-review 正文。"}
        </div>
      </section>
    </div>
  );
}

function ReadingAside({
  paper,
  currentThread,
}: {
  paper: PaperRecord;
  currentThread: ReviewThread;
}) {
  const authorTurns = paper.threads.reduce(
    (count, thread) =>
      count +
      thread.messages.filter((message) => message.role === "author").length,
    0,
  );
  const followups = paper.threads.reduce(
    (count, thread) =>
      count +
      thread.messages.filter(
        (message) => message.kind === "reviewer_followup",
      ).length,
    0,
  );

  return (
    <aside className="reading-aside">
      <section>
        <span className="aside-label">本篇速览</span>
        <dl>
          <div>
            <dt>作者回复</dt>
            <dd>{authorTurns} 次</dd>
          </div>
          <div>
            <dt>Reviewer 跟进</dt>
            <dd>{followups} 次</dd>
          </div>
          <div>
            <dt>当前线程</dt>
            <dd>{currentThread.messages.length} turns</dd>
          </div>
        </dl>
      </section>
      <section className="reading-note">
        <span className="aside-label">怎么读</span>
        <ol>
          <li>先看 Reviewer 真正在质疑什么。</li>
          <li>再看作者有没有给证据，而不只是解释。</li>
          <li>最后检查 Reviewer 的追问是否收敛。</li>
        </ol>
      </section>
      <section>
        <span className="aside-label">来源与边界</span>
        <p>
          {paper.source.type === "author_upload"
            ? "材料由作者公开上传并经过线程重组与排版；权利与原始版本以来源链接为准。"
            : `${sourceLabels[paper.source.type]}经过线程重组与排版；原始 Forum 始终是 canonical source。`}
        </p>
        <dl className="provenance-list">
          <div>
            <dt>License</dt>
            <dd>{paper.source.license || "以源站为准"}</dd>
          </div>
          <div>
            <dt>Retrieved</dt>
            <dd>{formatDate(paper.source.retrievedAt)}</dd>
          </div>
        </dl>
        <a
          className="source-link"
          href={paper.source.originalUrl}
          target="_blank"
          rel="noreferrer"
        >
          {paper.source.type === "author_upload"
            ? "打开原始来源"
            : "打开原始 Forum"}{" "}
          <span aria-hidden="true">↗</span>
        </a>
      </section>
    </aside>
  );
}

function UpdateDialog({
  generatedAt,
  paperCount,
  conversationCount,
  onClose,
}: {
  generatedAt: string | null;
  paperCount: number;
  conversationCount: number;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          aria-label="关闭"
          onClick={onClose}
        >
          ×
        </button>
        <span className="eyebrow">Manual refresh</span>
        <h2 id="update-title">数据由你决定何时更新</h2>
        <p>
          当前索引有 {paperCount.toLocaleString()} 篇、{" "}
          {conversationCount.toLocaleString()} 条讨论，生成于{" "}
          {formatDate(generatedAt)}。网站没有后台常驻爬虫；部署包只保存轻量目录，
          正文会在你点开单篇时按 Forum 或安全字节范围读取并由 CDN 缓存。
        </p>
        <div className="command-block">
          <span>刷新全部公开目录</span>
          <code>npm run update:data</code>
        </div>
        <div className="command-block">
          <span>只刷新 2020–2026 多会议公开归档</span>
          <code>npm run update:reviewbench</code>
        </div>
        <div className="command-block">
          <span>刷新 OpenReview 公共历史归档</span>
          <code>npm run update:openreview-archive</code>
        </div>
        <div className="command-block">
          <span>刷新 ICLR 2026 公共讨论</span>
          <code>npm run update:iclr-archive</code>
        </div>
        <div className="command-block">
          <span>刷新 Nature Portfolio 开放同行评议索引</span>
          <code>npm run update:nature</code>
        </div>
        <div className="command-block">
          <span>补充一个公开 OpenReview Forum</span>
          <code>npm run update:openreview -- --forum &lt;forum-id&gt;</code>
        </div>
        <div className="privacy-rule">
          <strong>公开性闸门</strong>
          <span>
            OpenReview 增量适配器会逐条检查 readers 是否包含 everyone；
            无法确认公开权限的内容一律不进入目录。
          </span>
        </div>
      </section>
    </div>
  );
}

function ReaderState({
  title,
  body,
  action,
  loading = false,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  loading?: boolean;
}) {
  return (
    <main
      className={`reader-state${loading ? " is-loading" : ""}`}
      aria-busy={loading || undefined}
    >
      <span className="brand-mark">R/</span>
      {loading && (
        <div
          className="thinking-label"
          role="status"
          aria-live="polite"
          aria-label="thinking..."
        >
          <span aria-hidden="true">
            thinking
            <span className="thinking-dots">
              <i>.</i>
              <i>.</i>
              <i>.</i>
            </span>
          </span>
        </div>
      )}
      <h1>{title}</h1>
      <p>{body}</p>
      {loading && (
        <div
          className="loading-progress"
          role="progressbar"
          aria-label="正在加载"
        >
          <span />
        </div>
      )}
      {action}
    </main>
  );
}

export function ReaderApp({
  seedPapers,
  seedGeneratedAt,
}: ReaderAppProps) {
  const seedDetails = useMemo(
    () => new Map(seedPapers.map((paper) => [paper.id, paper])),
    [seedPapers],
  );
  const detailCache = useRef(new Map(seedDetails));
  const [papers, setPapers] = useState<PaperIndexRecord[]>(() =>
    seedPapers.map(seedSummary),
  );
  const [libraryMeta, setLibraryMeta] = useState({
    generatedAt: seedGeneratedAt,
    sourceCount: seedPapers.length ? 1 : 0,
    paperCount: seedPapers.length,
    conversationCount: seedPapers.reduce(
      (count, paper) => count + paper.threads.length,
      0,
    ),
  });
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState("");
  const [indexProgress, setIndexProgress] = useState<IndexProgress>({
    label: "核心目录",
    completed: 0,
    total: INDEX_ROOTS.length,
    failed: 0,
  });
  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState("全部");
  const [year, setYear] = useState("全部");
  const [page, setPage] = useState(0);
  const [selectedPaperId, setSelectedPaperId] = useState(
    seedPapers[0]?.id ?? "",
  );
  const [selectedPaper, setSelectedPaper] = useState<PaperRecord | null>(
    seedPapers[0] ?? null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailAttempt, setDetailAttempt] = useState(0);
  const [selectedThread, setSelectedThread] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("chain");
  const [showUpdate, setShowUpdate] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const aiTriggerRef = useRef<HTMLButtonElement>(null);
  const userSelectedPaperRef = useRef(false);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    if (!showLibrary) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowLibrary(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showLibrary]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const seedSummaries = seedPapers.map(seedSummary);
    const catalog = new Map<
      string,
      { paper: PaperIndexRecord; priority: number }
    >(
      seedSummaries.map((paper) => [
        paper.id,
        { paper, priority: Number.POSITIVE_INFINITY },
      ]),
    );
    const generatedDates = new Set<string>();
    if (seedGeneratedAt) generatedDates.add(seedGeneratedAt);
    const loadedLeafUrls = new Set<string>();
    const scheduledUrls = new Set(INDEX_ROOTS.map((root) => root.url));
    const requestedPaperId =
      typeof window === "undefined"
        ? ""
        : new URLSearchParams(window.location.search).get("paper") || "";
    let requestedPaperResolved = false;
    let failedLoads = 0;
    let shardCompleted = 0;
    let shardTotal = 0;

    const sortedCatalog = () =>
      Array.from(catalog.values(), ({ paper }) => paper).sort(
        (a, b) =>
          b.year - a.year ||
          a.venue.localeCompare(b.venue) ||
          a.title.localeCompare(b.title),
      );

    const publishCatalog = () => {
      if (cancelled) return;
      const merged = sortedCatalog();
      setPapers(merged);
      setLibraryMeta({
        generatedAt:
          Array.from(generatedDates).sort().at(-1) ?? seedGeneratedAt,
        sourceCount:
          loadedLeafUrls.size + (seedPapers.length > 0 ? 1 : 0),
        paperCount: merged.length,
        conversationCount: merged.reduce(
          (count, paper) => count + paper.reviewCount,
          0,
        ),
      });

      if (
        !requestedPaperResolved &&
        !userSelectedPaperRef.current &&
        requestedPaperId &&
        catalog.has(requestedPaperId)
      ) {
        requestedPaperResolved = true;
        const requested = catalog.get(requestedPaperId)?.paper;
        if (requested?.source.type === "nature_peer_review") {
          setSelectedPaper(null);
          setDetailLoading(false);
          setDetailError("");
          setShowAssistant(false);
        }
        setSelectedPaperId(requestedPaperId);
        return;
      }
      setSelectedPaperId((current) => current || merged[0]?.id || "");
    };

    const mergeIndex = (
      index: LibraryIndexFile,
      task: IndexTask,
      leaf: boolean,
    ) => {
      if (index.meta.generatedAt) {
        generatedDates.add(index.meta.generatedAt);
      }
      if (leaf || index.papers.length > 0) {
        loadedLeafUrls.add(task.url);
      }

      let changed = false;
      for (const paper of index.papers) {
        const current = catalog.get(paper.id);
        if (!current || task.priority > current.priority) {
          catalog.set(paper.id, { paper, priority: task.priority });
          changed = true;
        }
      }
      if (changed || leaf) publishCatalog();
    };

    const fetchIndex = async (task: IndexTask) => {
      const response = await fetch(task.url, {
        cache: "no-cache",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const index = (await response.json()) as LibraryIndexFile;
      if (
        !index ||
        !index.meta ||
        !Array.isArray(index.papers)
      ) {
        throw new Error("Invalid library index.");
      }
      return index;
    };

    const coreShardTasks: IndexTask[] = [];
    const natureShardTasks: IndexTask[] = [];

    const enqueueShards = (index: LibraryIndexFile, parent: IndexTask) => {
      if (parent.depth >= 2) return;
      for (const shard of index.meta.shards ?? []) {
        if (
          typeof shard.url !== "string" ||
          !shard.url.startsWith("/data/") ||
          scheduledUrls.has(shard.url)
        ) {
          continue;
        }
        scheduledUrls.add(shard.url);
        const task = {
          url: shard.url,
          priority: parent.priority,
          nature: parent.nature,
          depth: parent.depth + 1,
        };
        if (task.nature) natureShardTasks.push(task);
        else coreShardTasks.push(task);
        shardTotal += 1;
      }
    };

    async function loadIndex() {
      try {
        if (requestedPaperId && catalog.has(requestedPaperId)) {
          requestedPaperResolved = true;
          const requested = catalog.get(requestedPaperId)?.paper;
          if (requested?.source.type === "nature_peer_review") {
            setSelectedPaper(null);
            setDetailLoading(false);
            setDetailError("");
            setShowAssistant(false);
          }
          setSelectedPaperId(requestedPaperId);
        }

        let rootCompleted = 0;
        await Promise.all(
          INDEX_ROOTS.map(async (root) => {
            const task: IndexTask = { ...root, depth: 0 };
            try {
              const index = await fetchIndex(task);
              const leaf = !index.meta.shards?.length;
              mergeIndex(index, task, leaf);
              enqueueShards(index, task);
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                return;
              }
              failedLoads += 1;
            } finally {
              rootCompleted += 1;
              if (!cancelled) {
                setIndexProgress({
                  label: "核心目录",
                  completed: rootCompleted,
                  total: INDEX_ROOTS.length,
                  failed: failedLoads,
                });
              }
            }
          }),
        );

        if (cancelled) return;
        setIndexProgress({
          label: shardTotal > 0 ? "年份分片" : "核心目录",
          completed: 0,
          total: shardTotal || INDEX_ROOTS.length,
          failed: failedLoads,
        });

        const runQueue = async (
          tasks: IndexTask[],
          concurrency: number,
        ) => {
          let cursor = 0;
          const worker = async () => {
            while (!cancelled) {
              const task = tasks[cursor];
              cursor += 1;
              if (!task) return;

              try {
                const index = await fetchIndex(task);
                const leaf = !index.meta.shards?.length;
                mergeIndex(index, task, leaf);
                enqueueShards(index, task);
              } catch (error) {
                if (
                  error instanceof DOMException &&
                  error.name === "AbortError"
                ) {
                  return;
                }
                failedLoads += 1;
              } finally {
                shardCompleted += 1;
                if (!cancelled) {
                  setIndexProgress({
                    label: task.nature
                      ? "Nature 年份目录"
                      : "公开归档分片",
                    completed: shardCompleted,
                    total: shardTotal,
                    failed: failedLoads,
                  });
                }
              }
            }
          };

          await Promise.all(
            Array.from(
              { length: Math.min(concurrency, tasks.length) },
              () => worker(),
            ),
          );
        };

        await Promise.all([
          runQueue(coreShardTasks, SHARD_CONCURRENCY),
          runQueue(natureShardTasks, NATURE_SHARD_CONCURRENCY),
        ]);

        if (cancelled) return;
        if (catalog.size === 0) {
          throw new Error("No library index is available.");
        }
        publishCatalog();
        setIndexError(
          failedLoads > 0
            ? `${failedLoads} 个目录分片暂时无法读取，其余案例仍可正常浏览。`
            : "",
        );
      } catch {
        if (!cancelled) {
          setIndexError("完整索引暂时无法读取，请稍后刷新。");
        }
      } finally {
        if (!cancelled) setIndexLoading(false);
      }
    }
    loadIndex();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [seedGeneratedAt, seedPapers]);

  const selectedSummary = useMemo(
    () => papers.find((paper) => paper.id === selectedPaperId) ?? papers[0],
    [papers, selectedPaperId],
  );

  const loadPaperForAssistant = useCallback(
    async (summary: PaperIndexRecord, signal?: AbortSignal) => {
      if (summary.source.type === "nature_peer_review") {
        throw new Error("Nature 透明同行评议当前以官方文件形式阅读。");
      }
      const cached = detailCache.current.get(summary.id);
      if (cached) return cached;
      const detail = await fetchPaperDetail(summary, signal);
      detailCache.current.set(detail.id, detail);
      return detail;
    },
    [],
  );

  useEffect(() => {
    if (!selectedSummary) return;
    if (
      selectedSummary.source.type === "nature_peer_review" &&
      selectedSummary.nature
    ) {
      return;
    }
    const cached = detailCache.current.get(selectedSummary.id);
    if (cached) {
      setSelectedPaper(cached);
      setDetailLoading(false);
      setDetailError("");
      return;
    }

    const controller = new AbortController();
    setSelectedPaper(null);
    setDetailLoading(true);
    setDetailError("");

    fetchPaperDetail(selectedSummary, controller.signal)
      .then((detail) => {
        detailCache.current.set(detail.id, detail);
        setSelectedPaper(detail);
        setDetailLoading(false);
        if (
          detail.titleKind === "paper_title" &&
          detail.title !== selectedSummary.title
        ) {
          setPapers((current) =>
            current.map((paper) =>
              paper.id === detail.id
                ? { ...paper, title: detail.title, titleKind: "paper_title" }
                : paper,
            ),
          );
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDetailLoading(false);
        setDetailError(
          error instanceof Error
            ? error.message
            : "这篇的源数据暂时无法读取。",
        );
      });

    return () => controller.abort();
  }, [detailAttempt, selectedSummary]);

  const venues = useMemo(
    () => venueOptionsForYear(papers, year),
    [papers, year],
  );
  const years = useMemo(() => yearOptions(papers), [papers]);

  const filteredPapers = useMemo(() => {
    const normalized = deferredQuery.trim().toLowerCase();
    return papers.filter((paper) => {
      const venueMatch =
        venue === "全部" || compactVenue(paper.venue) === venue;
      const yearMatch = year === "全部" || paper.year === Number(year);
      const queryMatch =
        !normalized ||
        [
          paper.id,
          paper.title,
          paper.venue,
          paper.decision,
          paper.topics.join(" "),
          paper.nature?.pmcid,
          paper.nature?.doi,
          paper.nature?.authorString,
          paper.nature?.journal,
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return venueMatch && yearMatch && queryMatch;
    });
  }, [deferredQuery, papers, venue, year]);

  const pageCount = Math.max(1, Math.ceil(filteredPapers.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visiblePapers = filteredPapers.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );

  const choosePaper = useCallback((paperId: string) => {
    userSelectedPaperRef.current = true;
    setSelectedPaperId(paperId);
    setSelectedPaper((current) => (current?.id === paperId ? current : null));
    setSelectedThread(0);
    setViewMode("chain");
    setDetailError("");
    setShowAssistant(false);
    setShowLibrary(false);
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 979px)").matches
    ) {
      window.requestAnimationFrame(() => {
        document
          .getElementById("reading-workspace")
          ?.scrollIntoView({ block: "start" });
      });
    }
    if (typeof window !== "undefined") {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("paper", paperId);
      window.history.replaceState({}, "", nextUrl);
    }
  }, []);

  const closeAssistant = useCallback(() => {
    setShowAssistant(false);
    window.requestAnimationFrame(() => aiTriggerRef.current?.focus());
  }, []);

  const closeDiscovery = useCallback(() => {
    setShowDiscovery(false);
  }, []);

  const copyPaperLink = useCallback(async () => {
    if (typeof window === "undefined") return;
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("paper", selectedSummary?.id ?? "");
    try {
      await navigator.clipboard.writeText(nextUrl.toString());
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 1600);
    } catch {
      window.prompt("复制这篇案例的链接", nextUrl.toString());
    }
  }, [selectedSummary?.id]);

  if (indexLoading && papers.length === 0) {
    return (
      <ReaderState
        title="正在展开完整案例库"
        body="第一次会先读取轻量目录，正文只在你点开某篇时加载。"
        loading
      />
    );
  }

  if (!selectedSummary) {
    return (
      <ReaderState
        title="案例库还是空的"
        body={indexError || "运行完整更新后再重新构建网站。"}
      />
    );
  }

  const currentThread =
    selectedPaper?.threads[selectedThread] ?? selectedPaper?.threads[0];
  const delta = selectedPaper ? scoreDelta(selectedPaper) : null;
  const selectedIsNature =
    selectedSummary.source.type === "nature_peer_review" &&
    Boolean(selectedSummary.nature);

  return (
    <div className="reader-app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            R/
          </span>
          <div className="brand-lockup">
            <strong>答辩录</strong>
            <span>Rebuttal Reader</span>
          </div>
        </div>
        <span className="header-rule" aria-hidden="true" />
        <p className="app-purpose">公开同行评议的因果阅读器</p>
        <div className="header-meta">
          <span className="header-stat">
            <strong>{libraryMeta.paperCount.toLocaleString()}</strong>
            <small>公开案例</small>
          </span>
          <button
            type="button"
            className="header-action header-discovery"
            onClick={() => {
              setShowAssistant(false);
              setShowDiscovery(true);
            }}
          >
            Nature / GitHub 查找
          </button>
          <button
            type="button"
            className="header-action"
            onClick={() => setShowUpdate(true)}
          >
            数据与更新
          </button>
        </div>
        <button
          type="button"
          className="mobile-discovery-button"
          aria-label="使用 arXiv 跨 Nature、GitHub 与公开索引查找"
          onClick={() => {
            setShowAssistant(false);
            setShowDiscovery(true);
          }}
        >
          <span aria-hidden="true">⌕</span>
          arXiv 查找
        </button>
        <button
          type="button"
          className="mobile-library-button"
          aria-controls="case-library"
          aria-expanded={showLibrary}
          onClick={() => setShowLibrary(true)}
        >
          <span aria-hidden="true">☰</span>
          案例库
        </button>
      </header>

      <div className="reader-shell">
        <aside
          id="case-library"
          className={`library-panel ${showLibrary ? "is-mobile-open" : ""}`}
          aria-label="Rebuttal 案例库"
        >
          <div className="library-heading">
            <div>
              <span className="eyebrow">Public beta · case archive</span>
              <h2>从质疑到决定</h2>
            </div>
            <button
              type="button"
              className="library-close"
              aria-label="关闭案例库"
              onClick={() => setShowLibrary(false)}
            >
              ×
            </button>
          </div>
          <p className="library-description">
            OpenReview 讨论与 Nature Portfolio 透明同行评议已统一进入目录；
            详细讨论或官方文件只在点开单篇时读取。
          </p>
          <button
            type="button"
            className="library-discovery-button"
            onClick={() => {
              setShowAssistant(false);
              setShowDiscovery(true);
            }}
          >
            <span>
              <strong>用 arXiv 补查 Nature / GitHub</strong>
              <small>发现尚未进入目录的公开 Rebuttal 材料</small>
            </span>
            <b aria-hidden="true">→</b>
          </button>

          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder="标题、期刊、DOI、PMCID 或 Forum ID"
              aria-label="搜索案例"
            />
            {query && (
              <button
                type="button"
                aria-label="清空搜索"
                onClick={() => {
                  setQuery("");
                  setPage(0);
                }}
              >
                ×
              </button>
            )}
          </label>

          <div className="filter-grid">
            <label className="filter-control">
              <span>已收录会议 / 期刊</span>
              <select
                value={venue}
                onChange={(event) => {
                  setVenue(event.target.value);
                  setPage(0);
                }}
              >
                {venues.map((item) => (
                  <option value={item} key={item}>
                    {item === "全部" ? "全部已收录会议 / 期刊" : item}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-control">
              <span>年份</span>
              <select
                value={year}
                onChange={(event) => {
                  const nextYear = event.target.value;
                  setYear(nextYear);
                  if (
                    !venueExistsInYear(papers, venue, nextYear)
                  ) {
                    setVenue("全部");
                  }
                  setPage(0);
                }}
              >
                {years.map((item) => (
                  <option value={item} key={item}>
                    {item === "全部" ? "全部年份" : item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="result-summary" aria-live="polite">
            <span>
              <strong>{filteredPapers.length.toLocaleString()}</strong> 篇匹配
            </span>
            <span>
              {indexLoading
                ? `thinking... ${indexProgress.label} ${Math.min(
                    indexProgress.completed,
                    indexProgress.total,
                  )} / ${indexProgress.total}${
                    indexProgress.failed > 0
                      ? ` · ${indexProgress.failed} 暂缓`
                      : ""
                  }`
                : `${safePage + 1} / ${pageCount} 页`}
            </span>
            {(query || venue !== "全部" || year !== "全部") && (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  setVenue("全部");
                  setYear("全部");
                  setPage(0);
                }}
              >
                清除筛选
              </button>
            )}
          </div>

          <nav className="paper-list" aria-label="Rebuttal 案例">
            {visiblePapers.map((paper) => (
              <PaperCard
                paper={paper}
                selected={paper.id === selectedSummary.id}
                onSelect={() => choosePaper(paper.id)}
                key={paper.id}
              />
            ))}
            {filteredPapers.length === 0 && (
              <div className="no-results">
                <strong>没有匹配案例</strong>
                <span>换个关键词，或清除会议和年份筛选。</span>
              </div>
            )}
            {filteredPapers.length > 0 && (
              <div className="pagination">
                <button
                  type="button"
                  disabled={safePage === 0}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                >
                  ← 上一页
                </button>
                <span>{safePage + 1}</span>
                <button
                  type="button"
                  disabled={safePage >= pageCount - 1}
                  onClick={() =>
                    setPage((value) => Math.min(pageCount - 1, value + 1))
                  }
                >
                  下一页 →
                </button>
              </div>
            )}
          </nav>

          <footer className="library-footer">
            <span>
              更新于 {formatDate(libraryMeta.generatedAt)}
              <br />
              {libraryMeta.conversationCount.toLocaleString()} 条 Reviewer 线程
            </span>
            <button type="button" onClick={() => setShowUpdate(true)}>
              如何更新 <span aria-hidden="true">↗</span>
            </button>
          </footer>
        </aside>

        {showLibrary && (
          <button
            type="button"
            className="library-backdrop"
            aria-label="关闭案例库"
            onClick={() => setShowLibrary(false)}
          />
        )}

        <section id="reading-workspace" className="reading-workspace">
          {selectedIsNature && (
              <NatureDetail
                key={selectedSummary.id}
                paper={selectedSummary}
                linkCopied={linkCopied}
                onCopyLink={copyPaperLink}
              />
            )}

          {!selectedIsNature && detailLoading && (
            <ReaderState
              title="正在读取这篇的完整讨论"
              body="只拉取当前论文的 Review、Author Response 与后续追问。"
              loading
            />
          )}

          {!selectedIsNature && !detailLoading && detailError && (
            <ReaderState
              title="这篇暂时没有读出来"
              body={detailError}
              action={
                <div className="reader-state-actions">
                  <button
                    className="retry-button"
                    type="button"
                    onClick={() => setDetailAttempt((value) => value + 1)}
                  >
                    重新读取
                  </button>
                  <a
                    className="retry-button"
                    href={selectedSummary.source.originalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开原始 Forum ↗
                  </a>
                </div>
              }
            />
          )}

          {!selectedIsNature &&
            !detailLoading &&
            !detailError &&
            selectedPaper &&
            selectedPaper.id === selectedSummary.id && (
            <main id="paper-reader" className="paper-reader">
              <div className="reader-toolbar">
                <div className="material-badge">
                  <span aria-hidden="true">01</span>
                  {materialLabels[selectedPaper.materialType]}
                </div>
                <div className="toolbar-actions">
                  <span className="source-badge">
                    {sourceLabels[selectedPaper.source.type]}
                  </span>
                  <button
                    ref={aiTriggerRef}
                    className="toolbar-button ai-trigger"
                    type="button"
                    aria-haspopup="dialog"
                    aria-controls="ai-assistant"
                    aria-expanded={showAssistant}
                    onClick={() => {
                      setShowDiscovery(false);
                      setShowAssistant(true);
                    }}
                  >
                    <span aria-hidden="true">✦</span> AI 共读
                  </button>
                  <button
                    type="button"
                    className="toolbar-button"
                    onClick={copyPaperLink}
                  >
                    {linkCopied ? "已复制" : "复制链接"}
                  </button>
                  <a
                    href={selectedPaper.source.originalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    原始 Forum ↗
                  </a>
                </div>
              </div>

              <header className="paper-hero">
                <div className="paper-meta-line">
                  <span>{compactVenue(selectedPaper.venue)}</span>
                  <span>{selectedPaper.year}</span>
                  <span>Forum {selectedPaper.id}</span>
                </div>
                <h1>
                  {selectedPaper.titleKind === "identifier"
                    ? "论文标题未收录"
                    : selectedPaper.title}
                </h1>
                {selectedPaper.titleKind === "review_heading" && (
                  <p className="metadata-note">
                    <strong>Reviewer 主题 · 非论文标题</strong>
                    论文标题未随这份数据快照保存；本页暂以 Reviewer
                    写下的主题作为阅读线索。
                  </p>
                )}
                {selectedPaper.titleKind === "identifier" && (
                  <p className="metadata-note">
                    <strong>仅有 Forum ID</strong>
                    这份公开数据快照没有保存可验证的论文标题，因此不根据正文猜测标题。可通过上方
                    Forum ID 或原始链接核对。
                  </p>
                )}
                {selectedPaper.authors.length > 0 && (
                  <p className="authors">
                    {selectedPaper.authors.join(" · ")}
                  </p>
                )}
                <details className="abstract-disclosure">
                  <summary>
                    {selectedPaper.abstract ? "阅读论文摘要" : "摘要未收录"}
                  </summary>
                  <p>
                    {selectedPaper.abstract ||
                      "该条目的论文摘要未在当前源记录中保存；Review 与 Author Response 正文仍按原始记录呈现。"}
                  </p>
                </details>
                {selectedPaper.topics.length > 0 && (
                  <div className="topic-row">
                    {selectedPaper.topics.map((topic) => (
                      <span key={topic}>{topic}</span>
                    ))}
                  </div>
                )}
              </header>

              <section className="score-journey" aria-label="评分变化">
                <div className="score-stage">
                  <span>初始评分</span>
                  <ScoreDots
                    scores={selectedPaper.scoreBefore}
                    emptyLabel="未保存"
                  />
                </div>
                <div className="journey-arrow">
                  <span>
                    {scoreLabel(
                      delta,
                      selectedPaper.scoreBefore.length,
                      selectedPaper.scoreAfter.length,
                    )}
                  </span>
                  <i aria-hidden="true">→</i>
                </div>
                <div className="score-stage">
                  <span>最终评分</span>
                  <ScoreDots
                    scores={selectedPaper.scoreAfter}
                    emptyLabel="未保存"
                    final
                  />
                </div>
                <div
                  className={`decision-pill ${
                    selectedPaper.accepted ? "is-accepted" : ""
                  }`}
                >
                  <span>Final decision</span>
                  <strong>{selectedPaper.decision}</strong>
                </div>
              </section>

              <div className="view-tabs" role="tablist" aria-label="阅读模式">
                {(
                  [
                    ["chain", "逐 Reviewer 因果链"],
                    ["responses", "只看作者回复"],
                    ["decision", "决定与 Meta-review"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    id={`tab-${mode}`}
                    type="button"
                    role="tab"
                    aria-controls={`panel-${mode}`}
                    aria-selected={viewMode === mode}
                    className={viewMode === mode ? "is-active" : ""}
                    onClick={() => setViewMode(mode)}
                    key={mode}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {viewMode === "chain" && selectedPaper.threads.length > 0 && (
                <ThreadSelector
                  threads={selectedPaper.threads}
                  selected={selectedThread}
                  onSelect={setSelectedThread}
                />
              )}

              <div
                id={`panel-${viewMode}`}
                className={`reading-grid ${
                  viewMode === "chain" ? "" : "is-single"
                }`}
                role="tabpanel"
                aria-labelledby={`tab-${viewMode}`}
              >
                <section className="reading-column">
                  {viewMode === "chain" && currentThread && (
                    <ThreadTimeline thread={currentThread} />
                  )}
                  {viewMode === "responses" && (
                    <AuthorResponses paper={selectedPaper} />
                  )}
                  {viewMode === "decision" && (
                    <DecisionView paper={selectedPaper} />
                  )}
                </section>
                {viewMode === "chain" && currentThread && (
                  <ReadingAside
                    paper={selectedPaper}
                    currentThread={currentThread}
                  />
                )}
              </div>
              </main>
            )}
        </section>
      </div>

      {showUpdate && (
        <UpdateDialog
          generatedAt={libraryMeta.generatedAt}
          paperCount={libraryMeta.paperCount}
          conversationCount={libraryMeta.conversationCount}
          onClose={() => setShowUpdate(false)}
        />
      )}
      {!selectedIsNature &&
        selectedPaper &&
        selectedPaper.id === selectedSummary.id && (
        <AiAssistant
          key={`${selectedPaper.id}:${currentThread?.id ?? "all"}`}
          open={showAssistant}
          paper={selectedPaper}
          summary={selectedSummary}
          currentThread={currentThread}
          papers={papers}
          loadPaper={loadPaperForAssistant}
          onOpenPaper={choosePaper}
          onClose={closeAssistant}
        />
      )}
      <DiscoveryDialog
        open={showDiscovery}
        papers={papers}
        onOpenPaper={choosePaper}
        onClose={closeDiscovery}
      />
    </div>
  );
}
