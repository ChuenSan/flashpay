"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ResourceReleaseSettings } from "@/lib/resource-releases";

type AdminRequest = <T = void>(
  url: string,
  init?: RequestInit,
  format?: "json" | "blob" | "none",
) => Promise<T>;

const EMPTY: ResourceReleaseSettings = {
  version: "",
  publishedAt: "",
  changes: "",
  knownIssues: "",
};

function readSettings(value: unknown): ResourceReleaseSettings {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !("publishedAt" in value) ||
    typeof value.publishedAt !== "string" ||
    !("changes" in value) ||
    typeof value.changes !== "string" ||
    !("knownIssues" in value) ||
    typeof value.knownIssues !== "string"
  )
    throw new Error("更新日志响应格式不正确，请重试。");
  return {
    version: value.version,
    publishedAt: value.publishedAt,
    changes: value.changes,
    knownIssues: value.knownIssues,
  };
}

export default function ReleaseSettings({
  request,
  disabled = false,
}: {
  request: AdminRequest;
  disabled?: boolean;
}) {
  const [settings, setSettings] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const saveLock = useRef(false);

  useEffect(() => {
    if (disabled) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    saveLock.current = false;
    void (async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setLoaded(false);
      setSaving(false);
      setSettings(EMPTY);
      setError("");
      setNotice("");
      try {
        const result = await request(
          "/api/admin/resource-release",
          { method: "GET", signal: controller.signal },
          "json",
        );
        if (controller.signal.aborted) return;
        setSettings(readSettings(result));
        setLoaded(true);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error ? error.message : "加载失败，请重试。",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [request, disabled, revision]);

  function change(field: keyof ResourceReleaseSettings, value: string) {
    setSettings((previous) => ({ ...previous, [field]: value }));
    setError("");
    setNotice("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const controller = controllerRef.current;
    if (
      disabled ||
      !loaded ||
      loading ||
      saveLock.current ||
      !controller ||
      controller.signal.aborted
    )
      return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const result = await request(
        "/api/admin/resource-release",
        {
          method: "PUT",
          body: JSON.stringify(settings),
          signal: controller.signal,
        },
        "json",
      );
      if (controller.signal.aborted) return;
      setSettings(readSettings(result));
      setNotice("更新日志已保存，刷新首页即可查看。");
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      if (!controller.signal.aborted) {
        saveLock.current = false;
        setSaving(false);
      }
    }
  }

  const busy = disabled || loading || saving;
  return (
    <section
      className="admin-release-settings"
      aria-labelledby="admin-release-title"
      aria-busy={busy}
    >
      <h2 className="admin-section-title" id="admin-release-title">
        更新日志设置
      </h2>
      <p className="admin-help" id="admin-release-help">
        编辑首页公开展示的最新版本。保存会替换当前说明，不保留历史版本；请勿填写下载链接或解压密码。
      </p>
      <form onSubmit={save} aria-describedby="admin-release-help">
        <fieldset className="admin-release-fields" disabled={busy || !loaded}>
          <legend className="admin-sr-only">最新版本发布说明</legend>
          <label className="admin-field" htmlFor="admin-release-version">
            版本名称
            <input
              className="admin-input"
              id="admin-release-version"
              name="version"
              type="text"
              required
              maxLength={120}
              autoComplete="off"
              value={settings.version}
              onChange={(event) => change("version", event.target.value)}
            />
          </label>
          <label className="admin-field" htmlFor="admin-release-date">
            发布日期
            <input
              className="admin-input"
              id="admin-release-date"
              name="publishedAt"
              type="date"
              required
              value={settings.publishedAt}
              onChange={(event) => change("publishedAt", event.target.value)}
            />
          </label>
          <div className="admin-field">
            <label htmlFor="admin-release-changes">更新内容（每行一条）</label>
            <textarea
              className="admin-input admin-release-textarea"
              id="admin-release-changes"
              name="changes"
              rows={5}
              required
              maxLength={3000}
              value={settings.changes}
              onChange={(event) => change("changes", event.target.value)}
            />
          </div>
          <div className="admin-field">
            <label htmlFor="admin-release-issues">
              已知问题（选填，每行一条）
            </label>
            <textarea
              className="admin-input admin-release-textarea"
              id="admin-release-issues"
              name="knownIssues"
              rows={5}
              maxLength={1500}
              value={settings.knownIssues}
              onChange={(event) => change("knownIssues", event.target.value)}
            />
          </div>
        </fieldset>
        <div className="admin-release-actions">
          <button
            className="admin-button admin-button-primary"
            type="submit"
            disabled={
              busy ||
              !loaded ||
              !settings.version.trim() ||
              !settings.publishedAt ||
              !settings.changes.trim()
            }
          >
            {saving ? "正在保存…" : "保存更新日志"}
          </button>
          <a href="/#releases" target="_blank" rel="noreferrer">
            查看首页日志 ↗
          </a>
        </div>
      </form>
      {loading && !disabled && (
        <p className="admin-help" role="status">
          正在加载更新日志…
        </p>
      )}
      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      {!loaded && !loading && error && (
        <button
          className="admin-button admin-button-secondary"
          type="button"
          disabled={disabled}
          onClick={() => {
            setLoading(true);
            setError("");
            setRevision((previous) => previous + 1);
          }}
        >
          重试加载日志
        </button>
      )}
      {notice && (
        <p className="admin-notice admin-release-feedback" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
