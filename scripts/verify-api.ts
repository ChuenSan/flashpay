/**
 * Destructive CONTRACT checks for a dedicated, EMPTY temporary SQLite service only.
 * The caller must provision its DATABASE_URL; HTTP cannot prove which DB is used.
 * No default URL/credentials, no delete-all, no requests to the download provider.
 *
 * VERIFY_BASE_URL=http://127.0.0.1:<temporary-port> \
 * VERIFY_ADMIN_USERNAME=... VERIFY_ADMIN_PASSWORD=... VERIFY_ALLOW_MUTATION=1 \
 * ./scripts/project-tool node --import tsx scripts/verify-api.ts
 *
 * Only self-reported confirmations are checked, never actual payment or downloads.
 * This fetch-only script does not execute browser UI validation or restart the DB.
 */
import { randomInt, randomUUID } from "node:crypto";
import { isIP } from "node:net";

let assertions = 0;
let phase = "authorization";
class VerificationFailure extends Error {}
function check(condition: unknown, label: string): asserts condition {
  assertions++;
  if (!condition) throw new VerificationFailure(label);
}

type Json = Record<string, unknown>;
type Reply = { response: Response; text: string; data: Json };
type Stats = {
  totalCount: number;
  todayCount: number;
  totalAmountCents: number;
  uniqueIps90d: number;
};
type RecordItem = {
  id: string;
  qq: string | null;
  ip: string;
  amountCents: number;
  createdAt: string;
  hidden: boolean;
  unlocked: boolean;
};
type Listing = {
  items: RecordItem[];
  total: number;
  page: number;
  pageSize: number;
  stats: Stats;
};
type Attempt = { amount: string; qq: string; idempotencyKey: string };

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configuration() {
  const {
    VERIFY_BASE_URL: raw,
    VERIFY_ADMIN_USERNAME: username,
    VERIFY_ADMIN_PASSWORD: password,
    VERIFY_ALLOW_MUTATION: allow,
  } = process.env;
  check(allow === "1", "explicit mutation authorization is required");
  check(
    raw && username && password,
    "explicit URL and admin credentials are required",
  );
  const base = new URL(raw);
  check(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      !!base.port &&
      Number(base.port) > 0 &&
      !base.username &&
      !base.password &&
      base.pathname === "/" &&
      !base.search &&
      !base.hash,
    "only an explicitly ported loopback test origin is allowed",
  );
  return { base: base.origin, username, password };
}

/** Separate jars emulate separate browsers. Never split Set-Cookie on commas. */
class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  async request(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      origin?: string;
      raw?: boolean;
    } = {},
  ): Promise<Reply> {
    const url = new URL(path, this.base);
    check(
      url.origin === this.base,
      "requests must stay on the authorized origin",
    );
    const headers = new Headers({ Origin: options.origin ?? this.base });
    if (this.cookies.size) {
      headers.set(
        "Cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      );
    }
    if (options.body !== undefined)
      headers.set("Content-Type", "application/json");
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    check(
      typeof response.headers.getSetCookie === "function",
      "Node getSetCookie support is required",
    );
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const equal = pair.indexOf("=");
      check(equal > 0, "valid Set-Cookie syntax");
      const name = pair.slice(0, equal).trim();
      const value = pair.slice(equal + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key, ...rest] = attribute.trim().split("=");
        return (
          (key.toLowerCase() === "max-age" && Number(rest.join("=")) <= 0) ||
          (key.toLowerCase() === "expires" &&
            Date.parse(rest.join("=")) <= Date.now())
        );
      });
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let data: Json = {};
    if (!options.raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("JSON response required");
      }
      check(object(parsed), "JSON object response required");
      data = parsed;
    }
    return { response, text, data };
  }
}

function privateNoStore(reply: Reply) {
  const policy = reply.response.headers.get("cache-control") ?? "";
  check(
    /\bprivate\b/i.test(policy) && /\bno-store\b/i.test(policy),
    "sensitive response must be private, no-store",
  );
}
function success(reply: Reply) {
  check(reply.response.ok, "request must succeed");
}
function denied(reply: Reply, statuses: number[]) {
  check(
    !reply.response.ok && statuses.includes(reply.response.status),
    "request must be rejected with the expected status",
  );
  check(
    typeof reply.data.error === "string" && reply.data.error.length > 0,
    "errors use the JSON error contract",
  );
  check(
    !/(downloadUrl|recordId|qqMasked)/i.test(reply.text),
    "error must not disclose a resource or record",
  );
  privateNoStore(reply);
}
function equalStats(actual: Stats, expected: Stats) {
  for (const field of [
    "totalCount",
    "todayCount",
    "totalAmountCents",
    "uniqueIps90d",
  ] as const) {
    check(
      actual[field] === expected[field],
      "statistics must match active confirmations",
    );
  }
}
function beijingDay(date: Date) {
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}
function expectedStats(items: RecordItem[]): Stats {
  const now = new Date();
  return {
    totalCount: items.length,
    todayCount: items.filter(
      (item) => beijingDay(new Date(item.createdAt)) === beijingDay(now),
    ).length,
    totalAmountCents: items.reduce((sum, item) => sum + item.amountCents, 0),
    uniqueIps90d: new Set(
      items
        .filter(
          (item) =>
            Date.parse(item.createdAt) >= now.getTime() - 90 * 86400_000,
        )
        .map((item) => item.ip),
    ).size,
  };
}
async function records(
  admin: Browser,
  filters: Record<string, string> = {},
): Promise<Listing> {
  const reply = await admin.request(
    `/api/admin/records?${new URLSearchParams({ page: "1", ...filters })}`,
  );
  success(reply);
  privateNoStore(reply);
  const data = reply.data;
  check(
    Array.isArray(data.items) &&
      Number.isSafeInteger(data.total) &&
      Number(data.total) >= 0,
    "records list shape",
  );
  check(
    data.page === Number(filters.page ?? "1") &&
      Number.isSafeInteger(data.pageSize) &&
      Number(data.pageSize) > 0,
    "pagination contract",
  );
  check(object(data.stats), "statistics object required");
  for (const name of [
    "totalCount",
    "todayCount",
    "totalAmountCents",
    "uniqueIps90d",
  ]) {
    check(
      Number.isSafeInteger(data.stats[name]) && Number(data.stats[name]) >= 0,
      "nonnegative integer statistics",
    );
  }
  return data as unknown as Listing;
}
async function sponsors(browser: Browser) {
  const reply = await browser.request("/api/sponsors");
  success(reply);
  check(
    Object.keys(reply.data).every((key) => key === "items") &&
      Array.isArray(reply.data.items),
    "public sponsors expose only items",
  );
  for (const item of reply.data.items) {
    check(object(item), "public sponsor object");
    check(
      Object.keys(item).sort().join(",") ===
        "amountCents,createdAt,id,qqMasked",
      "public allowlist excludes IP, full QQ and download URLs",
    );
    check(
      typeof item.id === "string" &&
        typeof item.qqMasked === "string" &&
        item.qqMasked.includes("*"),
      "public QQ must be masked",
    );
    check(
      Number.isSafeInteger(item.amountCents) &&
        Number(item.amountCents) >= 1 &&
        Number(item.amountCents) <= 1_000_000,
      "public amount range",
    );
    check(
      typeof item.createdAt === "string" &&
        Number.isFinite(Date.parse(item.createdAt)),
      "public creation date",
    );
  }
  return reply.data.items as Json[];
}
async function locked(browser: Browser) {
  const reply = await browser.request("/api/unlock");
  success(reply);
  privateNoStore(reply);
  check(
    reply.data.unlocked === false && Object.keys(reply.data).length === 1,
    "unconfirmed browser has no resource or private data",
  );
}
function unlocked(reply: Reply) {
  success(reply);
  privateNoStore(reply);
  check(
    reply.data.unlocked === true &&
      typeof reply.data.recordId === "string" &&
      reply.data.recordId.length > 0,
    "saved confirmation returns its record ID",
  );
  check(
    typeof reply.data.downloadUrl === "string",
    "saved confirmation returns a download URL",
  );
  const url = new URL(reply.data.downloadUrl);
  check(
    ["http:", "https:"].includes(url.protocol),
    "download URL uses HTTP(S)",
  );
  check(
    !/("qq"|"ip"|"password"|"secret")\s*:/i.test(reply.text),
    "unlock response excludes private record fields",
  );
  return { id: reply.data.recordId, download: reply.data.downloadUrl };
}

/** Minimal RFC4180 parser: no CSV content is ever written to disk or stdout. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && (char === "\r" || char === "\n")) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  check(!quoted, "CSV must not be truncated");
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (rows[0]?.[0]) rows[0][0] = rows[0][0].replace(/^\uFEFF/, "");
  return rows;
}

async function main() {
  const { base, username, password } = configuration();
  const admin = new Browser(base),
    anonymous = new Browser(base),
    publicQQ = new Browser(base),
    outsider = new Browser(base);
  const owned = new Set<string>();
  let loggedIn = false;
  const attemptA: Attempt = {
    amount: "0.01",
    qq: "",
    idempotencyKey: randomUUID(),
  };
  const attemptB: Attempt = {
    amount: "10000.00",
    qq: `8${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}12`,
    idempotencyKey: randomUUID(),
  };
  let wrongPassword: string = randomUUID();
  while (wrongPassword === password) wrongPassword = randomUUID();
  const post = (
    browser: Browser,
    path: string,
    body: unknown,
    origin?: string,
  ) => browser.request(path, { method: "POST", body, origin });
  const remove = (id: string, origin?: string) => {
    check(owned.has(id), "deletion is restricted to IDs generated by this run");
    return admin.request(`/api/admin/records/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: {},
      origin,
    });
  };
  try {
    phase = "public GET and anonymous initialization";
    const home = await anonymous.request("/", { raw: true });
    success(home);
    await locked(anonymous);
    await locked(publicQQ);
    await locked(outsider);
    await sponsors(outsider);

    phase = "admin authentication and empty test database safety gate";
    denied(await outsider.request("/api/admin/records"), [401, 403]);
    denied(await post(outsider, "/api/admin/export", { password }), [401, 403]);
    denied(
      await post(admin, "/api/admin/login", {
        username,
        password: wrongPassword,
      }),
      [401, 403],
    );
    denied(await admin.request("/api/admin/records"), [401, 403]);
    const login = await post(admin, "/api/admin/login", { username, password });
    success(login);
    privateNoStore(login);
    loggedIn = true;
    const baseline = await records(admin);
    check(
      baseline.total === 0 && baseline.items.length === 0,
      "refuse mutations unless the dedicated test database is empty",
    );
    equalStats(baseline.stats, expectedStats([]));
    check(
      (await sponsors(outsider)).length === 0,
      "initial public list is empty",
    );

    phase = "amount and QQ HTTP validation";
    // Same boundaries as core.test.ts. Browser UI execution is deliberately out of scope.
    for (const amount of [
      "0",
      "0.00",
      "-1",
      "10000.01",
      "10001",
      "0.001",
      "01",
      "1e2",
      " 5",
      5,
      null,
    ]) {
      const reply = await post(anonymous, "/api/confirm", {
        ...attemptA,
        amount,
        idempotencyKey: randomUUID(),
      });
      denied(reply, [400]);
      if (reply.data.code !== undefined)
        check(reply.data.code === "INVALID_AMOUNT", "amount error code");
    }
    for (const qq of [
      "1234",
      "012345",
      "1234567890123",
      "12a45",
      "12345 ",
      12345,
      null,
    ]) {
      const reply = await post(anonymous, "/api/confirm", {
        ...attemptA,
        qq,
        idempotencyKey: randomUUID(),
      });
      denied(reply, [400]);
      if (reply.data.code !== undefined)
        check(reply.data.code === "INVALID_QQ", "QQ error code");
    }
    denied(
      await post(anonymous, "/api/confirm", {
        ...attemptA,
        idempotencyKey: "not-a-uuid",
      }),
      [400],
    );
    equalStats((await records(admin)).stats, expectedStats([]));
    await locked(anonymous);

    phase = "anonymous save, cooldown, idempotent retry and recovery";
    const first = unlocked(await post(anonymous, "/api/confirm", attemptA));
    owned.add(first.id);
    // Do this immediately, before any potentially slow admin/asset checks.
    const cooldown = await post(anonymous, "/api/confirm", {
      ...attemptA,
      idempotencyKey: randomUUID(),
    });
    denied(cooldown, [429]);
    check(
      typeof cooldown.data.retryAfter === "number" &&
        cooldown.data.retryAfter > 0 &&
        cooldown.data.retryAfter <= 30,
      "new key has a 30-second browser cooldown",
    );
    // Simulate ignoring a saved response: original key must replay the saved result.
    const retries = await Promise.all([
      post(anonymous, "/api/confirm", attemptA),
      post(anonymous, "/api/confirm", attemptA),
    ]);
    for (const reply of retries) {
      const replay = unlocked(reply);
      check(
        replay.id === first.id && replay.download === first.download,
        "same key returns the original saved confirmation",
      );
    }
    const recovered = unlocked(await anonymous.request("/api/unlock"));
    check(
      recovered.id === first.id && recovered.download === first.download,
      "same browser restores without a new declaration",
    );
    denied(
      await post(anonymous, "/api/confirm", { ...attemptA, amount: "5" }),
      [409],
    );
    const savedA = await records(admin, { q: first.id });
    check(
      savedA.total === 1 && savedA.items.length === 1,
      "original confirmation persisted exactly once",
    );
    const rowA = savedA.items[0];
    check(
      rowA.id === first.id &&
        rowA.qq === null &&
        rowA.amountCents === 1 &&
        rowA.unlocked === true,
      "anonymous saved record matches submitted data",
    );
    check(
      typeof rowA.ip === "string" && isIP(rowA.ip) > 0,
      "confirmation stores a server-observed IP",
    );
    check(
      Number.isFinite(Date.parse(rowA.createdAt)),
      "confirmation stores a creation timestamp",
    );
    equalStats(savedA.stats, expectedStats([rowA]));
    check(
      !(await sponsors(outsider)).some((item) => item.id === first.id),
      "anonymous confirmation is never public",
    );

    phase = "browser binding and independent QQ confirmation";
    denied(await post(publicQQ, "/api/confirm", attemptA), [409, 403]);
    await locked(publicQQ);
    const second = unlocked(await post(publicQQ, "/api/confirm", attemptB));
    owned.add(second.id);
    check(
      second.id !== first.id && second.download === first.download,
      "independent browser can confirm immediately and receives the same resource",
    );
    denied(await post(outsider, "/api/confirm", attemptB), [409, 403]);
    await locked(outsider);
    const savedB = await records(admin, { q: attemptB.qq });
    check(
      savedB.total === 1 && savedB.items.length === 1,
      "full QQ search finds the persisted record",
    );
    const rowB = savedB.items[0];
    check(
      rowB.id === second.id &&
        rowB.qq === attemptB.qq &&
        rowB.amountCents === 1_000_000 &&
        rowB.unlocked === true &&
        rowB.hidden === false,
      "upper-limit QQ confirmation persisted",
    );
    check(
      typeof rowB.ip === "string" &&
        isIP(rowB.ip) > 0 &&
        Number.isFinite(Date.parse(rowB.createdAt)),
      "private record has server IP and date",
    );
    const active = [rowA, rowB];
    equalStats((await records(admin)).stats, expectedStats(active));
    const list = await sponsors(outsider);
    const publicRow = list.find((item) => item.id === second.id);
    check(
      list.length === 1 && publicRow !== undefined,
      "only the QQ confirmation is public across browsers",
    );
    check(
      publicRow.qqMasked ===
        attemptB.qq.slice(0, 3) + "******" + attemptB.qq.slice(-3) &&
        publicRow.amountCents === rowB.amountCents,
      "QQ masking and public self-reported amount",
    );

    phase = "public HTML, assets and GET privacy";
    const publicTexts = [home.text, JSON.stringify(list)];
    const scripts = [
      ...home.text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi),
    ];
    for (const src of new Set(
      scripts.map((match) => match[1].replaceAll("&amp;", "&")),
    )) {
      const url = new URL(src, base);
      if (url.origin !== base || !url.pathname.startsWith("/_next/")) continue;
      const asset = await outsider.request(url.pathname + url.search, {
        raw: true,
      });
      success(asset);
      publicTexts.push(asset.text);
    }
    // Compare raw and JSON/HTML-escaped forms; never print the compared values.
    const resource = new URL(first.download);
    for (const text of publicTexts) {
      for (const secret of [
        first.download,
        resource.host + resource.pathname,
        attemptB.qq,
      ]) {
        check(
          !text.includes(secret),
          "public GET must not contain a download location or full QQ",
        );
      }
      // A generic loopback literal in Next dev tooling is not a leaked record IP.
      // Public API allowlists above prohibit IP fields entirely; check serialized
      // private IP fields in HTML/chunks too, including RSC-escaped JSON.
      const normalized = text.replaceAll('\\"', '"');
      for (const ip of new Set([rowA.ip, rowB.ip])) {
        check(
          !normalized.includes(`"ip":"${ip}"`) &&
            !normalized.includes(`"ip": "${ip}"`),
          "public GET excludes serialized confirmation IPs",
        );
      }
      check(
        !text.includes(first.download.replaceAll("&", "&amp;")),
        "HTML-escaped download link is also private",
      );
    }

    phase = "admin search, pagination and Beijing date filters";
    const day = beijingDay(new Date(rowB.createdAt));
    const filtered = await records(admin, {
      q: second.id,
      visibility: "visible",
      from: day,
      to: day,
    });
    check(
      filtered.total === 1 && filtered.items[0]?.id === second.id,
      "search and inclusive Beijing date range",
    );
    equalStats(filtered.stats, expectedStats(active));
    const anonFilter = await records(admin, { visibility: "anonymous" });
    check(
      anonFilter.total === 1 && anonFilter.items[0]?.id === first.id,
      "anonymous filter",
    );
    const nextPage = await records(admin, { page: "2" });
    check(
      nextPage.total === 2 && nextPage.items.length === 0,
      "pagination beyond the first page",
    );
    denied(await admin.request("/api/admin/records?from=2025-02-30"), [400]);

    phase = "unauthenticated and cross-origin mutations";
    const foreign = "http://untrusted.invalid";
    denied(
      await outsider.request(
        `/api/admin/records/${encodeURIComponent(second.id)}`,
        { method: "PATCH", body: { hidden: true } },
      ),
      [401, 403],
    );
    denied(
      await outsider.request(
        `/api/admin/records/${encodeURIComponent(second.id)}`,
        { method: "DELETE", body: {} },
      ),
      [401, 403],
    );
    denied(
      await admin.request(
        `/api/admin/records/${encodeURIComponent(second.id)}`,
        { method: "PATCH", body: { hidden: true }, origin: foreign },
      ),
      [403],
    );
    denied(await remove(second.id, foreign), [403]);
    denied(
      await post(
        admin,
        "/api/admin/export",
        { password, q: second.id },
        foreign,
      ),
      [403],
    );
    denied(
      await post(outsider, "/api/admin/login", { username, password }, foreign),
      [403],
    );
    denied(
      await post(
        anonymous,
        "/api/confirm",
        { ...attemptA, idempotencyKey: randomUUID() },
        foreign,
      ),
      [403],
    );
    check(
      (await records(admin, { q: second.id })).items[0]?.hidden === false,
      "rejected mutations did not hide or delete the record",
    );
    equalStats((await records(admin)).stats, expectedStats(active));

    phase = "hide removes only public visibility, not statistics";
    const hidden = await admin.request(
      `/api/admin/records/${encodeURIComponent(second.id)}`,
      { method: "PATCH", body: { hidden: true } },
    );
    success(hidden);
    privateNoStore(hidden);
    check(
      !(await sponsors(outsider)).some((item) => item.id === second.id),
      "hidden confirmation removed from the shared public list",
    );
    const hiddenRecords = await records(admin, {
      q: second.id,
      visibility: "hidden",
    });
    check(
      hiddenRecords.total === 1 && hiddenRecords.items[0]?.hidden === true,
      "hidden record remains privately searchable",
    );
    equalStats(hiddenRecords.stats, expectedStats(active));
    check(
      (await records(admin, { q: second.id, visibility: "visible" })).total ===
        0,
      "visible filter excludes hidden records",
    );

    phase =
      "CSV password on every request, Beijing timestamps and private cache policy";
    // Five authenticated export attempts stay within the existing per-session
    // rate limit: wrong, valid, omitted, wrong, valid. Do not weaken server limits.
    denied(
      await post(admin, "/api/admin/export", {
        password: wrongPassword,
        q: second.id,
      }),
      [401, 403],
    );
    for (let i = 0; i < 2; i++) {
      const csv = await admin.request("/api/admin/export", {
        method: "POST",
        body: {
          password,
          q: second.id,
          visibility: "hidden",
          from: day,
          to: day,
        },
        raw: true,
      });
      success(csv);
      privateNoStore(csv);
      check(
        /text\/csv/i.test(csv.response.headers.get("content-type") ?? ""),
        "CSV MIME type",
      );
      check(
        /attachment/i.test(
          csv.response.headers.get("content-disposition") ?? "",
        ),
        "CSV is a private attachment, not a public URL",
      );
      const rows = parseCsv(csv.text);
      check(
        rows.length === 2,
        "filtered CSV contains a header and only the owned record",
      );
      const header = rows[0],
        line = rows[1];
      const idIndex = header.findIndex((cell) => /记录.*ID/i.test(cell));
      const qqIndex = header.findIndex((cell) => /QQ/i.test(cell));
      const ipIndex = header.findIndex((cell) => /IP/i.test(cell));
      const amountIndex = header.findIndex((cell) => /自报.*金额/.test(cell));
      const dateIndex = header.findIndex((cell) => /北京时间/.test(cell));
      check(
        [idIndex, qqIndex, ipIndex, amountIndex, dateIndex].every(
          (index) => index >= 0,
        ),
        "CSV labels private fields, self-reported amounts and Beijing time",
      );
      check(
        line.length === header.length &&
          line[idIndex] === second.id &&
          line[qqIndex] === attemptB.qq &&
          line[ipIndex] === rowB.ip &&
          line[amountIndex] === "10000.00",
        "CSV contains only the requested private record",
      );
      const expectedTime = new Date(Date.parse(rowB.createdAt) + 8 * 3600_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      check(
        line[dateIndex].startsWith(expectedTime) &&
          /(?:\+08:00|北京时间|Asia\/Shanghai)/.test(
            line[dateIndex] + header[dateIndex],
          ),
        "CSV date is Beijing local time",
      );
      // A previous valid export must not authorize any later export without a password.
      if (i === 0) {
        denied(
          await post(admin, "/api/admin/export", { q: second.id }),
          [400, 401, 403],
        );
        denied(
          await post(admin, "/api/admin/export", {
            password: wrongPassword,
            q: second.id,
          }),
          [401, 403],
        );
      }
    }

    phase =
      "deletion removes statistics, public entries, recovery and idempotent resurrection";
    // Unhide before deleting so public removal is tested independently of hiding.
    success(
      await admin.request(
        `/api/admin/records/${encodeURIComponent(second.id)}`,
        { method: "PATCH", body: { hidden: false } },
      ),
    );
    check(
      (await sponsors(outsider)).some((item) => item.id === second.id),
      "record is public again before deletion",
    );
    for (const [saved, attempt, browser, remaining] of [
      [second, attemptB, publicQQ, [rowA]],
      [first, attemptA, anonymous, []],
    ] as const) {
      const deletion = await remove(saved.id);
      success(deletion);
      privateNoStore(deletion);
      check(
        (await records(admin, { q: saved.id })).total === 0,
        "deleted record is not searchable",
      );
      check(
        !(await sponsors(outsider)).some((item) => item.id === saved.id),
        "deleted record is not public",
      );
      await locked(browser);
      denied(await post(browser, "/api/confirm", attempt), [409, 410]);
      await locked(browser);
      equalStats((await records(admin)).stats, expectedStats([...remaining]));
      owned.delete(saved.id);
    }
    check(
      (await records(admin)).total === 0 &&
        (await sponsors(outsider)).length === 0,
      "test-created live records are removed",
    );
    console.log(
      `PASS: ${assertions} assertions. Self-reported confirmation contracts only; no payment verification.`,
    );
  } finally {
    // This runs on failure too; never enumerate/delete existing records or clear tables.
    if (loggedIn && owned.size) {
      let failed = false;
      for (const id of owned) {
        try {
          const reply = await remove(id);
          if (
            !reply.response.ok &&
            reply.response.status !== 404 &&
            reply.response.status !== 410
          )
            failed = true;
        } catch {
          failed = true;
        }
      }
      if (failed) {
        console.error(
          "Cleanup incomplete: discard the dedicated temporary database; no identifiers are logged.",
        );
        process.exitCode = 1;
      }
    }
  }
}

void main().catch((error: unknown) => {
  // Only our static assertion labels are safe; never log raw exceptions or bodies.
  const detail =
    error instanceof VerificationFailure
      ? error.message
      : "request/configuration failed; sensitive details suppressed";
  console.error(
    `FAIL: phase=${phase}; ${assertions} assertions attempted; ${detail}.`,
  );
  process.exitCode = 1;
});
