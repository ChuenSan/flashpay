#!/usr/bin/env python3
"""Offline, authenticated SQLite restore. Keep alongside backup.py.

The selected systemd application unit MUST be loaded, inactive/dead and have no
main PID. This does not stop services or authorize bypassing maintenance mode.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from backup import (
    OperationError, check_database, crypto_file, directory_lock, node_binary,
    private_directory, private_file, private_path, separate_locations, sync_file,
)


def require_stopped(service):
    if not re.fullmatch(r"[A-Za-z0-9_@.:-]+\.service", service):
        raise OperationError("Specify the actual application systemd .service unit.")
    if shutil.which("systemctl") is None:
        raise OperationError("systemctl is required to verify the application is stopped.")
    result = subprocess.run([
        "systemctl", "--no-pager", "show", service, "--property=LoadState",
        "--property=ActiveState", "--property=SubState", "--property=MainPID",
    ], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    properties = dict(line.split("=", 1) for line in result.stdout.decode("utf-8", "replace").splitlines() if "=" in line)
    if (result.returncode != 0 or properties.get("LoadState") != "loaded"
            or properties.get("ActiveState") != "inactive" or properties.get("SubState") != "dead"
            or properties.get("MainPID") != "0"):
        raise OperationError("Application must be stopped (loaded, inactive/dead, MainPID=0).")


def target_state(target, replace):
    # Stale WAL/journal files can replay over the restored DB. Never discard them
    # silently: a stopped server with leftovers needs explicit offline archiving.
    for suffix in ("-wal", "-shm", "-journal"):
        sidecar = Path(str(target) + suffix)
        if sidecar.exists() or sidecar.is_symlink():
            raise OperationError("Database sidecars exist; archive the stopped database family privately first.")
    if not target.exists():
        return None
    info = private_file(target)
    if info.st_size and not replace:
        raise OperationError("Refusing a nonempty database; --replace explicitly authorizes replacement.")
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def restore(args):
    source = private_path(args.backup)
    target = private_path(args.database)
    secret = private_path(args.passphrase_file)
    separate_locations(target, source.parent, secret)
    private_directory(source.parent)
    private_file(source)
    private_directory(target.parent)
    node = node_binary(args.node)
    require_stopped(args.service)
    with directory_lock(target.parent) as directory_fd:
        original = target_state(target, args.replace)
        with tempfile.TemporaryDirectory(prefix=".flashpay-restore-", dir=target.parent) as work:
            work = Path(work)
            restored = work / "restored.sqlite3"
            # Crypto helper exclusively creates plaintext mode 0600 before any byte.
            crypto_file(source, restored, secret, node, decrypt=True)
            check_database(restored)
            sync_file(restored)
            # Recheck immediately before atomic replacement. Operators must prevent
            # other units/manual processes from reopening the DB throughout recovery.
            require_stopped(args.service)
            if target_state(target, args.replace) != original:
                raise OperationError("Target changed during restore; refusing replacement.")
            if original is None:
                os.link(restored, target)  # fail rather than overwrite a raced creation
                restored.unlink()
            else:
                os.replace(restored, target)
            os.fsync(directory_fd)
    print("SQLite restore authenticated and integrity-checked. Service was NOT started.")
    print("REQUIRED: privately review and reapply deletions made since this backup before reopening access.")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", required=True, help="Absolute trusted Node binary")
    parser.add_argument("--backup", required=True, help="Private authenticated .enc input, never under public/")
    parser.add_argument("--database", required=True, help="Absolute destination SQLite path")
    parser.add_argument("--passphrase-file", required=True, help="Separate operator-owned mode-0600 secret")
    parser.add_argument("--service", required=True, help="Actual application systemd unit, e.g. flashpay.service")
    parser.add_argument("--replace", action="store_true", help="Explicitly allow replacing a nonempty database")
    args = parser.parse_args()
    try:
        restore(args)
    except OperationError as error:
        print("Restore refused: " + str(error), file=sys.stderr)
        return 1
    except (OSError, sqlite3.Error, subprocess.SubprocessError):
        print("Restore failed; inspect permissions/tools/storage privately. No record details logged.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
