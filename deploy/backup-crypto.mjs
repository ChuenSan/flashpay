#!/usr/bin/env node
// Version 1: magic(8) | version(1) | scrypt salt(16) | GCM nonce(12) |
// ciphertext(variable) | GCM tag(16). The complete 37-byte header is AAD.
// Fixed KDF costs prevent attacker-controlled resource exhaustion on decryption.
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";

const MAGIC = Buffer.from("FPAYBKP\0", "ascii");
const HEADER_SIZE = 37;
const TAG_SIZE = 16;
const derive = promisify(scrypt);

async function privatePath(value, output = false) {
  if (!path.isAbsolute(value)) throw new Error("absolute path required");
  const canonical = output
    ? path.join(await realpath(path.dirname(value)), path.basename(value))
    : await realpath(value);
  for (const spelling of [value, canonical]) {
    if (
      spelling.split(path.sep).some((part) => part.toLowerCase() === "public")
    ) {
      throw new Error("public path forbidden");
    }
  }
  if (!output && (await lstat(value)).isSymbolicLink())
    throw new Error("symlink forbidden");
  return canonical;
}

async function privateInput(filename) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      (info.mode & 0o777) !== 0o600 ||
      info.uid !== process.getuid() ||
      info.nlink !== 1
    ) {
      throw new Error("private file required");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (!bytesWritten) throw new Error("short write");
    offset += bytesWritten;
  }
}

async function readAt(handle, length, position) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      length - offset,
      position + offset,
    );
    if (!bytesRead) throw new Error("truncated input");
    offset += bytesRead;
  }
  return bytes;
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (!["encrypt", "decrypt"].includes(operation) || args.length !== 6)
    throw new Error("invalid arguments");
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (
      !["--input", "--output", "--passphrase-file"].includes(args[i]) ||
      options.has(args[i])
    ) {
      throw new Error("invalid arguments");
    }
    options.set(args[i], args[i + 1]);
  }
  const source = await privatePath(options.get("--input"));
  const destination = await privatePath(options.get("--output"), true);
  const secret = await privatePath(options.get("--passphrase-file"));
  if (source === destination || secret === destination || secret === source)
    throw new Error("distinct paths required");

  let input, output, secretHandle, key, passphrase;
  let created = false;
  let succeeded = false;
  try {
    secretHandle = await privateInput(secret);
    const secretSize = (await secretHandle.stat()).size;
    if (secretSize < 32 || secretSize > 4096)
      throw new Error("invalid secret file");
    passphrase = await secretHandle.readFile();
    // One optional CRLF/LF, not arbitrary whitespace trimming.
    let end = passphrase.length;
    if (passphrase[end - 1] === 10) {
      end--;
      if (passphrase[end - 1] === 13) end--;
    }
    const material = passphrase.subarray(0, end);
    if (
      material.length < 32 ||
      material.includes(10) ||
      material.includes(13) ||
      material.includes(0)
    ) {
      throw new Error("invalid secret file");
    }
    input = await privateInput(source);
    const size = (await input.stat()).size;
    if (!Number.isSafeInteger(size) || size < 1)
      throw new Error("invalid input size");
    let header, salt, nonce, tag;
    if (operation === "encrypt") {
      salt = randomBytes(16);
      nonce = randomBytes(12);
      header = Buffer.concat([MAGIC, Buffer.from([1]), salt, nonce]);
    } else {
      if (size <= HEADER_SIZE + TAG_SIZE) throw new Error("truncated input");
      header = await readAt(input, HEADER_SIZE, 0);
      if (!header.subarray(0, 8).equals(MAGIC) || header[8] !== 1)
        throw new Error("unknown format");
      salt = header.subarray(9, 25);
      nonce = header.subarray(25, 37);
      tag = await readAt(input, TAG_SIZE, size - TAG_SIZE);
    }
    key = await derive(material, salt, 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    passphrase.fill(0);
    const cipher =
      operation === "encrypt"
        ? createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_SIZE })
        : createDecipheriv("aes-256-gcm", key, nonce, {
            authTagLength: TAG_SIZE,
          });
    cipher.setAAD(header);
    if (tag) cipher.setAuthTag(tag);
    // Exclusive creation: no clobber, and plaintext starts mode 0600, before any write.
    output = await open(destination, "wx", 0o600);
    created = true;
    if (operation === "encrypt") await writeAll(output, header);
    const stream = input.createReadStream({
      autoClose: false,
      start: operation === "encrypt" ? 0 : HEADER_SIZE,
      end: operation === "encrypt" ? size - 1 : size - TAG_SIZE - 1,
    });
    for await (const chunk of stream)
      await writeAll(output, cipher.update(chunk));
    await writeAll(output, cipher.final()); // decryption MUST authenticate before success
    if (operation === "encrypt") await writeAll(output, cipher.getAuthTag());
    await output.sync();
    succeeded = true;
  } finally {
    key?.fill(0);
    passphrase?.fill(0);
    try {
      await output?.close();
    } finally {
      await input?.close();
      await secretHandle?.close();
      if (created && !succeeded) await unlink(destination);
    }
  }
}

main().catch(() => {
  // Authentication failures, paths and OS error details never reach shared logs.
  process.stderr.write(
    "Backup crypto operation failed (arguments, permissions, format or authentication).\n",
  );
  process.exitCode = 1;
});
