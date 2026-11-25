import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

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
        "dist/admin/ui/index.html",
        // The licence, and the notices of the third-party code built into the admin UI (D23).
        "LICENSE",
        "NOTICE",
        "dist/admin/THIRD_PARTY_NOTICES.txt",
        "schemas/plugin-manifest.schema.json",
        "schemas/platform.schema.json",
        "schemas/platform-lock.schema.json",
      ]),
    );
    expect(files.filter((f) => /^(src|test|examples)\//.test(f))).toEqual([]);
  });

  it("names every package built into the admin UI in its third-party notices", () => {
    const notices = readFileSync(join(unpacked, "dist", "admin", "THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const name of [
      "react",
      "react-dom",
      "react-router",
      "react-router-dom",
      "scheduler",
      "cookie",
      "set-cookie-parser",
      "tailwindcss",
    ]) {
      expect(notices, name).toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(MIT\\)$`, "m"));
    }
    // The licence text itself is there, not only a name.
    expect(notices).toContain("Permission is hereby granted, free of charge");
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

  it("runs an admin action through its own built CLI, and audits it", async () => {
    const project = join(work, "admin-project");
    mkdirSync(project);
    cpSync(join(pkgDir, "examples/postgres"), join(project, "examples", "postgres"), { recursive: true });
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [join(unpacked, "dist/bin.js"), ...args], { cwd: project, encoding: "utf8" });
    expect(cli("init", "--name", "demo").status).toBe(0);
    expect(cli("add", "examples/postgres").status).toBe(0);

    const ui = join(work, "admin-ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<!doctype html><title>admin ui</title>");
    // The admin comes from the packed package, not from src/: its own default CLI path is under test.
    const { startAdmin } = (await import(
      pathToFileURL(join(unpacked, "dist", "admin", "server.js")).href
    )) as typeof import("../src/admin/server.js");
    const admin = startAdmin({ root: project, runtime: "compose", port: 0, dev: true, uiDir: ui });
    try {
      const base = `http://127.0.0.1:${await admin.ready}`;
      const post = async (action: string, brick: string) => {
        const res = await fetch(`${base}/api/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, brick }),
        });
        const text = await res.text();
        expect(res.status, text).toBe(202);
        return JSON.parse(text) as { id: string };
      };
      const wait = async (id: string) => {
        for (let i = 0; i < 250; i++) {
          const res = await fetch(`${base}/api/actions/${id}`);
          expect(res.status).toBe(200);
          const a = (await res.json()) as { state: string; exitCode: number | null };
          if (a.state !== "running") return a;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("the admin action did not finish");
      };
      const platform = () =>
        JSON.parse(readFileSync(join(project, "platform.json"), "utf8")) as { bricks: Record<string, { enabled?: boolean }> };

      const disabled = await post("disable", "postgres");
      expect(await wait(disabled.id)).toMatchObject({ state: "succeeded", exitCode: 0 });
      expect(platform().bricks.postgres.enabled).toBe(false);

      const enabled = await post("enable", "postgres");
      expect(await wait(enabled.id)).toMatchObject({ state: "succeeded", exitCode: 0 });
      expect(platform().bricks.postgres.enabled).toBeUndefined();

      const audit = readFileSync(join(project, ".admin", "audit.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { result: string; details: string });
      for (const id of [disabled.id, enabled.id]) {
        const lines = audit.filter((l) => l.details.includes(id));
        expect(lines, id).toHaveLength(2);
        expect(lines[0].result).toBe("Accepted");
        expect(lines[1].result).toBe("Success");
      }
    } finally {
      admin.close();
    }
  });

  it("serves its own built UI from the packed package", async () => {
    const project = join(work, "admin-ui-project");
    mkdirSync(project);
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, [join(unpacked, "dist/bin.js"), ...args], { cwd: project, encoding: "utf8" });
    expect(cli("init", "--name", "ui-demo").status).toBe(0);
    const port = await freePort();
    const child = spawn(process.execPath, [join(unpacked, "dist/bin.js"), "admin", "--dev", "--port", String(port)], {
      cwd: project,
      stdio: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        try {
          up = (await fetch(`http://127.0.0.1:${port}/api/session`)).status === 200;
        } catch {
          // Not listening yet.
        }
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up, "the packed admin started").toBe(true);
      const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(page).toContain("plugbricks admin");
    } finally {
      child.kill();
    }
  }, 60_000);

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
