import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { serverConfig } from "./config";
import { HttpError } from "./http";

export const DAY = 24 * 60 * 60 * 1000;
export const RECOVERY_MS = 7 * DAY;
export const SESSION_MS = 8 * 60 * 60 * 1000;
const BROWSER_SECONDS = 365 * 24 * 60 * 60;

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function keyedDigest(purpose: string, value: string): string {
  return createHmac("sha256", serverConfig().sessionSecret)
    .update(`${purpose}\0${value}`)
    .digest("base64url");
}

export function cookieName(kind: "browser" | "admin"): string {
  return `${serverConfig().production ? "__Host-" : ""}flashpay-${kind}`;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  if (header.length > 16384) return undefined;
  const matches = header
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.startsWith(`${name}=`));
  // Reject ambiguous duplicate cookies, including path-based cookie tossing.
  return matches.length === 1 ? matches[0].slice(name.length + 1) : undefined;
}

export function setCookie(
  response: NextResponse,
  kind: "browser" | "admin",
  value: string,
  maxAge: number,
): void {
  response.cookies.set(cookieName(kind), value, {
    httpOnly: true,
    sameSite: "strict",
    secure: serverConfig().production,
    path: "/",
    maxAge,
  });
}

export function browserIdentity(request: Request): {
  id: string;
  cookie?: string;
  refreshedCookie?: string;
} {
  const raw = readCookie(request, cookieName("browser"));
  if (raw && raw.length < 256) {
    const [id, expires, signature, extra] = raw.split(".");
    if (
      !extra &&
      /^[A-Za-z0-9_-]{43}$/.test(id ?? "") &&
      /^\d{10}$/.test(expires ?? "")
    ) {
      const expected = keyedDigest("browser-cookie", `${id}.${expires}`);
      const supplied = Buffer.from(signature ?? "");
      if (
        supplied.length === expected.length &&
        timingSafeEqual(supplied, Buffer.from(expected)) &&
        Number(expires) > Date.now() / 1000 &&
        Number(expires) <= Date.now() / 1000 + BROWSER_SECONDS + 60
      ) {
        const renewed = `${id}.${Math.floor(Date.now() / 1000) + BROWSER_SECONDS}`;
        return {
          id: digest(id),
          refreshedCookie: `${renewed}.${keyedDigest("browser-cookie", renewed)}`,
        };
      }
    }
  }
  const id = randomBytes(32).toString("base64url");
  const expires = Math.floor(Date.now() / 1000) + BROWSER_SECONDS;
  const payload = `${id}.${expires}`;
  return {
    id: digest(id),
    cookie: `${payload}.${keyedDigest("browser-cookie", payload)}`,
  };
}

export function attachBrowser(
  response: NextResponse,
  identity: ReturnType<typeof browserIdentity>,
): NextResponse {
  const cookie = identity.cookie ?? identity.refreshedCookie;
  if (cookie) setCookie(response, "browser", cookie, BROWSER_SECONDS);
  return response;
}

/** No socket peer is exposed by App Router. Unconfigured headers are NEVER trusted.
 * In development, "unknown" is an explicit unavailable-IP marker, not a guessed IP.
 * Production requires a configured trusted proxy and a valid single-IP header.
 */
export function clientIp(request: Request): string {
  const config = serverConfig();
  if (!config.trustedProxyIpHeader) return "unknown";
  const raw = request.headers.get(config.trustedProxyIpHeader)?.trim() ?? "";
  if (!isIP(raw))
    throw new HttpError(
      503,
      "可信代理未提供有效客户端地址",
      "CLIENT_IP_UNAVAILABLE",
    );
  // Normalize IPv6 spellings and mapped IPv4 so equivalent IPs share a counter.
  if (isIP(raw) === 4) return raw;
  const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/i.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}
