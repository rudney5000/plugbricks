import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./fsutil.js";
import { issue, type Issue } from "./issues.js";

/** Where secrets live in a project. Never committed: the folder ignores itself (see ensureSecretsDir). */
export const SECRETS_DIR = ".secrets";
/** Every generated secret, as KEY=value lines. Read by `docker compose --env-file`, and the source of the Kubernetes Secret. */
export const SECRETS_FILE = "secrets.env";

export type RunResult = { status: number | null; stdout: string; stderr: string };
export type PowerShellRunner = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => RunResult;

export interface RestrictOptions {
  platform?: NodeJS.Platform | string;
  run?: PowerShellRunner;
}

export type RestrictResult = { ok: true; method: string } | { ok: false; detail: string };

const ACL_REPORT =
  "[pscustomobject]@{ user = $user.Value; protected = $check.AreAccessRulesProtected; rules = @($rules | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited; rights = [string]$_.FileSystemRights } }) } | ConvertTo-Json -Compress -Depth 4";

/**
 * PowerShell run on Windows. It replaces the whole DACL of the folder with a new, protected one
 * holding a single entry (full control for the current user's SID), so explicit entries such as
 * BUILTIN\Administrators are dropped too. It then reads the ACL back with GetAccessRules(...,
 * SecurityIdentifier), which always gives real SIDs (icacls /save writes aliases such as LA for
 * the built-in Administrator account), and prints it as JSON. The path comes from an environment
 * variable, so no quoting is involved.
 * The .NET methods are called directly: the Get-Acl and Set-Acl cmdlets live in a module that
 * failed to load on windows-latest ("the module could not be loaded"), and the folder was left
 * with its inherited ACL.
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
  "[System.IO.Directory]::SetAccessControl($path, $acl)",
  "$check = [System.IO.Directory]::GetAccessControl($path)",
  "$rules = $check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
  ACL_REPORT,
].join("; ");

/** Same report as WINDOWS_ACL_SCRIPT, without changing anything: used before writing a secret. */
export const WINDOWS_ACL_CHECK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$path = $env:PLUGBRICKS_SECRETS_DIR",
  "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
  "$check = [System.IO.Directory]::GetAccessControl($path)",
  "$rules = $check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])",
  ACL_REPORT,
].join("; ");

export interface AclReport {
  user: string;
  protected: boolean;
  rules: { sid: string; type: string; inherited: boolean; rights: string }[];
}

/**
 * Checks the ACL reported by the scripts above: protected, nothing inherited, every allow
 * entry is the current user's SID, and the user has full control. SIDs only, never names.
 */
export function checkWindowsAcl(acl: AclReport | undefined | null): { ok: true } | { ok: false; detail: string } {
  if (!acl || typeof acl.user !== "string" || !Array.isArray(acl.rules))
    return { ok: false, detail: "unexpected ACL report; cannot check the ACL" };
  if (!acl.protected || acl.rules.some((r) => r.inherited)) return { ok: false, detail: "inherited permissions are still present" };
  const allows = acl.rules.filter((r) => r.type === "Allow");
  const others = allows.filter((r) => r.sid.toUpperCase() !== acl.user.toUpperCase());
  if (others.length) return { ok: false, detail: `other accounts still have access: ${others.map((r) => r.sid).join(", ")}` };
  if (!allows.some((r) => r.rights.includes("FullControl"))) return { ok: false, detail: "the ACL gives the current user no full control" };
  return { ok: true };
}

const defaultRun: PowerShellRunner = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? r.error.message : "") };
};

function runAclScript(dir: string, script: string, run: PowerShellRunner): { ok: true } | { ok: false; detail: string } {
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    ...process.env,
    PLUGBRICKS_SECRETS_DIR: dir,
  });
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout || "").trim().split(/\r?\n/)[0];
    return { ok: false, detail: `PowerShell exited with ${r.status}${why ? `: ${why}` : ""}` };
  }
  let acl: AclReport;
  try {
    acl = JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);
  } catch {
    return { ok: false, detail: "unexpected ACL report; cannot check the ACL" };
  }
  return checkWindowsAcl(acl);
}

/**
 * Restricts a directory to the current user and checks that it worked.
 * - Linux, macOS: chmod 700, then stat to confirm the mode.
 * - Windows: there are no POSIX modes (chmod only toggles read-only); WINDOWS_ACL_SCRIPT sets a
 *   new DACL for the current user's SID only and reports it back; checkWindowsAcl verifies it.
 *   Members of Administrators can still take ownership, as root can on Linux and macOS.
 * Never throws; returns { ok: false, detail } so the caller reports it instead of failing silently.
 * `platform` and `run` are injectable so tests can exercise the Windows branch on any OS.
 */
export function restrictToCurrentUser(dir: string, opts: RestrictOptions = {}): RestrictResult {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform !== "win32") {
      chmodSync(dir, 0o700);
      const mode = statSync(dir).mode & 0o777;
      return mode === 0o700 ? { ok: true, method: "chmod 700" } : { ok: false, detail: `mode is ${mode.toString(8)} after chmod 700` };
    }
    const checked = runAclScript(dir, WINDOWS_ACL_SCRIPT, opts.run ?? defaultRun);
    return checked.ok ? { ok: true, method: "DACL for the current user's SID only" } : checked;
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Checks, without changing anything, that only the current user can use `dir`.
 * - Linux, macOS: the folder belongs to the current user and gives no right to group or others.
 * - Windows: the same ACL rules as after restrictToCurrentUser.
 */
export function isRestrictedToCurrentUser(dir: string, opts: RestrictOptions = {}): { ok: true } | { ok: false; detail: string } {
  const platform = opts.platform ?? process.platform;
  try {
    if (platform !== "win32") {
      const st = statSync(dir);
      const mode = st.mode & 0o777;
      const uid = process.getuid?.();
      if (uid !== undefined && st.uid !== uid) return { ok: false, detail: `it belongs to user id ${st.uid}, not to you (${uid})` };
      if (mode & 0o077) return { ok: false, detail: `its mode is ${mode.toString(8)}; group and others must have no access (chmod 700)` };
      return { ok: true };
    }
    return runAclScript(dir, WINDOWS_ACL_CHECK_SCRIPT, opts.run ?? defaultRun);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/**
 * Makes sure `<root>/.secrets/` exists, is restricted to the current user, and ignores itself in
 * git (a `.gitignore` holding `*`), whatever the project's own .gitignore says.
 * A folder that does not exist yet is created and restricted; an existing one is only checked,
 * never changed. Returns a SECRETS_NOT_RESTRICTED issue instead of writing anything when the
 * folder is open to other accounts.
 */
export function ensureSecretsDir(root: string, opts: RestrictOptions = {}): { ok: true; dir: string } | { ok: false; issue: Issue } {
  const dir = join(root, SECRETS_DIR);
  let r: { ok: true } | { ok: false; detail: string };
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    r = restrictToCurrentUser(dir, opts);
  } else {
    r = isRestrictedToCurrentUser(dir, opts);
  }
  if (!r.ok) return { ok: false, issue: issue("SECRETS_NOT_RESTRICTED", "", { dir, detail: r.detail }) };
  writeFileAtomic(join(dir, ".gitignore"), "# Written by plugbricks: nothing in this folder is ever committed.\n*\n");
  return { ok: true, dir };
}

const LINE = /^(PB_[A-Z0-9_]+)=([A-Za-z0-9]+)$/;

/** Reads secrets.env. Blank lines and lines starting with # are ignored; anything else must be KEY=value. */
export function readSecrets(file: string): { ok: true; values: Map<string, string> } | { ok: false; issue: Issue } {
  const values = new Map<string, string>();
  if (!existsSync(file)) return { ok: true, values };
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) return { ok: false, issue: issue("SECRETS_FILE_INVALID", "", { file, line: String(i + 1) }) };
    values.set(m[1], m[2]);
  }
  return { ok: true, values };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A random secret of 32 letters and digits (about 190 bits). Letters and digits only, so it can be
 * placed in a URL, an env file or a YAML string without any escaping.
 */
export function randomSecret(bytes: (n: number) => Buffer = randomBytes): string {
  let out = "";
  while (out.length < 32) {
    for (const b of bytes(48)) {
      // 248 = 62 * 4: rejecting the bytes above it keeps every character equally likely.
      if (b < 248 && out.length < 32) out += ALPHABET[b % 62];
    }
  }
  return out;
}

/** Writes a file readable by its owner only (0600 on Linux and macOS; on Windows the folder ACL applies). */
export function writePrivateFile(file: string, content: string): void {
  writeFileAtomic(file, content, 0o600);
}

export interface SecretsResult {
  values: Map<string, string>;
  /** Keys generated by this call. Existing values are never changed. */
  created: string[];
}

/**
 * Returns a value for every key in `keys`, generating the missing ones into .secrets/secrets.env.
 * Existing secrets are kept as they are, including those no installed brick uses any more: a
 * retained volume that is attached again still needs the password it was created with.
 */
export function ensureSecrets(
  root: string,
  keys: string[],
  opts: RestrictOptions & { random?: () => string } = {},
): { ok: true; result: SecretsResult } | { ok: false; issue: Issue } {
  const dir = ensureSecretsDir(root, opts);
  if (!dir.ok) return dir;
  const file = join(dir.dir, SECRETS_FILE);
  const read = readSecrets(file);
  if (!read.ok) return read;
  const values = read.values;
  const created: string[] = [];
  for (const key of [...new Set(keys)].sort()) {
    if (values.has(key)) continue;
    values.set(key, (opts.random ?? randomSecret)());
    created.push(key);
  }
  if (created.length || !existsSync(file)) {
    const body = [...values.keys()].sort().map((k) => `${k}=${values.get(k)}`);
    writePrivateFile(file, ["# Generated by plugbricks. Never commit or share this file.", ...body, ""].join("\n"));
  }
  return { ok: true, result: { values, created } };
}
