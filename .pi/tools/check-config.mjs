import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const text = (name) => readFile(path.join(root, name), "utf8");
const json = async (name) => JSON.parse(await text(name));
const manifest = await json(".pi/tools/package.json");
const lock = await json(".pi/tools/package-lock.json");
const mainNode = (await text(".node-version")).trim();
const graphNode = (await text(".pi/tools/codegraph-node-version")).trim();
assert.equal(process.versions.node, mainNode);
assert.equal(manifest.engines.node, mainNode);
assert.equal(manifest.packageManager, `npm@${manifest.engines.npm}`);
assert.equal(
  execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
  manifest.engines.npm,
);
assert.equal(
  execFileSync(
    path.join(root, ".tools/codegraph-node/bin/node"),
    ["-p", "process.versions.node"],
    { encoding: "utf8" },
  ).trim(),
  graphNode,
);
for (const [name, version] of Object.entries(manifest.devDependencies)) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.packages[""].devDependencies[name], version);
  assert.equal(lock.packages[`node_modules/${name}`].version, version);
  assert.equal(
    (await json(`.pi/tools/node_modules/${name}/package.json`)).version,
    version,
  );
}
const mcp = await json(".pi/mcp.json");
assert.equal(mcp.mcpServers.codegraph.cwd, ".");
assert.equal(mcp.mcpServers.codegraph.command, "./scripts/codegraph");
assert.deepEqual(mcp.mcpServers.codegraph.args, ["serve", "--mcp"]);
assert.equal(mcp.mcpServers.codegraph.exposure, "direct");
assert.equal(typeof mcp.mcpServers.github.enabled, "boolean");
assert.equal(mcp.mcpServers.cloudflare.enabled, false);
await access(path.join(root, mcp.mcpServers.codegraph.command));
const graphConfig = await json("codegraph.json");
for (const directory of [".tools/", ".pi/", ".agents/", "node_modules/"]) {
  assert(graphConfig.exclude.includes(directory));
}
console.log(
  "Runtime, package locks, MCP and index configuration are consistent.",
);
