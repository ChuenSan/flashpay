import { Prisma, type SponsorRecord } from "@prisma/client";
import { database } from "./db";
import { HttpError, privateResponse } from "./http";
import { DAY } from "./security";
import { beijingDayStart, beijingTimestamp, parseDate } from "./validation";

export const PAGE_SIZE = 20;

export function recordFilters(
  input: Record<string, unknown>,
): Prisma.SponsorRecordWhereInput {
  const q = input.q === undefined ? "" : input.q;
  if (typeof q !== "string" || q.length > 128)
    throw new HttpError(400, "搜索内容过长或格式无效", "INVALID_FILTER");
  const visibility =
    input.visibility === undefined || input.visibility === ""
      ? "all"
      : input.visibility;
  if (!["all", "visible", "hidden", "anonymous"].includes(visibility as string))
    throw new HttpError(400, "显示状态无效", "INVALID_FILTER");
  const from = parseDate(input.from, "起始");
  const to = parseDate(input.to, "结束");
  if (from && to && from > to)
    throw new HttpError(400, "起始日期不能晚于结束日期", "INVALID_FILTER");
  const search = q.trim();
  return {
    ...(search
      ? {
          OR: [
            { qq: { contains: search } },
            { ip: { contains: search } },
            { id: { contains: search } },
          ],
        }
      : {}),
    ...(visibility === "visible" ? { hidden: false, qq: { not: null } } : {}),
    ...(visibility === "hidden" ? { hidden: true } : {}),
    ...(visibility === "anonymous" ? { qq: null } : {}),
    ...(from || to
      ? {
          createdAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lt: new Date(to.getTime() + DAY) } : {}),
          },
        }
      : {}),
  };
}

export function recordItem(record: SponsorRecord) {
  return {
    id: record.id,
    qq: record.qq,
    ip: record.ip,
    amountCents: record.amountCents,
    createdAt: record.createdAt.toISOString(),
    hidden: record.hidden,
    unlocked: record.unlocked,
  };
}

export async function listRecords(url: URL) {
  const pageInput = url.searchParams.get("page") ?? "1";
  if (!/^[1-9]\d{0,6}$/.test(pageInput))
    throw new HttpError(400, "页码无效", "INVALID_PAGE");
  const page = Number(pageInput);
  const where = recordFilters(Object.fromEntries(url.searchParams));
  const now = new Date();
  const today = beijingDayStart(now);
  return database().$transaction(async (tx) => {
    const items = await tx.sponsorRecord.findMany({
      where,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const total = await tx.sponsorRecord.count({ where });
    const aggregate = await tx.sponsorRecord.aggregate({
      _count: { _all: true },
      _sum: { amountCents: true },
    });
    const todayCount = await tx.sponsorRecord.count({
      where: { createdAt: { gte: today, lt: new Date(today.getTime() + DAY) } },
    });
    const uniqueIps = await tx.sponsorRecord.groupBy({
      by: ["ip"],
      where: {
        createdAt: { gte: new Date(now.getTime() - 90 * DAY) },
        ip: { not: "unknown" },
      },
    });
    return {
      items: items.map(recordItem),
      total,
      page,
      pageSize: PAGE_SIZE,
      stats: {
        totalCount: aggregate._count._all,
        todayCount,
        totalAmountCents: aggregate._sum.amountCents ?? 0,
        uniqueIps90d: uniqueIps.length,
      },
    };
  });
}

export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvRow(record: SponsorRecord): string {
  return (
    [
      record.id,
      record.qq ?? "",
      record.ip,
      (record.amountCents / 100).toFixed(2),
      beijingTimestamp(record.createdAt),
      record.hidden ? "是" : "否",
      record.unlocked ? "是" : "否",
      record.confirmed ? "是" : "否",
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

/** Keyset batches bound export memory. Exports are generated privately, never stored.
 * Include records present when export begins, not confirmations arriving mid-export.
 */
export async function exportRecords(
  where: Prisma.SponsorRecordWhereInput,
): Promise<Response> {
  const cutoff = new Date();
  const base: Prisma.SponsorRecordWhereInput = {
    AND: [where, { createdAt: { lte: cutoff } }],
  };
  const fetchBatch = (after?: { createdAt: Date; id: string }) =>
    database().sponsorRecord.findMany({
      where: after
        ? {
            AND: [
              base,
              {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              },
            ],
          }
        : base,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
    });
  // Fetch before committing response headers, so initial DB failures remain non-2xx.
  let batch = await fetchBatch();
  let headerSent = false;
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!headerSent) {
          controller.enqueue(
            encoder.encode(
              "\uFEFF记录ID,QQ（匿名留空）,确认IP,自报赞助金额（元）,确认时间（北京时间）,公开隐藏,资源已解锁,用户自主确认\r\n",
            ),
          );
          headerSent = true;
          return;
        }
        if (cancelled) return;
        if (!batch.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(batch.map(csvRow).join("")));
        const last = batch[batch.length - 1];
        batch = batch.length < 500 ? [] : await fetchBatch(last);
      } catch {
        // Terminate a partial download instead of silently reporting a complete CSV.
        controller.error(new Error("CSV export interrupted"));
      }
    },
    cancel() {
      cancelled = true;
      batch = [];
    },
  });
  return privateResponse(
    new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="flashpay-records-${beijingTimestamp(cutoff).slice(0, 10)}.csv"`,
        "X-Accel-Buffering": "no",
      },
    }),
  );
}
