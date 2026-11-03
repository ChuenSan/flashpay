/** Kept separate so server adapters can preserve format/range error semantics. */
export function hasValidAmountFormat(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(value)
  );
}

export function parseAmountCents(value: unknown): number | null {
  if (!hasValidAmountFormat(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents >= 1 && cents <= 1000000 ? cents : null;
}

export function isValidQq(value: unknown): boolean {
  return (
    typeof value === "string" && (value === "" || /^[1-9]\d{4,11}$/.test(value))
  );
}
