#!/usr/bin/env node
// Installs one tool pinned in tools.json: node scripts/install-tool.mjs <tool> <directory>
// The download is checked against the sha256 of tools.json BEFORE anything is written to the
// directory: a mismatch installs nothing and exits 1. Only plain binaries ("archive": "none").
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** "linux-amd64", "darwin-arm64", "windows-amd64": the keys of tools.json. */
export function platformKey(platform = process.platform, arch = process.arch) {
  const os = { linux: "linux", darwin: "darwin", win32: "windows" }[platform];
  const cpu = { x64: "amd64", arm64: "arm64" }[arch];
  if (!os || !cpu) throw new Error(`unsupported platform ${platform}/${arch}`);
  return `${os}-${cpu}`;
}

/** The entry of one tool for one platform; throws when the tool has none or needs an archive. */
export function pick(tools, tool, key) {
  const entry = tools?.[tool]?.platforms?.[key];
  if (!entry) throw new Error(`tools.json has no "${tool}" for ${key}`);
  if (entry.available === false) throw new Error(`"${tool}" is not available for ${key}: ${entry.reason}`);
  if (entry.archive !== "none") throw new Error(`"${tool}" for ${key} is an archive; this script installs plain binaries only`);
  return entry;
}

/** Downloads, verifies, then writes `<directory>/<tool>` (`.exe` on Windows). Returns the path. */
export async function installTool(tools, tool, directory, key = platformKey(), fetchBytes = defaultFetch) {
  const entry = pick(tools, tool, key);
  const bytes = await fetchBytes(entry.url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) {
    throw new Error(`sha256 of ${entry.url} is ${actual}, tools.json says ${entry.sha256}; nothing was installed`);
  }
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, key.startsWith("windows") ? `${tool}.exe` : tool);
  const partial = `${destination}.partial`;
  writeFileSync(partial, bytes);
  chmodSync(partial, 0o755);
  renameSync(partial, destination);
  return destination;
}

async function defaultFetch(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tool, directory] = process.argv.slice(2);
  if (!tool || !directory) {
    console.error("usage: node scripts/install-tool.mjs <tool> <directory>");
    process.exit(2);
  }
  try {
    const tools = JSON.parse(readFileSync(fileURLToPath(new URL("../tools.json", import.meta.url)), "utf8")).tools;
    console.log(`installed ${await installTool(tools, tool, directory)}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
