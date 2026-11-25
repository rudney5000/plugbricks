import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main as plugbricks, MANIFEST_SCHEMA_ID, validateManifest } from "plugbricks";
import { BASE_BRICKS, checkWindowsAcl, create, parseArgs, restrictToCurrentUser, STARTERS, WINDOWS_ACL_SCRIPT } from "../lib/create.js";
import { extractTgz, linkDir, npmPack } from "../../plugbricks/test/helpers/pack.ts";

// Everything runs in .test-work/ inside this package (gitignored).
const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkgDir, ".test-work");
const examplesDir = fileURLToPath(new URL("../../plugbricks/examples/", import.meta.url));
/** The bricks a new project gets in bricks/ (D25): those whose images are public, on Docker Hub. */
const SHIPPED_BRICKS = ["nats", "postgres", "rabbitmq"];
/** The catalogue of the generator (D30): the base bricks and the bricks of the starters. */
const catalogueDir = fileURLToPath(new URL("../bricks/", import.meta.url));

/** Every file of a folder, relative and sorted, with "/" as the separator. */
function filesOf(dir, prefix = "") {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesOf(dir, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]))
    .sort();
}
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
  "services/README.md",
  "bricks/postgres/plugin.json",
  "bricks/postgres/provision/create-database.sh",
  "bricks/rabbitmq/plugin.json",
  "bricks/rabbitmq/provision/create-vhost.sh",
  "bricks/nats/plugin.json",
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

  // Checked with a different tool than the generator uses (icacls instead of PowerShell).
  it.runIf(process.platform === "win32")(".secrets/ has exactly one ACL entry, not inherited (Windows)", () => {
    const acl = spawnSync("icacls", [join(project, ".secrets")], { encoding: "utf8" });
    expect(acl.status, acl.stderr).toBe(0);
    const entries = acl.stdout.split(/\r?\n/).filter((l) => l.includes(":("));
    expect(entries, acl.stdout).toHaveLength(1);
    expect(
      entries.filter((l) => l.includes("(I)")),
      acl.stdout,
    ).toEqual([]);
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

  it("explains every folder in the README", () => {
    const readme = readFileSync(join(project, "README.md"), "utf8");
    expect(readme.startsWith("# mon-saas\n")).toBe(true);
    expect(readme).not.toContain("{{name}}");
    for (const p of [
      "platform.json",
      "platform.lock",
      ".platform/bricks/",
      "bricks/",
      "services/",
      "config/",
      ".generated/",
      ".secrets/",
      ".gitattributes",
      "package.json",
    ]) {
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
    // What building a created service on this machine leaves (D28).
    expect(ignored("services/inventory-api/node_modules/graphql/package.json")).toBe(true);
    expect(ignored("services/inventory-api/dist/main.js")).toBe(true);
    expect(ignored("services/inventory-api/src/main.ts")).toBe(false);
    for (const p of [
      "platform.json",
      "platform.lock",
      ".platform/bricks/.gitkeep",
      "services/README.md",
      "bricks/postgres/plugin.json",
      "config/README.md",
    ]) {
      expect(ignored(p), `${p} must be committed`).toBe(false);
    }
  });

  it("gives a new project the base bricks in bricks/, and no starter's", () => {
    expect(BASE_BRICKS).toEqual(SHIPPED_BRICKS);
    expect(readdirSync(join(project, "bricks")).sort()).toEqual(SHIPPED_BRICKS);
    expect(JSON.parse(readFileSync(join(project, "platform.json"), "utf8")).bricks).toEqual({});
  });

  it("lets a beginner follow the README: add the database by name, then create a first API (D28)", () => {
    const pg = cli(["add", "postgres"], project);
    expect(pg.code, pg.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(project, "platform.json"), "utf8")).bricks.postgres).toEqual({ source: "bricks/postgres" });
    const r = cli(["create", "inventory", "--kind", "api"], project);
    expect(r.code, r.stderr).toBe(0);
    // The build command of the README is the one create prints.
    const readme = readFileSync(join(project, "README.md"), "utf8");
    const build = /^ {2}(docker build .*)$/m.exec(r.stdout)[1];
    expect(readme).toContain(build);
    expect(Object.keys(JSON.parse(readFileSync(join(project, "platform.lock"), "utf8")).bricks).sort()).toEqual([
      "inventory-api",
      "postgres",
    ]);
    expect(existsSync(join(project, "services/inventory-api/src/main.ts"))).toBe(true);
  });
});

describe("the catalogue of the generator (D25, D30)", () => {
  it("holds the examples of plugbricks as they are, with the published $schema (their scripts run through /bin/sh: no mode to keep)", () => {
    const catalogue = readdirSync(catalogueDir).sort();
    expect(catalogue).toEqual([...new Set([...BASE_BRICKS, ...Object.values(STARTERS).flatMap((s) => s.bricks)])].sort());
    for (const b of catalogue) {
      const example = join(examplesDir, b);
      const copy = join(catalogueDir, b);
      expect(filesOf(copy), b).toEqual(filesOf(example));
      for (const f of filesOf(example)) {
        // Only the $schema line differs: the example points at the schema file of the repository, the copy at its
        // published URL, which an editor of the new project can reach.
        const text = (file) => readFileSync(file, "utf8").replace(/^ {2}"\$schema": ".*",$/m, '  "$schema": "<schema>",');
        expect(text(join(copy, f)), `bricks/${b}/${f} differs from examples/${b}/${f}`).toBe(text(join(example, f)));
      }
      const manifest = JSON.parse(readFileSync(join(copy, "plugin.json"), "utf8"));
      expect(manifest.$schema, `bricks/${b}/plugin.json`).toBe(MANIFEST_SCHEMA_ID);
      expect(validateManifest(manifest), b).toEqual({ ok: true });
      // Every image a new project can pull: none only this repository can build (D29).
      expect(JSON.stringify(manifest), b).not.toContain("plugbricks-example/");
    }
  });
});

describe("npm create plugbricks <name> -- --starter <starter> (D30)", () => {
  const cwd = join(work, "starters");
  beforeAll(() => {
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
  });

  it("reads the starter before or after the name, and as --starter=<starter>", () => {
    expect(parseArgs(["shop", "--starter", "demo"])).toEqual({ name: "shop", starter: "demo" });
    expect(parseArgs(["--starter", "demo", "shop"])).toEqual({ name: "shop", starter: "demo" });
    expect(parseArgs(["shop", "--starter=demo"])).toEqual({ name: "shop", starter: "demo" });
    expect(parseArgs(["shop"])).toEqual({ name: "shop", starter: undefined });
    for (const bad of [
      ["shop", "--starter"],
      ["shop", "--starter="],
      ["shop", "--starter", "--x"],
      ["shop", "--other"],
      ["a", "b"],
      ["shop", "--starter", "demo", "--starter", "demo"],
    ]) {
      expect(parseArgs(bad), bad.join(" ")).toBeNull();
    }
  });

  it.each(Object.keys(STARTERS))("%s: adds its bricks without asking, in its order, and says what it did", (starter) => {
    const name = `with-${starter}`;
    const r = run([name, "--starter", starter], cwd);
    expect(r.code, r.stderr).toBe(0);
    const project = join(cwd, name);
    const bricks = STARTERS[starter].bricks;
    expect(r.stdout).toContain(`Starter "${starter}": `);
    const added = /^Added (.*)$/m
      .exec(r.stdout)[1]
      .split(", ")
      .map((b) => b.split(" ")[0]);
    expect(added, "added in the starter's order").toEqual(bricks);
    expect(Object.keys(JSON.parse(readFileSync(join(project, "platform.json"), "utf8")).bricks).sort()).toEqual([...bricks].sort());
    // The starter's bricks are in bricks/ too, next to the base ones, so that add and remove work on them by name.
    expect(readdirSync(join(project, "bricks")).sort()).toEqual([...new Set([...SHIPPED_BRICKS, ...bricks])].sort());
    // The platform is complete as it is: status and generate accept it.
    expect(cli(["status"], project).code).toBe(0);
    const generated = cli(["generate"], project);
    expect(generated.code, generated.stderr).toBe(0);
  });

  it("demo: the shop, with the addresses of its router and its page", () => {
    const r = run(["shop", "--starter=demo"], cwd);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Added postgres 1.0.0, orders-api 0.1.0, shipping-api 0.1.0, orders-web 0.1.0");
    expect(r.stdout).toContain("Once it is up, the GraphQL router answers at http://127.0.0.1:4000/graphql");
    expect(r.stdout).toContain("and the page of orders-web at http://127.0.0.1:8080/orders");
    expect(r.stdout).toContain("  npx plugbricks up");
    const lock = JSON.parse(readFileSync(join(cwd, "shop", "platform.lock"), "utf8"));
    expect(lock.capabilities).toEqual({ database: "postgres" });
    expect(lock.federation.subgraphs).toEqual(["orders-api", "shipping-api"]);
  });

  it("refuses an unknown starter, or a starter without a name, and writes nothing", () => {
    const unknown = run(["nothing-here", "--starter", "nope"], cwd);
    expect(unknown).toMatchObject({ code: 2, stderr: 'error CREATE_UNKNOWN_STARTER: no starter named "nope"; the starters are: demo' });
    expect(existsSync(join(cwd, "nothing-here"))).toBe(false);
    expect(run(["--starter", "demo"], cwd)).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error CREATE_MISSING_NAME: /) });
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

describe("restrictToCurrentUser: the Windows branch, with a fake PowerShell (runs on every OS)", () => {
  const dir = "D:\\a\\proj\\.secrets";
  const ANA = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  const BOB = "S-1-5-21-1111111111-2222222222-3333333333-1002";
  const BANANA = "S-1-5-21-1111111111-2222222222-3333333333-1003";
  const ADMINS = "S-1-5-32-544"; // BUILTIN\Administrators, "BA" in SDDL
  const full = (sid, extra = {}) => ({ sid, type: "Allow", inherited: false, rights: "FullControl", ...extra });
  const report = (rules, extra = {}) => ({
    status: 0,
    stdout: JSON.stringify({ user: ANA, protected: true, rules, ...extra }) + "\r\n",
    stderr: "",
  });
  const fake = (calls, result) => (cmd, args, env) => {
    calls.push({ cmd, args, dir: env.PLUGBRICKS_SECRETS_DIR });
    return result;
  };

  it("runs one PowerShell script, passes the folder through the environment, accepts a DACL with only the user's SID", () => {
    const calls = [];
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake(calls, report([full(ANA)])) });
    expect(r).toEqual({ ok: true, method: "DACL for the current user's SID only" });
    expect(calls).toEqual([
      { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_SCRIPT], dir },
    ]);
  });

  it("the script replaces the whole DACL (protected, one rule) and reads SIDs back, never names or SDDL aliases", () => {
    expect(WINDOWS_ACL_SCRIPT).toContain("SetAccessRuleProtection($true, $false)");
    expect(WINDOWS_ACL_SCRIPT).toContain("[System.IO.Directory]::SetAccessControl($path, $acl)");
    expect(WINDOWS_ACL_SCRIPT).not.toMatch(/\b(Get|Set)-Acl\b/); // module cmdlets: not used any more
    expect(WINDOWS_ACL_SCRIPT).toContain("GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])");
    expect(WINDOWS_ACL_SCRIPT).toContain("$env:PLUGBRICKS_SECRETS_DIR");
    expect(WINDOWS_ACL_SCRIPT).not.toContain(dir);
  });

  // Seen on the GitHub Windows runner: BUILTIN\Administrators kept an explicit entry.
  it.each([
    ["another account (BOX\\bob)", [full(ANA), full(BOB)], BOB],
    [
      "an account whose name contains the user name (BOX\\banana)",
      [full(ANA), full(BANANA, { rights: "ReadAndExecute, Synchronize" })],
      BANANA,
    ],
    ["BUILTIN\\Administrators, as left by icacls on the CI runner", [full(ANA), full(ADMINS)], ADMINS],
    ["Everyone", [full(ANA), full("S-1-1-0", { rights: "Read" })], "S-1-1-0"],
  ])("reports %s as another account", (_, rules, other) => {
    expect(restrictToCurrentUser(dir, { platform: "win32", run: fake([], report(rules)) })).toEqual({
      ok: false,
      detail: `other accounts still have access: ${other}`,
    });
  });

  it.each([
    ["a DACL that still inherits", report([full(ANA)], { protected: false }), "inherited permissions are still present"],
    ["an inherited entry", report([full(ANA), full("S-1-5-18", { inherited: true })]), "inherited permissions are still present"],
    ["no full control for the user", report([full(ANA, { rights: "Read" })]), "the ACL gives the current user no full control"],
    ["output that is not JSON", { status: 0, stdout: "Accès refusé\r\n", stderr: "" }, "unexpected ACL report; cannot check the ACL"],
    ["JSON of the wrong shape", { status: 0, stdout: "{}", stderr: "" }, "unexpected ACL report; cannot check the ACL"],
    [
      "PowerShell failing",
      { status: 1, stdout: "", stderr: "Set-Acl : Attempted to perform an unauthorized operation.\r\nAt line:1" },
      "PowerShell exited with 1: Set-Acl : Attempted to perform an unauthorized operation.",
    ],
  ])("refuses %s", (_, result, detail) => {
    expect(restrictToCurrentUser(dir, { platform: "win32", run: fake([], result) })).toEqual({ ok: false, detail });
  });

  it("a deny entry for another account is not access", () => {
    const r = restrictToCurrentUser(dir, { platform: "win32", run: fake([], report([full(BOB, { type: "Deny" }), full(ANA)])) });
    expect(r.ok).toBe(true);
  });

  it("checkWindowsAcl compares SIDs case-insensitively and exactly", () => {
    expect(checkWindowsAcl({ user: ANA.toLowerCase(), protected: true, rules: [full(ANA)] })).toEqual({ ok: true });
    expect(checkWindowsAcl({ user: ANA, protected: true, rules: [full(`${ANA}0`)] }).ok).toBe(false);
  });

  it("the generator turns a failure into an explicit SECRETS_NOT_RESTRICTED warning and still creates the project", () => {
    const cwd = join(work, "secrets-warning");
    rmSync(cwd, { recursive: true, force: true });
    mkdirSync(cwd, { recursive: true });
    const stderr = [];
    const code = create(
      ["warned"],
      { cwd, stdout: () => {}, stderr: (l) => stderr.push(l) },
      {
        restrict: () => ({ ok: false, detail: "simulated failure" }),
      },
    );
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
      expect.arrayContaining([
        "bin/create-plugbricks.js",
        "lib/create.js",
        "template/gitignore",
        "template/gitattributes",
        "template/README.md",
        "template/services/README.md",
        ...SHIPPED_BRICKS.map((b) => `bricks/${b}/plugin.json`),
        "bricks/postgres/provision/create-database.sh",
        "bricks/orders-web/plugin.json",
        "starters.json",
      ]),
    );
    expect(files.filter((f) => f.startsWith("test/"))).toEqual([]);
  });

  it("creates a project from the packed bin", () => {
    const r = spawnSync(process.execPath, [join(packWork, "package/bin/create-plugbricks.js"), "from-pack"], {
      cwd: packWork,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    for (const p of STRUCTURE) expect(existsSync(join(packWork, "from-pack", p)), p).toBe(true);
    // The catalogue and the starters are in the archive (D30).
    const started = spawnSync(
      process.execPath,
      [join(packWork, "package/bin/create-plugbricks.js"), "from-pack-demo", "--starter", "demo"],
      {
        cwd: packWork,
        encoding: "utf8",
      },
    );
    expect(started.status, started.stderr).toBe(0);
    expect(existsSync(join(packWork, "from-pack-demo/.platform/bricks/orders-web/plugin.json"))).toBe(true);
  });
});
