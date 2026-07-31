"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildEvidenceExcerpt,
  rankSimilarPapers,
  sanitizePublicEvidence,
  type RankedPaper,
} from "@/lib/rag";
import type {
  PaperIndexRecord,
  PaperRecord,
  ReviewThread,
} from "@/lib/types";

type AssistantMode = "read" | "similar" | "draft";

interface AssistantConfiguration {
  configured: boolean;
  model: string;
  localOnly: boolean;
}

interface AssistantResult {
  content: string;
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

interface LoadedSource {
  ranked: RankedPaper;
  excerpt: string;
}

interface AiAssistantProps {
  open: boolean;
  paper: PaperRecord;
  summary: PaperIndexRecord;
  currentThread?: ReviewThread;
  papers: readonly PaperIndexRecord[];
  loadPaper: (
    summary: PaperIndexRecord,
    signal?: AbortSignal,
  ) => Promise<PaperRecord>;
  onOpenPaper: (paperId: string) => void;
  onClose: () => void;
}

const modeOptions: Array<{
  value: AssistantMode;
  label: string;
  description: string;
}> = [
  {
    value: "read",
    label: "读懂本篇",
    description: "拆解质疑、证据与未解决问题",
  },
  {
    value: "similar",
    label: "找相似案例",
    description: "从公开索引召回可核对的 Rebuttal",
  },
  {
    value: "draft",
    label: "打磨回复",
    description: "改结构与表达，不编造实验结果",
  },
];

function truncate(value: string, limit: number) {
  const characters = Array.from(value.trim());
  if (characters.length <= limit) return characters.join("");
  return `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

function promptPaper(
  paper: PaperRecord,
  characterCap: number,
  reason?: string,
) {
  const excerpt = buildEvidenceExcerpt(paper, characterCap);
  const abstract = truncate(sanitizePublicEvidence(paper.abstract), 3_000);
  const metaReview = truncate(
    sanitizePublicEvidence(paper.metaReview ?? ""),
    3_000,
  );

  return {
    id: paper.id,
    title: paper.title,
    titleKind: paper.titleKind,
    venue: paper.venue,
    year: paper.year,
    materialType: paper.materialType,
    decision: paper.decision,
    accepted: paper.accepted,
    abstract: abstract || undefined,
    topics: paper.topics.slice(0, 12),
    scoreBefore: paper.scoreBefore.slice(0, 20),
    scoreAfter: paper.scoreAfter.slice(0, 20),
    metaReview: metaReview || undefined,
    similarityReason: reason,
    sourceUrl: paper.source.originalUrl,
    excerpts: excerpt
      ? [
          {
            label: "Public Review and Author Response excerpts",
            text: excerpt,
            sourceUrl: paper.source.originalUrl,
          },
        ]
      : undefined,
  };
}

function firstReview(thread?: ReviewThread) {
  return (
    thread?.messages.find((message) => message.kind === "review")?.body ?? ""
  );
}

function ThinkingIndicator() {
  return (
    <div className="ai-thinking" aria-busy="true">
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
      <p>正在检索公开案例，并让 DeepSeek 基于证据组织回答。</p>
      <div
        className="loading-progress"
        role="progressbar"
        aria-label="正在生成回答"
      >
        <span />
      </div>
    </div>
  );
}

export function AiAssistant({
  open,
  paper,
  summary,
  currentThread,
  papers,
  loadPaper,
  onOpenPaper,
  onClose,
}: AiAssistantProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<AssistantMode>("read");
  const [configuration, setConfiguration] =
    useState<AssistantConfiguration | null>(null);
  const [checkingConfiguration, setCheckingConfiguration] = useState(false);
  const [question, setQuestion] = useState("");
  const [reviewerComment, setReviewerComment] = useState(() =>
    truncate(firstReview(currentThread), 12_000),
  );
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [loadedSources, setLoadedSources] = useState<LoadedSource[]>([]);
  const [error, setError] = useState("");

  const similarCases = useMemo(
    () => rankSimilarPapers(summary, papers, 6),
    [papers, summary],
  );

  const checkConfiguration = useCallback(async () => {
    setCheckingConfiguration(true);
    try {
      const response = await fetch("/api/assistant", {
        cache: "no-store",
      });
      const payload = (await response.json()) as
        | AssistantConfiguration
        | { error?: string };
      if (!response.ok || !("configured" in payload)) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "无法检测 DeepSeek 配置。",
        );
      }
      setConfiguration(payload);
      setError("");
    } catch (nextError) {
      setConfiguration(null);
      setError(
        nextError instanceof Error
          ? nextError.message
          : "无法检测 DeepSeek 配置。",
      );
    } finally {
      setCheckingConfiguration(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const configurationTimer = window.setTimeout(() => {
      void checkConfiguration();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("input, textarea, button")
        ?.focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(configurationTimer);
      abortRef.current?.abort();
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [checkConfiguration, onClose, open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!configuration?.configured || thinking) return;
    if (mode === "draft" && !reviewerComment.trim()) {
      setError("请先填写 Reviewer 的意见或核心质疑。");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setThinking(true);
    setResult(null);
    setLoadedSources([]);
    setError("");

    try {
      const retrieved =
        mode === "read"
          ? []
          : (
              await Promise.all(
                similarCases.slice(0, 3).map(async (ranked) => {
                  try {
                    const detail = await loadPaper(
                      ranked.paper,
                      controller.signal,
                    );
                    return {
                      ranked,
                      detail,
                      excerpt: buildEvidenceExcerpt(detail, 3_600),
                    };
                  } catch (nextError) {
                    if (
                      nextError instanceof DOMException &&
                      nextError.name === "AbortError"
                    ) {
                      throw nextError;
                    }
                    return null;
                  }
                }),
              )
            ).filter(
              (
                item,
              ): item is {
                ranked: RankedPaper;
                detail: PaperRecord;
                excerpt: string;
              } => item !== null,
            );

      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({
          mode,
          locale: "zh-CN",
          currentPaper: promptPaper(paper, 8_000),
          evidence: retrieved.map(({ detail, ranked }) =>
            promptPaper(detail, 3_600, ranked.reasons.join("；")),
          ),
          reviewerComment:
            mode === "draft"
              ? reviewerComment.trim()
              : undefined,
          draft: mode === "draft" ? draft.trim() || undefined : undefined,
          question:
            question.trim() ||
            (mode === "read"
              ? "请提炼核心质疑、作者回应策略、证据链与仍未解决的问题。"
              : mode === "similar"
                ? "这些案例有哪些可迁移的回应策略，又有哪些关键差异？"
                : "请给出一份可以逐点核对的回复结构和修改建议。"),
        }),
      });
      const payload = (await response.json()) as
        | AssistantResult
        | { error?: string };
      if (!response.ok || !("content" in payload)) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "DeepSeek 暂时没有返回回答。",
        );
      }
      setResult(payload);
      setLoadedSources(
        retrieved.map(({ ranked, excerpt }) => ({ ranked, excerpt })),
      );
    } catch (nextError) {
      if (
        nextError instanceof DOMException &&
        nextError.name === "AbortError"
      ) {
        return;
      }
      setError(
        nextError instanceof Error
          ? nextError.message
          : "AI 助读暂时失败，请稍后重试。",
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setThinking(false);
    }
  };

  if (!open) return null;

  return (
    <div className="ai-backdrop" onMouseDown={onClose}>
      <aside
        id="ai-assistant"
        className="ai-drawer"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-title"
        aria-describedby="ai-disclosure"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="ai-drawer-header">
          <div>
            <span className="eyebrow">DeepSeek · explainable RAG beta</span>
            <h2 id="ai-title">AI 共读</h2>
            <p>先检索公开案例，再基于有限证据回答。</p>
          </div>
          <button
            className="ai-close"
            type="button"
            aria-label="关闭 AI 共读"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="ai-drawer-scroll">
          <fieldset className="ai-mode-switch">
            <legend className="sr-only">选择 AI 助读任务</legend>
            {modeOptions.map((option) => (
              <label className="ai-mode-option" key={option.value}>
                <input
                  type="radio"
                  name="ai-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => {
                    setMode(option.value);
                    setResult(null);
                    setLoadedSources([]);
                    setError("");
                  }}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="ai-context-chip">
            <span>当前案例</span>
            <strong>{paper.title}</strong>
            <small>
              {paper.venue} · {paper.year}
            </small>
          </div>

          {!checkingConfiguration && !configuration?.configured && (
            <section className="ai-not-configured">
              <span className="eyebrow">Local key required</span>
              <h3>DeepSeek 生成尚未启用</h3>
              <p>
                相似案例检索仍可使用。若要生成助读与写作建议，请在本地启动前设置环境变量：
              </p>
              <code>export DEEPSEEK_API_KEY=&quot;your-key-here&quot;</code>
              <button type="button" onClick={checkConfiguration}>
                重新检测
              </button>
              <small>
                密钥只由服务端进程读取，不进入浏览器、Git 或部署产物。
              </small>
            </section>
          )}

          {checkingConfiguration && (
            <p className="ai-configuration-status" role="status">
              正在检测 DeepSeek 配置…
            </p>
          )}

          {configuration?.configured && (
            <div className="ai-provider-status">
              <span>已连接</span>
              <strong>{configuration.model}</strong>
              {configuration.localOnly && <small>本地模式</small>}
            </div>
          )}

          <form className="ai-form" onSubmit={submit}>
            {mode === "read" && (
              <label>
                <span>你想重点读懂什么？</span>
                <textarea
                  value={question}
                  maxLength={3_000}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="例如：Reviewer 为什么没有被说服？作者的证据链缺在哪里？"
                />
              </label>
            )}

            {mode === "similar" && (
              <label>
                <span>希望比较什么？</span>
                <textarea
                  value={question}
                  maxLength={3_000}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="例如：比较这些案例如何回应“消融实验不足”的质疑。"
                />
              </label>
            )}

            {mode === "draft" && (
              <>
                <label>
                  <span>Reviewer 意见或核心质疑</span>
                  <textarea
                    value={reviewerComment}
                    maxLength={12_000}
                    onChange={(event) =>
                      setReviewerComment(event.target.value)
                    }
                    placeholder="粘贴需要回应的 Reviewer 意见。"
                  />
                </label>
                <label>
                  <span>你的回复草稿（可选）</span>
                  <textarea
                    className="ai-draft"
                    value={draft}
                    maxLength={16_000}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="可以先留空，让助手给出逐点结构；也可以粘贴现有草稿进行打磨。"
                  />
                </label>
              </>
            )}

            <button
              className="ai-submit"
              type="submit"
              disabled={
                !configuration?.configured ||
                checkingConfiguration ||
                thinking
              }
            >
              {thinking
                ? "正在思考…"
                : mode === "read"
                  ? "开始助读"
                  : mode === "similar"
                    ? "让 DeepSeek 比较"
                    : draft.trim()
                      ? "打磨这份回复"
                      : "生成回复结构"}
            </button>
          </form>

          {thinking && <ThinkingIndicator />}

          {error && (
            <p className="ai-error" role="alert">
              {error}
            </p>
          )}

          {result && (
            <section className="ai-answer" aria-live="polite">
              <div className="ai-answer-heading">
                <span className="eyebrow">Evidence-grounded answer</span>
                <small>
                  {result.model}
                  {result.usage?.totalTokens
                    ? ` · ${result.usage.totalTokens.toLocaleString()} tokens`
                    : ""}
                </small>
              </div>
              <div>{result.content}</div>
            </section>
          )}

          {(mode === "similar" || mode === "draft") && (
            <section className="ai-source-section">
              <div className="ai-section-heading">
                <span className="eyebrow">Retrieved cases</span>
                <strong>可解释的相似案例</strong>
              </div>
              {similarCases.length > 0 ? (
                <div className="ai-source-list">
                  {similarCases.map((ranked) => {
                    const evidenceIndex = loadedSources.findIndex(
                      (source) => source.ranked.paper.id === ranked.paper.id,
                    );
                    const loaded =
                      evidenceIndex >= 0
                        ? loadedSources[evidenceIndex]
                        : undefined;
                    return (
                      <article
                        className="ai-source-card"
                        key={ranked.paper.id}
                      >
                        <div className="ai-source-meta">
                          <span>
                            {ranked.paper.venue} · {ranked.paper.year}
                          </span>
                          {evidenceIndex >= 0 && (
                            <strong>E{evidenceIndex + 1}</strong>
                          )}
                        </div>
                        <h3>{ranked.paper.title}</h3>
                        <p className="ai-source-reason">
                          <strong>为什么相关</strong>
                          {ranked.reasons.join("；")}
                        </p>
                        {loaded?.excerpt && (
                          <p className="ai-source-excerpt">
                            {truncate(loaded.excerpt, 320)}
                          </p>
                        )}
                        <div className="ai-source-actions">
                          <button
                            type="button"
                            onClick={() => {
                              onOpenPaper(ranked.paper.id);
                              onClose();
                            }}
                          >
                            在答辩录中打开
                          </button>
                          <a
                            href={ranked.paper.source.originalUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            原始 Forum ↗
                          </a>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="ai-empty">
                  当前元数据中没有找到足够相似、且理由可解释的公开案例。
                </p>
              )}
            </section>
          )}

          <p className="ai-disclosure" id="ai-disclosure">
            AI 可能出错。只有带来源的检索片段可视为案例证据；提交前请核对原始
            Forum。请勿粘贴机密审稿内容，也不要让模型虚构实验、结果、引用或会议政策。
          </p>
        </div>
      </aside>
    </div>
  );
}
