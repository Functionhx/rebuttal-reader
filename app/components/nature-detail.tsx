"use client";

import { useEffect, useRef, useState } from "react";
import type { PaperIndexRecord } from "@/lib/types";
import { compactVenue } from "@/lib/library-filters";
import {
  fetchNaturePeerReviewFilesDirect,
} from "@/lib/nature";

type JsonRecord = Record<string, unknown>;
const FILE_LOOKUP_TIMEOUT_MS = 25_000;

interface NatureDetailProps {
  paper: PaperIndexRecord;
  linkCopied: boolean;
  onCopyLink: () => void;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeOfficialFileUrl(value: unknown, pmcid: string) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expectedPrefix = `/articles/${pmcid}/bin/`;
    const filename = url.pathname.slice(expectedPrefix.length);
    const allowed =
      url.protocol === "https:" &&
      url.hostname === "europepmc.org" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith(expectedPrefix) &&
      filename.length > 4 &&
      filename.toLowerCase().endsWith(".pdf") &&
      !filename.includes("/");
    if (!allowed) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function fileUrlFromPayload(value: unknown, pmcid: string): string | null {
  if (!isRecord(value)) return null;
  for (const key of ["peerReviewUrl", "url", "href"]) {
    const direct = safeOfficialFileUrl(value[key], pmcid);
    if (direct) return direct;
  }
  for (const key of ["peerReviewFile", "file"]) {
    const nested = fileUrlFromPayload(value[key], pmcid);
    if (nested) return nested;
  }
  for (const key of ["peerReviewFiles", "files", "candidates"]) {
    const items = value[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const nested = fileUrlFromPayload(item, pmcid);
      if (nested) return nested;
    }
  }
  return null;
}

function openWaitingTab() {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  tab.opener = null;
  tab.document.title = "Rebuttal Reader · thinking...";
  tab.document.body.style.cssText =
    "margin:0;display:grid;min-height:100vh;place-items:center;background:#f4f1e9;color:#1a1b18;font:16px system-ui,sans-serif";
  tab.document.body.textContent = "thinking... 正在定位公开同行评议文件";
  return tab;
}

export function NatureDetail({
  paper,
  linkCopied,
  onCopyLink,
}: NatureDetailProps) {
  const pointer = paper.nature;
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState("");
  const [resolvedUrl, setResolvedUrl] = useState("");
  const activeController = useRef<AbortController | null>(null);
  const waitingTabRef = useRef<Window | null>(null);

  useEffect(
    () => () => {
      const controller = activeController.current;
      activeController.current = null;
      controller?.abort();
      if (waitingTabRef.current && !waitingTabRef.current.closed) {
        waitingTabRef.current.close();
      }
    },
    [],
  );

  if (!pointer) return null;

  const articleUrl = /^10\.1038\/[-._;()/:a-z0-9]+$/i.test(pointer.doi)
    ? `https://doi.org/${pointer.doi.toLowerCase()}`
    : `https://europepmc.org/articles/${pointer.pmcid}`;
  const europePmcUrl = `https://europepmc.org/articles/${pointer.pmcid}`;

  const openPeerReviewFile = async () => {
    if (activeController.current) return;
    if (resolvedUrl) {
      window.open(resolvedUrl, "_blank", "noopener,noreferrer");
      return;
    }

    const waitingTab = openWaitingTab();
    waitingTabRef.current = waitingTab;
    const controller = new AbortController();
    activeController.current?.abort();
    activeController.current = controller;
    setFileLoading(true);
    setFileError("");
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FILE_LOOKUP_TIMEOUT_MS);

    try {
      let fileUrl: string | null = null;
      let serverError = "";
      try {
        const response = await fetch("/api/nature", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pmcid: pointer.pmcid }),
          signal: controller.signal,
        });
        const payload = (await response.json()) as unknown;
        if (response.ok) {
          fileUrl = fileUrlFromPayload(payload, pointer.pmcid);
        } else {
          serverError =
            isRecord(payload) && typeof payload.error === "string"
              ? payload.error
              : `HTTP ${response.status}`;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        serverError =
          error instanceof Error ? error.message : "站内解析暂时不可用。";
      }

      if (!fileUrl) {
        const directFiles = await fetchNaturePeerReviewFilesDirect(
          pointer.pmcid,
          { signal: controller.signal },
        );
        fileUrl = directFiles[0]?.url ?? null;
      }
      if (!fileUrl) {
        throw new Error(
          serverError ||
            "Europe PMC 记录里暂时没有可验证的同行评议文件链接。",
        );
      }

      setResolvedUrl(fileUrl);
      if (waitingTab && !waitingTab.closed) {
        waitingTab.location.replace(fileUrl);
        waitingTabRef.current = null;
      } else {
        window.open(fileUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      if (waitingTab && !waitingTab.closed) waitingTab.close();
      if (waitingTabRef.current === waitingTab) waitingTabRef.current = null;
      if (error instanceof DOMException && error.name === "AbortError") {
        if (timedOut && activeController.current === controller) {
          setFileError("Europe PMC 响应超时，请稍后重试。");
        }
        return;
      }
      setFileError(
        error instanceof Error
          ? error.message
          : "公开同行评议文件暂时无法定位。",
      );
    } finally {
      window.clearTimeout(timeout);
      if (activeController.current === controller) {
        activeController.current = null;
        setFileLoading(false);
      }
    }
  };

  return (
    <main id="paper-reader" className="paper-reader nature-reader">
      <div className="reader-toolbar">
        <div className="material-badge">
          <span aria-hidden="true">N</span>
          Transparent peer-review file
        </div>
        <div className="toolbar-actions">
          <span className="source-badge">Europe PMC 开放索引</span>
          <button
            type="button"
            className="toolbar-button"
            onClick={onCopyLink}
          >
            {linkCopied ? "已复制" : "复制链接"}
          </button>
          <a href={articleUrl} target="_blank" rel="noreferrer">
            原始论文 ↗
          </a>
        </div>
      </div>

      <header className="paper-hero nature-hero">
        <div className="paper-meta-line">
          <span>{compactVenue(paper.venue)}</span>
          <span>{paper.year}</span>
          <span>{pointer.pmcid}</span>
        </div>
        <h1>{paper.title}</h1>
        {pointer.authorString && (
          <p className="authors">{pointer.authorString}</p>
        )}
        {pointer.abstract && (
          <details className="abstract-disclosure">
            <summary>阅读论文摘要</summary>
            <p>{pointer.abstract}</p>
          </details>
        )}
      </header>

      <section className="nature-file-panel" aria-labelledby="nature-file-title">
        <div className="nature-file-copy">
          <span className="eyebrow">Transparent peer review</span>
          <h2 id="nature-file-title">查看出版社公开的完整同行评议文件</h2>
          <p>
            这条记录来自 Europe PMC 的开放全文索引。点击后才会核验附件并打开官方文件；
            本站不保存 PDF，也不会把尚未解析的合并文件伪装成 Reviewer 对话时间线。
          </p>
          <button
            type="button"
            className="nature-file-button"
            disabled={fileLoading}
            onClick={openPeerReviewFile}
          >
            {fileLoading ? (
              <>
                <span className="nature-button-spinner" aria-hidden="true" />
                thinking... 正在定位文件
              </>
            ) : resolvedUrl ? (
              "再次打开同行评议文件 ↗"
            ) : (
              "打开同行评议文件 ↗"
            )}
          </button>
          {fileError && (
            <p className="nature-file-error" role="alert">
              {fileError}{" "}
              <a href={europePmcUrl} target="_blank" rel="noreferrer">
                打开 Europe PMC 记录 ↗
              </a>
            </p>
          )}
        </div>

        <aside className="nature-provenance">
          <span className="aside-label">索引与来源</span>
          <dl>
            <div>
              <dt>Journal</dt>
              <dd>{pointer.journal || paper.venue}</dd>
            </div>
            <div>
              <dt>DOI</dt>
              <dd>{pointer.doi || "未收录"}</dd>
            </div>
            <div>
              <dt>PMCID</dt>
              <dd>{pointer.pmcid}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd>{pointer.publishedAt || String(paper.year)}</dd>
            </div>
            <div>
              <dt>License</dt>
              <dd>{paper.source.license || "以源站为准"}</dd>
            </div>
          </dl>
          <div className="nature-source-links">
            <a href={europePmcUrl} target="_blank" rel="noreferrer">
              Europe PMC 记录 ↗
            </a>
            <a href={articleUrl} target="_blank" rel="noreferrer">
              出版社页面 ↗
            </a>
          </div>
        </aside>
      </section>

      <section className="nature-boundary-note">
        <span>当前解析边界</span>
        <p>
          Nature Portfolio 的透明同行评议附件常把决定信、Reviewer reports
          与逐点回复合并在一个文件中。本版先提供可靠索引和原文件入口，待文档切分完成后再展示轮次与角色。
        </p>
      </section>
    </main>
  );
}
