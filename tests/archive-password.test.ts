import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hashPassword } from "../src/lib/auth-password";
import { database } from "../src/lib/db";
import { browserIdentity, digest, keyedDigest } from "../src/lib/security";
import {
  GET as getSettings,
  PUT as putSettings,
} from "../src/app/api/admin/settings/route";
import { GET as unlock } from "../src/app/api/unlock/route";
import { POST as confirm } from "../src/app/api/confirm/route";
import { GET as sponsors } from "../src/app/api/sponsors/route";

test("archive password persists with the link and is delivered only after confirmation", async (t) => {
  const original = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), "flashpay-archive-password-"));
  const origin = "http://localhost:3107";
  const hash = await hashPassword("test-only administrator password");
  Object.assign(process.env, {
    NODE_ENV: "test",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: hash,
    SESSION_SECRET: "test-only-0123456789abcdefghijklmnopqrstuvwxyz-ABCDE",
    APP_ORIGIN: origin,
    DOWNLOAD_URL: "https://downloads.example.test/original",
    DATABASE_URL: `file:${join(directory, "test.db")}`,
    TRUSTED_PROXY_IP_HEADER: "",
  });
  t.after(async () => {
    await database().$disconnect();
    process.env = original;
  });
  execFileSync(
    process.execPath,
    ["node_modules/prisma/build/index.js", "migrate", "deploy"],
    { env: process.env, stdio: "pipe" },
  );
  const token = randomBytes(32).toString("base64url");
  await database().adminSession.create({
    data: {
      tokenHash: digest(token),
      credentialFingerprint: keyedDigest("admin-credentials", `admin\0${hash}`),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const admin = `flashpay-admin=${token}`;
  function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    requestOrigin = origin,
  ) {
    return new Request(`${origin}${path}`, {
      method,
      headers: {
        origin: requestOrigin,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const path = "/api/admin/settings";
  const initial = {
    downloadUrl: process.env.DOWNLOAD_URL,
    archivePassword: "",
  };
  assert.deepEqual(
    await (await getSettings(request(path, "GET", undefined, admin))).json(),
    initial,
  );
  assert.equal((await getSettings(request(path))).status, 401);
  const settings = {
    downloadUrl: "https://downloads.example.test/new?pwd=CloudCode",
    archivePassword: "  archive<&>密碼  ",
  };
  assert.equal((await putSettings(request(path, "PUT", settings))).status, 401);
  assert.equal(
    (
      await putSettings(
        request(path, "PUT", settings, admin, "https://other.example.test"),
      )
    ).status,
    403,
  );
  const saved = await putSettings(request(path, "PUT", settings, admin));
  assert.equal(saved.status, 200);
  assert.match(saved.headers.get("cache-control")!, /no-store/);
  assert.deepEqual(await saved.json(), settings);
  assert.deepEqual(
    await (await getSettings(request(path, "GET", undefined, admin))).json(),
    settings,
  );
  for (const archivePassword of [null, 42, {}, "x".repeat(1025)]) {
    const rejected = await putSettings(
      request(
        path,
        "PUT",
        {
          ...settings,
          downloadUrl: "https://downloads.example.test/invalid",
          archivePassword,
        },
        admin,
      ),
    );
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, "INVALID_ARCHIVE_PASSWORD");
  }
  assert.deepEqual(
    await (await getSettings(request(path, "GET", undefined, admin))).json(),
    settings,
  );
  const before = await unlock(request("/api/unlock"));
  assert.deepEqual(await before.json(), { unlocked: false });
  const visitor = before.headers.get("set-cookie")!.split(";")[0];
  const browserId = browserIdentity(request("/", "GET", undefined, visitor)).id;
  const key = randomUUID();
  const record = await database().sponsorRecord.create({
    data: {
      browserId,
      ip: "unknown",
      qq: "123456789",
      amountCents: 500,
      claim: { create: { key, browserId } },
    },
  });
  const body = { amount: "5", qq: "123456789", idempotencyKey: key };
  async function delivered() {
    const replay = await confirm(
      request("/api/confirm", "POST", body, visitor),
    );
    assert.equal(replay.status, 200);
    const payload = await replay.json();
    assert.equal(payload.replayed, true);
    assert.equal(payload.recordId, record.id);
    assert.equal(payload.downloadUrl, settings.downloadUrl);
    assert.equal(payload.archivePassword, settings.archivePassword);
    const recovered = await (
      await unlock(request("/api/unlock", "GET", undefined, visitor))
    ).json();
    assert.equal(recovered.downloadUrl, settings.downloadUrl);
    assert.equal(recovered.archivePassword, settings.archivePassword);
  }
  await delivered();
  const publicList = await (await sponsors(request("/api/sponsors"))).text();
  assert.equal(publicList.includes(settings.archivePassword), false);
  assert.equal(publicList.includes("archivePassword"), false);
  const source =
    "import { getDownloadSettings } from './src/lib/settings.ts'; import { database } from './src/lib/db.ts'; console.log(JSON.stringify(await getDownloadSettings())); await database().$disconnect();";
  const restarted = execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    { env: process.env, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(restarted), settings);
  settings.downloadUrl = "https://downloads.example.test/replaced";
  const linkOnly = await putSettings(
    request(path, "PUT", { downloadUrl: settings.downloadUrl }, admin),
  );
  assert.deepEqual(await linkOnly.json(), settings);
  await delivered();
  settings.archivePassword = "replacement-password";
  assert.equal(
    (await putSettings(request(path, "PUT", settings, admin))).status,
    200,
  );
  await delivered();
  settings.archivePassword = "";
  assert.equal(
    (await putSettings(request(path, "PUT", settings, admin))).status,
    200,
  );
  await delivered();
});
