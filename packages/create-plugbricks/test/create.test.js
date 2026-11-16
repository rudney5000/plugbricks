import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main as plugbricks, validateManifest } from "plugbricks";
import { create, parseDacl, restrictToCurrentUser } from "../lib/create.js";
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

describe("restrictToCurrentUser: the Windows branch, with fake whoami and icacls (runs on every OS)", () => {
  // A real folder, so the fake `icacls /save` can write its UTF-16 file next to it like icacls does.
  const base = join(work, "fake-icacls");
  const dir = join(base, ".secrets");
  const ANA = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  const BOB = "S-1-5-21-1111111111-2222222222-3333333333-1002";
  const BANANA = "S-1-5-21-1111111111-2222222222-3333333333-1003";
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const whoami = (name = "box\\ana", sid = ANA) => ok(`"${name}","${sid}"\r\n`);

  /** Fake runner: whoami, icacls /grant, then icacls /save writing `sddl` as UTF-16LE with a BOM. */
  function fake(calls, sddl, overrides = {}) {
    return (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "whoami") return overrides.whoami ?? whoami();
      if (args[1] === "/save") {
        if (overrides.save) return overrides.save;
        writeFileSync(args[2], Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`.secrets\r\n${sddl}\r\n`, "utf16le")]));
        return ok("Successfully processed 1 files; Failed processing 0 files\r\n");
      }
      return overrides.grant ?? ok("processed file: .secrets\r\nSuccessfully processed 1 files\r\n");
    };
  }

  beforeAll(() => {
    rmSync(base, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });

  it("grants by SID, saves the ACL, accepts a protected DACL with only the user's SID, and cleans up", () => {
    const calls = [];
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake(calls, `D:PAI(A;OICI;FA;;;${ANA})`) });
    expect(r).toEqual({ ok: true, method: "icacls (current user's SID only)" });
    expect(calls).toEqual([
      ["whoami", "/user", "/fo", "csv", "/nh"],
      ["icacls", dir, "/inheritance:r", "/grant:r", `*${ANA}:(OI)(CI)F`],
      ["icacls", dir, "/save", `${dir}.acl-check`],
    ]);
    expect(existsSync(`${dir}.acl-check`), "temporary ACL file removed").toBe(false);
  });

  // Names never matter any more: the folder path may contain the user name, another account's
  // name may contain it, the console may garble non-ASCII names. Only SIDs are compared.
  it.each([
    ["another account (BOX\\bob) while the project is under C:\\Users\\ana", `D:PAI(A;OICI;FA;;;${ANA})(A;OICI;FA;;;${BOB})`, BOB],
    ["an account whose name contains the user name (BOX\\banana)", `D:PAI(A;OICI;FA;;;${ANA})(A;;0x1200a9;;;${BANANA})`, BANANA],
    ["Everyone (WD)", `D:PAI(A;OICI;FA;;;${ANA})(A;;FR;;;WD)`, "WD"],
  ])("reports %s as another account", (_, sddl, other) => {
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake([], sddl) });
    expect(r).toEqual({ ok: false, detail: `other accounts still have access: ${other}` });
  });

  it("works whatever the account name looks like (non-ASCII, garbled by the code page)", () => {
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake([], `D:PAI(A;OICI;FA;;;${ANA})`, { whoami: whoami("box\\Jos\uFFFD", ANA) }) });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["a DACL that still inherits", `D:AI(A;OICI;FA;;;${ANA})`, "inherited permissions are still present"],
    ["an inherited entry", `D:PAI(A;OICI;FA;;;${ANA})(A;OICIID;FA;;;SY)`, "inherited permissions are still present"],
    ["no full control for the user", `D:PAI(A;OICI;FR;;;${ANA})`, "the ACL gives the current user no full control"],
    ["unexpected output", "not sddl at all", "unexpected icacls /save output; cannot check the ACL"],
  ])("refuses %s", (_, sddl, detail) => {
    expect(restrictToCurrentUser(dir, { platform: "win32", run: fake([], sddl) })).toEqual({ ok: false, detail });
  });

  it.each([
    ["whoami fails", { whoami: { status: 1, stdout: "", stderr: "" } }, /could not read the current user's SID/],
    ["icacls /grant fails", { grant: { status: 5, stdout: "", stderr: "Access is denied." } }, /icacls exited with 5: Access is denied/],
    ["icacls /save fails", { save: { status: 2, stdout: "", stderr: "" } }, /icacls \/save exited with 2/],
  ])("reports, never hides, a failure: %s", (_, overrides, detail) => {
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake([], `D:PAI(A;OICI;FA;;;${ANA})`, overrides) });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(detail);
  });

  it("parseDacl reads flags and entries; deny entries are not access", () => {
    expect(parseDacl(`D:PAI(D;;FA;;;${BOB})(A;OICI;FA;;;${ANA})`)).toEqual({
      protected: true,
      aces: [
        { type: "D", flags: "", rights: "FA", sid: BOB },
        { type: "A", flags: "OICI", rights: "FA", sid: ANA },
      ],
    });
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake([], `D:PAI(D;;FA;;;${BOB})(A;OICI;FA;;;${ANA})`) });
    expect(r.ok).toBe(true);
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
