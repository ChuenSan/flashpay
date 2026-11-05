import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPassword, verifyPassword } from "../auth-password";
import { database } from "../db";
import { serverConfig } from "../config";
import { browserIdentity, clientIp, DAY, keyedDigest } from "../security";
import {
  beijingDayStart,
  maskQQ,
  parseConfirmation,
  parseDate,
} from "../validation";
import { csvCell } from "../admin-records";
import { rateLimit } from "../rate-limit";
import { GET as unlock } from "../../app/api/unlock/route";
import { POST as confirm } from "../../app/api/confirm/route";
import { GET as sponsors } from "../../app/api/sponsors/route";
import { POST as login } from "../../app/api/admin/login/route";
import { POST as logout } from "../../app/api/admin/logout/route";
import { GET as session } from "../../app/api/admin/session/route";
import { GET as records } from "../../app/api/admin/records/route";
import {
  GET as getSettings,
  PUT as putSettings,
} from "../../app/api/admin/settings/route";
import { PATCH, DELETE } from "../../app/api/admin/records/[id]/route";
import { POST as exportCsv } from "../../app/api/admin/export/route";

const origin = "http://localhost:3000";
const password = "a long test administrator password";

function request(
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      ...(method !== "GET"
        ? { origin, "content-type": "application/json" }
        : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function cookie(response: Response): string {
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function browser(): Promise<string> {
  return cookie(await unlock(request("/api/unlock")));
}
const confirmation = (key = randomUUID(), amount = "5", qq = "123456789") => ({
  idempotencyKey: key,
  amount,
  qq,
});

// Run as: ./scripts/project-tool npx tsx --test src/lib/__tests__/backend.test.ts
// All persistent integration data lives in an isolated temporary SQLite database.
test("backend contracts, persistence and security", async (t) => {
  const original = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), "flashpay-backend-"));
  const hash = await hashPassword(password);
  Object.assign(process.env, {
    NODE_ENV: "test",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: hash,
    SESSION_SECRET: "test-only-0123456789abcdefghijklmnopqrstuvwxyz-ABCDE",
    APP_ORIGIN: origin,
    DOWNLOAD_URL: "https://downloads.example.test/private-resource",
    DATABASE_URL: `file:${join(directory, "test.db")}`,
  });
  // Prisma may load .env for missing keys; explicitly suppress local proxy config.
  process.env.TRUSTED_PROXY_IP_HEADER = "";
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: process.env, stdio: "pipe" },
  );
  t.after(async () => {
    await database().$disconnect();
    await rm(directory, { recursive: true, force: true });
    process.env = original;
  });

  let firstBrowser: string;
  let firstId: string;
  const firstKey = randomUUID();
  let admin: string;

  await t.test("scrypt and input validation", async () => {
    assert.equal(await verifyPassword(password, hash), true);
    assert.equal(await verifyPassword("incorrect", hash), false);
    assert.equal(
      await verifyPassword(password, "scrypt$999999999$8$1$bad$bad"),
      false,
    );
    assert.notEqual(await hashPassword(password), hash);
    for (const amount of [
      "0",
      "-1",
      "0.001",
      "1e2",
      "10000.01",
      "01",
      ".1",
      "NaN",
      " 5",
    ])
      assert.throws(() =>
        parseConfirmation(confirmation(randomUUID(), amount)),
      );
    assert.equal(
      parseConfirmation(confirmation(randomUUID(), "0.01")).amountCents,
      1,
    );
    assert.equal(
      parseConfirmation(confirmation(randomUUID(), "10000")).amountCents,
      1000000,
    );
    assert.throws(() => parseConfirmation({ ...confirmation(), qq: "01234" }));
    assert.deepEqual(
      [
        maskQQ("12345"),
        maskQQ("123456"),
        maskQQ("1234567"),
        maskQQ("123456789012"),
      ],
      ["*****", "******", "123*567", "123******012"],
    );
    assert.equal(csvCell("=1+1"), '"\'=1+1"');
    assert.throws(() => parseDate("2026-02-30", "from"));
    assert.equal(
      beijingDayStart(new Date("2026-01-01T16:00:00Z")).toISOString(),
      "2026-01-01T16:00:00.000Z",
    );
  });

  await t.test(
    "ordinary unlock initializes only a signed cookie, never writes IP",
    async () => {
      const response = await unlock(
        request("/api/unlock", "GET", undefined, undefined, {
          "x-forwarded-for": "1.2.3.4",
        }),
      );
      assert.deepEqual(await response.json(), { unlocked: false });
      assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
      assert.match(response.headers.get("set-cookie")!, /SameSite=strict/i);
      assert.match(response.headers.get("cache-control")!, /no-store/);
      firstBrowser = cookie(response);
      assert.equal(await database().browserState.count(), 0);
      assert.equal(await database().sponsorRecord.count(), 0);
      assert.equal(
        clientIp(
          request("/", "GET", undefined, undefined, { "x-real-ip": "1.2.3.4" }),
        ),
        "unknown",
      );
    },
  );

  await t.test(
    "CSRF and browser initialization fail without delivering a URL",
    async () => {
      const crossSite = await confirm(
        request("/api/confirm", "POST", confirmation(), firstBrowser, {
          origin: "https://attacker.test",
        }),
      );
      assert.equal(crossSite.status, 403);
      assert.equal(
        JSON.stringify(await crossSite.json()).includes("downloadUrl"),
        false,
      );
      const missingOrigin = request(
        "/api/confirm",
        "POST",
        confirmation(),
        firstBrowser,
      );
      missingOrigin.headers.delete("origin");
      assert.equal((await confirm(missingOrigin)).status, 403);
      const noBrowser = await confirm(
        request("/api/confirm", "POST", confirmation()),
      );
      assert.equal(noBrowser.status, 409);
      assert.ok(noBrowser.headers.get("set-cookie"));
      assert.equal(await database().sponsorRecord.count(), 0);
      const tampered = firstBrowser.replace(/.$/, "x");
      assert.equal(
        (
          await confirm(
            request("/api/confirm", "POST", confirmation(), tampered),
          )
        ).status,
        409,
      );
    },
  );

  await t.test(
    "concurrent retries create one record; cooldown and browser binding",
    async () => {
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          confirm(
            request(
              "/api/confirm",
              "POST",
              confirmation(firstKey),
              firstBrowser,
            ),
          ),
        ),
      );
      for (const response of responses) assert.equal(response.status, 200);
      const payloads = await Promise.all(
        responses.map((response) => response.json()),
      );
      firstId = payloads[0].recordId;
      assert.equal(payloads.filter((payload) => !payload.replayed).length, 1);
      assert.ok(payloads.every((payload) => payload.recordId === firstId));
      assert.equal(await database().sponsorRecord.count(), 1);
      const limited = await confirm(
        request("/api/confirm", "POST", confirmation(), firstBrowser),
      );
      assert.equal(limited.status, 429);
      const failure = await limited.json();
      assert.equal(failure.code, "CONFIRM_COOLDOWN");
      assert.ok(failure.retryAfter > 0 && failure.retryAfter <= 30);
      assert.equal(failure.downloadUrl, undefined);
      assert.equal(
        (
          await confirm(
            request(
              "/api/confirm",
              "POST",
              confirmation(firstKey),
              await browser(),
            ),
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await confirm(
            request(
              "/api/confirm",
              "POST",
              confirmation(firstKey, "10"),
              firstBrowser,
            ),
          )
        ).status,
        409,
      );
      assert.equal(
        (await unlock(request("/api/unlock", "GET", undefined, firstBrowser)))
          .status,
        200,
      );
      assert.equal(
        (
          await (
            await unlock(request("/api/unlock", "GET", undefined, firstBrowser))
          ).json()
        ).recordId,
        firstId,
      );
      const publicBody = await (
        await sponsors(request("/api/sponsors"))
      ).json();
      assert.deepEqual(Object.keys(publicBody.items[0]).sort(), [
        "amountCents",
        "createdAt",
        "id",
        "qqMasked",
      ]);
      assert.equal(publicBody.items[0].qqMasked, "123***789");
    },
  );

  await t.test(
    "fresh process replays and enforces durable browser cooldown",
    () => {
      const browserId = browserIdentity(
        request("/", "GET", undefined, firstBrowser),
      ).id;
      const source = `const { confirm } = require('./src/lib/confirmations.ts'); const { database } = require('./src/lib/db.ts'); (async () => { const x = await confirm(${JSON.stringify(browserId)}, 'unknown', ${JSON.stringify(confirmation(firstKey))}); if (!x.replayed) throw Error('not replayed'); try { await confirm(${JSON.stringify(browserId)}, 'unknown', ${JSON.stringify(confirmation())}); throw Error('cooldown bypassed'); } catch (e) { if (e.code !== 'CONFIRM_COOLDOWN') throw e; } await database().$disconnect(); })().catch(e => { console.error(e); process.exit(1); });`;
      execFileSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "-e", source],
        { env: process.env, stdio: "pipe" },
      );
    },
  );

  await t.test(
    "database failure rolls back every confirmation write and never returns a URL",
    async () => {
      const cookie = await browser();
      const input = confirmation();
      const before = await database().sponsorRecord.count();
      const browsersBefore = await database().browserState.count();
      const ratesBefore = await database().confirmationRate.findMany({
        orderBy: { key: "asc" },
      });
      await database().$executeRawUnsafe(
        `CREATE TRIGGER fail_confirmation BEFORE INSERT ON SponsorRecord BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END`,
      );
      try {
        const response = await confirm(
          request("/api/confirm", "POST", input, cookie),
        );
        assert.equal(response.status, 500);
        assert.equal((await response.text()).includes("downloadUrl"), false);
        assert.equal(await database().sponsorRecord.count(), before);
        assert.equal(await database().browserState.count(), browsersBefore);
        assert.deepEqual(
          await database().confirmationRate.findMany({
            orderBy: { key: "asc" },
          }),
          ratesBefore,
        );
        assert.equal(
          await database().confirmationClaim.findUnique({
            where: { key: input.idempotencyKey },
          }),
          null,
        );
      } finally {
        await database().$executeRawUnsafe("DROP TRIGGER fail_confirmation");
      }
    },
  );

  await t.test(
    "concurrent distinct keys in one browser cannot bypass cooldown",
    async () => {
      const cookie = await browser();
      const responses = await Promise.all(
        [confirmation(), confirmation()].map((input) =>
          confirm(request("/api/confirm", "POST", input, cookie)),
        ),
      );
      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 429],
      );
      for (const response of responses) {
        if (response.status === 200)
          await database().sponsorRecord.delete({
            where: { id: (await response.json()).recordId },
          });
      }
    },
  );

  await t.test(
    "admin auth, session, origin and every-export password",
    async () => {
      assert.equal((await records(request("/api/admin/records"))).status, 401);
      assert.deepEqual(
        await (await session(request("/api/admin/session"))).json(),
        { authenticated: false },
      );
      assert.equal(
        (
          await login(
            request("/api/admin/login", "POST", {
              username: "admin",
              password: "wrong",
            }),
          )
        ).status,
        401,
      );
      const result = await login(
        request("/api/admin/login", "POST", { username: "admin", password }),
      );
      assert.equal(result.status, 200);
      admin = cookie(result);
      assert.deepEqual(
        await (
          await session(request("/api/admin/session", "GET", undefined, admin))
        ).json(),
        { authenticated: true, username: "admin" },
      );
      const context = { params: Promise.resolve({ id: firstId }) };
      assert.equal(
        (
          await PATCH(
            request(
              `/api/admin/records/${firstId}`,
              "PATCH",
              { hidden: true },
              admin,
              { origin: "https://attacker.test" },
            ),
            context,
          )
        ).status,
        403,
      );
      assert.equal(
        (await exportCsv(request("/api/admin/export", "POST", { password })))
          .status,
        401,
      );
      assert.equal(
        (
          await exportCsv(
            request("/api/admin/export", "POST", { password: "wrong" }, admin),
          )
        ).status,
        403,
      );
      const csv = await exportCsv(
        request("/api/admin/export", "POST", { password }, admin),
      );
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("cache-control")!, /no-store/);
      const text = await csv.text();
      assert.ok(text.includes("123456789"));
      assert.ok(text.includes("+08:00"));
      assert.equal(
        (await exportCsv(request("/api/admin/export", "POST", {}, admin)))
          .status,
        403,
      );
    },
  );

  await t.test(
    "download settings require admin auth and a trusted origin",
    async () => {
      const path = "/api/admin/settings";
      assert.equal((await getSettings(request(path))).status, 401);
      assert.equal(
        (
          await putSettings(
            request(path, "PUT", {
              downloadUrl: "https://other.example.test/",
            }),
          )
        ).status,
        401,
      );
      const initial = await getSettings(request(path, "GET", undefined, admin));
      assert.equal(initial.status, 200);
      assert.match(initial.headers.get("cache-control")!, /no-store/);
      assert.deepEqual(await initial.json(), {
        downloadUrl: process.env.DOWNLOAD_URL,
        archivePassword: "",
      });
      assert.equal(
        (
          await putSettings(
            request(
              path,
              "PUT",
              { downloadUrl: "https://other.example.test/" },
              admin,
              { origin: "https://attacker.test" },
            ),
          )
        ).status,
        403,
      );
      for (const downloadUrl of [
        undefined,
        null,
        42,
        "",
        "   ",
        "/relative",
        "javascript:alert(1)",
        "data:text/html,test",
        "https://user:pass@example.test/",
        "https://example.test/" + "a".repeat(2048),
      ]) {
        const response = await putSettings(
          request(path, "PUT", { downloadUrl }, admin),
        );
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "INVALID_DOWNLOAD_URL");
      }
      assert.equal(await database().siteSetting.count(), 0);
    },
  );

  await t.test(
    "saved download link is persistent and used by confirmations and recovery",
    async () => {
      const path = "/api/admin/settings";
      const downloadUrl = "https://delivery.example.test/share/new?pwd=Ab12#";
      const saved = await putSettings(
        request(path, "PUT", { downloadUrl: ` ${downloadUrl} ` }, admin),
      );
      assert.equal(saved.status, 200);
      assert.match(saved.headers.get("cache-control")!, /no-store/);
      assert.deepEqual(await saved.json(), {
        downloadUrl,
        archivePassword: "",
      });
      assert.deepEqual(
        await (
          await getSettings(request(path, "GET", undefined, admin))
        ).json(),
        { downloadUrl, archivePassword: "" },
      );
      const recovered = await unlock(
        request("/api/unlock", "GET", undefined, firstBrowser),
      );
      assert.equal((await recovered.json()).downloadUrl, downloadUrl);
      const replayed = await confirm(
        request("/api/confirm", "POST", confirmation(firstKey), firstBrowser),
      );
      assert.equal(replayed.status, 200);
      assert.equal((await replayed.json()).downloadUrl, downloadUrl);
      const freshBrowser = await browser();
      const fresh = await confirm(
        request("/api/confirm", "POST", confirmation(), freshBrowser),
      );
      assert.equal(fresh.status, 200);
      const payload = await fresh.json();
      assert.equal(payload.downloadUrl, downloadUrl);
      await database().sponsorRecord.delete({
        where: { id: payload.recordId },
      });
      assert.equal(
        (await (await unlock(request("/api/unlock"))).json()).downloadUrl,
        undefined,
      );
      assert.equal(
        (await (await sponsors(request("/api/sponsors"))).text()).includes(
          downloadUrl,
        ),
        false,
      );
      const source = `const { getDownloadSettings } = require('./src/lib/settings.ts'); const { database } = require('./src/lib/db.ts'); (async () => { if ((await getDownloadSettings()).downloadUrl !== ${JSON.stringify(downloadUrl)}) throw Error('download setting did not persist'); await database().$disconnect(); })().catch(() => process.exit(1));`;
      execFileSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "-e", source],
        { env: process.env, stdio: "pipe" },
      );
      const replacement =
        "https://delivery.example.test/share/replaced?pwd=Cd34#";
      assert.equal(
        (
          await putSettings(
            request(path, "PUT", { downloadUrl: replacement }, admin),
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await (
            await unlock(request("/api/unlock", "GET", undefined, firstBrowser))
          ).json()
        ).downloadUrl,
        replacement,
      );
      assert.equal(await database().siteSetting.count(), 1);
      await database().siteSetting.deleteMany();
    },
  );

  await t.test(
    "hiding affects only public list; deletion removes data but preserves tombstone",
    async () => {
      const context = { params: Promise.resolve({ id: firstId }) };
      assert.equal(
        (
          await PATCH(
            request(
              `/api/admin/records/${firstId}`,
              "PATCH",
              { hidden: true },
              admin,
            ),
            context,
          )
        ).status,
        200,
      );
      assert.equal(
        (await (await sponsors(request("/api/sponsors"))).json()).items.length,
        0,
      );
      const hiddenList = await (
        await records(
          request(
            "/api/admin/records?visibility=hidden",
            "GET",
            undefined,
            admin,
          ),
        )
      ).json();
      assert.equal(hiddenList.stats.totalCount, 1);
      assert.equal(hiddenList.items[0].qq, "123456789");
      assert.equal(
        (
          await DELETE(
            request(`/api/admin/records/${firstId}`, "DELETE", {}, admin),
            context,
          )
        ).status,
        200,
      );
      assert.deepEqual(
        await (
          await unlock(request("/api/unlock", "GET", undefined, firstBrowser))
        ).json(),
        { unlocked: false },
      );
      const replay = await confirm(
        request("/api/confirm", "POST", confirmation(firstKey), firstBrowser),
      );
      assert.equal(replay.status, 410);
      assert.equal((await replay.json()).downloadUrl, undefined);
      const claim = await database().confirmationClaim.findUniqueOrThrow({
        where: { key: firstKey },
      });
      assert.equal(claim.recordId, null);
      assert.equal(await database().sponsorRecord.count(), 0);
      const stats = (
        await (
          await records(request("/api/admin/records", "GET", undefined, admin))
        ).json()
      ).stats;
      assert.equal(stats.totalCount, 0);
      assert.equal(stats.totalAmountCents, 0);
      assert.equal(
        (
          await confirm(
            request("/api/confirm", "POST", confirmation(), firstBrowser),
          )
        ).status,
        429,
      );
    },
  );

  await t.test(
    "seven-day recovery expires; anonymous never public; recent fifty only",
    async () => {
      const anonymousBrowser = await browser();
      const anonymousKey = randomUUID();
      const response = await confirm(
        request(
          "/api/confirm",
          "POST",
          confirmation(anonymousKey, "0.01", ""),
          anonymousBrowser,
        ),
      );
      assert.equal(response.status, 200);
      const id = (await response.json()).recordId;
      assert.equal(
        (await (await sponsors(request("/api/sponsors"))).json()).items.length,
        0,
      );
      await database().sponsorRecord.update({
        where: { id },
        data: { createdAt: new Date(Date.now() - 7 * DAY - 1000) },
      });
      assert.deepEqual(
        await (
          await unlock(
            request("/api/unlock", "GET", undefined, anonymousBrowser),
          )
        ).json(),
        { unlocked: false },
      );
      assert.equal(
        (
          await confirm(
            request(
              "/api/confirm",
              "POST",
              confirmation(anonymousKey, "0.01", ""),
              anonymousBrowser,
            ),
          )
        ).status,
        410,
      );
      await database().sponsorRecord.createMany({
        data: Array.from({ length: 55 }, (_, index) => ({
          browserId: "fixture",
          ip: "192.0.2.1",
          qq: "12345",
          amountCents: 1,
          createdAt: new Date(Date.now() - index * 1000),
        })),
      });
      assert.equal(
        (await (await sponsors(request("/api/sponsors"))).json()).items.length,
        50,
      );
    },
  );

  await t.test(
    "Beijing inclusive dates, pagination, unfiltered statistics and 90-day IPs",
    async () => {
      await database().sponsorRecord.deleteMany();
      const day = beijingDayStart();
      await database().sponsorRecord.createMany({
        data: [
          {
            browserId: "fixture",
            ip: "192.0.2.1",
            qq: "12345",
            amountCents: 500,
            createdAt: day,
          },
          {
            browserId: "fixture",
            ip: "192.0.2.1",
            qq: null,
            amountCents: 1000,
            createdAt: new Date(day.getTime() + DAY - 1),
          },
          {
            browserId: "fixture",
            ip: "192.0.2.2",
            qq: "123456",
            amountCents: 2000,
            hidden: true,
            createdAt: new Date(day.getTime() - 1),
          },
          {
            browserId: "fixture",
            ip: "192.0.2.3",
            qq: "1234567",
            amountCents: 5000,
            createdAt: new Date(Date.now() - 91 * DAY),
          },
        ],
      });
      const date = new Date(day.getTime() + 8 * 3600000)
        .toISOString()
        .slice(0, 10);
      const filtered = await (
        await records(
          request(
            `/api/admin/records?from=${date}&to=${date}`,
            "GET",
            undefined,
            admin,
          ),
        )
      ).json();
      assert.equal(filtered.total, 2);
      assert.equal(filtered.stats.totalCount, 4);
      assert.equal(filtered.stats.todayCount, 2);
      assert.equal(filtered.stats.totalAmountCents, 8500);
      assert.equal(filtered.stats.uniqueIps90d, 2);
      assert.equal(
        (
          await (
            await records(
              request(
                "/api/admin/records?visibility=anonymous",
                "GET",
                undefined,
                admin,
              ),
            )
          ).json()
        ).total,
        1,
      );
      assert.equal(
        (
          await (
            await records(
              request(
                "/api/admin/records?q=192.0.2.2",
                "GET",
                undefined,
                admin,
              ),
            )
          ).json()
        ).total,
        1,
      );
      assert.equal(
        (
          await (
            await records(
              request("/api/admin/records?page=2", "GET", undefined, admin),
            )
          ).json()
        ).items.length,
        0,
      );
      assert.equal(
        (
          await records(
            request(
              "/api/admin/records?from=2026-02-30",
              "GET",
              undefined,
              admin,
            ),
          )
        ).status,
        400,
      );
    },
  );

  await t.test(
    "CSV keyset export covers more than one batch without duplicate rows",
    async () => {
      const ip = "203.0.113.9";
      const createdAt = new Date(Date.now() - 1000);
      await database().sponsorRecord.createMany({
        data: Array.from({ length: 501 }, () => ({
          browserId: "csv-fixture",
          ip,
          qq: "1234567",
          amountCents: 1,
          createdAt,
        })),
      });
      try {
        const response = await exportCsv(
          request("/api/admin/export", "POST", { password, q: ip }, admin),
        );
        assert.equal(response.status, 200);
        const lines = (await response.text()).trim().split("\r\n");
        assert.equal(lines.length, 502);
        assert.equal(
          new Set(lines.slice(1).map((line) => line.split(",")[0])).size,
          501,
        );
      } finally {
        await database().sponsorRecord.deleteMany({ where: { ip } });
      }
    },
  );

  await t.test(
    "trusted proxy opt-in, IP limits survive restart, malformed headers rejected",
    async () => {
      process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";
      assert.equal(
        clientIp(
          request("/", "GET", undefined, undefined, {
            "x-real-ip": "::ffff:192.0.2.4",
          }),
        ),
        "192.0.2.4",
      );
      assert.throws(() =>
        clientIp(
          request("/", "GET", undefined, undefined, {
            "x-real-ip": "1.2.3.4, 5.6.7.8",
          }),
        ),
      );
      const ip = "198.51.100.6";
      await database().confirmationRate.create({
        data: {
          key: keyedDigest("confirmation-ip-rate", `60000:${ip}`),
          count: 10,
          expiresAt: new Date(Date.now() + 60000),
        },
      });
      const response = await confirm(
        request("/api/confirm", "POST", confirmation(), await browser(), {
          "x-real-ip": ip,
        }),
      );
      assert.equal(response.status, 429);
      assert.equal((await response.json()).code, "IP_RATE_LIMITED");
      const child = `const { confirm } = require('./src/lib/confirmations.ts'); const { database } = require('./src/lib/db.ts'); (async () => { try { await confirm('fresh-process-browser', '${ip}', ${JSON.stringify(confirmation())}); throw Error('IP rate bypassed'); } catch (e) { if (e.code !== 'IP_RATE_LIMITED') throw e; } await database().$disconnect(); })().catch(e => { console.error(e); process.exit(1); });`;
      execFileSync(
        process.execPath,
        ["node_modules/tsx/dist/cli.mjs", "-e", child],
        { env: process.env, stdio: "pipe" },
      );
      process.env.TRUSTED_PROXY_IP_HEADER = "";
    },
  );

  await t.test(
    "hash changes invalidate sessions, logout revokes server-side, rate limits apply",
    async () => {
      process.env.ADMIN_PASSWORD_HASH = await hashPassword(password);
      assert.deepEqual(
        await (
          await session(request("/api/admin/session", "GET", undefined, admin))
        ).json(),
        { authenticated: false },
      );
      process.env.ADMIN_PASSWORD_HASH = hash;
      assert.deepEqual(
        await (
          await session(request("/api/admin/session", "GET", undefined, admin))
        ).json(),
        { authenticated: false },
      );
      const result = await login(
        request("/api/admin/login", "POST", { username: "admin", password }),
      );
      const newAdmin = cookie(result);
      assert.equal(
        (await logout(request("/api/admin/logout", "POST", {}, newAdmin)))
          .status,
        200,
      );
      assert.deepEqual(
        await (
          await session(
            request("/api/admin/session", "GET", undefined, newAdmin),
          )
        ).json(),
        { authenticated: false },
      );
      rateLimit("test-boundary", 1, 1000);
      assert.throws(() => rateLimit("test-boundary", 1, 1000));
    },
  );

  await t.test(
    "production rejects unsafe configuration and uses secure host cookies",
    async () => {
      Object.assign(process.env, {
        NODE_ENV: "production",
        APP_ORIGIN: "https://flashpay.example.test",
        TRUSTED_PROXY_IP_HEADER: "x-real-ip",
      });
      const response = await unlock(request("/api/unlock"));
      assert.match(
        response.headers.get("set-cookie")!,
        /^__Host-flashpay-browser=/,
      );
      assert.match(response.headers.get("set-cookie")!, /; Secure/);
      process.env.APP_ORIGIN = origin;
      assert.throws(() => serverConfig());
      assert.equal((await unlock(request("/api/unlock"))).status, 503);
      process.env.APP_ORIGIN = "https://flashpay.example.test";
      delete process.env.TRUSTED_PROXY_IP_HEADER;
      assert.throws(() => serverConfig());
      Object.assign(process.env, { NODE_ENV: "test", APP_ORIGIN: origin });
    },
  );
});
