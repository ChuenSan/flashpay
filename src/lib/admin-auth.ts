import { randomBytes, timingSafeEqual } from "node:crypto";
import { type NextResponse } from "next/server";
import { verifyPassword } from "./auth-password";
import { serverConfig } from "./config";
import { database } from "./db";
import { HttpError } from "./http";
import { passwordJob, rateLimit } from "./rate-limit";
import {
  clientIp,
  cookieName,
  digest,
  keyedDigest,
  readCookie,
  SESSION_MS,
  setCookie,
} from "./security";

function fingerprint(): string {
  const config = serverConfig();
  return keyedDigest(
    "admin-credentials",
    `${config.adminUsername}\0${config.adminPasswordHash}`,
  );
}

function sessionToken(request: Request): string | undefined {
  const token = readCookie(request, cookieName("admin"));
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}

export function adminRequestLimit(
  request: Request,
  kind: "login" | "session" | "admin" | "logout",
): void {
  const ipKey = keyedDigest("memory-admin-ip", clientIp(request));
  rateLimit(`admin-global:${kind}`, kind === "login" ? 60 : 1200, 60000);
  rateLimit(
    `admin-ip:${kind}:${ipKey}`,
    kind === "login" ? 5 : 120,
    kind === "login" ? 15 * 60000 : 60000,
  );
}

export async function getAdminSession(request: Request) {
  const token = sessionToken(request);
  if (!token) return null;
  const session = await database().adminSession.findUnique({
    where: { tokenHash: digest(token) },
  });
  if (!session) return null;
  if (
    session.expiresAt.getTime() <= Date.now() ||
    session.credentialFingerprint !== fingerprint()
  ) {
    // Rejected sessions stay revoked even if an operator later restores an old hash.
    await database().adminSession.deleteMany({
      where: { tokenHash: session.tokenHash },
    });
    return null;
  }
  return {
    tokenHash: session.tokenHash,
    username: serverConfig().adminUsername,
  };
}

export async function requireAdmin(request: Request) {
  adminRequestLimit(request, "admin");
  const session = await getAdminSession(request);
  if (!session) throw new HttpError(401, "请先登录管理后台", "UNAUTHENTICATED");
  rateLimit(`admin-session:${session.tokenHash}`, 120, 60000);
  return session;
}

export async function checkAdminPassword(password: unknown): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024)
    return false;
  return passwordJob(() =>
    verifyPassword(password, serverConfig().adminPasswordHash),
  );
}

export async function login(
  request: Request,
  body: Record<string, unknown>,
  response: NextResponse,
): Promise<void> {
  const config = serverConfig();
  if (
    typeof body.username !== "string" ||
    body.username.length > 128 ||
    typeof body.password !== "string" ||
    Buffer.byteLength(body.password) > 1024
  ) {
    throw new HttpError(400, "用户名或密码格式无效", "INVALID_CREDENTIALS");
  }
  // Run scrypt even for a wrong username to avoid account-dependent timing.
  const validPassword = await checkAdminPassword(body.password);
  const username = Buffer.from(digest(body.username));
  const expectedUsername = Buffer.from(digest(config.adminUsername));
  if (!validPassword || !timingSafeEqual(username, expectedUsername)) {
    throw new HttpError(401, "用户名或密码错误", "INVALID_CREDENTIALS");
  }
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const oldToken = sessionToken(request);
  await database().$transaction(async (tx) => {
    await tx.adminSession.deleteMany({
      where: {
        OR: [
          { expiresAt: { lte: now } },
          { credentialFingerprint: { not: fingerprint() } },
          ...(oldToken ? [{ tokenHash: digest(oldToken) }] : []),
        ],
      },
    });
    // Keep session storage bounded even when the administrator repeatedly logs in.
    const older = await tx.adminSession.findMany({
      orderBy: [{ createdAt: "desc" }, { tokenHash: "desc" }],
      skip: 19,
      select: { tokenHash: true },
    });
    if (older.length)
      await tx.adminSession.deleteMany({
        where: { tokenHash: { in: older.map((s) => s.tokenHash) } },
      });
    await tx.adminSession.create({
      data: {
        tokenHash: digest(token),
        credentialFingerprint: fingerprint(),
        createdAt: now,
        expiresAt: new Date(now.getTime() + SESSION_MS),
      },
    });
  });
  setCookie(response, "admin", token, SESSION_MS / 1000);
}

export async function logout(
  request: Request,
  response: NextResponse,
): Promise<void> {
  const token = sessionToken(request);
  if (token)
    await database().adminSession.deleteMany({
      where: { tokenHash: digest(token) },
    });
  setCookie(response, "admin", "", 0);
}
