import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { formatMessage, initPlatform, isValidPlatformName, PlugbricksError } from "plugbricks";

const templateDir = new URL("../template/", import.meta.url);

/** Exact version of the plugbricks package this generator was released with. */
function plugbricksVersion() {
  const pkg = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("plugbricks/package.json"), "utf8"));
  return pkg.version;
}

function error(io, code, params = {}) {
  io.stderr(`error ${code}: ${formatMessage(code, params)}`);
}

function warning(io, code, params = {}) {
  io.stderr(`warning ${code}: ${formatMessage(code, params)}`);
}

/**
 * Restricts a directory to the current user and checks that it worked.
 * - Linux, macOS: chmod 700, then stat to confirm the mode.
 * - Windows: there are no POSIX modes (chmod only toggles read-only), so an ACL is set with
 *   icacls: inherited entries removed, full control granted to the current user only. The ACL
 *   is then read back with icacls to confirm.
 * Never throws; returns { ok: false, detail } so the caller reports it instead of failing silently.
 * `platform` and `run` are injectable so tests can exercise the Windows branch on any OS.
 * @param {string} dir
 * @param {{ platform?: string, run?: (cmd: string, args: string[]) => { status: number | null, stdout: string, stderr: string }, user?: string }} [opts]
 * @returns {{ ok: true, method: string } | { ok: false, detail: string }}
 */
export function restrictToCurrentUser(dir, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? ((cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }));
  try {
    if (platform !== "win32") {
      chmodSync(dir, 0o700);
      const mode = statSync(dir).mode & 0o777;
      return mode === 0o700 ? { ok: true, method: "chmod 700" } : { ok: false, detail: `mode is ${mode.toString(8)} after chmod 700` };
    }
    const user = opts.user ?? (process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${userInfo().username}` : userInfo().username);
    const set = run("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`]);
    if (set.status !== 0) return { ok: false, detail: `icacls exited with ${set.status}: ${(set.stderr || set.stdout || "").trim()}` };
    const check = run("icacls", [dir]);
    if (check.status !== 0) return { ok: false, detail: `icacls could not read the ACL back (exit ${check.status})` };
    const entries = check.stdout.split(/\r?\n/).filter((l) => l.includes(":("));
    if (entries.some((l) => l.includes("(I)"))) return { ok: false, detail: "inherited permissions are still present" };
    const name = user.split("\\").pop().toLowerCase();
    const others = entries.filter((l) => !l.toLowerCase().includes(name));
    if (others.length) return { ok: false, detail: `other accounts still have access: ${others.map((l) => l.trim()).join("; ")}` };
    return { ok: true, method: "icacls (current user only)" };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

/**
 * Creates a new plugbricks project in <cwd>/<name>.
 * Returns the exit code: 0 created, 1 refused, 2 usage error. Writes nothing when it refuses.
 * @param {string[]} args
 * @param {{ cwd: string, stdout: (l: string) => void, stderr: (l: string) => void }} io
 * @param {{ restrict?: typeof restrictToCurrentUser }} [deps] injectable for tests
 */
export function create(args, io, deps = {}) {
  const restrict = deps.restrict ?? restrictToCurrentUser;
  const [name, ...extra] = args;
  if (!name || extra.length) {
    error(io, "CREATE_MISSING_NAME");
    return 2;
  }
  if (!isValidPlatformName(name)) {
    error(io, "PLATFORM_INVALID_NAME", { name });
    return 1;
  }
  const dir = resolve(io.cwd, name);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    error(io, "CREATE_TARGET_NOT_EMPTY", { dir });
    return 1;
  }

  mkdirSync(dir, { recursive: true });
  cpSync(templateDir, dir, { recursive: true });
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));
  renameSync(join(dir, "gitattributes"), join(dir, ".gitattributes"));
  const readme = join(dir, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replaceAll("{{name}}", name));

  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { status: "plugbricks status" },
    devDependencies: { plugbricks: plugbricksVersion() },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  try {
    initPlatform(dir, name);
  } catch (e) {
    if (e instanceof PlugbricksError) {
      for (const i of e.issues) error(io, i.code, i.params);
      return 1;
    }
    throw e;
  }
  // Empty folders are not kept by git: a placeholder keeps .platform/bricks/ visible from the first commit.
  writeFileSync(join(dir, ".platform/bricks/.gitkeep"), "");
  mkdirSync(join(dir, ".generated"), { recursive: true });
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  const secrets = restrict(join(dir, ".secrets"));
  // Not fatal: .secrets/ is still empty. Writing a secret into it must refuse (milestone 3).
  if (!secrets.ok) warning(io, "SECRETS_NOT_RESTRICTED", { dir: join(dir, ".secrets"), detail: secrets.detail });

  io.stdout(`Created ${name} in ${dir}`);
  io.stdout("");
  io.stdout("Next steps:");
  io.stdout(`  cd ${name}`);
  io.stdout("  npm install");
  io.stdout("  npx plugbricks status");
  io.stdout("Then read README.md: it explains every folder.");
  return 0;
}
