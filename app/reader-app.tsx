"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  MessageKind,
  PaperRecord,
  ReviewThread,
  ThreadMessage,
} from "@/lib/types";

type ViewMode = "chain" | "responses" | "decision";

interface ReaderAppProps {
  initialPapers: PaperRecord[];
  libraryMeta: {
    generatedAt: string | null;
    sourceCount: number;
    paperCount: number;
  };
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

function average(scores: number[]) {
  if (!scores.length) return null;
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function scoreDelta(paper: PaperRecord) {
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
      return `${beforeCount}→${afterCount} 个评分`;
    }
    return "评分记录不完整";
  }
  if (Math.abs(delta) < 0.05) return "均分持平";
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} 均分`;
}

function responseSignals(body: string) {
  const signals: string[] = [];
  if (/thank|appreciate|agree/i.test(body)) signals.push("先接住问题");
  if (/clarif|misunder|in fact|specifically/i.test(body)) signals.push("澄清边界");
  if (/experiment|result|table|figure|appendix/i.test(body))
    signals.push("引用证据");
  if (/we (?:have )?(?:add|revise|change|include|fix)|will (?:add|revise|change|include|fix)/i.test(body))
    signals.push("明确改动");
  return signals.slice(0, 3);
}

function PaperCard({
  paper,
  selected,
  onSelect,
}: {
  paper: PaperRecord;
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
      <span className="paper-card-footer">
        <span>{paper.decision.replace(/^Accept:\s*/i, "")}</span>
        <span>{paper.threads.length} 位 Reviewer</span>
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
      {scores.map((score, index) => (
        <span
          className={`score-dot ${final ? "is-final" : ""}`}
          key={`${score}-${index}`}
        >
          {score}
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
          <span>该 Reviewer 评分</span>
          <strong>
            {thread.initialScore ?? "未记录"} <i>→</i>{" "}
            {thread.finalScore ?? "未记录"}
          </strong>
        </div>
        <p>
          “—” 表示派生数据里没有保存该时点评分，不将缺失值推断为未评分。
        </p>
      </div>
      {thread.messages.map((message, index) => (
        <MessageCard
          message={message}
          turn={index + 1}
          key={message.id}
        />
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
          已把所有 Reviewer 下的作者回复汇总到一起。结构信号是简单规则提示，方便快速扫读，不是对回复质量的自动评分。
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
            ? "来自派生数据集，适合冷启动学习；原始 Forum 才是 canonical source。"
            : "由 OpenReview API 读取，且采集时已检查公开 readers 权限。"}
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
  onClose,
}: {
  generatedAt: string | null;
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
          当前数据生成于 {formatDate(generatedAt)}。本项目没有后台常驻爬虫，更新后重新构建即可。
        </p>
        <div className="command-block">
          <span>刷新精选 Re² 冷启动案例</span>
          <code>npm run update:data</code>
        </div>
        <div className="command-block">
          <span>导入一个公开 OpenReview Forum</span>
          <code>npm run update:openreview -- --forum &lt;forum-id&gt;</code>
        </div>
        <div className="command-block">
          <span>按 venue 小批量导入</span>
          <code>
            npm run update:openreview -- --venue ICLR.cc/2023/Conference
            --limit 50
          </code>
        </div>
        <div className="privacy-rule">
          <strong>公开性闸门</strong>
          <span>
            OpenReview 适配器只接纳 readers 包含 everyone 的投稿和回复；私有内容会直接跳过。
          </span>
        </div>
      </section>
    </div>
  );
}

export function ReaderApp({ initialPapers, libraryMeta }: ReaderAppProps) {
  const [query, setQuery] = useState("");
  const [venue, setVenue] = useState("全部");
  const [selectedPaperId, setSelectedPaperId] = useState(
    initialPapers[0]?.id ?? "",
  );
  const [selectedThread, setSelectedThread] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("chain");
  const [showUpdate, setShowUpdate] = useState(false);

  const venues = useMemo(
    () => [
      "全部",
      ...Array.from(
        new Set(initialPapers.map((paper) => compactVenue(paper.venue))),
      ).sort((a, b) => b.localeCompare(a)),
    ],
    [initialPapers],
  );

  const filteredPapers = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return initialPapers.filter((paper) => {
      const venueMatch =
        venue === "全部" || compactVenue(paper.venue) === venue;
      const queryMatch =
        !normalized ||
        [
          paper.title,
          paper.authors.join(" "),
          paper.venue,
          paper.topics.join(" "),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return venueMatch && queryMatch;
    });
  }, [initialPapers, query, venue]);

  const selectedPaper =
    initialPapers.find((paper) => paper.id === selectedPaperId) ??
    filteredPapers[0] ??
    initialPapers[0];

  if (!selectedPaper) {
    return (
      <main className="empty-library">
        <span className="brand-mark">R/</span>
        <h1>案例库还是空的</h1>
        <p>
          运行 <code>npm run update:data</code> 导入第一批公开案例。
        </p>
      </main>
    );
  }

  const currentThread =
    selectedPaper.threads[selectedThread] ?? selectedPaper.threads[0];
  const delta = scoreDelta(selectedPaper);

  const choosePaper = (paperId: string) => {
    setSelectedPaperId(paperId);
    setSelectedThread(0);
    setViewMode("chain");
  };

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
            <span className="eyebrow">Case library</span>
            <h2>从质疑到决定</h2>
          </div>
          <span className="paper-count">{libraryMeta.paperCount}</span>
        </div>

        <label className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、作者或主题"
            aria-label="搜索案例"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
            >
              ×
            </button>
          )}
        </label>

        <div className="venue-filters" aria-label="按会议筛选">
          {venues.map((item) => (
            <button
              type="button"
              key={item}
              className={venue === item ? "is-active" : ""}
              onClick={() => setVenue(item)}
            >
              {item}
            </button>
          ))}
        </div>

        <nav className="paper-list" aria-label="Rebuttal 案例">
          {filteredPapers.map((paper) => (
            <PaperCard
              paper={paper}
              selected={paper.id === selectedPaper.id}
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
        </nav>

        <footer className="library-footer">
          <span>
            更新于 {formatDate(libraryMeta.generatedAt)} ·{" "}
            {libraryMeta.sourceCount} 个数据源
          </span>
          <button type="button" onClick={() => setShowUpdate(true)}>
            手动更新 <span aria-hidden="true">↗</span>
          </button>
        </footer>
      </aside>

      <main className="paper-reader">
        <div className="reader-toolbar">
          <div className="material-badge">
            <span />
            {materialLabels[selectedPaper.materialType]}
          </div>
          <div className="toolbar-actions">
            <span className="source-badge">
              {selectedPaper.source.type === "derived_dataset"
                ? "派生数据"
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
          <p className="authors">{selectedPaper.authors.join(" · ")}</p>
          <p className="abstract">{selectedPaper.abstract}</p>
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
            <ReadingAside paper={selectedPaper} currentThread={currentThread} />
          )}
        </div>
      </main>

      {showUpdate && (
        <UpdateDialog
          generatedAt={libraryMeta.generatedAt}
          onClose={() => setShowUpdate(false)}
        />
      )}
    </div>
  );
}
