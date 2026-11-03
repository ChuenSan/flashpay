import { hashPassword } from "../src/lib/auth-password";

// stdout contains only a hash (or a dotenv-safe assignment with --dotenv).
// Never accept passwords in argv or environment.
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 1026) throw new Error("Invalid input");
      chunks.push(bytes);
    }
    // Permit one line terminator from a secret file, preserving other whitespace.
    const password = Buffer.concat(chunks)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    if (/[\r\n]/.test(password)) throw new Error("Invalid input");
    return password;
  }

  process.stderr.write("管理员密码（不回显，Ctrl-C 取消）：");
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let bytes: number[] = [];
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      for (const signal of signals) process.off(signal, onSignal);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(bytes).toString("utf8"));
      bytes = [];
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const onSignal = () => finish(new Error("Cancelled"));
    const onEnd = () => finish(new Error("Cancelled"));
    const onError = () => finish(new Error("Input failed"));
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4) return finish(new Error("Cancelled"));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) {
          // Delete a complete UTF-8 code point, not just its last byte.
          let last = bytes.pop();
          while (last !== undefined && (last & 0xc0) === 0x80)
            last = bytes.pop();
        } else if (byte < 32) {
          return finish(new Error("Invalid input"));
        } else {
          bytes.push(byte);
          if (bytes.length > 1024) return finish(new Error("Invalid input"));
        }
      }
    };
    for (const signal of signals) process.once(signal, onSignal);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dotenv = args.length === 1 && args[0] === "--dotenv";
  if (args.length && !dotenv) throw new Error("Only --dotenv is accepted");
  const password = await readPassword();
  const hash = await hashPassword(password);
  process.stdout.write(
    dotenv
      ? `ADMIN_PASSWORD_HASH=${hash.replace(/\$/g, "\\$")}\n`
      : `${hash}\n`,
  );
}

main().catch(() => {
  // Do not print exception/input contents: those could include credentials.
  process.stderr.write(
    "密码哈希生成失败：仅接受 --dotenv 选项；请输入 1–1024 UTF-8 字节的单行密码。\n",
  );
  process.exitCode = 1;
});
