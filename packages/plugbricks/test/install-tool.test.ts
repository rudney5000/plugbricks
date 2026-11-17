import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// scripts/install-tool.mjs installs the pinned k3d and kubectl in CI. It must verify before it writes.
const pkg = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkg, ".test-work/install-tool");
const script = await import(pathToFileURL(join(pkg, "../../scripts/install-tool.mjs")).href);
const realTools = JSON.parse(readFileSync(join(pkg, "../../tools.json"), "utf8")).tools;

const bytes = Buffer.from("#!/bin/sh\necho hello\n");
const sha = createHash("sha256").update(bytes).digest("hex");
const tools = (sha256: string) => ({
  demo: { platforms: { "linux-amd64": { url: "https://example.invalid/demo", sha256, archive: "none" }, "windows-amd64": { url: "https://example.invalid/demo.exe", sha256, archive: "none" } } },
});
const serve = async () => bytes;

beforeAll(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
});

describe("install-tool", () => {
  it("writes the binary when the sha256 matches, executable on POSIX", async () => {
    const dir = join(work, "ok");
    const path = await script.installTool(tools(sha), "demo", dir, "linux-amd64", serve);
    expect(path).toBe(join(dir, "demo"));
    expect(readFileSync(path).equals(bytes)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o111).not.toBe(0);
    expect(readdirSync(dir)).toEqual(["demo"]);
  });

  it("installs nothing when the sha256 does not match: not even the directory", async () => {
    const dir = join(work, "bad");
    await expect(script.installTool(tools("0".repeat(64)), "demo", dir, "linux-amd64", serve)).rejects.toThrow(/nothing was installed/);
    expect(existsSync(dir)).toBe(false);
  });

  it("names the binary with .exe on Windows", async () => {
    const path = await script.installTool(tools(sha), "demo", join(work, "win"), "windows-amd64", serve);
    expect(path.endsWith("demo.exe")).toBe(true);
  });

  it("refuses an unknown tool, an unavailable platform and an archive", () => {
    expect(() => script.pick(tools(sha), "other", "linux-amd64")).toThrow(/no "other"/);
    expect(() => script.pick(realTools, "k3d", "windows-arm64")).toThrow(/not available/);
    expect(() => script.pick({ x: { platforms: { "linux-amd64": { archive: "tar.gz" } } } }, "x", "linux-amd64")).toThrow(/archive/);
  });

  it.each(["k3d", "kubectl"])("%s: the pinned linux-amd64 entry is installable by this script", (tool) => {
    expect(script.pick(realTools, tool, "linux-amd64").sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("platformKey maps Node's names to tools.json keys", () => {
    expect(script.platformKey("linux", "x64")).toBe("linux-amd64");
    expect(script.platformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(script.platformKey("win32", "x64")).toBe("windows-amd64");
    expect(() => script.platformKey("freebsd", "x64")).toThrow(/unsupported/);
  });
});
