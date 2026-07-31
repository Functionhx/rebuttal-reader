"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { matchLocalPapers } from "@/lib/discovery";
import type { PaperIndexRecord } from "@/lib/types";

type CandidateProvider = "nature" | "github" | "crossref" | "brave";
type CandidateConfidence = "verified" | "likely" | "lead";
type ProviderState = "searched" | "partial" | "skipped" | "error";

interface ArxivPaper {
  id: string;
  version?: string;
  title: string;
  authors: string[];
  abstract: string;
  categories: string[];
  doi?: string;
  journalRef?: string;
  published?: string;
  updated?: string;
  canonicalUrl: string;
}

interface DiscoveryCandidate {
  id: string;
  provider: CandidateProvider;
  kind:
    | "peer_review_file"
    | "rebuttal_file"
    | "repository"
    | "peer_review_record"
    | "web_result";
  title: string;
  url: string;
  contextUrl?: string;
  description?: string;
  confidence: CandidateConfidence;
  matchedBy: string[];
}

interface ProviderStatus {
  id: string;
  label: string;
  status: ProviderState;
  detail: string;
  configured?: boolean;
}

interface DiscoveryResponse {
  paper: ArxivPaper;
  candidates: DiscoveryCandidate[];
  providers: ProviderStatus[];
  manualSearchUrls: Array<{
    label: string;
    url: string;
  }>;
  searchedAt: string;
}

interface DiscoveryDialogProps {
  open: boolean;
  papers: readonly PaperIndexRecord[];
  onOpenPaper: (paperId: string) => void;
  onClose: () => void;
}

const providerLabels: Record<CandidateProvider, string> = {
  nature: "Nature Portfolio",
  github: "GitHub",
  crossref: "Crossref",
  brave: "全网线索",
};

const confidenceLabels: Record<CandidateConfidence, string> = {
  verified: "已验证附件",
  likely: "高可信候选",
  lead: "待核对线索",
};

const providerStateLabels: Record<ProviderState, string> = {
  searched: "已检查",
  partial: "部分检查",
  skipped: "未启用",
  error: "暂时失败",
};

function formatDate(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(parsed);
}

function isDiscoveryResponse(value: unknown): value is DiscoveryResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DiscoveryResponse>;
  return (
    Boolean(candidate.paper?.title) &&
    Array.isArray(candidate.candidates) &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.manualSearchUrls)
  );
}

function DiscoveryThinking() {
  return (
    <div className="discovery-thinking" aria-busy="true">
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
      <p>解析 arXiv，检查 Nature、公开索引与 GitHub。</p>
      <div
        className="loading-progress"
        role="progressbar"
        aria-label="正在探测公开 Rebuttal"
      >
        <span />
      </div>
    </div>
  );
}

export function DiscoveryDialog({
  open,
  papers,
  onOpenPaper,
  onClose,
}: DiscoveryDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [arxivUrl, setArxivUrl] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<DiscoveryResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => inputRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
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
      abortRef.current?.abort();
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => previousFocusRef.current?.focus());
    };
  }, [onClose, open]);

  const localMatches = useMemo(() => {
    if (!result) return [];
    return matchLocalPapers(
      {
        title: result.paper.title,
        categories: result.paper.categories,
        published: result.paper.published ?? null,
      },
      papers.filter((paper) => paper.titleKind === "paper_title"),
      5,
    );
  }, [papers, result]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!arxivUrl.trim() || searching) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setResult(null);
    setError("");

    try {
      const response = await fetch("/api/discovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        signal: controller.signal,
        body: JSON.stringify({ arxivUrl: arxivUrl.trim() }),
      });
      const payload = (await response.json()) as unknown;
      if (!response.ok || !isDiscoveryResponse(payload)) {
        const message =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : "这次探测没有完成，请稍后重试。";
        throw new Error(message);
      }
      setResult(payload);
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
          : "这次探测没有完成，请稍后重试。",
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setSearching(false);
    }
  };

  if (!open) return null;

  const resultCount = (result?.candidates.length ?? 0) + localMatches.length;

  return (
    <div className="dialog-backdrop discovery-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="discovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="discovery-title"
        aria-describedby="discovery-description"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          aria-label="关闭 Rebuttal 探测器"
          onClick={onClose}
        >
          ×
        </button>

        <header className="discovery-header">
          <span className="eyebrow">ArXiv → public evidence</span>
          <h2 id="discovery-title">全网找 Rebuttal</h2>
          <p id="discovery-description">
            粘贴 arXiv 地址，按需检查答辩录索引、Nature Portfolio
            透明评审附件、GitHub 与可选的全网搜索。
          </p>
        </header>

        <form className="discovery-form" onSubmit={submit}>
          <label htmlFor="discovery-arxiv-url">arXiv 地址或编号</label>
          <div>
            <input
              ref={inputRef}
              id="discovery-arxiv-url"
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={500}
              value={arxivUrl}
              onChange={(event) => setArxivUrl(event.target.value)}
              placeholder="https://arxiv.org/abs/2011.07036"
            />
            <button type="submit" disabled={!arxivUrl.trim() || searching}>
              {searching ? "探测中…" : "开始探测"}
            </button>
          </div>
          <small>
            不会抓取你输入的任意网址；系统只提取合法 arXiv ID，再调用受信任的公开接口。
          </small>
        </form>

        {searching && <DiscoveryThinking />}

        {error && (
          <p className="discovery-error" role="alert">
            {error}
          </p>
        )}

        {result && (
          <div className="discovery-results" aria-live="polite">
            <section className="discovery-paper">
              <div>
                <span>arXiv:{result.paper.id}</span>
                {result.paper.published && (
                  <span>{formatDate(result.paper.published)}</span>
                )}
              </div>
              <h3>{result.paper.title}</h3>
              {result.paper.authors.length > 0 && (
                <p>{result.paper.authors.slice(0, 8).join(" · ")}</p>
              )}
              <dl>
                {result.paper.doi && (
                  <div>
                    <dt>DOI</dt>
                    <dd>{result.paper.doi}</dd>
                  </div>
                )}
                {result.paper.journalRef && (
                  <div>
                    <dt>Journal</dt>
                    <dd>{result.paper.journalRef}</dd>
                  </div>
                )}
              </dl>
              <a
                href={result.paper.canonicalUrl}
                target="_blank"
                rel="noreferrer"
              >
                核对 arXiv 原文 ↗
              </a>
            </section>

            <section className="discovery-provider-section">
              <div className="discovery-section-title">
                <span className="eyebrow">Search coverage</span>
                <strong>这次实际检查了什么</strong>
              </div>
              <div className="discovery-providers">
                {result.providers.map((provider) => (
                  <article
                    className={`provider-status is-${provider.status}`}
                    key={provider.id}
                  >
                    <div>
                      <strong>{provider.label}</strong>
                      <span>{providerStateLabels[provider.status]}</span>
                    </div>
                    <p>{provider.detail}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="discovery-candidate-section">
              <div className="discovery-section-title">
                <span className="eyebrow">Evidence candidates</span>
                <strong>
                  {resultCount > 0
                    ? `发现 ${resultCount} 条可核对线索`
                    : "暂未发现可核对线索"}
                </strong>
              </div>

              {localMatches.length > 0 && (
                <div className="discovery-candidate-list">
                  {localMatches.map(({ paper, titleSimilarity, reasons }) => (
                    <article
                      className="discovery-candidate is-local"
                      key={`local-${paper.id}`}
                    >
                      <div className="candidate-topline">
                        <span>答辩录索引</span>
                        <strong>
                          标题匹配 {Math.round(titleSimilarity * 100)}%
                        </strong>
                      </div>
                      <h3>{paper.title}</h3>
                      <p>
                        {paper.venue} · {paper.year} · {paper.reviewCount} 位
                        Reviewer
                      </p>
                      <ul>
                        {reasons.slice(0, 3).map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                      <div className="candidate-actions">
                        <button
                          type="button"
                          onClick={() => {
                            onOpenPaper(paper.id);
                            onClose();
                          }}
                        >
                          在答辩录中阅读
                        </button>
                        <a
                          href={paper.source.originalUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          原始 Forum ↗
                        </a>
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {result.candidates.length > 0 && (
                <div className="discovery-candidate-list">
                  {result.candidates.map((candidate) => (
                    <article
                      className={`discovery-candidate is-${candidate.confidence}`}
                      key={candidate.id}
                    >
                      <div className="candidate-topline">
                        <span>{providerLabels[candidate.provider]}</span>
                        <strong>
                          {confidenceLabels[candidate.confidence]}
                        </strong>
                      </div>
                      <h3>{candidate.title}</h3>
                      {candidate.description && (
                        <p>{candidate.description}</p>
                      )}
                      <ul>
                        {candidate.matchedBy.slice(0, 4).map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                      <div className="candidate-actions">
                        <a
                          className="candidate-primary"
                          href={candidate.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {candidate.kind === "peer_review_file"
                            ? "打开 Peer Review File"
                            : candidate.kind === "rebuttal_file"
                              ? "打开 Rebuttal 文件"
                              : "打开候选来源"}{" "}
                          ↗
                        </a>
                        {candidate.contextUrl &&
                          candidate.contextUrl !== candidate.url && (
                            <a
                              href={candidate.contextUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              查看上下文 ↗
                            </a>
                          )}
                      </div>
                    </article>
                  ))}
                </div>
              )}

              {resultCount === 0 && (
                <div className="discovery-empty">
                  <strong>未发现，不代表不存在。</strong>
                  <p>
                    作者可能没有公开材料，也可能使用了尚未覆盖的个人主页、云盘或投稿系统。
                  </p>
                </div>
              )}
            </section>

            {result.manualSearchUrls.length > 0 && (
              <details className="discovery-manual-links">
                <summary>继续到外部搜索引擎核对</summary>
                <div>
                  {result.manualSearchUrls.map((link) => (
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      key={link.url}
                    >
                      {link.label} ↗
                    </a>
                  ))}
                </div>
              </details>
            )}

            <p className="discovery-disclosure">
              候选链接不是论文真实性或权利状态背书。Nature 文件只链接回源，不在本站镜像；GitHub
              与全网线索请在使用前核对论文标题、作者、arXiv ID 和公开许可。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
