import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidQq, parseAmountCents } from "../src/lib/input-rules";
import { HttpError } from "../src/lib/http";
import {
  beijingDayStart,
  beijingTimestamp,
  maskQQ,
  parseConfirmation,
  parseDate,
} from "../src/lib/validation";
import {
  hashPassword,
  isPasswordHash,
  verifyPassword,
} from "../src/lib/auth-password";

const key = "8a0cc497-1ae3-4ce1-9faa-f48e326e7181";
const input = { amount: "5", qq: "", idempotencyKey: key };

function rejectsInput(body: Record<string, unknown>, code: string) {
  assert.throws(
    () => parseConfirmation(body),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      error.status === 400 &&
      "code" in error &&
      error.code === code,
  );
}

test("amounts use exact integer cents, including both inclusive limits", () => {
  for (const [amount, cents] of [
    ["0.01", 1],
    ["0.1", 10],
    ["0.29", 29],
    ["5", 500],
    ["10.00", 1000],
    ["20", 2000],
    ["50", 5000],
    ["9999.99", 999999],
    ["10000", 1000000],
    ["10000.00", 1000000],
  ] as const) {
    assert.equal(parseAmountCents(amount), cents);
    assert.equal(parseConfirmation({ ...input, amount }).amountCents, cents);
  }
});

test("amount validation rejects out-of-range, ambiguous and non-string inputs", () => {
  for (const amount of [
    "0",
    "0.00",
    "-0.01",
    "10000.01",
    "10001",
    "99999",
    "100000",
    "0.001",
    "5.000",
    "01",
    "00.01",
    ".01",
    "1.",
    "+1",
    "1e2",
    " 5",
    "5 ",
    "5\n",
    "1,000",
    "NaN",
    "Infinity",
    "",
    "５",
    5,
    0.01,
    null,
    undefined,
    true,
    {},
    [],
  ]) {
    assert.equal(parseAmountCents(amount), null);
    rejectsInput({ ...input, amount }, "INVALID_AMOUNT");
  }
});

test("QQ is optional and accepts only 5–12 digits with nonzero first digit", () => {
  assert.equal(isValidQq(""), true);
  assert.equal(parseConfirmation(input).qq, null);
  for (const qq of ["12345", "123456", "1234567", "123456789012"]) {
    assert.equal(isValidQq(qq), true);
    assert.equal(parseConfirmation({ ...input, qq }).qq, qq);
  }
  for (const qq of [
    "1234",
    "1234567890123",
    "012345",
    "00000",
    " 12345",
    "12345 ",
    "12345\n",
    "12a45",
    "１２３４５",
    "+12345",
    12345,
    null,
    undefined,
    true,
    {},
    [],
    new String("12345"),
  ]) {
    assert.equal(isValidQq(qq), false);
    rejectsInput({ ...input, qq }, "INVALID_QQ");
  }
});

test("shared amount rules cover neighboring cents and reject formatting changes", () => {
  for (const cents of [-1, 0, 1, 2, 99, 100, 999999, 1000000, 1000001]) {
    const value = (cents / 100).toFixed(2);
    assert.equal(
      parseAmountCents(value),
      cents >= 1 && cents <= 1000000 ? cents : null,
    );
    for (const invalid of [` ${value}`, `${value} `, `${value}0`]) {
      assert.equal(parseAmountCents(invalid), null);
    }
  }
  for (const value of [new String("5"), 5n, Symbol("5")]) {
    assert.equal(parseAmountCents(value), null);
    assert.equal(isValidQq(value), false);
  }
});

test("backend preserves error messages, class and validation order", () => {
  for (const [body, code, message] of [
    [
      { ...input, amount: "01", qq: "bad" },
      "INVALID_AMOUNT",
      "金额须为 0.01 至 10000 元，最多两位小数",
    ],
    [
      { ...input, amount: "100000" },
      "INVALID_AMOUNT",
      "金额须为 0.01 至 10000 元，最多两位小数",
    ],
    [
      { ...input, amount: "0", qq: "bad" },
      "INVALID_AMOUNT",
      "金额超出有效范围",
    ],
    [{ ...input, amount: "10000.01" }, "INVALID_AMOUNT", "金额超出有效范围"],
    [
      { ...input, qq: "bad", idempotencyKey: "bad" },
      "INVALID_QQ",
      "QQ 号须为首位非零的 5–12 位数字，或留空",
    ],
    [
      { ...input, idempotencyKey: "bad" },
      "INVALID_IDEMPOTENCY_KEY",
      "缺少有效的确认标识",
    ],
  ] as const) {
    assert.throws(
      () => parseConfirmation(body),
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 400 &&
        error.code === code &&
        error.message === message,
    );
  }
});

test("UUID keys are required, validated and normalized without mutating input", () => {
  const body = { ...input, idempotencyKey: key.toUpperCase() };
  assert.equal(parseConfirmation(body).key, key);
  assert.equal(body.idempotencyKey, key.toUpperCase());
  for (const idempotencyKey of [
    "",
    undefined,
    null,
    123,
    key + "\n",
    " " + key,
    key.replace("-4ce1-", "-0ce1-"),
    key.replace("-9faa-", "-7faa-"),
    key.replaceAll("-", ""),
    "00000000-0000-0000-0000-000000000000",
  ]) {
    rejectsInput({ ...input, idempotencyKey }, "INVALID_IDEMPOTENCY_KEY");
  }
});

test("masking covers every supported length and never returns the full QQ", () => {
  for (const [qq, masked] of [
    ["12345", "*****"],
    ["123456", "******"],
    ["1234567", "123*567"],
    ["12345678", "123**678"],
    ["123456789", "123***789"],
    ["1234567890", "123****890"],
    ["12345678901", "123*****901"],
    ["123456789012", "123******012"],
  ]) {
    assert.equal(maskQQ(qq), masked);
    assert.equal(maskQQ(qq).length, qq.length);
    assert.notEqual(maskQQ(qq), qq);
  }
});

test("Beijing day boundary is UTC+8, including year and leap-day rollover", () => {
  for (const [now, start] of [
    ["2025-12-31T15:59:59.999Z", "2025-12-30T16:00:00.000Z"],
    ["2025-12-31T16:00:00.000Z", "2025-12-31T16:00:00.000Z"],
    ["2024-02-29T15:59:59.999Z", "2024-02-28T16:00:00.000Z"],
    ["2024-02-29T16:00:00.000Z", "2024-02-29T16:00:00.000Z"],
    ["2026-06-01T04:00:00.000Z", "2026-05-31T16:00:00.000Z"],
  ]) {
    const date = new Date(now);
    assert.equal(beijingDayStart(date).toISOString(), start);
    assert.equal(date.toISOString(), now);
  }
});

test("date filters accept real calendar dates and return Beijing midnight", () => {
  assert.equal(parseDate(undefined, "from"), undefined);
  assert.equal(parseDate("", "to"), undefined);
  for (const [value, iso] of [
    ["1970-01-01", "1969-12-31T16:00:00.000Z"],
    ["2000-02-29", "2000-02-28T16:00:00.000Z"],
    ["2024-02-29", "2024-02-28T16:00:00.000Z"],
    ["9998-12-31", "9998-12-30T16:00:00.000Z"],
  ]) {
    assert.equal(parseDate(value, "from")?.toISOString(), iso);
  }
});

test("date filters reject overflow dates, timestamps and unsupported types", () => {
  for (const value of [
    "1969-12-31",
    "9999-01-01",
    "2023-02-29",
    "2100-02-29",
    "2024-02-30",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-1-01",
    "2026-01-1",
    "2026-01-01T00:00:00Z",
    "2026-01-01\n",
    " 2026-01-01",
    null,
    20260101,
    {},
    [],
  ]) {
    assert.throws(
      () => parseDate(value, "from"),
      (error: unknown) =>
        error instanceof Error &&
        "status" in error &&
        error.status === 400 &&
        "code" in error &&
        error.code === "INVALID_FILTER",
    );
  }
});

test("CSV timestamps explicitly label Beijing time and omit milliseconds", () => {
  assert.equal(
    beijingTimestamp(new Date("2025-12-31T16:02:03.456Z")),
    "2026-01-01 00:02:03 +08:00",
  );
  assert.equal(
    beijingTimestamp(new Date("2024-02-29T15:59:59.999Z")),
    "2024-02-29 23:59:59 +08:00",
  );
});

test("password hashes have fixed scrypt costs, random salts and no plaintext", async () => {
  const password = "test-only 密码 🔒";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.ok(isPasswordHash(first));
  assert.ok(isPasswordHash(second));
  assert.notEqual(first, second);
  assert.ok(!first.includes(password));
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword(password, second), true);
  assert.equal(await verifyPassword(password + "!", first), false);
  assert.equal(await verifyPassword("", first), false);
});

test("password limits count UTF-8 bytes, not characters", async () => {
  const password = "密".repeat(341) + "x"; // Exactly 1024 UTF-8 bytes.
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  for (const invalid of ["", "a".repeat(1025), "密".repeat(342)]) {
    await assert.rejects(hashPassword(invalid));
    assert.equal(await verifyPassword(invalid, hash), false);
  }
});

test("malformed hashes and attacker-selected costs fail closed", async () => {
  const hash = await hashPassword("test-only password");
  for (const malformed of [
    "",
    "plaintext",
    hash + "\n",
    hash.slice(0, -1),
    hash.replace("32768", "1048576"),
    hash.replace("$8$1$", "$1$1$"),
    hash.replace("scrypt$", "argon2$"),
    hash.replace(/.$/, "="),
  ]) {
    assert.equal(isPasswordHash(malformed), false);
    assert.equal(await verifyPassword("test-only password", malformed), false);
  }
  const parts = hash.split("$");
  // Valid-looking base64url with nonzero unused bits must not be accepted.
  for (const index of [4, 5]) {
    const changed = [...parts];
    changed[index] = changed[index].slice(0, -1) + "B";
    const malformed = changed.join("$");
    assert.equal(isPasswordHash(malformed), false);
    assert.equal(await verifyPassword("test-only password", malformed), false);
  }
  assert.equal(
    await verifyPassword(undefined as unknown as string, hash),
    false,
  );
});
