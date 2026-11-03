#!/usr/bin/env python3
"""Private SQLite online snapshots, encrypted with Node AES-256-GCM.

Also supplies the narrowly scoped helpers used by restore.py. No third-party
Python packages. Never log subprocess output, SQLite errors, records or secrets.

Independent retention cleanup (also run after FAILED backup attempts):
    backup.py prune --backup-dir /absolute/private/backups
One-time legacy-page cleanup, with ALL database users stopped:
    backup.py sanitize-source --database /absolute/private/database.db
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile


class OperationError(Exception):
    pass


def private_path(value):
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise OperationError("Use absolute paths.")
    resolved = path.resolve()
    # Check both spellings so that symlinks cannot bypass the public-directory rule.
    if any(part.lower() == "public" for part in (*path.parts, *resolved.parts)):
        raise OperationError("Public directories are forbidden.")
    if path.is_symlink():
        raise OperationError("Symlink endpoints are forbidden.")
    return resolved


def within(path, directory):
    return path == directory or directory in path.parents


def private_file(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.geteuid() or info.st_nlink != 1):
        raise OperationError("Private files must be owned by the operator, regular, single-link and mode 0600.")
    return info


def private_directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700
            or info.st_uid != os.geteuid()):
        raise OperationError("Data and backup directories must be operator-owned and mode 0700.")


def separate_locations(database, backup_directory, secret):
    if (within(database, backup_directory) or within(backup_directory, database.parent)
            or within(secret, database.parent) or within(secret, backup_directory)
            or within(database, secret.parent) or within(backup_directory, secret.parent)):
        raise OperationError("Database, backup and secret must use separate directory trees.")
    info = private_file(secret)
    if info.st_size == 0 or info.st_size > 4096:
        raise OperationError("Passphrase file must contain one nonempty line (at most 4096 bytes).")
    value = secret.read_bytes()
    line = value[:-1] if value.endswith(b"\n") else value
    if value.endswith(b"\r\n"):
        line = line[:-1]
    if not line or b"\n" in line or b"\r" in line or b"\x00" in line:
        raise OperationError("Passphrase file must contain one nonempty line.")
    # This is a generated backup key, not a human login password.
    if len(line) < 32:
        raise OperationError("Use at least 32 random bytes of passphrase material.")


@contextmanager
def directory_lock(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OperationError("Another maintenance operation holds this directory.") from None
        yield descriptor
    finally:
        os.close(descriptor)


def sync_file(path):
    with path.open("rb") as handle:
        os.fsync(handle.fileno())


def check_database(path):
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        connection.execute("PRAGMA query_only=ON")
        if connection.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise OperationError("SQLite integrity check failed.")
    finally:
        connection.close()


def snapshot(source, destination):
    # Online backup includes committed WAL content; never cp a live .db file.
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.close(descriptor)
    reader = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30)
    writer = sqlite3.connect(str(destination), timeout=30)
    try:
        reader.execute("PRAGMA query_only=ON")
        reader.backup(writer, pages=256, sleep=0.1)
        # backup() copies physical pages, including free cells/pages left by old
        # secure_delete=OFF writers. integrity_check alone does NOT remove them.
        # Rebuild ONLY this private snapshot from current logical data before any
        # encryption/publication: new backups must never prolong deleted data's
        # retention. This also normalizes a copied WAL header to a standalone DB.
        writer.execute("PRAGMA journal_mode=DELETE").fetchone()
        writer.execute("PRAGMA secure_delete=ON").fetchone()
        writer.execute("PRAGMA journal_size_limit=0").fetchone()
        writer.execute("VACUUM")
    finally:
        writer.close()
        reader.close()
    os.chmod(destination, 0o600)
    check_database(destination)
    sync_file(destination)


def sanitize_source(database):
    """One-time OFFLINE upgrade for databases written with secure_delete=OFF.

    Stop ALL app/worker/backup connections first; do not call from HTTP handlers.
    Existing encrypted backups are not rewritten and expire under normal retention.
    This removes SQLite-recoverable deleted data, not filesystem snapshots, unlinked
    journal blocks, SSD remapped sectors, or independently retained copies.
    """
    source = private_path(database)
    private_directory(source.parent)
    private_file(source)
    with directory_lock(source.parent):
        connection = sqlite3.connect(str(source), timeout=1)
        try:
            connection.execute("PRAGMA busy_timeout=1000")
            checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
            if checkpoint[0] != 0:
                raise OperationError("Stop all database users before source sanitization.")
            # Switching out of WAL fails when readers are still attached; never
            # delete -wal/-shm by hand or replace an active database inode.
            mode = connection.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
            if mode.lower() != "delete":
                raise OperationError("Exclusive offline database access is required.")
            connection.execute("PRAGMA secure_delete=ON").fetchone()
            connection.execute("PRAGMA journal_size_limit=0").fetchone()
            connection.execute("VACUUM")
        finally:
            connection.close()
        private_file(source)
        check_database(source)
        sync_file(source)
    print("Offline SQLite sanitization completed. Restart only after verification; historical backups unchanged.")


def node_binary(value):
    binary = private_path(value)
    info = binary.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not os.access(binary, os.X_OK):
        raise OperationError("Node must be an absolute, trusted executable, not group/world writable.")
    return binary


def crypto_file(source, destination, secret, node, decrypt=False):
    helper = Path(__file__).resolve().parent.parent / "deploy" / "backup-crypto.mjs"
    command = [
        str(node), str(helper), "decrypt" if decrypt else "encrypt",
        "--input", str(source), "--output", str(destination), "--passphrase-file", str(secret),
    ]
    # Do not inherit NODE_OPTIONS/NODE_PATH/loader or OpenSSL configuration hooks.
    environment = {"PATH": os.defpath, "LANG": "C", "LC_ALL": "C"}
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env=environment, check=False)
    if result.returncode != 0:
        raise OperationError("Authenticated encryption/decryption failed; no pruning or database replacement performed.")
    private_file(destination)
    sync_file(destination)


MANAGED_NAME = re.compile(r"flashpay-(\d{8}T\d{12}Z)\.sqlite3\.enc\Z")


def prune(directory, now):
    # Keep today's UTC backup date plus the previous six UTC dates. A rolling
    # now-7days cutoff with a daily timer could otherwise retain a late-created
    # file until day eight. Operators must monitor missed cleanup runs and prune
    # before restoring/reopening service after a scheduler outage.
    cutoff_date = now.astimezone(timezone.utc).date() - timedelta(days=6)
    for candidate in directory.iterdir():
        match = MANAGED_NAME.fullmatch(candidate.name)
        if not match:
            continue
        try:
            created = datetime.strptime(match[1], "%Y%m%dT%H%M%S%fZ").replace(tzinfo=timezone.utc)
            info = candidate.lstat()
        except (ValueError, FileNotFoundError):
            continue
        # Never traverse symlinks or remove files not owned/protected by this tool.
        if (created.date() < cutoff_date and stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600):
            candidate.unlink()


def prune_only(backup_directory):
    """Expire managed backups even if DB access, encryption or Node is unavailable."""
    directory = private_path(backup_directory)
    private_directory(directory)
    with directory_lock(directory) as directory_fd:
        prune(directory, datetime.now(timezone.utc))
        os.fsync(directory_fd)
    print("Independent managed-backup cleanup completed; seven UTC backup dates retained.")


def backup(args):
    source = private_path(args.database)
    directory = private_path(args.backup_dir)
    secret = private_path(args.passphrase_file)
    separate_locations(source, directory, secret)
    private_directory(source.parent)
    if private_file(source).st_size == 0:
        raise OperationError("Source database is empty.")
    node = node_binary(args.node)
    private_directory(directory, create=True)
    with directory_lock(directory) as directory_fd:
        with tempfile.TemporaryDirectory(prefix=".flashpay-work-", dir=directory) as work:
            work = Path(work)
            plain = work / "snapshot.sqlite3"
            encrypted = work / "snapshot.sqlite3.enc"
            verified = work / "verified.sqlite3"
            snapshot(source, plain)
            crypto_file(plain, encrypted, secret, node)
            # Round-trip GCM authentication before publishing or expiring old backups.
            crypto_file(encrypted, verified, secret, node, decrypt=True)
            check_database(verified)
            now = datetime.now(timezone.utc)
            name = "flashpay-" + now.strftime("%Y%m%dT%H%M%S%fZ") + ".sqlite3.enc"
            # Atomic no-clobber publication; encrypted temporary file is on the same FS.
            os.link(encrypted, directory / name)
            encrypted.unlink()
            os.fsync(directory_fd)
        # Only after successful snapshot/encryption/authentication/publication/cleanup.
        prune(directory, now)
        os.fsync(directory_fd)
    print("Encrypted SQLite backup verified; seven UTC backup dates retained.")


def main():
    os.umask(0o077)
    command = sys.argv[1] if len(sys.argv) > 1 else None
    parser = argparse.ArgumentParser(description=__doc__)
    if command in ("sanitize-source", "prune"):
        parser.add_argument("command", choices=[command])
        if command == "prune":
            parser.add_argument("--backup-dir", required=True, help="Existing operator-owned mode-0700 private backup directory")
        else:
            parser.add_argument("--database", required=True, help="Absolute private SQLite path; STOP ALL database users first")
        args = parser.parse_args()
        try:
            if command == "prune":
                prune_only(args.backup_dir)
            else:
                sanitize_source(args.database)
        except (OperationError, OSError, sqlite3.Error):
            print("Maintenance refused/failed; check private storage, permissions and maintenance locks. No record details logged.", file=sys.stderr)
            return 1
        return 0
    parser.add_argument("--node", required=True, help="Absolute trusted Node binary, e.g. /opt/flashpay/.tools/node/bin/node")
    parser.add_argument("--database", required=True, help="Absolute SQLite source path, not a DATABASE_URL")
    parser.add_argument("--backup-dir", required=True, help="Independent private backup directory")
    parser.add_argument("--passphrase-file", required=True, help="Independent operator-owned mode-0600 secret")
    args = parser.parse_args()
    try:
        backup(args)
    except OperationError as error:
        print("Backup refused: " + str(error), file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error, subprocess.SubprocessError):
        print("Backup failed; inspect permissions/tools/storage privately. No record details logged.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
