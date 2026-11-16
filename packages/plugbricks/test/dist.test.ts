import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractTgz, linkDir, npmPack } from "./helpers/pack.js";

// Packs the package exactly as npm would publish it (prepack runs the build),
// unpacks it and runs the compiled code from there: this catches a schema path that
// only resolves from src/, files missing from "files", and a broken bin entry.
// Everything happens in .test-work/dist/ inside the package (gitignored).
const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const nodeModules = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const example = join(pkgDir, "examples/postgres/plugin.json");
const work = join(pkgDir, ".test-work/dist");
const unpacked = join(work, "package");

let files: string[];

beforeAll(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const packed = npmPack(pkgDir, work);
  files = packed.files;
  extractTgz(packed.tarball, work);
  // Dependencies come from the workspace install; the unpacked package has none of its own.
  linkDir(nodeModules, join(unpacked, "node_modules"));
}, 120_000);

describe("published package", () => {
  it("ships the compiled code, the CLI and the schemas, not the sources or tests", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "package.json",
        "dist/index.js",
        "dist/index.d.ts",
        "dist/bin.js",
        "schemas/plugin-manifest.schema.json",
        "schemas/platform.schema.json",
        "schemas/platform-lock.schema.json",
      ]),
    );
    expect(files.filter((f) => /^(src|test|examples)\//.test(f))).toEqual([]);
  });

  it("validates an example manifest from the built code", () => {
    const script = `
      import { readFileSync } from "node:fs";
      import { validateManifest, MANIFEST_SCHEMA_ID } from "plugbricks";
      import schema from "plugbricks/schema.json" with { type: "json" };
      if (schema.$id !== MANIFEST_SCHEMA_ID) throw new Error("schema export mismatch");
      const r = validateManifest(JSON.parse(readFileSync(process.argv[1], "utf8")));
      const bad = validateManifest({ name: "x" });
      console.log(JSON.stringify({ ok: r.ok, rejectsInvalid: !bad.ok, from: import.meta.resolve("plugbricks") }));
    `;
    // Run inside the unpacked package so "plugbricks" resolves to it via its own exports.
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, example], {
      cwd: unpacked,
      encoding: "utf8",
    });
    const r = JSON.parse(out);
    expect(r).toMatchObject({ ok: true, rejectsInvalid: true });
    // import.meta.resolve gives a file: URL (file:///D:/... on Windows): compare as paths.
    expect(fileURLToPath(r.from)).toBe(join(unpacked, "dist", "index.js"));
  });

  it("declares the plugbricks bin, with a node shebang", () => {
    const manifest = JSON.parse(readFileSync(join(unpacked, "package.json"), "utf8"));
    expect(manifest.bin).toEqual({ plugbricks: "dist/bin.js" });
    const bin = readFileSync(join(unpacked, "dist/bin.js"), "utf8");
    expect(bin.split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(bin.includes("\r"), "compiled files use LF on every OS (tsconfig newLine)").toBe(false);
  });

  it("runs init, add, status and remove from the built CLI", () => {
    const project = join(work, "project");
    mkdirSync(project);
    cpSync(join(pkgDir, "examples"), join(project, "examples"), { recursive: true });
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [join(unpacked, "dist/bin.js"), ...args], { cwd: project, encoding: "utf8" });

    expect(cli("init", "--name", "demo").status).toBe(0);
    expect(cli("add", "examples/postgres").status).toBe(0);
    expect(cli("add", "examples/orders").status).toBe(0);

    const status = cli("status", "--json");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      name: "demo",
      capabilities: { database: "postgres" },
      problems: [],
    });

    const refused = cli("remove", "postgres");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/^error CAPABILITY_IN_USE: /);

    const usage = cli("deploy");
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/^error USAGE_UNKNOWN_COMMAND: /);
    expect(existsSync(join(project, ".platform/bricks/orders/schema.graphql"))).toBe(true);
  });
});
