import { isIP } from "node:net";
import { isPasswordHash } from "./auth-password";

export class ConfigurationError extends Error {}

function fail(message: string): never {
  throw new ConfigurationError(message);
}

function parseUrl(value: string | undefined, name: string): URL {
  try {
    const url = new URL(value ?? "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      fail(`${name} must be an HTTP(S) URL without credentials`);
    }
    return url;
  } catch {
    return fail(`Invalid ${name}`);
  }
}

// Read at request time: changing username/hash/secret immediately invalidates sessions.
// Node-only imports prevent this module from being bundled for the browser.
export function serverConfig() {
  const production = process.env.NODE_ENV === "production";
  const sessionSecret = process.env.SESSION_SECRET ?? "";
  if (
    Buffer.byteLength(sessionSecret) < 32 ||
    /^(change.?me|example|placeholder)/i.test(sessionSecret) ||
    new Set(sessionSecret).size < 8
  ) {
    fail(
      "SESSION_SECRET requires at least 32 bytes of high-entropy secret material",
    );
  }
  const adminUsername = process.env.ADMIN_USERNAME ?? "";
  if (!adminUsername.trim() || adminUsername.length > 128)
    fail("Invalid ADMIN_USERNAME");
  const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH ?? "";
  if (!isPasswordHash(adminPasswordHash))
    fail("Invalid ADMIN_PASSWORD_HASH (use hashPassword)");
  const app = parseUrl(process.env.APP_ORIGIN, "APP_ORIGIN");
  if (
    app.pathname !== "/" ||
    app.search ||
    app.hash ||
    process.env.APP_ORIGIN !== app.origin
  ) {
    fail("APP_ORIGIN must be an exact origin, without a trailing slash");
  }
  const download = parseUrl(process.env.DOWNLOAD_URL, "DOWNLOAD_URL");
  const databaseUrl =
    process.env.DATABASE_URL || "file:../var/data/flashpay.db";
  if (
    !databaseUrl.startsWith("file:") ||
    databaseUrl.includes(":memory:") ||
    databaseUrl.includes("mode=memory")
  ) {
    fail("DATABASE_URL must refer to a persistent SQLite file");
  }
  // This is a deployment trust assertion, NOT proxy autodetection. The origin must
  // be inaccessible except through a proxy that STRIPS and OVERWRITES this header
  // with exactly one peer IP. Never enable it on a publicly reachable origin.
  const trustedProxyIpHeader =
    process.env.TRUSTED_PROXY_IP_HEADER?.toLowerCase();
  if (
    trustedProxyIpHeader &&
    !["x-real-ip", "cf-connecting-ip", "x-forwarded-for"].includes(
      trustedProxyIpHeader,
    )
  ) {
    fail("Unsupported TRUSTED_PROXY_IP_HEADER");
  }
  if (production) {
    if (app.protocol !== "https:" || download.protocol !== "https:")
      fail("Production requires HTTPS URLs");
    if (!trustedProxyIpHeader)
      fail("Production requires an explicitly trusted, overwriting proxy");
    if (
      ["localhost", "127.0.0.1", "[::1]"].includes(app.hostname) ||
      isIP(app.hostname)
    ) {
      fail("Production APP_ORIGIN must be a public HTTPS hostname");
    }
  }
  return {
    production,
    sessionSecret,
    adminUsername,
    adminPasswordHash,
    appOrigin: app.origin,
    downloadUrl: download.href,
    databaseUrl,
    trustedProxyIpHeader,
  };
}

export type ServerConfig = ReturnType<typeof serverConfig>;
