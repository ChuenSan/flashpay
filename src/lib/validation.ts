import { HttpError } from "./http";
import {
  hasValidAmountFormat,
  isValidQq,
  parseAmountCents,
} from "./input-rules";

export function parseConfirmation(body: Record<string, unknown>) {
  const amountCents = parseAmountCents(body.amount);
  if (amountCents === null) {
    throw new HttpError(
      400,
      hasValidAmountFormat(body.amount)
        ? "金额超出有效范围"
        : "金额须为 0.01 至 10000 元，最多两位小数",
      "INVALID_AMOUNT",
    );
  }
  if (!isValidQq(body.qq)) {
    throw new HttpError(
      400,
      "QQ 号须为首位非零的 5–12 位数字，或留空",
      "INVALID_QQ",
    );
  }
  if (
    typeof body.idempotencyKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      body.idempotencyKey,
    )
  ) {
    throw new HttpError(400, "缺少有效的确认标识", "INVALID_IDEMPOTENCY_KEY");
  }
  return {
    amountCents,
    qq: (body.qq as string) || null,
    key: body.idempotencyKey.toLowerCase(),
  };
}

export function maskQQ(qq: string): string {
  return qq.length < 7
    ? "*".repeat(qq.length)
    : qq.slice(0, 3) + "*".repeat(qq.length - 6) + qq.slice(-3);
}

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;
export function beijingDayStart(now = new Date()): Date {
  const date = new Date(now.getTime() + BEIJING_OFFSET)
    .toISOString()
    .slice(0, 10);
  return new Date(`${date}T00:00:00+08:00`);
}

export function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "1970-01-01" ||
    value > "9998-12-31"
  ) {
    throw new HttpError(400, `${field} 日期格式无效`, "INVALID_FILTER");
  }
  const date = new Date(`${value}T00:00:00+08:00`);
  if (
    !Number.isFinite(date.getTime()) ||
    new Date(date.getTime() + BEIJING_OFFSET).toISOString().slice(0, 10) !==
      value
  ) {
    throw new HttpError(400, `${field} 日期不存在`, "INVALID_FILTER");
  }
  return date;
}

export function beijingTimestamp(date: Date): string {
  return new Date(date.getTime() + BEIJING_OFFSET)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " +08:00");
}
