import { Prisma, type SponsorRecord } from "@prisma/client";
import { database } from "./db";
import { getDownloadSettings, type DownloadSettings } from "./settings";
import { HttpError } from "./http";
import { keyedDigest, RECOVERY_MS } from "./security";
import { parseConfirmation } from "./validation";

export function unlockPayload(
  record: SponsorRecord,
  settings: DownloadSettings,
) {
  return {
    unlocked: true as const,
    ...settings,
    confirmedAt: record.createdAt.toISOString(),
    expiresAt: new Date(record.createdAt.getTime() + RECOVERY_MS).toISOString(),
    recordId: record.id,
  };
}

async function persistentIpLimit(
  tx: Prisma.TransactionClient,
  ip: string,
  now: Date,
) {
  for (const [windowMs, limit] of [
    [60000, 10],
    [3600000, 100],
  ]) {
    const key = keyedDigest("confirmation-ip-rate", `${windowMs}:${ip}`);
    const bucket = await tx.confirmationRate.findUnique({ where: { key } });
    if (bucket && bucket.expiresAt > now && bucket.count >= limit) {
      throw new HttpError(
        429,
        "该网络确认过于频繁，请稍后重试",
        "IP_RATE_LIMITED",
        Math.max(
          1,
          Math.ceil((bucket.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      );
    }
    const active = bucket && bucket.expiresAt > now;
    await tx.confirmationRate.upsert({
      where: { key },
      create: { key, count: 1, expiresAt: new Date(now.getTime() + windowMs) },
      update: active
        ? { count: { increment: 1 } }
        : { count: 1, expiresAt: new Date(now.getTime() + windowMs) },
    });
  }
  await tx.confirmationRate.deleteMany({ where: { expiresAt: { lte: now } } });
}

/** All cooldown, abuse counters, claim, and record writes commit together.
 * Acquire SQLite's write lock BEFORE reading to prevent read-then-write races.
 */
export async function confirm(
  browserId: string,
  ip: string,
  body: Record<string, unknown>,
) {
  const input = parseConfirmation(body);
  const settings = await getDownloadSettings();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await database().$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO "BrowserState" ("id") VALUES (${browserId}) ON CONFLICT("id") DO NOTHING`;
          const now = new Date();
          const claim = await tx.confirmationClaim.findUnique({
            where: { key: input.key },
            include: { record: true },
          });
          if (claim) {
            if (claim.browserId !== browserId)
              throw new HttpError(
                409,
                "确认标识不属于当前浏览器",
                "IDEMPOTENCY_CONFLICT",
              );
            if (!claim.record)
              throw new HttpError(
                410,
                "该确认已删除，不能再次使用",
                "RECORD_DELETED",
              );
            if (
              claim.record.amountCents !== input.amountCents ||
              claim.record.qq !== input.qq
            ) {
              throw new HttpError(
                409,
                "同一确认标识不能更改金额或 QQ",
                "IDEMPOTENCY_CONFLICT",
              );
            }
            if (
              !claim.record.unlocked ||
              now.getTime() - claim.record.createdAt.getTime() >= RECOVERY_MS
            ) {
              throw new HttpError(
                410,
                "该确认的恢复期限已过，请发起新的确认",
                "UNLOCK_EXPIRED",
              );
            }
            return {
              ...unlockPayload(claim.record, settings),
              replayed: true,
            };
          }
          const browser = await tx.browserState.findUniqueOrThrow({
            where: { id: browserId },
          });
          if (
            browser.lastConfirmedAt &&
            now.getTime() - browser.lastConfirmedAt.getTime() < 30000
          ) {
            throw new HttpError(
              429,
              "新的确认需间隔 30 秒",
              "CONFIRM_COOLDOWN",
              Math.max(
                1,
                Math.ceil(
                  (30000 -
                    (now.getTime() - browser.lastConfirmedAt.getTime())) /
                    1000,
                ),
              ),
            );
          }
          await persistentIpLimit(tx, ip, now);
          const record = await tx.sponsorRecord.create({
            data: {
              browserId,
              ip,
              qq: input.qq,
              amountCents: input.amountCents,
              createdAt: now,
            },
          });
          await tx.confirmationClaim.create({
            data: { key: input.key, browserId, recordId: record.id },
          });
          await tx.browserState.update({
            where: { id: browserId },
            data: { lastConfirmedAt: now },
          });
          return { ...unlockPayload(record, settings), replayed: false };
        },
        { maxWait: 5000, timeout: 5000 },
      );
    } catch (error) {
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P1008", "P2002", "P2028", "P2034"].includes(error.code);
      if (!retryable) throw error;
      if (attempt === 3)
        throw new HttpError(
          503,
          "保存繁忙，请使用同一确认标识重试",
          "DATABASE_BUSY",
          1,
        );
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
  throw new HttpError(503, "保存暂不可用", "DATABASE_BUSY", 1);
}

export async function recover(browserId: string) {
  const record = await database().sponsorRecord.findFirst({
    where: {
      browserId,
      unlocked: true,
      createdAt: { gt: new Date(Date.now() - RECOVERY_MS) },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return record
    ? unlockPayload(record, await getDownloadSettings())
    : { unlocked: false as const };
}
