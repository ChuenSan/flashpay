import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const config = JSON.parse(
  await readFile(path.join(root, ".pi/mcp.json"), "utf8"),
);
const server = config.mcpServers.codegraph;
assert.equal(server.enabled ?? true, true);

async function probe(number) {
  const child = spawn(path.resolve(root, server.command), server.args, {
    cwd: path.resolve(root, server.cwd ?? "."),
    // Exercise a GUI-like PATH without system Node or personal credentials.
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  function fail(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }
  child.on("error", fail);
  child.on("exit", (code) =>
    fail(new Error(`MCP exited (${code}): ${stderr}`)),
  );
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const item = pending.get(message.id);
      if (!item) return; // Ignore server notifications.
      pending.delete(message.id);
      if (message.error) item.reject(new Error(JSON.stringify(message.error)));
      else item.resolve(message.result);
    } catch (error) {
      fail(error);
    }
  });
  function request(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`MCP request timed out: ${method}\n${stderr}`));
      }, 30000);
      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) +
          "\n",
      );
    });
  }
  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: `flashpay-mcp-check-${number}`, version: "1.0.0" },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
        "\n",
    );
    const tools = await request("tools/list");
    assert(tools.tools.some((tool) => tool.name === "codegraph_explore"));
    const result = await request("tools/call", {
      name: "codegraph_explore",
      arguments: { query: "__vibe_init_no_business_source__", maxFiles: 1 },
    });
    assert(!result.isError, JSON.stringify(result));
    return {
      client: number,
      server: initialized.serverInfo,
      tools: tools.tools.map((tool) => tool.name),
      result,
    };
  } finally {
    fail(new Error("MCP probe finished"));
    lines.close();
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

// Two clients exercise the shared-daemon path rather than a single writer.
console.log(JSON.stringify(await Promise.all([probe(1), probe(2)]), null, 2));
