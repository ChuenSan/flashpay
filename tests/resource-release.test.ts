import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  GET as getRelease,
  PUT as putRelease,
} from "../src/app/api/admin/resource-release/route";
import { hashPassword } from "../src/lib/auth-password";
import { database } from "../src/lib/db";
import { HttpError, readJson } from "../src/lib/http";
import { saveResourceReleaseSettings } from "../src/lib/release-settings";
import { defaultReleaseSettings } from "../src/lib/resource-releases";
import { digest, keyedDigest } from "../src/lib/security";

// Copy the real schema/migrations to an isolated cwd so Prisma never loads .env.
test("resource release settings use an isolated singleton and authenticated API", async (t) => {
  const original = process.env;
  const root = resolve(".");
  const directory = await mkdtemp(join(tmpdir(), "flashpay-resource-release-"));
  const origin = "http://localhost:3107";
  const hash = await hashPassword("test-only release administrator password");
  process.env = {
    PATH: original.PATH,
    NODE_ENV: "test",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: hash,
    SESSION_SECRET: "test-only-0123456789abcdefghijklmnopqrstuvwxyz-ABCDE",
    APP_ORIGIN: origin,
    DOWNLOAD_URL: "https://downloads.example.test/original",
    DATABASE_URL: `file:${join(directory, "test.db")}`,
    TRUSTED_PROXY_IP_HEADER: "",
  };
  t.after(async () => {
    try {
      await database().$disconnect();
    } finally {
      process.env = original;
      await rm(directory, { recursive: true, force: true });
    }
  });
  await mkdir(join(directory, "prisma"));
  await copyFile(
    join(root, "prisma/schema.prisma"),
    join(directory, "prisma/schema.prisma"),
  );
  await cp(
    join(root, "prisma/migrations"),
    join(directory, "prisma/migrations"),
    { recursive: true },
  );
  const migration = "20261106000100_resource_release";
  await rm(join(directory, "prisma/migrations", migration), {
    recursive: true,
  });
  function migrate() {
    execFileSync(
      process.execPath,
      [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"],
      {
        cwd: directory,
        env: process.env,
        stdio: "pipe",
      },
    );
  }
  migrate();
  const db = database();
  const download = await db.siteSetting.create({
    data: {
      id: "site",
      downloadUrl: "https://downloads.example.test/preserved",
      archivePassword: "test-only secret",
    },
  });
  await db.browserState.create({ data: { id: "test-only-browser" } });
  const oldSchema = await db.$queryRawUnsafe(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  await cp(
    join(root, "prisma/migrations", migration),
    join(directory, "prisma/migrations", migration),
    { recursive: true },
  );
  migrate();
  assert.deepEqual(
    await db.$queryRawUnsafe(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'ResourceReleaseSetting' ORDER BY name",
    ),
    oldSchema,
  );
  assert.equal(await db.resourceReleaseSetting.count(), 0);
  const token = randomBytes(32).toString("base64url");
  await db.adminSession.create({
    data: {
      tokenHash: digest(token),
      credentialFingerprint: keyedDigest("admin-credentials", `admin\0${hash}`),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const admin = `flashpay-admin=${token}`;
  const path = `${origin}/api/admin/resource-release`;
  function request(
    method = "GET",
    body?: unknown,
    cookie = admin,
    requestOrigin = origin,
  ) {
    return new Request(path, {
      method,
      headers: {
        origin: requestOrigin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function current() {
    const response = await getRelease(request());
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    return response.json();
  }
  const settings = {
    version: "v1.2.3",
    publishedAt: "2026-11-06",
    changes: "修复更新问题\n<script>仅作纯文本</script>",
    knownIssues: "部分机型待验证",
  };

  await t.test(
    "requires administrator and trusted origin; defaults do not create rows",
    async () => {
      assert.equal(
        (await getRelease(request("GET", undefined, ""))).status,
        401,
      );
      assert.equal(
        (await putRelease(request("PUT", settings, ""))).status,
        401,
      );
      assert.equal(
        (
          await putRelease(
            request("PUT", settings, admin, "https://other.example.test"),
          )
        ).status,
        403,
      );
      assert.deepEqual(await current(), defaultReleaseSettings);
      assert.equal(await db.resourceReleaseSetting.count(), 0);
      await assert.rejects(
        saveResourceReleaseSettings(null),
        (error: unknown) => error instanceof HttpError && error.status === 400,
      );
      assert.equal(await db.resourceReleaseSetting.count(), 0);
    },
  );

  await t.test("trims and persists only explicit public fields", async () => {
    const response = await putRelease(
      request("PUT", {
        ...settings,
        version: `  ${settings.version}  `,
        changes: `  ${settings.changes}  `,
        knownIssues: `  ${settings.knownIssues}  `,
        id: "injected",
        updatedAt: "injected",
        downloadUrl: "https://example.test/injected",
        archivePassword: "injected",
      }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.deepEqual(await response.json(), settings);
    assert.deepEqual(await current(), settings);
    const stored = await db.resourceReleaseSetting.findUniqueOrThrow({
      where: { id: "current" },
    });
    assert.equal(typeof stored.updatedAt, "string");
    assert.ok(Number.isFinite(Date.parse(stored.updatedAt)));
    assert.equal(stored.publishedAt, settings.publishedAt);
    assert.equal(await db.resourceReleaseSetting.count(), 1);
  });

  await t.test(
    "rejects invalid dates, incomplete fields and non-object bodies without writes",
    async () => {
      const before = await db.resourceReleaseSetting.findMany();
      const invalid: unknown[] = [null, [], "text", 42];
      for (const publishedAt of [
        "",
        "2026-02-29",
        "2024-02-30",
        "1900-02-29",
        "2026-04-31",
        "2026-00-10",
        "2026-13-01",
        "2026-11-00",
        "2026-11-32",
        "2026-1-06",
        "2026-11-06T00:00:00Z",
        " 2026-11-06 ",
        "0000-01-01",
        null,
      ]) {
        invalid.push({ ...settings, publishedAt });
      }
      for (const [field, values] of Object.entries({
        version: [" ", "x".repeat(121), 12, null],
        changes: ["\n ", "x".repeat(3001), {}, null],
        knownIssues: ["x".repeat(1501), [], null, false],
      })) {
        for (const value of values)
          invalid.push({ ...settings, [field]: value });
      }
      for (const field of Object.keys(settings)) {
        const incomplete: Record<string, unknown> = { ...settings };
        delete incomplete[field];
        invalid.push(incomplete);
      }
      for (const body of invalid) {
        const response = await putRelease(request("PUT", body));
        assert.equal(response.status, 400, JSON.stringify(body));
        assert.match((await response.json()).error, /[\u4e00-\u9fff]/);
      }
      assert.deepEqual(await db.resourceReleaseSetting.findMany(), before);
      assert.deepEqual(await current(), settings);
    },
  );

  await t.test(
    "accepts real leap dates, exact field limits and empty known issues",
    async () => {
      for (const publishedAt of ["2000-02-29", "2024-02-29"]) {
        const value = {
          version: "v".repeat(120),
          publishedAt,
          changes: "更".repeat(3000),
          knownIssues: "问".repeat(1500),
        };
        const response = await putRelease(request("PUT", value));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), value);
      }
      const empty = { ...settings, knownIssues: "" };
      const response = await putRelease(
        request("PUT", { ...empty, knownIssues: " \n " }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), empty);
      assert.deepEqual(await current(), empty);
    },
  );

  await t.test(
    "enforces byte limits while streaming; other readers retain 4096 bytes",
    async () => {
      const value = { ...settings, changes: "更".repeat(2000) };
      const encoded = new TextEncoder().encode(JSON.stringify(value));
      assert.ok(encoded.byteLength > 4096);
      function streamed(
        bytes: Uint8Array,
        contentLength?: string,
        onCancel?: () => void,
      ) {
        let offset = 0;
        return new Request(path, {
          method: "PUT",
          headers: {
            origin,
            cookie: admin,
            "content-type": "application/json",
            ...(contentLength ? { "content-length": contentLength } : {}),
          },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= bytes.length) return controller.close();
              controller.enqueue(bytes.slice(offset, offset + 257));
              offset += 257;
            },
            cancel() {
              onCancel?.();
            },
          }),
          duplex: "half",
        } as RequestInit & { duplex: "half" });
      }
      const response = await putRelease(streamed(encoded));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), value);
      await assert.rejects(
        readJson(streamed(encoded)),
        (error: unknown) => error instanceof HttpError && error.status === 413,
      );
      const before = await db.resourceReleaseSetting.findMany();
      const prefix = JSON.stringify(value);
      const exact = new TextEncoder().encode(
        prefix + " ".repeat(16 * 1024 - Buffer.byteLength(prefix)),
      );
      assert.equal((await putRelease(streamed(exact))).status, 200);
      const afterExact = await db.resourceReleaseSetting.findMany();
      assert.deepEqual(
        afterExact.map((row) => ({ ...row, updatedAt: "" })),
        before.map((row) => ({ ...row, updatedAt: "" })),
      );
      let cancelled = false;
      const oversized = new Uint8Array(17 * 1024).fill(32);
      oversized.set(exact);
      const rejected = await putRelease(
        streamed(oversized, "1", () => {
          cancelled = true;
        }),
      );
      assert.equal(rejected.status, 413);
      assert.equal((await rejected.json()).code, "BODY_TOO_LARGE");
      assert.equal(cancelled, true);
      assert.deepEqual(await db.resourceReleaseSetting.findMany(), afterExact);
    },
  );

  await t.test(
    "survives a new process and leaves all existing settings intact",
    async () => {
      const expected = await current();
      const settingsUrl = pathToFileURL(
        join(root, "src/lib/release-settings.ts"),
      ).href;
      const dbUrl = pathToFileURL(join(root, "src/lib/db.ts")).href;
      const source = `import { getResourceReleaseSettings } from ${JSON.stringify(settingsUrl)}; import { database } from ${JSON.stringify(dbUrl)}; console.log(JSON.stringify(await getResourceReleaseSettings())); await database().$disconnect();`;
      const output = execFileSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href,
          "--input-type=module",
          "-e",
          source,
        ],
        {
          cwd: directory,
          env: process.env,
          encoding: "utf8",
        },
      );
      assert.deepEqual(JSON.parse(output), expected);
      assert.deepEqual(
        await db.siteSetting.findUnique({ where: { id: "site" } }),
        download,
      );
      assert.deepEqual(await db.browserState.findMany(), [
        { id: "test-only-browser", lastConfirmedAt: null },
      ]);
      assert.equal(await db.resourceReleaseSetting.count(), 1);
    },
  );
});
