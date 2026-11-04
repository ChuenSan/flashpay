"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type AdminRequest = <T = void>(
  url: string,
  init?: RequestInit,
  format?: "json" | "blob" | "none",
) => Promise<T>;

type Settings = { downloadUrl: string };

function readDownloadUrl(result: unknown) {
  if (
    !result ||
    typeof result !== "object" ||
    !("downloadUrl" in result) ||
    typeof result.downloadUrl !== "string"
  ) {
    throw new Error("下载设置响应格式不正确，请重试。");
  }
  return result.downloadUrl;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

function aborted(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export default function DownloadSettings({
  request,
  disabled = false,
}: {
  request: AdminRequest;
  disabled?: boolean;
}) {
  const [downloadUrl, setDownloadUrl] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
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
      // Allow cleanup to cancel Strict Mode replays before requesting settings.
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setLoaded(false);
      setSaving(false);
      setDownloadUrl("");
      setError("");
      setNotice("");
      try {
        const result = await request<Settings>(
          "/api/admin/settings",
          { method: "GET", signal: controller.signal },
          "json",
        );
        if (controller.signal.aborted) return;
        setDownloadUrl(readDownloadUrl(result));
        setLoaded(true);
      } catch (error) {
        if (!controller.signal.aborted && !aborted(error))
          setError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [request, disabled, revision]);

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
      const result = await request<Settings>(
        "/api/admin/settings",
        {
          method: "PUT",
          body: JSON.stringify({ downloadUrl: downloadUrl.trim() }),
          signal: controller.signal,
        },
        "json",
      );
      if (controller.signal.aborted) return;
      setDownloadUrl(readDownloadUrl(result));
      setNotice("下载链接已保存并立即生效，已打开的页面请刷新后获取新地址。");
    } catch (error) {
      if (!controller.signal.aborted && !aborted(error))
        setError(errorMessage(error));
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
      className="admin-download-settings"
      aria-labelledby="admin-download-settings-title"
      aria-busy={busy}
    >
      <h2 id="admin-download-settings-title" className="admin-section-title">
        下载设置
      </h2>
      <form className="admin-download-form" onSubmit={save}>
        <label className="admin-field" htmlFor="admin-download-url">
          下载链接
          <input
            className="admin-input"
            id="admin-download-url"
            name="downloadUrl"
            type="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={downloadUrl}
            disabled={busy || !loaded}
            aria-describedby="admin-download-help"
            onChange={(event) => {
              setDownloadUrl(event.target.value);
              setError("");
              setNotice("");
            }}
          />
        </label>
        <button
          className="admin-button admin-button-primary"
          type="submit"
          disabled={busy || !loaded || !downloadUrl.trim()}
        >
          {saving ? "正在保存…" : "保存下载链接"}
        </button>
      </form>
      <p id="admin-download-help" className="admin-help">
        支付确认后的「打开下载」「复制链接」使用此地址。保存后立即生效，已打开的页面需刷新后获取新地址。
      </p>
      {loading && !disabled && (
        <p className="admin-help" role="status">
          正在加载下载链接…
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
          重试加载
        </button>
      )}
      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
