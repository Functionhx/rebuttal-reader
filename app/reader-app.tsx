"use client";

import {
  useCallback,
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

function formatDate(value: string | null) {
  if (!value) return "尚未更新";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function compactVenue(venue: string) {
  return venue.replace(/\s+Conference$/i, "");
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

function PaperCard({
  paper,
  selected,
  onSelect,
}: {
  paper: PaperIndexRecord;
  selected: boolean;
  onSelect: () => void;
}) {
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
          {scoreLabel(
            delta,
            paper.scoreBefore.length,
            paper.scoreAfter.length,
          )}
        </span>
      </span>
      <strong>{paper.title}</strong>
      {paper.titleKind === "review_heading" && (
        <span className="title-origin">Reviewer 给出的主题标题</span>
      )}
      <span className="paper-card-footer">
        <span>{paper.decision.replace(/^Accept:\s*/i, "")}</span>
        <span>{paper.reviewCount} 位 Reviewer</span>
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
          {paper.source.type === "derived_dataset"
            ? "来自 Re² 派生数据；原始 OpenReview Forum 才是 canonical source。"
            : paper.source.type === "openreview_archive"
              ? "来自 OpenReview 公共归档；正文按篇读取，原始 Forum 是 canonical source。"
              : "由 OpenReview API 读取，采集时已检查公开 readers 权限。"}
        </p>
        <a
          className="source-link"
          href={paper.source.originalUrl}
          target="_blank"
          rel="noreferrer"
        >
          打开原始 Forum <span aria-hidden="true">↗</span>
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
          <span>补充一个公开 OpenReview Forum</span>
          <code>npm run update:openreview -- --forum &lt;forum-id&gt;</code>
        </div>
        <div className="privacy-rule">
          <strong>公开性闸门</strong>
          <span>
            归档只收录公开数据；OpenReview 增量适配器还会逐条检查 readers
            包含 everyone，私有内容直接跳过。
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
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <main className="reader-state">
      <span className="brand-mark">R/</span>
      <h1>{title}</h1>
      <p>{body}</p>
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
  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState("全部");
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

  useEffect(() => {
    let cancelled = false;
    async function loadIndex() {
      try {
        const load = async (
          url: string,
          depth = 0,
        ): Promise<LibraryIndexFile[]> => {
          try {
            const response = await fetch(url, { cache: "no-cache" });
            if (!response.ok) return [];
            const index = (await response.json()) as LibraryIndexFile;
            if (index.meta.shards?.length && depth < 2) {
              const groups = await Promise.all(
                index.meta.shards.map((shard) =>
                  load(shard.url, depth + 1),
                ),
              );
              return groups.flat();
            }
            return [index];
          } catch {
            return [];
          }
        };
        const groups = await Promise.all([
          load("/data/re2/index.json"),
          load("/data/reviewbench/index.json"),
          load("/data/openreview-archive/index.json"),
          load("/data/iclr-archive/index.json"),
          load("/data/openreview/index.json"),
        ]);
        const indexes = groups.flat();
        if (indexes.length === 0) {
          throw new Error("No library index is available.");
        }
        if (cancelled) return;

        const byId = new Map<string, PaperIndexRecord>();
        for (const index of indexes) {
          for (const paper of index.papers) byId.set(paper.id, paper);
        }
        for (const paper of seedPapers) byId.set(paper.id, seedSummary(paper));
        const merged = Array.from(byId.values()).sort(
          (a, b) =>
            b.year - a.year ||
            a.venue.localeCompare(b.venue) ||
            a.title.localeCompare(b.title),
        );
        setPapers(merged);
        setLibraryMeta({
          generatedAt:
            [
              ...indexes.map((index) => index.meta.generatedAt),
              seedGeneratedAt,
            ]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? null,
          sourceCount: indexes.length + (seedPapers.length ? 1 : 0),
          paperCount: merged.length,
          conversationCount: merged.reduce(
            (count, paper) => count + paper.reviewCount,
            0,
          ),
        });
        setSelectedPaperId((current) => current || merged[0]?.id || "");
        setIndexError("");
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
    };
  }, [seedGeneratedAt, seedPapers]);

  const selectedSummary = useMemo(
    () => papers.find((paper) => paper.id === selectedPaperId) ?? papers[0],
    [papers, selectedPaperId],
  );

  useEffect(() => {
    if (!selectedSummary) return;
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

    const detailRequest = selectedSummary.iclrArchive
      ? {
          url: "/api/iclr-archive",
          body: {
            paperId: selectedSummary.id,
            pointer: selectedSummary.iclrArchive,
          },
        }
      : selectedSummary.openReviewArchive
      ? {
          url: "/api/openreview-archive",
          body: {
            paperId: selectedSummary.id,
            pointer: selectedSummary.openReviewArchive,
          },
        }
      : selectedSummary.reviewBench
      ? {
          url: "/api/reviewbench",
          body: {
            paperId: selectedSummary.id,
            pointer: selectedSummary.reviewBench,
          },
        }
      : selectedSummary.detailUrl
        ? { url: selectedSummary.detailUrl, body: null }
        : {
            url: "/api/re2",
            body: {
              paperId: selectedSummary.id,
              rebuttalRanges: selectedSummary.rebuttalRanges,
              reviewRange: selectedSummary.reviewRange,
              paperZip: selectedSummary.paperZip,
            },
          };

    fetch(detailRequest.url, {
      method: detailRequest.body ? "POST" : "GET",
      headers: detailRequest.body
        ? { "Content-Type": "application/json" }
        : undefined,
      body: detailRequest.body
        ? JSON.stringify(detailRequest.body)
        : undefined,
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `HTTP ${response.status}`);
        }
        return payload as DetailPayload | ReviewBenchDetailPayload | PaperRecord;
      })
      .then((payload) => {
        const detail =
          "paper" in payload
            ? payload.paper
            : "rebuttals" in payload
              ? hydratePaper(selectedSummary, payload)
              : payload;
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

  const venues = useMemo(() => {
    const counts = new Map<string, number>();
    for (const paper of papers) {
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
  }, [papers]);
  const featuredVenues = useMemo(() => {
    const featured = venues.slice(0, 9);
    if (venue !== "全部" && !featured.includes(venue)) featured.push(venue);
    return featured;
  }, [venue, venues]);

  const filteredPapers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return papers.filter((paper) => {
      const venueMatch =
        venue === "全部" || compactVenue(paper.venue) === venue;
      const queryMatch =
        !normalized ||
        [
          paper.id,
          paper.title,
          paper.venue,
          paper.decision,
          paper.topics.join(" "),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return venueMatch && queryMatch;
    });
  }, [papers, query, venue]);

  const pageCount = Math.max(1, Math.ceil(filteredPapers.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visiblePapers = filteredPapers.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  );

  const choosePaper = useCallback((paperId: string) => {
    setSelectedPaperId(paperId);
    setSelectedThread(0);
    setViewMode("chain");
    setDetailError("");
  }, []);

  if (indexLoading && papers.length === 0) {
    return (
      <ReaderState
        title="正在展开完整案例库"
        body="第一次会先读取轻量目录，正文只在你点开某篇时加载。"
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

  return (
    <div className="reader-shell">
      <aside className="library-panel">
        <header className="brand">
          <span className="brand-mark">R/</span>
          <div>
            <strong>答辩录</strong>
            <span>Rebuttal Reader</span>
          </div>
        </header>

        <div className="library-heading">
          <div>
            <span className="eyebrow">Public beta · full case library</span>
            <h2>从质疑到决定</h2>
          </div>
          <span
            className="paper-count"
            title={`${libraryMeta.conversationCount.toLocaleString()} 条 rebuttal 对话`}
          >
            {libraryMeta.paperCount.toLocaleString()}
          </span>
        </div>

        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            placeholder="搜索主题、会议或 OpenReview ID"
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

        <div className="venue-filters" aria-label="按会议筛选">
          {featuredVenues.map((item) => (
            <button
              type="button"
              key={item}
              className={venue === item ? "is-active" : ""}
              onClick={() => {
                setVenue(item);
                setPage(0);
              }}
            >
              {item}
            </button>
          ))}
          {venues.length > featuredVenues.length && (
            <select
              value={venue}
              aria-label="选择全部会议与年份"
              onChange={(event) => {
                setVenue(event.target.value);
                setPage(0);
              }}
            >
              {venues.map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
        </div>

        <nav className="paper-list" aria-label="Rebuttal 案例">
          <div className="result-summary">
            <span>{filteredPapers.length.toLocaleString()} 篇匹配</span>
            <span>
              {safePage + 1} / {pageCount}
            </span>
          </div>
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
              <span>换个关键词或清除会议筛选。</span>
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
            {formatDate(libraryMeta.generatedAt)} ·{" "}
            {libraryMeta.conversationCount.toLocaleString()} 条对话
          </span>
          <button type="button" onClick={() => setShowUpdate(true)}>
            手动更新 <span aria-hidden="true">↗</span>
          </button>
        </footer>
      </aside>

      {detailLoading && (
        <ReaderState
          title="正在读取这篇的完整讨论"
          body="只拉取当前论文的 Review、Author Response 与后续追问。"
        />
      )}

      {!detailLoading && detailError && (
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

      {!detailLoading && !detailError && selectedPaper && (
        <main className="paper-reader">
          <div className="reader-toolbar">
            <div className="material-badge">
              <span />
              {materialLabels[selectedPaper.materialType]}
            </div>
            <div className="toolbar-actions">
              <span className="source-badge">
                {selectedPaper.source.type === "derived_dataset"
                  ? "Re² 派生数据"
                  : selectedPaper.source.type === "openreview_archive"
                    ? "OpenReview 公共归档"
                    : "OpenReview API"}
              </span>
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
              <span>{selectedPaper.id}</span>
            </div>
            <h1>{selectedPaper.title}</h1>
            {selectedPaper.titleKind !== "paper_title" && (
              <p className="metadata-note">
                数据包未解析出论文标题；这里展示 Reviewer 的主题标题或 OpenReview
                ID，并明确保留这一缺失。
              </p>
            )}
            {selectedPaper.authors.length > 0 && (
              <p className="authors">{selectedPaper.authors.join(" · ")}</p>
            )}
            <p className="abstract">
              {selectedPaper.abstract ||
                "该条目的论文摘要未在当前源记录中保存；Review 与 Author Response 正文完整保留。"}
            </p>
            <div className="topic-row">
              {selectedPaper.topics.map((topic) => (
                <span key={topic}>{topic}</span>
              ))}
            </div>
          </header>

          <section className="score-journey" aria-label="评分变化">
            <div className="score-stage">
              <span>已记录初评</span>
              <ScoreDots
                scores={selectedPaper.scoreBefore}
                emptyLabel="未保存"
              />
            </div>
            <div className="journey-arrow" aria-hidden="true">
              <span>
                {scoreLabel(
                  delta,
                  selectedPaper.scoreBefore.length,
                  selectedPaper.scoreAfter.length,
                )}
              </span>
              <i>→</i>
            </div>
            <div className="score-stage">
              <span>最终评分</span>
              <ScoreDots
                scores={selectedPaper.scoreAfter}
                emptyLabel="未保存"
                final
              />
            </div>
            <div className="decision-pill">
              <span>Decision</span>
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
                type="button"
                role="tab"
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

          <div className="reading-grid">
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
            {currentThread && (
              <ReadingAside
                paper={selectedPaper}
                currentThread={currentThread}
              />
            )}
          </div>
        </main>
      )}

      {showUpdate && (
        <UpdateDialog
          generatedAt={libraryMeta.generatedAt}
          paperCount={libraryMeta.paperCount}
          conversationCount={libraryMeta.conversationCount}
          onClose={() => setShowUpdate(false)}
        />
      )}
    </div>
  );
}
