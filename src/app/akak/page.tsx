"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import DownloadSettings from "./download-settings";
import "./admin.css";

// Client pages cannot set HTTP response cache headers. The server must send
// Cache-Control: private, no-store for /akak and /api/admin/* independently.

type Auth = "checking" | "guest" | "authenticated" | "error";
type Visibility = "all" | "visible" | "hidden" | "anonymous";
type Filters = { q: string; visibility: Visibility; from: string; to: string };
type RecordItem = {
  id: string;
  qq: string | null;
  ip: string;
  amountCents: number;
  createdAt: string;
  hidden: boolean;
  unlocked: boolean;
};
type RecordsResult = {
  items: RecordItem[];
  total: number;
  page: number;
  pageSize: number;
  stats: {
    totalCount: number;
    todayCount: number;
    totalAmountCents: number;
    uniqueIps90d: number;
  };
};
type Session = { authenticated: boolean; username?: string };
type Modal =
  | { type: "export"; filters: Filters }
  | { type: "hide" | "delete"; record: RecordItem };

const EMPTY_FILTERS: Filters = { q: "", visibility: "all", from: "", to: "" };
const money = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
});
const integer = new Intl.NumberFormat("zh-CN");
const beijingTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const beijingDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间不可用" : beijingTime.format(date);
}

function aborted(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function message(error: unknown) {
  return error instanceof Error ? error.message : "请求失败，请稍后重试。";
}

async function responseError(response: Response) {
  let detail: { error?: string; code?: string; retryAfter?: number | string } =
    {};
  try {
    detail = await response.json();
  } catch {
    /* Non-JSON errors still have a useful status. */
  }
  const wait = detail.retryAfter ?? response.headers.get("Retry-After");
  return new Error(
    `${detail.error || `请求失败（${response.status}），请重试。`}${wait ? ` 请稍后重试（Retry-After：${wait}）。` : ""}`,
  );
}

function ConfirmDialog({
  modal,
  busy,
  error,
  onDismiss,
  onSubmit,
}: {
  modal: Modal;
  busy: boolean;
  error: string;
  onDismiss: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-admin-autofocus]")?.focus();
    return () => {
      dialog?.close();
    };
  }, []);

  const title =
    modal.type === "export"
      ? "验证密码并导出 CSV"
      : modal.type === "delete"
        ? "永久删除这条确认？"
        : modal.record.hidden
          ? "恢复公开展示？"
          : "隐藏这条确认？";
  return (
    <dialog
      ref={ref}
      className="admin-dialog"
      aria-labelledby="admin-dialog-title"
      aria-describedby="admin-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onDismiss();
      }}
    >
      <form className="admin-dialog-form" onSubmit={onSubmit} aria-busy={busy}>
        <h2 id="admin-dialog-title" className="admin-section-title">
          {title}
        </h2>
        <div id="admin-dialog-description" className="admin-dialog-description">
          {modal.type === "export" ? (
            <>
              <p>
                导出当前已应用筛选下的全部记录，不限当前页，包含完整 QQ 和
                IP。请妥善保管文件。
              </p>
              <p>每次导出均需验证管理员密码，密码不会保存在页面中。</p>
              <p className="admin-export-scope">
                关键词：{modal.filters.q || "不限"} · 状态：
                {
                  {
                    all: "全部",
                    visible: "公开",
                    hidden: "隐藏",
                    anonymous: "匿名",
                  }[modal.filters.visibility]
                }
                <br />
                北京日期：{modal.filters.from || "不限"} 至{" "}
                {modal.filters.to || "不限"}
              </p>
            </>
          ) : (
            <>
              <p className="admin-record-reference">
                记录 ID：{modal.record.id}
              </p>
              {modal.type === "delete" ? (
                <>
                  <p>
                    <strong>删除不可恢复。</strong>该记录及完整 QQ、IP
                    将从线上移除，并从统计中剔除；不能再凭此记录恢复资源入口。
                  </p>
                  <p>
                    已取得或分享的资源链接无法撤回。历史备份副本最多额外保留 7
                    天。
                  </p>
                </>
              ) : (
                <p>
                  {modal.record.hidden
                    ? modal.record.qq === null
                      ? "将取消隐藏标记；匿名记录仍不会公开展示。统计不受影响。"
                      : "将在公共名单后续刷新时恢复打码展示，完整 QQ 和 IP 不会公开。统计不受影响。"
                    : "将在公共名单后续刷新时移除。隐藏不影响确认次数、金额、IP 去重统计或已解锁的资源。"}
                </p>
              )}
            </>
          )}
        </div>
        {modal.type === "export" && (
          <label className="admin-field" htmlFor="admin-export-password">
            管理员密码
            <input
              id="admin-export-password"
              className="admin-input"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={busy}
              data-admin-autofocus
            />
          </label>
        )}
        {error && (
          <p className="admin-error" role="alert">
            {error}
          </p>
        )}
        <div className="admin-dialog-actions">
          <button
            className="admin-button admin-button-secondary"
            type="button"
            onClick={onDismiss}
            disabled={busy}
            data-admin-autofocus={modal.type !== "export" || undefined}
          >
            取消
          </button>
          <button
            className={`admin-button ${modal.type === "delete" ? "admin-button-danger" : "admin-button-primary"}`}
            type="submit"
            disabled={busy}
          >
            {busy
              ? modal.type === "export"
                ? "验证并准备下载…"
                : "处理中…"
              : modal.type === "export"
                ? "验证并导出"
                : modal.type === "delete"
                  ? "确认永久删除"
                  : modal.record.hidden
                    ? "确认恢复展示"
                    : "确认隐藏"}
          </button>
        </div>
        {busy && (
          <p className="admin-help" role="status">
            正在处理，请勿重复提交。完成前暂不能关闭此窗口。
          </p>
        )}
      </form>
    </dialog>
  );
}

export default function AdminPage() {
  const [auth, setAuth] = useState<Auth>("checking");
  const [username, setUsername] = useState("admin");
  const [authError, setAuthError] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [query, setQuery] = useState({
    filters: EMPTY_FILTERS,
    page: 1,
    revision: 0,
  });
  const [data, setData] = useState<RecordsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [filterError, setFilterError] = useState("");
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<Modal | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState("");
  const sessionController = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const actionLock = useRef(false);
  const downloadUrls = useRef(new Set<string>());

  const clearPrivateState = useCallback(() => {
    generation.current += 1;
    sessionController.current?.abort();
    sessionController.current = new AbortController();
    setData(null);
    setDraft(EMPTY_FILTERS);
    setQuery({ filters: EMPTY_FILTERS, page: 1, revision: 0 });
    setListError("");
    setFilterError("");
    setNotice("");
    setModal(null);
    setModalError("");
    setModalBusy(false);
    setLoading(false);
    setLoginBusy(false);
    setLogoutBusy(false);
    actionLock.current = false;
    downloadUrls.current.forEach((url) => URL.revokeObjectURL(url));
    downloadUrls.current.clear();
  }, []);

  // One request boundary for cookies, cache policy, cancellation, and expired sessions.
  const request = useCallback(
    async <T = void,>(
      url: string,
      init: RequestInit = {},
      format: "json" | "blob" | "none" = "none",
    ): Promise<T> => {
      if (!sessionController.current)
        sessionController.current = new AbortController();
      const currentGeneration = generation.current;
      const signal = init.signal
        ? AbortSignal.any([init.signal, sessionController.current.signal])
        : sessionController.current.signal;
      const response = await fetch(url, {
        ...init,
        credentials: "same-origin",
        cache: "no-store",
        signal,
        headers: {
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          "Cache-Control": "no-cache, no-store",
          ...init.headers,
        },
      });
      if (generation.current !== currentGeneration || signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      if (!response.ok) {
        const error = await responseError(response);
        if (generation.current !== currentGeneration || signal.aborted)
          throw new DOMException("Cancelled", "AbortError");
        if (response.status === 401) {
          clearPrivateState();
          setAuth("guest");
          setAuthError(
            url === "/api/admin/login"
              ? error.message
              : `会话已失效，请重新登录。${error.message}`,
          );
          throw new DOMException("Session expired", "AbortError");
        }
        throw error;
      }
      const result =
        format === "json"
          ? await response.json()
          : format === "blob"
            ? await response.blob()
            : undefined;
      if (generation.current !== currentGeneration || signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      return result as T;
    },
    [clearPrivateState],
  );

  const checkSession = useCallback(async () => {
    clearPrivateState();
    setAuth("checking");
    setAuthError("");
    try {
      const session = await request<Session>("/api/admin/session", {}, "json");
      if (session.authenticated) {
        setUsername(session.username || "admin");
        setAuth("authenticated");
      } else setAuth("guest");
    } catch (error) {
      if (!aborted(error)) {
        setAuth("error");
        setAuthError(message(error));
      }
    }
  }, [clearPrivateState, request]);

  useEffect(() => {
    let active = true;
    const urls = downloadUrls.current;
    queueMicrotask(() => {
      if (active) void checkSession();
    });
    // Do not restore sensitive records from the browser's back/forward cache.
    const hide = () => {
      clearPrivateState();
      setAuth("checking");
    };
    const show = (event: PageTransitionEvent) => {
      if (event.persisted) void checkSession();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      active = false;
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      sessionController.current?.abort();
      urls.forEach((url) => URL.revokeObjectURL(url));
      urls.clear();
    };
  }, [checkSession, clearPrivateState]);

  useEffect(() => {
    if (auth !== "authenticated") return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      ...query.filters,
      page: String(query.page),
    });
    void (async () => {
      // Start the external request after effect setup; cleanup can cancel Strict Mode replays.
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setData(null);
      setListError("");
      try {
        const result = await request<RecordsResult>(
          `/api/admin/records?${params}`,
          { signal: controller.signal },
          "json",
        );
        if (
          controller.signal.aborted ||
          sessionController.current?.signal.aborted
        )
          return;
        if (
          !Array.isArray(result.items) ||
          !result.stats ||
          result.pageSize < 1 ||
          result.page < 1 ||
          result.total < 0
        ) {
          throw new Error("记录响应格式不正确，请重试。");
        }
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (result.page > lastPage) {
          setQuery((previous) => ({ ...previous, page: lastPage }));
          return;
        }
        setData(result);
      } catch (error) {
        if (!aborted(error) && !controller.signal.aborted)
          setListError(message(error));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [auth, query, request]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actionLock.current) return;
    const form = event.currentTarget;
    const passwordInput = form.elements.namedItem(
      "password",
    ) as HTMLInputElement;
    const password = passwordInput.value;
    passwordInput.value = "";
    actionLock.current = true;
    setLoginBusy(true);
    setAuthError("");
    try {
      await request("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const session = await request<Session>("/api/admin/session", {}, "json");
      if (!session.authenticated)
        throw new Error("登录未建立有效会话，请重试。");
      setUsername(session.username || username.trim());
      setAuth("authenticated");
    } catch (error) {
      if (!aborted(error)) setAuthError(message(error));
    } finally {
      actionLock.current = false;
      setLoginBusy(false);
    }
  }

  async function logout() {
    if (actionLock.current) return;
    actionLock.current = true;
    setLogoutBusy(true);
    setNotice("");
    setListError("");
    try {
      await request("/api/admin/logout", { method: "POST", body: "{}" });
      clearPrivateState();
      setAuth("guest");
      setAuthError("");
    } catch (error) {
      if (!aborted(error))
        setListError(`注销失败，当前会话可能仍然有效。${message(error)}`);
    } finally {
      actionLock.current = false;
      setLogoutBusy(false);
    }
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft.from && draft.to && draft.from > draft.to) {
      setFilterError("开始日期不能晚于结束日期。");
      return;
    }
    setFilterError("");
    setNotice("");
    setQuery((previous) => ({
      filters: { ...draft, q: draft.q.trim() },
      page: 1,
      revision: previous.revision + 1,
    }));
  }

  function openModal(value: Modal) {
    setModalError("");
    setNotice("");
    setModal(value);
  }

  async function submitModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || actionLock.current) return;
    const currentModal = modal;
    const passwordInput = event.currentTarget.elements.namedItem(
      "password",
    ) as HTMLInputElement | null;
    const password = passwordInput?.value || "";
    if (passwordInput) passwordInput.value = "";
    actionLock.current = true;
    setModalBusy(true);
    setModalError("");
    try {
      if (currentModal.type === "export") {
        const blob = await request<Blob>(
          "/api/admin/export",
          {
            method: "POST",
            body: JSON.stringify({ password, ...currentModal.filters }),
          },
          "blob",
        );
        if (sessionController.current?.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        downloadUrls.current.add(url);
        const link = document.createElement("a");
        link.href = url;
        link.download = `sponsorship-records-${beijingDate.format(new Date())}.csv`;
        document.body.appendChild(link);
        try {
          link.click();
        } finally {
          link.remove();
          window.setTimeout(() => {
            URL.revokeObjectURL(url);
            downloadUrls.current.delete(url);
          }, 1000);
        }
        setNotice("CSV 已准备并发起下载，请妥善保管含完整 QQ 与 IP 的文件。");
      } else {
        const deleting = currentModal.type === "delete";
        await request(
          `/api/admin/records/${encodeURIComponent(currentModal.record.id)}`,
          {
            method: deleting ? "DELETE" : "PATCH",
            body: JSON.stringify(
              deleting ? {} : { hidden: !currentModal.record.hidden },
            ),
          },
        );
        setNotice(
          deleting
            ? "记录已删除，正在重新获取记录和统计。"
            : "公开展示状态已更新，正在重新获取记录和统计。",
        );
        // Only report success after the server accepts the operation; never optimistically remove rows.
        setQuery((previous) => ({
          ...previous,
          revision: previous.revision + 1,
        }));
      }
      setModal(null);
    } catch (error) {
      if (!aborted(error)) setModalError(message(error));
    } finally {
      actionLock.current = false;
      setModalBusy(false);
    }
  }

  const shell = (content: ReactNode) => (
    <main className="admin-root">
      <div className="admin-container">{content}</div>
    </main>
  );

  if (auth === "checking" || auth === "error")
    return shell(
      <section className="admin-access" aria-busy={auth === "checking"}>
        <p className="admin-eyebrow">Flashpay · 管理</p>
        <h1 className="admin-title">
          {auth === "checking" ? "正在验证会话" : "暂时无法验证会话"}
        </h1>
        {auth === "checking" ? (
          <p className="admin-muted" role="status">
            身份验证完成前不会加载管理数据。
          </p>
        ) : (
          <>
            <p className="admin-error" role="alert">
              {authError}
            </p>
            <button
              className="admin-button admin-button-primary"
              onClick={() => void checkSession()}
            >
              重新验证
            </button>
          </>
        )}
      </section>,
    );

  if (auth === "guest")
    return shell(
      <section className="admin-access">
        <p className="admin-eyebrow">Flashpay · 管理</p>
        <h1 className="admin-title">管理员登录</h1>
        <p className="admin-muted">使用服务器配置的管理员凭据登录。</p>
        <form
          className="admin-login-form"
          onSubmit={login}
          aria-busy={loginBusy}
        >
          <label className="admin-field" htmlFor="admin-username">
            用户名
            <input
              className="admin-input"
              id="admin-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={loginBusy}
            />
          </label>
          <label className="admin-field" htmlFor="admin-password">
            密码
            <input
              className="admin-input"
              id="admin-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              disabled={loginBusy}
            />
          </label>
          {authError && (
            <p className="admin-error" role="alert">
              {authError}
            </p>
          )}
          <button
            className="admin-button admin-button-primary"
            type="submit"
            disabled={loginBusy}
          >
            {loginBusy ? "正在登录…" : "登录"}
          </button>
        </form>
        <p className="admin-help">
          修改密码请更新服务器配置；改密后已有会话将失效。本页不保存密码。
        </p>
      </section>,
    );

  const busy = loading || logoutBusy || modalBusy;
  const totalPages = data
    ? Math.max(1, Math.ceil(data.total / data.pageSize))
    : null;
  return shell(
    <>
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">Flashpay · 管理</p>
          <h1 className="admin-title">赞助确认记录</h1>
          <p className="admin-muted">
            管理自主确认，不代表支付核验或实际到账。全部日期均为北京时间（Asia/Shanghai）。
          </p>
        </div>
        <div className="admin-account">
          <span className="admin-account-name">{username}</span>
          <button
            className="admin-button admin-button-secondary"
            onClick={() => void logout()}
            disabled={logoutBusy || modalBusy}
          >
            {logoutBusy ? "正在注销…" : "注销"}
          </button>
        </div>
      </header>

      <DownloadSettings request={request} disabled={logoutBusy} />

      <section
        className="admin-overview"
        aria-labelledby="admin-overview-title"
        aria-busy={loading}
      >
        <h2 id="admin-overview-title" className="admin-section-title">
          确认概览
        </h2>
        <dl className="admin-stats">
          {(
            [
              [
                "累计有效确认",
                data ? integer.format(data.stats.totalCount) : "—",
              ],
              [
                "今日有效确认",
                data ? integer.format(data.stats.todayCount) : "—",
              ],
              [
                "自报赞助金额合计",
                data ? money.format(data.stats.totalAmountCents / 100) : "—",
              ],
              [
                "近 90 天 IP 去重",
                data ? integer.format(data.stats.uniqueIps90d) : "—",
              ],
            ] as const
          ).map(([label, value]) => (
            <div className="admin-stat" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="admin-help">
          IP
          去重不代表实际人数。隐藏不影响统计，删除会剔除对应记录；自报金额不是实际收入。
        </p>
      </section>

      <section className="admin-records" aria-labelledby="admin-records-title">
        <div className="admin-section-header">
          <h2 id="admin-records-title" className="admin-section-title">
            确认明细
          </h2>
          <button
            className="admin-button admin-button-primary"
            onClick={() =>
              openModal({ type: "export", filters: { ...query.filters } })
            }
            disabled={busy || !data}
          >
            导出 CSV
          </button>
        </div>
        <form className="admin-filters" onSubmit={applyFilters}>
          <label className="admin-field admin-search" htmlFor="admin-q">
            搜索 QQ / IP / 记录 ID
            <input
              className="admin-input"
              id="admin-q"
              name="q"
              type="search"
              autoComplete="off"
              placeholder="输入完整或部分关键词"
              value={draft.q}
              onChange={(event) =>
                setDraft({ ...draft, q: event.target.value })
              }
              disabled={logoutBusy}
            />
          </label>
          <label className="admin-field" htmlFor="admin-visibility">
            公开状态
            <select
              className="admin-input"
              id="admin-visibility"
              name="visibility"
              value={draft.visibility}
              disabled={logoutBusy}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  visibility: event.target.value as Visibility,
                })
              }
            >
              <option value="all">全部记录</option>
              <option value="visible">公开</option>
              <option value="hidden">已隐藏</option>
              <option value="anonymous">匿名</option>
            </select>
          </label>
          <label className="admin-field" htmlFor="admin-from">
            开始日期（北京）
            <input
              className="admin-input"
              id="admin-from"
              name="from"
              type="date"
              autoComplete="off"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(event) =>
                setDraft({ ...draft, from: event.target.value })
              }
              disabled={logoutBusy}
            />
          </label>
          <label className="admin-field" htmlFor="admin-to">
            结束日期（北京）
            <input
              className="admin-input"
              id="admin-to"
              name="to"
              type="date"
              autoComplete="off"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(event) =>
                setDraft({ ...draft, to: event.target.value })
              }
              disabled={logoutBusy}
            />
          </label>
          <div className="admin-filter-actions">
            <button
              className="admin-button admin-button-secondary"
              type="submit"
              disabled={busy}
            >
              {loading ? "查询中…" : "查询"}
            </button>
            <button
              className="admin-button admin-button-quiet"
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(EMPTY_FILTERS);
                setFilterError("");
                setNotice("");
                setQuery((previous) => ({
                  filters: EMPTY_FILTERS,
                  page: 1,
                  revision: previous.revision + 1,
                }));
              }}
            >
              重置
            </button>
          </div>
        </form>
        <p className="admin-help">
          日期按北京时间整日筛选。修改条件后点击「查询」；分页和导出均使用已应用的筛选条件。
        </p>
        {filterError && (
          <p className="admin-error" role="alert">
            {filterError}
          </p>
        )}
        {notice && (
          <p className="admin-notice" role="status">
            {notice}
          </p>
        )}
        {listError && (
          <div className="admin-error-panel" role="alert">
            <p className="admin-error">{listError}</p>
            <button
              className="admin-button admin-button-secondary"
              disabled={busy}
              onClick={() =>
                setQuery((previous) => ({
                  ...previous,
                  revision: previous.revision + 1,
                }))
              }
            >
              重试加载
            </button>
          </div>
        )}
        {loading && (
          <p className="admin-table-state" role="status">
            正在加载记录和统计…
          </p>
        )}
        {!loading && !data && !listError && (
          <p className="admin-table-state" role="status">
            准备加载记录…
          </p>
        )}
        {data && !loading && (
          <>
            <p className="admin-result-count" role="status">
              共 {integer.format(data.total)} 条匹配记录
              {data.total > 0 &&
                ` · 本页 ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} 条`}
            </p>
            <p className="admin-mobile-hint admin-help">
              表格可左右滑动查看完整记录与操作。
            </p>
            <div
              className="admin-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="赞助确认明细，可横向滚动"
            >
              <table className="admin-table">
                <caption className="admin-sr-only">
                  赞助确认明细，包含完整 QQ、IP 和自报金额，时间为北京时间
                </caption>
                <thead>
                  <tr>
                    <th scope="col">记录 ID</th>
                    <th scope="col">QQ</th>
                    <th scope="col">确认 IP</th>
                    <th scope="col">自报金额</th>
                    <th scope="col">确认时间（北京）</th>
                    <th scope="col">资源状态</th>
                    <th scope="col">公开状态</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.length ? (
                    data.items.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <span className="admin-id">{record.id}</span>
                        </td>
                        <td className="admin-numeric">
                          {record.qq ?? (
                            <span className="admin-muted">匿名</span>
                          )}
                        </td>
                        <td>
                          <span className="admin-ip">{record.ip}</span>
                        </td>
                        <td className="admin-numeric">
                          {money.format(record.amountCents / 100)}
                        </td>
                        <td className="admin-time">
                          <time dateTime={record.createdAt}>
                            {formatTime(record.createdAt)}
                          </time>
                        </td>
                        <td>
                          <span className="admin-status">
                            {record.unlocked ? "资源已解锁" : "资源未解锁"}
                          </span>
                        </td>
                        <td>
                          {record.hidden
                            ? "已隐藏"
                            : record.qq === null
                              ? "匿名 · 不公开"
                              : "公开（QQ 打码）"}
                        </td>
                        <td>
                          <div className="admin-row-actions">
                            <button
                              className="admin-button admin-button-quiet"
                              disabled={busy}
                              aria-label={`${record.hidden ? "恢复展示" : "隐藏"}记录 ${record.id}`}
                              onClick={() =>
                                openModal({ type: "hide", record })
                              }
                            >
                              {record.hidden ? "恢复展示" : "隐藏"}
                            </button>
                            <button
                              className="admin-button admin-button-delete"
                              disabled={busy}
                              aria-label={`删除记录 ${record.id}`}
                              onClick={() =>
                                openModal({ type: "delete", record })
                              }
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="admin-empty">
                        暂无匹配记录。可调整筛选条件或重置查询。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <nav className="admin-pagination" aria-label="记录分页">
              <p className="admin-help">
                第 {data.page} / {totalPages} 页 · 每页 {data.pageSize} 条
              </p>
              <div className="admin-page-actions">
                <button
                  className="admin-button admin-button-secondary"
                  disabled={busy || data.page <= 1}
                  onClick={() =>
                    setQuery((previous) => ({
                      ...previous,
                      page: data.page - 1,
                    }))
                  }
                >
                  上一页
                </button>
                <button
                  className="admin-button admin-button-secondary"
                  disabled={busy || data.page >= (totalPages ?? 1)}
                  onClick={() =>
                    setQuery((previous) => ({
                      ...previous,
                      page: data.page + 1,
                    }))
                  }
                >
                  下一页
                </button>
              </div>
            </nav>
          </>
        )}
      </section>
      <footer className="admin-footer">
        <p>
          「资源已解锁」不代表下载成功。完整 QQ 和 IP 仅供管理使用，请勿公开。
        </p>
        <p>
          修改管理员密码请更新服务器配置；改密后已有会话将失效。本页不保存密码。
        </p>
      </footer>
      {modal && (
        <ConfirmDialog
          modal={modal}
          busy={modalBusy}
          error={modalError}
          onDismiss={() => {
            if (!modalBusy) {
              setModal(null);
              setModalError("");
            }
          }}
          onSubmit={submitModal}
        />
      )}
    </>,
  );
}
