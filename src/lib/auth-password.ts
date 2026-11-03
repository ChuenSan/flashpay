import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 32768;
const r = 8;
const p = 1;
const keyLength = 64;
const maxmem = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N, r, p, maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function isPasswordHash(value: string): boolean {
  if (
    !/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/.test(value)
  )
    return false;
  const parts = value.split("$");
  return (
    Buffer.from(parts[4], "base64url").toString("base64url") === parts[4] &&
    Buffer.from(parts[5], "base64url").toString("base64url") === parts[5]
  );
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || Buffer.byteLength(password) > 1024) {
    throw new Error("Password must contain 1–1024 UTF-8 bytes");
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Malformed hashes fail closed, without accepting attacker-selected scrypt costs. */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password) > 1024 ||
    !isPasswordHash(encoded)
  ) {
    return false;
  }
  const parts = encoded.split("$");
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (
    salt.toString("base64url") !== parts[4] ||
    expected.toString("base64url") !== parts[5]
  )
    return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}
