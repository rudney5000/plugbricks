import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTgz, npmPack, resolveNpmCli } from "./helpers/pack.js";

// The pack helpers run on Linux, macOS and Windows; these tests pin how they find npm.
const pkg = fileURLToPath(new URL("../", import.meta.url));

describe("resolveNpmCli", () => {
  const has =
    (...paths: string[]) =>
    (p: string) =>
      paths.includes(p);

  it("uses npm_execpath when it is npm-cli.js", () => {
    const cli = "/usr/lib/node_modules/npm/bin/npm-cli.js";
    expect(resolveNpmCli({ npm_execpath: cli }, "/usr/bin/node", "linux", has(cli))).toBe(cli);
  });

  it("ignores npm_execpath when it is another tool (yarn.js) and uses the npm bundled with node", () => {
    const bundled = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";
    expect(resolveNpmCli({ npm_execpath: "/opt/yarn/bin/yarn.js" }, "/opt/node/bin/node", "linux", has(bundled))).toBe(bundled);
  });

  it("finds the npm bundled next to node.exe on Windows", () => {
    const bundled = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    expect(resolveNpmCli({}, "C:\\Program Files\\nodejs\\node.exe", "win32", has(bundled))).toBe(bundled);
  });

  it("Debian/Ubuntu distribution node: npm_execpath is pnpm, npm is a PATH link to /usr/share/nodejs", () => {
    const cli = "/usr/share/nodejs/npm/bin/npm-cli.js";
    const realpath = (p: string) => (p === "/usr/bin/npm" ? cli : p);
    expect(
      resolveNpmCli(
        { npm_execpath: "/home/u/.local/pnpm/pnpm.cjs", PATH: "/usr/local/bin:/usr/bin" },
        "/usr/bin/node",
        "linux",
        has("/usr/bin/npm", cli),
        realpath,
      ),
    ).toBe(cli);
  });

  it("a PATH entry whose npm is not npm-cli.js (a wrapper script) is skipped", () => {
    expect(resolveNpmCli({ PATH: "/opt/bin" }, "/usr/bin/node", "linux", has("/opt/bin/npm"), (p) => p)).toBeUndefined();
  });

  it("Windows: npm.cmd on PATH leads to the npm-cli.js next to it", () => {
    const cli = "C:\\tools\\node\\node_modules\\npm\\bin\\npm-cli.js";
    expect(
      resolveNpmCli({ Path: "C:\\Windows;C:\\tools\\node" }, "C:\\other\\node.exe", "win32", has("C:\\tools\\node\\npm.cmd", cli)),
    ).toBe(cli);
  });

  it("returns undefined rather than guessing", () => {
    expect(resolveNpmCli({ npm_execpath: "/x/yarn.js" }, "/x/node", "linux", has())).toBeUndefined();
  });

  it("finds a real npm on this machine", () => {
    const cli = resolveNpmCli();
    expect(cli && existsSync(cli)).toBe(true);
  });
});

describe("npmPack and extractTgz with a space in the paths", () => {
  it("packs into and extracts from folders whose names contain a space", () => {
    const root = join(pkg, ".test-work/helpers/with space");
    rmSync(root, { recursive: true, force: true });
    const src = join(root, "my package");
    const dest = join(root, "pack output");
    mkdirSync(src, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "space-test", version: "1.0.0", files: ["index.js"] }));
    writeFileSync(join(src, "index.js"), "export const ok = true;\n");

    const { tarball, files } = npmPack(src, dest);
    expect(tarball).toBe(join(dest, "space-test-1.0.0.tgz"));
    expect(existsSync(tarball)).toBe(true);
    expect(files.sort()).toEqual(["index.js", "package.json"]);

    const out = join(root, "extracted here");
    extractTgz(tarball, out);
    expect(readFileSync(join(out, "package/index.js"), "utf8")).toBe("export const ok = true;\n");
  });
});
