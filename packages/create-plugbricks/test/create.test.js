import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main as plugbricks, validateManifest } from "plugbricks";
import { create, restrictToCurrentUser } from "../lib/create.js";
import { extractTgz, linkDir, npmPack } from "../../plugbricks/test/helpers/pack.ts";

// Everything runs in .test-work/ inside this package (gitignored).
const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkgDir, ".test-work");
const postgresExample = fileURLToPath(new URL("../../plugbricks/examples/postgres", import.meta.url));
const plugbricksVersion = JSON.parse(readFileSync(new URL("../../plugbricks/package.json", import.meta.url), "utf8")).version;

function run(args, cwd) {
  const stdout = [];
  const stderr = [];
  const code = create(args, { cwd, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
function cli(args, cwd) {
  const stdout = [];
  const stderr = [];
  const code = plugbricks(args, { cwd, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

const STRUCTURE = [
  "README.md",
  "package.json",
  ".gitignore",
  ".gitattributes",
  "platform.json",
  "platform.lock",
  "config/README.md",
  "services/orders/plugin.json",
  "services/orders/schema.graphql",
  ".platform/bricks/.gitkeep",
  ".generated",
  ".secrets",
];

describe("npm create plugbricks <name>", () => {
  const cwd = join(work, "create");
  const project = join(cwd, "mon-saas");

  beforeAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    const r = run(["mon-saas"], cwd);
    expect(r.code, r.stderr).toBe(0);
  });

  it("creates the decided structure", () => {
    for (const p of STRUCTURE) expect(existsSync(join(project, p)), p).toBe(true);
    expect(existsSync(join(project, "gitignore")), "template name must be renamed").toBe(false);
    expect(existsSync(join(project, "gitattributes")), "template name must be renamed").toBe(false);
  });

  it.skipIf(process.platform === "win32")(".secrets/ is mode 700 (Linux, macOS)", () => {
    expect(statSync(join(project, ".secrets")).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === "win32")(".secrets/ has no inherited ACL entry and only the current user (Windows)", () => {
    const acl = spawnSync("icacls", [join(project, ".secrets")], { encoding: "utf8" });
    expect(acl.status, acl.stderr).toBe(0);
    const entries = acl.stdout.split(/\r?\n/).filter((l) => l.includes(":("));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((l) => l.includes("(I)"))).toEqual([]);
  });

  it("created without a SECRETS_NOT_RESTRICTED warning", () => {
    const again = join(cwd, "warning-check");
    const r = run(["warning-check"], cwd);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    rmSync(again, { recursive: true, force: true });
  });

  it("writes a valid, empty platform named after the project", () => {
    const platform = JSON.parse(readFileSync(join(project, "platform.json"), "utf8"));
    expect(platform).toMatchObject({ name: "mon-saas", bricks: {} });
    const s = cli(["status", "--json"], project);
    expect(s.code, s.stderr).toBe(0);
    expect(JSON.parse(s.stdout)).toMatchObject({ name: "mon-saas", bricks: [], problems: [] });
  });

  it("pins the plugbricks dev dependency to the exact version", () => {
    const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "mon-saas", private: true, devDependencies: { plugbricks: plugbricksVersion } });
    expect(pkg.devDependencies.plugbricks).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("ships services/orders as a valid brick", () => {
    const m = JSON.parse(readFileSync(join(project, "services/orders/plugin.json"), "utf8"));
    expect(validateManifest(m)).toEqual({ ok: true });
  });

  it("explains every folder in the README", () => {
    const readme = readFileSync(join(project, "README.md"), "utf8");
    expect(readme.startsWith("# mon-saas\n")).toBe(true);
    expect(readme).not.toContain("{{name}}");
    for (const p of ["platform.json", "platform.lock", ".platform/bricks/", "services/", "config/", ".generated/", ".secrets/", ".gitattributes", "package.json"]) {
      expect(readme, `README must explain ${p}`).toMatch(new RegExp(`^\\| \`${p.replace(/[.]/g, "\\.")}\` \\| \\S`, "m"));
    }
  });

  it("makes git ignore .generated/ and .secrets/, and keep the rest", () => {
    execFileSync("git", ["init", "-q"], { cwd: project });
    writeFileSync(join(project, ".generated/compose.yaml"), "x");
    writeFileSync(join(project, ".secrets/db_password"), "x");
    const ignored = (p) => spawnSync("git", ["check-ignore", "-q", p], { cwd: project }).status === 0;
    expect(ignored(".generated/compose.yaml")).toBe(true);
    expect(ignored(".secrets/db_password")).toBe(true);
    for (const p of ["platform.json", "platform.lock", ".platform/bricks/.gitkeep", "services/orders/plugin.json", "config/README.md"]) {
      expect(ignored(p), `${p} must be committed`).toBe(false);
    }
  });

  it("lets a beginner follow the README: add a database, then services/orders", () => {
    expect(cli(["add", "services/orders"], project)).toMatchObject({ code: 1 });
    expect(cli(["add", postgresExample], project).code).toBe(0);
    const r = cli(["add", "services/orders"], project);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(project, "platform.lock"), "utf8")).capabilities).toEqual({ database: "postgres" });
  });
});

describe("refusals write nothing", () => {
  const cwd = join(work, "refusals");
  beforeAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
  });

  it("missing name: usage error", () => {
    expect(run([], cwd)).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error CREATE_MISSING_NAME: /) });
  });

  it("invalid name", () => {
    const r = run(["Mon_SaaS"], cwd);
    expect(r).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error PLATFORM_INVALID_NAME: /) });
    expect(existsSync(join(cwd, "Mon_SaaS"))).toBe(false);
  });

  it("existing non-empty folder is left untouched", () => {
    mkdirSync(join(cwd, "taken"));
    writeFileSync(join(cwd, "taken/notes.txt"), "mine");
    const r = run(["taken"], cwd);
    expect(r).toMatchObject({ code: 1, stderr: expect.stringMatching(/^error CREATE_TARGET_NOT_EMPTY: /) });
    expect(readFileSync(join(cwd, "taken/notes.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(cwd, "taken/platform.json"))).toBe(false);
  });
});

describe("restrictToCurrentUser: the Windows branch, with a fake icacls (runs on every OS)", () => {
  const dir = "C:\\p\\.secrets";
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fake = (calls, results) => (cmd, args) => {
    calls.push([cmd, ...args]);
    return results.shift();
  };

  it("removes inheritance, grants only the user, then reads the ACL back", () => {
    const calls = [];
    const r = restrictToCurrentUser(dir, {
      platform: "win32",
      user: "BOX\\ana",
      run: fake(calls, [ok(), ok(`${dir} BOX\\ana:(OI)(CI)(F)\r\n\r\nSuccessfully processed 1 files\r\n`)]),
    });
    expect(r).toEqual({ ok: true, method: "icacls (current user only)" });
    expect(calls).toEqual([
      ["icacls", dir, "/inheritance:r", "/grant:r", "BOX\\ana:(OI)(CI)F"],
      ["icacls", dir],
    ]);
  });

  it.each([
    ["icacls fails", [{ status: 5, stdout: "", stderr: "Access is denied." }], /icacls exited with 5: Access is denied/],
    ["inherited entries remain", [ok(), ok(`${dir} BOX\\ana:(OI)(CI)(F)\r\n         BUILTIN\\Users:(I)(RX)\r\n`)], /inherited/],
    ["another account has access", [ok(), ok(`${dir} BOX\\ana:(OI)(CI)(F)\r\n         Everyone:(R)\r\n`)], /other accounts.*Everyone/],
  ])("reports, never hides, a failure: %s", (_, results, detail) => {
    const r = restrictToCurrentUser(dir, { platform: "win32", user: "BOX\\ana", run: fake([], results) });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(detail);
  });

  it("the generator turns a failure into an explicit SECRETS_NOT_RESTRICTED warning and still creates the project", () => {
    const cwd = join(work, "secrets-warning");
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    const stderr = [];
    const code = create(["warned"], { cwd, stdout: () => {}, stderr: (l) => stderr.push(l) }, {
      restrict: () => ({ ok: false, detail: "simulated failure" }),
    });
    expect(code).toBe(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^warning SECRETS_NOT_RESTRICTED: could not restrict .*\.secrets to your user only \(simulated failure\)/);
    expect(existsSync(join(cwd, "warned/platform.json"))).toBe(true);
  });
});

describe("published package", () => {
  // npm drops .gitignore files from packages: run the packed generator to prove the template survives packing.
  const packWork = join(work, "pack");
  const nodeModules = fileURLToPath(new URL("../../../node_modules", import.meta.url));
  let files;

  beforeAll(() => {
    rmSync(packWork, { recursive: true, force: true });
    mkdirSync(packWork, { recursive: true });
    const packed = npmPack(pkgDir, packWork);
    files = packed.files;
    extractTgz(packed.tarball, packWork);
    linkDir(nodeModules, join(packWork, "package/node_modules"));
  }, 120_000);

  it("ships bin, lib and the whole template", () => {
    expect(files).toEqual(
      expect.arrayContaining(["bin/create-plugbricks.js", "lib/create.js", "template/gitignore", "template/gitattributes", "template/README.md", "template/services/orders/plugin.json"]),
    );
    expect(files.filter((f) => f.startsWith("test/"))).toEqual([]);
  });

  it("creates a project from the packed bin", () => {
    const r = spawnSync(process.execPath, [join(packWork, "package/bin/create-plugbricks.js"), "from-pack"], { cwd: packWork, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    for (const p of STRUCTURE) expect(existsSync(join(packWork, "from-pack", p)), p).toBe(true);
  });
});
