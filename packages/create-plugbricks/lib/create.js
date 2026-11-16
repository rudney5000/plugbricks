import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
 * PowerShell run on Windows. It replaces the whole DACL of the folder with a new, protected one
 * holding a single entry (full control for the current user's SID), so explicit entries such as
 * BUILTIN\Administrators are dropped too. It then reads the ACL back with GetAccessRules(...,
 * SecurityIdentifier), which always gives real SIDs (icacls /save writes aliases such as LA for
 * the built-in Administrator account), and prints it as JSON. The path comes from an environment
 * variable, so no quoting is involved.
 */
export const WINDOWS_ACL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:PLUGBRICKS_SECRETS_DIR",
  "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
  "$acl.SetAccessRuleProtection($true, $false)",
  "$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($user, [System.Security.AccessControl.FileSystemRights]::FullControl, $inherit, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)",
  "$acl.AddAccessRule($rule)",
  "Set-Acl -LiteralPath $path -AclObject $acl",
  "$check = Get-Acl -LiteralPath $path",
  "$rules = $check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
  "[pscustomobject]@{ user = $user.Value; protected = $check.AreAccessRulesProtected; rules = @($rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited; rights = [string]$_.FileSystemRights } }) } | ConvertTo-Json -Compress -Depth 4",
].join("; ");

/**
 * Checks the ACL reported by WINDOWS_ACL_SCRIPT: protected, nothing inherited, every allow
 * entry is the current user's SID, and the user has full control. SIDs only, never names.
 * @param {{ user: string, protected: boolean, rules: { sid: string, type: string, inherited: boolean, rights: string }[] }} acl
 * @returns {{ ok: true } | { ok: false, detail: string }}
 */
export function checkWindowsAcl(acl) {
  if (!acl || typeof acl.user !== "string" || !Array.isArray(acl.rules)) return { ok: false, detail: "unexpected ACL report; cannot check the ACL" };
  if (!acl.protected || acl.rules.some((r) => r.inherited)) return { ok: false, detail: "inherited permissions are still present" };
  const allows = acl.rules.filter((r) => r.type === "Allow");
  const others = allows.filter((r) => r.sid.toUpperCase() !== acl.user.toUpperCase());
  if (others.length) return { ok: false, detail: `other accounts still have access: ${others.map((r) => r.sid).join(", ")}` };
  if (!allows.some((r) => r.rights.includes("FullControl"))) return { ok: false, detail: "the ACL gives the current user no full control" };
  return { ok: true };
}

/**
 * Restricts a directory to the current user and checks that it worked.
 * - Linux, macOS: chmod 700, then stat to confirm the mode.
 * - Windows: there are no POSIX modes (chmod only toggles read-only); WINDOWS_ACL_SCRIPT sets a
 *   new DACL for the current user's SID only and reports it back; checkWindowsAcl verifies it.
 *   Members of Administrators can still take ownership, as root can on Linux and macOS.
 * Never throws; returns { ok: false, detail } so the caller reports it instead of failing silently.
 * `platform` and `run` are injectable so tests can exercise the Windows branch on any OS.
 * @param {string} dir
 * @param {{ platform?: string, run?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => { status: number | null, stdout: string, stderr: string } }} [opts]
 * @returns {{ ok: true, method: string } | { ok: false, detail: string }}
 */
export function restrictToCurrentUser(dir, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? ((cmd, args, env) => spawnSync(cmd, args, { encoding: "utf8", env }));
  try {
    if (platform !== "win32") {
      chmodSync(dir, 0o700);
      const mode = statSync(dir).mode & 0o777;
      return mode === 0o700 ? { ok: true, method: "chmod 700" } : { ok: false, detail: `mode is ${mode.toString(8)} after chmod 700` };
    }
    const r = run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_SCRIPT],
      { ...process.env, PLUGBRICKS_SECRETS_DIR: dir },
    );
    if (r.status !== 0) {
      const why = (r.stderr || r.stdout || "").trim().split(/\r?\n/)[0];
      return { ok: false, detail: `PowerShell exited with ${r.status}${why ? `: ${why}` : ""}` };
    }
    let acl;
    try {
      acl = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    } catch {
      return { ok: false, detail: "unexpected ACL report; cannot check the ACL" };
    }
    const checked = checkWindowsAcl(acl);
    return checked.ok ? { ok: true, method: "DACL for the current user's SID only" } : checked;
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
