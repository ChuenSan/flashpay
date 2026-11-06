"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { publicConfig } from "@/lib/public-config";
import { isValidQq, parseAmountCents } from "@/lib/input-rules";

type Unlock = {
  unlocked: true;
  downloadUrl: string;
  archivePassword: string;
  confirmedAt: string;
  expiresAt: string;
  recordId: string;
};
type Sponsor = {
  id: string;
  qqMasked: string;
  amountCents: number;
  createdAt: string;
};
type Attempt = { amount: string; qq: string; idempotencyKey: string };
const storageKey = "flashpay-tab-draft-v1";
const money = (cents: number) =>
  (cents / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });

function readDraft(): {
  amount?: string;
  qq?: string;
  custom?: boolean;
  attempt?: Attempt;
} | null {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey) || "null");
  } catch {
    return null;
  }
}

export function SponsorWorkspace() {
  const [amount, setAmount] = useState(String(publicConfig.amounts[0] / 100));
  const [custom, setCustom] = useState(false);
  const [qq, setQq] = useState("");
  const [qqOpen, setQqOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unlock, setUnlock] = useState<Unlock | null>(null);
  const [sponsors, setSponsors] = useState<Sponsor[]>([]);
  const [listError, setListError] = useState(false);
  const [copied, setCopied] = useState<"link" | "password" | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [now, setNow] = useState(0);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const inFlight = useRef(false);
  const secondsLeft = Math.max(0, Math.ceil((cooldownUntil - now) / 1000));
  const selectedAmount = parseAmountCents(amount);

  const refreshSponsors = useCallback(async () => {
    try {
      const response = await fetch("/api/sponsors", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const data = await response.json();
      setSponsors(data.items);
      setListError(false);
    } catch {
      setListError(true);
    }
  }, []);

  const checkUnlock = useCallback(async () => {
    setChecking(true);
    setError("");
    try {
      if (!navigator.locks)
        throw new Error("当前浏览器不支持安全初始化，请使用较新版本浏览器。");
      const signal = AbortSignal.timeout(15_000);
      // Cookies are shared by tabs. Serialize initialization across the origin so
      // a late, cookie-less response cannot overwrite an already confirmed identity.
      const data = await navigator.locks.request(
        "flashpay-browser-identity-v1",
        { signal },
        async () => {
          const response = await fetch("/api/unlock", {
            cache: "no-store",
            signal,
          });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error || "暂时无法检查资源入口，请重试。");
          return result;
        },
      );
      if (data.unlocked) setUnlock(data);
      setReady(true);
    } catch (cause) {
      setReady(false);
      setError(
        cause instanceof Error &&
          !(cause instanceof TypeError) &&
          !(cause instanceof DOMException)
          ? cause.message
          : "入口检测未完成，请检查网络后重新检测。",
      );
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Browser-only storage is read after hydration; never put private draft data in SSR HTML.
    const draft = readDraft();
    if (draft && typeof draft === "object") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Restore browser-only draft once after hydration, not into public server HTML.
      if (typeof draft.amount === "string") setAmount(draft.amount);
      if (typeof draft.qq === "string") {
        setQq(draft.qq);
        setQqOpen(Boolean(draft.qq));
      }
      if (typeof draft.custom === "boolean") setCustom(draft.custom);
      if (draft.attempt?.idempotencyKey) attemptRef.current = draft.attempt;
    }
    setDraftLoaded(true);
    void checkUnlock();
    void refreshSponsors();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshSponsors();
    }, 30_000);
    const onVisible = () => {
      if (!document.hidden) void refreshSponsors();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkUnlock, refreshSponsors]);

  useEffect(() => {
    if (!draftLoaded) return;
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ amount, qq, custom, attempt: attemptRef.current }),
      );
    } catch {
      /* Storage unavailable: keep the live form usable. */
    }
  }, [amount, qq, custom, draftLoaded]);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !ready) return;
    setError("");
    if (parseAmountCents(amount) === null) {
      setError("请输入 ¥0.01～¥10,000 的金额，最多两位小数。");
      return;
    }
    if (!isValidQq(qq)) {
      setError("QQ 号应为 5～12 位数字，首位不能是 0；也可以留空。");
      return;
    }
    let attempt = attemptRef.current;
    if (!attempt || attempt.amount !== amount || attempt.qq !== qq) {
      attempt = { amount, qq, idempotencyKey: crypto.randomUUID() };
      attemptRef.current = attempt;
    }
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ amount, qq, custom, attempt }),
      );
    } catch {
      /* The in-memory idempotency key still protects retries. */
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.retryAfter) {
          const time = Date.now();
          setNow(time);
          setCooldownUntil(time + data.retryAfter * 1000);
        }
        throw new Error(data.error || "记录未能保存，请重试。");
      }
      if (!data.unlocked || !data.downloadUrl)
        throw new Error("尚未取得资源地址，请使用相同信息重试。");
      setUnlock(data);
      attemptRef.current = null;
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* No durable browser draft is required after success. */
      }
      void refreshSponsors();
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (cause) {
      setError(
        cause instanceof Error &&
          !(cause instanceof TypeError) &&
          !(cause instanceof DOMException)
          ? cause.message
          : "网络连接中断。信息已保留，请重试，不会重复计数。",
      );
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }

  function startAnother() {
    const elapsed = Date.now() - new Date(unlock!.confirmedAt).getTime();
    if (elapsed < 30_000) {
      const time = Date.now();
      setNow(time);
      setCooldownUntil(time + (30_000 - elapsed));
    }
    setUnlock(null);
    setError("");
    setQq("");
    setQqOpen(false);
    attemptRef.current = null;
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(unlock!.downloadUrl);
      setCopied("link");
    } catch {
      setError("无法自动复制，请使用「打开下载」进入资源页面。");
    }
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(unlock!.archivePassword);
      setCopied("password");
    } catch {
      setError("无法自动复制，请手动选择上方的压缩包密码并复制。");
    }
  }

  return (
    <div className="sponsor-workspace">
      <section
        className="workspace"
        aria-label="赞助与资源入口"
        aria-busy={busy || checking}
      >
        <div className="workspace-top">
          <h2>{unlock ? "你的资源入口" : "随心赞助，获取资源"}</h2>
          <span className={unlock ? "state-label is-unlocked" : "state-label"}>
            <i aria-hidden="true" />
            {unlock
              ? "记录已保存"
              : checking
                ? "正在检测入口"
                : !ready
                  ? "检测未完成"
                  : busy
                    ? "正在保存"
                    : "等待自主确认"}
          </span>
        </div>
        {unlock ? (
          <div className="unlock-panel">
            <span className="unlock-symbol" aria-hidden="true">
              ✓
            </span>
            <h3 ref={resultRef} tabIndex={-1}>
              资源入口已解锁
            </h3>
            <p>赞助记录已保存，谢谢你的支持。</p>
            <a
              className="primary-button download-button"
              href={unlock.downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              打开下载 <span aria-hidden="true">↗</span>
            </a>
            <button type="button" className="text-button" onClick={copyLink}>
              {copied === "link" ? "链接已复制" : "复制资源链接"}
            </button>
            {unlock.archivePassword && (
              <div className="archive-password">
                <span>压缩包密码</span>
                <code>{unlock.archivePassword}</code>
                <button
                  type="button"
                  className="text-button"
                  onClick={copyPassword}
                >
                  {copied === "password" ? "密码已复制" : "复制压缩包密码"}
                </button>
              </div>
            )}
            <div className="restore-note">
              <strong>
                此浏览器可恢复至{" "}
                {new Intl.DateTimeFormat("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                }).format(new Date(unlock.expiresAt))}
                （北京时间）。
              </strong>
              <span>清除浏览器数据、换设备或记录被删除后，可能无法恢复。</span>
            </div>
            <a
              className="resource-check-link"
              href={publicConfig.demoUrl}
              target="_blank"
              rel="noreferrer"
            >
              刷机前，查看演示核对机型与步骤 ↗
            </a>
            {error && (
              <p
                className="form-error"
                role="alert"
                ref={errorRef}
                tabIndex={-1}
              >
                {error}
              </p>
            )}
            <button
              type="button"
              className="text-button another-button"
              onClick={startAnother}
            >
              再支持一次
            </button>
            <span className="sr-only" role="status">
              {copied === "link"
                ? "资源链接已复制"
                : copied === "password"
                  ? "压缩包密码已复制"
                  : ""}
            </span>
          </div>
        ) : (
          <form className="sponsor-form" onSubmit={submit} noValidate>
            <div className="form-inputs">
              <fieldset disabled={busy} className="amount-fieldset">
                <legend>
                  <span className="step-number">1</span>选择赞助金额
                </legend>
                <div className="amount-options">
                  {publicConfig.amounts.map((cents) => (
                    <button
                      type="button"
                      key={cents}
                      aria-pressed={!custom && Number(amount) * 100 === cents}
                      className={
                        !custom && Number(amount) * 100 === cents
                          ? "amount-option selected"
                          : "amount-option"
                      }
                      onClick={() => {
                        setCustom(false);
                        setAmount(String(cents / 100));
                      }}
                    >
                      <span>¥</span>
                      {money(cents)}
                    </button>
                  ))}
                </div>
                <div className="amount-meta">
                  <p className="amount-hint">任意金额，获取同一份资源。</p>
                  <button
                    type="button"
                    className="custom-toggle"
                    aria-expanded={custom}
                    aria-controls="custom-amount-area"
                    onClick={() => {
                      setCustom(!custom);
                      if (!custom) setAmount("");
                      else setAmount(String(publicConfig.amounts[0] / 100));
                    }}
                  >
                    {custom ? "使用固定金额 −" : "自定义金额 ＋"}
                  </button>
                </div>
                {custom && (
                  <div id="custom-amount-area" className="custom-amount">
                    <label htmlFor="custom-amount">自定义金额（元）</label>
                    <div className="currency-input">
                      <span>¥</span>
                      <input
                        id="custom-amount"
                        name="amount"
                        type="text"
                        inputMode="decimal"
                        placeholder="0.01～10,000"
                        value={amount}
                        maxLength={8}
                        onChange={(e) => setAmount(e.target.value)}
                      />
                    </div>
                    <small>最多两位小数，任意合法金额获取相同资源。</small>
                  </div>
                )}
              </fieldset>
            </div>
            <div className="payment-area">
              <h3>
                <span className="step-number">2</span>使用微信扫码
              </h3>
              <div className="qr-frame">
                <Image
                  src={publicConfig.qrPath}
                  alt="微信收款二维码"
                  width={196}
                  height={196}
                  priority
                  unoptimized
                />
              </div>
              <p className="chosen-amount">
                本次赞助{" "}
                <strong>
                  ¥{selectedAmount !== null ? money(selectedAmount) : "—"}
                </strong>
              </p>
              <p className="manual-amount">
                微信内手动填金额，转账后在下方确认。
              </p>
              <details className="phone-payment-help">
                <summary>在本机付款？</summary>
                <p>
                  <a href={publicConfig.qrPath} download="微信收款码.png">
                    保存收款码 ↓
                  </a>
                  ，在微信扫一扫中尝试从相册识别；无法识别时，请用另一台设备扫码。返回本页后继续确认。
                </p>
              </details>
            </div>
            <div className="optional-details">
              <details
                className="qq-field"
                open={qqOpen}
                onToggle={(event) => setQqOpen(event.currentTarget.open)}
              >
                <summary>
                  添加 QQ 号<span>选填</span>
                </summary>
                <label htmlFor="qq">QQ 号</label>
                <input
                  id="qq"
                  name="qq"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={12}
                  placeholder="也可以匿名支持"
                  value={qq}
                  disabled={busy}
                  onChange={(e) => setQq(e.target.value)}
                  aria-describedby="qq-privacy"
                />
                <p id="qq-privacy">
                  完整 QQ
                  号仅后台可见。填写即同意公开打码号码与自报金额；留空不进入公开名单。
                </p>
              </details>
              <p className="form-privacy">
                <Link href="/privacy">隐私说明</Link>
              </p>
            </div>
            <div className="confirm-area">
              <div className="confirm-description">
                <span className="step-number">3</span>
                <span>付款后，自主确认</span>
              </div>
              <button
                type="submit"
                className="primary-button confirm-button"
                disabled={busy || checking || !ready || secondsLeft > 0}
              >
                {busy
                  ? "正在保存确认…"
                  : checking
                    ? "正在检测入口…"
                    : secondsLeft > 0
                      ? `${secondsLeft} 秒后可再次确认`
                      : "我已付款，确认赞助"}
                <span aria-hidden="true">{busy || checking ? "…" : "→"}</span>
              </button>
              <p className="confirm-note">本站不自动核验微信到账。</p>
              <div className="form-feedback" aria-live="polite">
                {error && (
                  <p
                    className="form-error"
                    role="alert"
                    ref={errorRef}
                    tabIndex={-1}
                  >
                    {error}
                  </p>
                )}
                {!checking && !ready && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => void checkUnlock()}
                  >
                    重新检测入口
                  </button>
                )}
              </div>
            </div>
          </form>
        )}
      </section>
      <section className="supporters-section" aria-label="最近的赞助支持">
        <div className="supporters-title">感谢每一份支持</div>
        {listError ? (
          <p className="supporters-empty">名单暂时无法更新，感谢你的支持。</p>
        ) : sponsors.length === 0 ? null : (
          <div className="supporters-viewport">
            <div className="supporters-track">
              {sponsors.map((sponsor) => (
                <span className="supporter" key={sponsor.id}>
                  <span>{sponsor.qqMasked}</span>
                  <strong>¥{money(sponsor.amountCents)}</strong>
                  <span className="sr-only">自报赞助金额，感谢支持</span>
                </span>
              ))}
            </div>
          </div>
        )}
        <span className="public-list-label">自报赞助 · 非到账统计</span>
      </section>
    </div>
  );
}
