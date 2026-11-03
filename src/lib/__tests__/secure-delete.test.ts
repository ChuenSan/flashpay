import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { hashPassword } from "../auth-password";
import { checkpointAfterDeletion, database } from "../db";
import { POST as login } from "../../app/api/admin/login/route";
import { DELETE } from "../../app/api/admin/records/[id]/route";

const origin = "http://localhost:3000";
function request(path: string, body: object, cookie?: string, method = "POST") {
  return new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function contains(path: string, marker: string): Promise<boolean> {
  for (const suffix of ["", "-wal", "-journal"]) {
    try {
      if ((await readFile(path + suffix)).includes(Buffer.from(marker)))
        return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return false;
}

// Only OS-temp fixtures are opened. Never infer a database path from local .env.
test("secure deletion scrubs source pages, handles pinned WAL readers and sanitizes new backups", async (t) => {
  const original = { ...process.env };
  const directory = await mkdtemp(join(tmpdir(), "flashpay-secure-delete-"));
  const path = join(directory, "application.db");
  const password = "synthetic secure-delete test password";
  Object.assign(process.env, {
    NODE_ENV: "test",
    ADMIN_USERNAME: "fixture-admin",
    ADMIN_PASSWORD_HASH: await hashPassword(password),
    SESSION_SECRET: "secure-delete-fixture-only-0123456789-ABCDEFGHIJKLMNOP",
    APP_ORIGIN: origin,
    DOWNLOAD_URL: "https://example.test/fixture-resource",
    DATABASE_URL: `file:${path}`,
    TRUSTED_PROXY_IP_HEADER: "",
  });
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
  const authenticated = await login(
    request("/api/admin/login", { username: "fixture-admin", password }),
  );
  assert.equal(authenticated.status, 200);
  const admin = authenticated.headers.get("set-cookie")!.split(";")[0];

  await t.test(
    "write connection starts secure and reconnect initializes it again",
    async () => {
      assert.equal(
        Number(
          (
            await database().$queryRawUnsafe<Array<{ secure_delete: bigint }>>(
              "PRAGMA secure_delete",
            )
          )[0].secure_delete,
        ),
        1,
      );
      await database().$disconnect();
      assert.equal(
        Number(
          (
            await database().$queryRawUnsafe<Array<{ secure_delete: bigint }>>(
              "PRAGMA secure_delete",
            )
          )[0].secure_delete,
        ),
        1,
      );
    },
  );

  for (const [index, mode] of ["DELETE", "PERSIST", "WAL"].entries()) {
    await t.test(
      `${mode}: DELETE enables secure_delete in its own transaction and leaves no readable QQ/IP`,
      async () => {
        await database().$queryRawUnsafe(`PRAGMA journal_mode=${mode}`);
        const qq = `9867314258${index}9`;
        const ip = `2001:db8:6ad3:9e41::b72${index}`;
        const record = await database().sponsorRecord.create({
          data: {
            browserId: `secure-fixture-${index}`,
            qq,
            ip,
            amountCents: 500,
          },
        });
        const key = randomUUID();
        await database().confirmationClaim.create({
          data: { key, browserId: record.browserId, recordId: record.id },
        });
        if (mode === "WAL")
          await database().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
        assert.equal(await contains(path, qq), true);
        assert.equal(await contains(path, ip), true);
        // Even an incorrectly configured prior connection cannot defeat route safety.
        await database().$queryRawUnsafe("PRAGMA secure_delete=OFF");
        const response = await DELETE(
          request(`/api/admin/records/${record.id}`, {}, admin, "DELETE"),
          { params: Promise.resolve({ id: record.id }) },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { deleted: true });
        assert.equal(await contains(path, qq), false);
        assert.equal(await contains(path, ip), false);
        assert.equal(
          (
            await database().confirmationClaim.findUniqueOrThrow({
              where: { key },
            })
          ).recordId,
          null,
        );
      },
    );
  }

  await t.test(
    "pinned WAL snapshots do not block deletion; new backups still contain only current rows",
    async () => {
      await database().$queryRawUnsafe("PRAGMA journal_mode=WAL");
      const qq = "982640753819";
      const ip = "2001:db8:aa73:5ec1::f928";
      const record = await database().sponsorRecord.create({
        data: { browserId: "pinned-reader-fixture", qq, ip, amountCents: 1000 },
      });
      await database().$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
      const reader = spawn(
        "python3",
        [
          "-B",
          "-u",
          "-c",
          `
import sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('BEGIN')
connection.execute('SELECT id FROM SponsorRecord WHERE id=?', (sys.argv[2],)).fetchone()
print('ready', flush=True)
sys.stdin.readline()
connection.rollback()
connection.close()
`,
          path,
          record.id,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      try {
        assert.equal(
          String((await once(reader.stdout, "data"))[0]).trim(),
          "ready",
        );
        const start = Date.now();
        const response = await DELETE(
          request(`/api/admin/records/${record.id}`, {}, admin, "DELETE"),
          { params: Promise.resolve({ id: record.id }) },
        );
        assert.equal(response.status, 200);
        assert.ok(
          Date.now() - start < 2000,
          "pinned readers must not make maintenance wait on the application's busy timeout",
        );
        assert.equal(
          await database().sponsorRecord.findUnique({
            where: { id: record.id },
          }),
          null,
        );
        // SQLite cannot erase pages still needed by this old read transaction.
        assert.equal(await contains(path, qq), true);
        execFileSync(
          "python3",
          [
            "-B",
            "-c",
            `
import importlib.util, pathlib, sqlite3, sys
spec = importlib.util.spec_from_file_location('backup', 'scripts/backup.py')
backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)
source, target = map(pathlib.Path, sys.argv[1:3])
backup.snapshot(source, target)
raw = target.read_bytes()
assert sys.argv[3].encode() not in raw
assert sys.argv[4].encode() not in raw
connection = sqlite3.connect(target)
assert connection.execute('SELECT count(*) FROM SponsorRecord WHERE id=?', (sys.argv[5],)).fetchone()[0] == 0
assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
connection.close()
`,
            path,
            join(directory, "while-reader-pinned.db"),
            qq,
            ip,
            record.id,
          ],
          { stdio: "pipe" },
        );
      } finally {
        const exited = once(reader, "exit");
        reader.stdin.end("release\n");
        await exited;
      }
      await checkpointAfterDeletion();
      assert.equal(await contains(path, qq), false);
      assert.equal(await contains(path, ip), false);
    },
  );

  await t.test(
    "prune-only keeps seven UTC dates, needs no DB/key/Node and never touches unmanaged files",
    () => {
      execFileSync(
        "python3",
        [
          "-B",
          "-c",
          `
from datetime import datetime, timedelta, timezone, time
import os, pathlib, subprocess, sys
sys.path.insert(0, str(pathlib.Path('scripts').resolve()))
import backup
root = pathlib.Path(sys.argv[1]) / 'prune-only'
root.mkdir(mode=0o700)
now = datetime.now(timezone.utc)
def name_at(date, hour=0, second=0):
    stamp = datetime.combine(date, time(hour, 0, second), tzinfo=timezone.utc)
    return 'flashpay-' + stamp.strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3.enc'
def fixture(name, mode=0o600):
    path = root / name
    path.write_bytes(b'synthetic retention fixture')
    path.chmod(mode)
    return path
# The end of UTC day -7 must expire, even though it can be younger than 7*24h.
expired = fixture(name_at(now.date()-timedelta(days=7), hour=23, second=59))
old = fixture(name_at(now.date()-timedelta(days=10)))
oldest_retained = fixture(name_at(now.date()-timedelta(days=6)))
today = fixture(name_at(now.date()))
unmanaged = fixture('unmanaged-private-file.enc')
unsafe_mode = fixture(name_at(now.date()-timedelta(days=11)), 0o644)
hardlink = root / name_at(now.date()-timedelta(days=12))
os.link(unmanaged, hardlink)
symlink = root / name_at(now.date()-timedelta(days=13))
symlink.symlink_to(unmanaged)
managed_directory = root / name_at(now.date()-timedelta(days=14))
managed_directory.mkdir(mode=0o700)
originals = {path: path.read_bytes() for path in (oldest_retained, today, unmanaged, unsafe_mode, hardlink)}
environment = {'PATH': os.defpath, 'LANG': 'C', 'LC_ALL': 'C'}
command = [sys.executable, '-B', 'scripts/backup.py', 'prune', '--backup-dir', str(root)]
result = subprocess.run(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
assert result.returncode == 0, result.stderr
assert not expired.exists() and not old.exists()
for path, expected in originals.items():
    assert path.read_bytes() == expected
assert symlink.is_symlink() and managed_directory.is_dir()
# Directory ownership/mode and the maintenance lock are still enforced.
blocked = fixture(name_at(now.date()-timedelta(days=15)))
root.chmod(0o755)
assert subprocess.run(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode != 0
assert blocked.exists()
root.chmod(0o700)
with backup.directory_lock(root):
    assert subprocess.run(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode != 0
    assert blocked.exists()
actual_uid = backup.os.geteuid
backup.os.geteuid = lambda: actual_uid() + 1
try:
    try:
        backup.prune_only(str(root))
        raise AssertionError('wrong directory owner accepted')
    except backup.OperationError:
        pass
finally:
    backup.os.geteuid = actual_uid
assert blocked.exists()
subprocess.run(command, env=environment, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
assert not blocked.exists()
`,
          directory,
        ],
        { stdio: "pipe" },
      );
    },
  );

  await t.test(
    "legacy free cells/overflow pages are excluded from new snapshots, encrypted restores and offline-cleaned source",
    () => {
      execFileSync(
        "python3",
        [
          "-B",
          "-c",
          `
import importlib.util, pathlib, sqlite3, subprocess, sys
from types import SimpleNamespace
root = pathlib.Path(sys.argv[1]) / 'legacy'
for name in ('data', 'backups', 'secrets', 'restored'):
    (root / name).mkdir(parents=True, mode=0o700)
sys.path.insert(0, str(pathlib.Path('scripts').resolve()))
import backup, restore
source = root / 'data' / 'legacy.db'
plain = root / 'backups' / 'clean.db'
qq, ip = b'984736251907', b'2001:db8:9af3:7bc1::d531'
live = ('975318642507', '198.51.100.231')
connection = sqlite3.connect(source)
source.chmod(0o600)
connection.execute('PRAGMA secure_delete=OFF')
connection.execute('PRAGMA journal_mode=WAL')
connection.execute('CREATE TABLE records(id INTEGER PRIMARY KEY, qq TEXT, ip TEXT, payload TEXT)')
connection.execute('CREATE INDEX records_qq ON records(qq)')
connection.execute('INSERT INTO records VALUES (1, ?, ?, ?)', (qq.decode(), ip.decode(), (qq + ip).decode() * 400))
connection.execute('INSERT INTO records VALUES (2, ?, ?, ?)', (*live, 'keep logical live data'))
connection.commit()
connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
connection.execute('DELETE FROM records WHERE id=1')
connection.commit()
def family_has(marker):
    return any(marker in candidate.read_bytes() for candidate in (source, pathlib.Path(str(source)+'-wal'), pathlib.Path(str(source)+'-journal')) if candidate.exists())
assert family_has(qq) and family_has(ip), 'fixture must reproduce old deleted bytes'
assert connection.execute('PRAGMA freelist_count').fetchone()[0] > 0
backup.snapshot(source, plain)
assert qq not in plain.read_bytes() and ip not in plain.read_bytes()
assert family_has(qq), 'online snapshot must not rewrite the running source DB'
check = sqlite3.connect(plain)
assert check.execute('SELECT qq,ip FROM records').fetchall() == [live]
assert check.execute('PRAGMA freelist_count').fetchone()[0] == 0
assert check.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
check.close()
secret = root / 'secrets' / 'key'
secret.write_bytes(b'fixture-only-32-plus-random-looking-key-0123456789ABCDEF')
secret.chmod(0o600)
node = backup.node_binary(sys.argv[2])
encrypted = root / 'backups' / 'new.enc'
backup.crypto_file(plain, encrypted, secret, node)
history = root / 'backups' / 'historical.enc'
history.write_bytes(b'untouched historical backup fixture')
history.chmod(0o600)
# Only systemd's service-state check is replaced: the fixture has no service.
# Exercise actual authenticated decrypt, checks, and atomic restore publication.
restore.require_stopped = lambda service: None
target = root / 'restored' / 'recovered.db'
args = SimpleNamespace(backup=str(encrypted), database=str(target), passphrase_file=str(secret), node=str(node), service='fixture.service', replace=False)
restore.restore(args)
assert qq not in target.read_bytes() and ip not in target.read_bytes()
check = sqlite3.connect(target)
assert check.execute('SELECT qq,ip FROM records').fetchall() == [live]
check.close()
# Authentication failure must not replace the existing recovered DB.
tampered = root / 'backups' / 'tampered.enc'
raw = bytearray(encrypted.read_bytes()); raw[-1] ^= 1
tampered.write_bytes(raw); tampered.chmod(0o600)
args.backup = str(tampered); args.replace = True
before = target.read_bytes()
try:
    restore.restore(args)
    raise AssertionError('corrupt backup accepted')
except backup.OperationError:
    pass
assert target.read_bytes() == before
assert history.read_bytes() == b'untouched historical backup fixture'
connection.close()
# Upgrade already-dirty source pages only via the explicit offline command.
subprocess.run([sys.executable, '-B', 'scripts/backup.py', 'sanitize-source', '--database', str(source)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
assert not family_has(qq) and not family_has(ip)
check = sqlite3.connect(source)
assert check.execute('SELECT qq,ip FROM records').fetchall() == [live]
assert check.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
check.close()
`,
          directory,
          resolve(process.execPath),
        ],
        { stdio: "pipe" },
      );
    },
  );
});
