import { HttpError } from "./http";

interface Bucket {
  count: number;
  expires: number;
}
const state = globalThis as unknown as {
  flashpayRateBuckets?: Map<string, Bucket>;
  flashpayPasswordJobs?: number;
};
const MAX_BUCKETS = 10000;

/** Bounded, fail-closed TTL memory limiter. No ordinary access IPs are persisted. */
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const buckets = (state.flashpayRateBuckets ??= new Map());
  const now = Date.now();
  for (const [entry, bucket] of buckets) {
    if (bucket.expires <= now) buckets.delete(entry);
  }
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS)
      throw new HttpError(
        429,
        "请求过于频繁，请稍后重试",
        "RATE_LIMITED",
        Math.max(
          1,
          Math.ceil(
            (Math.min(...Array.from(buckets.values(), (b) => b.expires)) -
              now) /
              1000,
          ),
        ),
      );
    bucket = { count: 0, expires: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.count >= limit)
    throw new HttpError(
      429,
      "请求过于频繁，请稍后重试",
      "RATE_LIMITED",
      Math.max(1, Math.ceil((bucket.expires - now) / 1000)),
    );
  bucket.count++;
}

// Bound concurrent scrypt allocations, in addition to request frequency limits.
export async function passwordJob<T>(job: () => Promise<T>): Promise<T> {
  if ((state.flashpayPasswordJobs ?? 0) >= 4)
    throw new HttpError(429, "验证繁忙，请稍后重试", "RATE_LIMITED", 2);
  state.flashpayPasswordJobs = (state.flashpayPasswordJobs ?? 0) + 1;
  try {
    return await job();
  } finally {
    state.flashpayPasswordJobs!--;
  }
}
