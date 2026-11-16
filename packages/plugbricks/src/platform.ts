import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path, { basename, dirname, join, resolve, sep } from "node:path";
import { issue, type Issue } from "./issues.js";
import { validateManifest } from "./manifest.js";
import type { IssueCode, IssueParams } from "./messages.js";
import {
  LOCK_SCHEMA_ID,
  lockSchema,
  MANIFEST_DEFAULTS,
  PLATFORM_SCHEMA_ID,
  platformSchema,
  schemaIssues,
} from "./schemas.js";

export const PLATFORM_FILE = "platform.json";
export const LOCK_FILE = "platform.lock";
export const BRICKS_DIR = ".platform/bricks";
const NAME = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

/** Same rule as "name" in platform.schema.json. */
export function isValidPlatformName(name: string): boolean {
  return NAME.test(name);
}

// ---------- types ----------

export interface Platform {
  $schema?: string;
  name: string;
  bricks: Record<string, { source: string }>;
}

export interface VolumeRef {
  brick: string;
  service: string;
  name: string;
}

export interface LockedBrick {
  version: string;
  source: string;
  integrity: string;
  provides: string[];
  requires: Record<string, { provider: string; wait: "healthy" | "started"; timeoutSeconds: number }>;
  volumes: { service: string; name: string; retention: "retain" | "delete" }[];
}

export interface Lock {
  $schema?: string;
  lockfileVersion: 1;
  bricks: Record<string, LockedBrick>;
  capabilities: Record<string, string>;
  retainedVolumes: VolumeRef[];
  /** The only volumes a driver may delete, and only with --prune-volumes. */
  pendingDeletion: VolumeRef[];
}

/** A refusal. Carries one or more issues; the first one gives the headline code. */
export class PlugbricksError extends Error {
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(issues.map((i) => `${i.code}: ${i.message}`).join("\n"));
    this.issues = issues;
  }
  get code(): IssueCode {
    return this.issues[0].code;
  }
}

function fail(code: IssueCode, params: IssueParams = {}, more: Issue[] = []): never {
  throw new PlugbricksError([issue(code, "", params), ...more]);
}

// ---------- files ----------

/** Deterministic JSON: object keys sorted at every level, 2-space indent, trailing newline. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

/** Writes through a temp file and a rename, so a crash never leaves a half-written file. Skips identical content. */
function writeFileAtomic(file: string, content: string): void {
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function readJson(file: string, label: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail("INVALID_JSON", { file: label, detail: (e as Error).message });
  }
}

/**
 * Relative path from `from` to `to`, always written with "/" so platform.json and
 * platform.lock are identical on Linux, macOS and Windows. `p` is the path flavour of the
 * running OS; tests pass path.win32 to check the Windows behaviour on any machine.
 */
export function portableRelative(from: string, to: string, p: path.PlatformPath = path): string | undefined {
  const rel = p.relative(from, to);
  // On Windows, two paths on different drives have no relative path: path.relative returns the
  // absolute target ("D:\\bricks\\pg"), which would be meaningless on another machine or OS.
  if (p.isAbsolute(rel)) return undefined;
  return rel.split(p.sep).join(path.posix.sep);
}

/**
 * The `source` recorded for a brick: its folder relative to the platform root, with "/".
 * Refuses (BRICK_PATH_NOT_PORTABLE) a folder on another Windows drive, and a folder name that
 * contains a backslash (legal on Linux and macOS, a separator on Windows).
 */
export function brickSource(root: string, brickDir: string, brick: string, p: path.PlatformPath = path): string {
  const rel = portableRelative(root, brickDir, p);
  if (rel === undefined) {
    const drive = p.parse(p.resolve(brickDir)).root.replace(/[\\/]+$/, "");
    fail("BRICK_PATH_NOT_PORTABLE", {
      brick,
      detail: `its folder is on another drive (${drive}) than the platform; copy the brick under the platform folder`,
    });
  }
  if (rel.includes("\\")) {
    fail("BRICK_PATH_NOT_PORTABLE", {
      brick,
      detail: `its folder "${rel}" has a backslash in its name, which is a path separator on Windows; rename it`,
    });
  }
  return rel || ".";
}

// ---------- brick contents ----------

/** Every regular file of a brick, as sorted posix paths. Refuses symbolic links. */
function listBrickFiles(dir: string, brick: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${entry}` : entry;
      if (entry.includes("\\")) {
        fail("BRICK_PATH_NOT_PORTABLE", {
          brick,
          detail: `the file "${r}" inside the brick has a backslash in its name, which is a path separator on Windows; rename it`,
        });
      }
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) fail("BRICK_SYMLINK", { brick, file: r });
      if (st.isDirectory()) walk(r);
      else if (st.isFile()) out.push(r);
    }
  };
  walk("");
  return out.sort();
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file is text when, over its whole length, it is valid UTF-8 and contains no control byte
 * other than tab, LF, form feed and CR. Anything else (certificates, compressed data, images,
 * even without a NUL byte) is binary and is never modified.
 */
export function isText(data: Buffer): boolean {
  for (const b of data) {
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) return false;
    if (b === 0x7f) return false;
  }
  try {
    utf8.decode(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Text files get CRLF turned into LF, so a brick checked out on Windows (git autocrlf) has the
 * same integrity as on Linux, and its installed copy has LF. Binary files (see isText) are
 * returned unchanged, byte for byte. A buffer without CR is returned as is, without any copy.
 */
export function normalizeLineEndings(data: Buffer): Buffer {
  if (data.indexOf(0x0d) === -1) return data;
  if (!isText(data)) return data;
  const out = Buffer.allocUnsafe(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0d && data[i + 1] === 0x0a) continue;
    out[n++] = data[i];
  }
  return n === data.length ? data : out.subarray(0, n);
}

/** sha256 over (path, size, content) of every file, in sorted path order, after normalizeLineEndings. */
export function brickIntegrity(dir: string, brick: string): string {
  const h = createHash("sha256");
  for (const f of listBrickFiles(dir, brick)) {
    const data = normalizeLineEndings(readFileSync(join(dir, f)));
    h.update(`${f}\0${data.length}\0`);
    h.update(data);
  }
  return `sha256-${h.digest("hex")}`;
}

interface Manifest {
  name: string;
  version: string;
  services: { name: string; volumes?: { name: string; retention?: "retain" | "delete" }[] }[];
  provides?: Record<string, { provision: { command: string[]; scripts?: string } }>;
  requires?: Record<string, { wait?: "healthy" | "started"; timeoutSeconds?: number }>;
  subgraph?: { schema: string };
}

/** Files a manifest points at must ship with the brick. */
function checkReferencedFiles(dir: string, m: Manifest): void {
  const missing: Issue[] = [];
  const need = (file: string, path: string) => {
    if (!existsSync(join(dir, file))) missing.push(issue("BRICK_FILE_MISSING", path, { brick: m.name, file }));
  };
  if (m.subgraph) need(m.subgraph.schema, "/subgraph/schema");
  for (const [cap, p] of Object.entries(m.provides ?? {})) {
    const scripts = p.provision.scripts;
    if (scripts !== undefined) need(scripts, `/provides/${cap}/provision/scripts`);
    for (const arg of p.provision.command) {
      if (arg.startsWith("/provision/")) {
        if (scripts === undefined) need("<provision.scripts>", `/provides/${cap}/provision/scripts`);
        else need(`${scripts}/${arg.slice("/provision/".length)}`, `/provides/${cap}/provision/command`);
      }
    }
  }
  if (missing.length) throw new PlugbricksError(missing);
}

// ---------- project ----------

export interface Project {
  root: string;
  platform: Platform;
  lock: Lock;
}

function emptyLock(): Lock {
  return { $schema: LOCK_SCHEMA_ID, lockfileVersion: 1, bricks: {}, capabilities: {}, retainedVolumes: [], pendingDeletion: [] };
}

/** Creates platform.json, platform.lock and .platform/bricks/. Refuses to overwrite an existing platform. */
export function initPlatform(root: string, name?: string): { name: string; created: string[] } {
  const dir = resolve(root);
  if (existsSync(join(dir, PLATFORM_FILE))) fail("PLATFORM_ALREADY_INITIALIZED", { dir });
  const platformName = name ?? basename(dir);
  if (!NAME.test(platformName)) fail("PLATFORM_INVALID_NAME", { name: platformName });

  mkdirSync(join(dir, BRICKS_DIR), { recursive: true });
  const platform: Platform = { $schema: PLATFORM_SCHEMA_ID, name: platformName, bricks: {} };
  writeFileAtomic(join(dir, LOCK_FILE), canonicalJson(emptyLock()));
  writeFileAtomic(join(dir, PLATFORM_FILE), canonicalJson(platform));
  return { name: platformName, created: [PLATFORM_FILE, LOCK_FILE, `${BRICKS_DIR}/`] };
}

/** Reads and validates platform.json and platform.lock, and checks that they list the same bricks. */
export function readProject(root: string): Project {
  const dir = resolve(root);
  const platform = readJson(join(dir, PLATFORM_FILE), PLATFORM_FILE);
  if (platform === undefined) fail("PLATFORM_NOT_INITIALIZED", { dir });
  const pIssues = schemaIssues(platformSchema.validate, platform, `${PLATFORM_FILE}#`);
  if (pIssues.length) fail("PLATFORM_FILE_INVALID", { file: PLATFORM_FILE }, pIssues);

  const lock = readJson(join(dir, LOCK_FILE), LOCK_FILE);
  if (lock === undefined) fail("LOCK_MISSING", { dir });
  const lIssues = schemaIssues(lockSchema.validate, lock, `${LOCK_FILE}#`);
  if (lIssues.length) fail("PLATFORM_FILE_INVALID", { file: LOCK_FILE }, lIssues);

  const p = platform as Platform;
  const l = lock as Lock;
  for (const b of Object.keys(p.bricks)) {
    if (!l.bricks[b]) fail("LOCK_OUT_OF_SYNC", { brick: b, detail: "it is in platform.json but not in platform.lock" });
  }
  for (const b of Object.keys(l.bricks)) {
    if (!p.bricks[b]) fail("LOCK_OUT_OF_SYNC", { brick: b, detail: "it is in platform.lock but not in platform.json" });
  }
  checkVolumeLists(l);
  return { root: dir, platform: p, lock: l };
}

const volumeKey = (r: VolumeRef) => `${r.brick}/${r.service}/${r.name}`;
const byKey = (a: VolumeRef, b: VolumeRef) => volumeKey(a).localeCompare(volumeKey(b));

/**
 * The two volume lists must never contradict each other or the installed bricks: a volume
 * pending deletion that is also retained, or that belongs to an installed brick, would let a
 * driver delete live data.
 */
function checkVolumeLists(lock: Lock): void {
  const retained = new Set(lock.retainedVolumes.map(volumeKey));
  for (const v of lock.pendingDeletion) {
    if (retained.has(volumeKey(v))) {
      fail("LOCK_INCONSISTENT", { volume: volumeKey(v), detail: "both in retainedVolumes and in pendingDeletion" });
    }
  }
  for (const [list, entries] of [["retainedVolumes", lock.retainedVolumes], ["pendingDeletion", lock.pendingDeletion]] as const) {
    for (const v of entries) {
      if (lock.bricks[v.brick]) {
        fail("LOCK_INCONSISTENT", { volume: volumeKey(v), detail: `in ${list} although brick "${v.brick}" is installed` });
      }
    }
  }
}

/**
 * Volumes a driver may delete when run with --prune-volumes: exactly lock.pendingDeletion.
 * Never derived from what is missing from the lock: a volume in neither list is kept.
 */
export function volumesToPrune(lock: Lock): VolumeRef[] {
  checkVolumeLists(lock);
  return [...lock.pendingDeletion].sort(byKey);
}

function save(project: Project): void {
  project.lock.retainedVolumes.sort(byKey);
  project.lock.pendingDeletion.sort(byKey);
  // Lock first: if the second write fails, readProject reports LOCK_OUT_OF_SYNC instead of silently drifting.
  writeFileAtomic(join(project.root, LOCK_FILE), canonicalJson(project.lock));
  writeFileAtomic(join(project.root, PLATFORM_FILE), canonicalJson(project.platform));
}

// ---------- add ----------

export interface AddResult {
  name: string;
  version: string;
  status: "added" | "unchanged";
  reattachedVolumes: VolumeRef[];
  /** Volumes of this brick that were pending deletion; adding the brick back cancels that. */
  cancelledDeletions: VolumeRef[];
}

/**
 * Validates a brick, checks it against the installed ones, copies it to .platform/bricks/<name>
 * and records it. Adding the same brick again changes nothing.
 * `brickPath` is a brick directory or its plugin.json, absolute or relative to `root`.
 */
export function addBrick(root: string, brickPath: string): AddResult {
  const project = readProject(root);
  const target = resolve(project.root, brickPath);
  const manifestFile = target.endsWith(".json") ? target : join(target, "plugin.json");
  const brickDir = dirname(manifestFile);
  const shown = portableRelative(project.root, manifestFile) || manifestFile.split(path.sep).join("/");
  if (!existsSync(manifestFile) || !statSync(manifestFile).isFile()) fail("BRICK_NOT_FOUND", { path: shown });

  const raw = readJson(manifestFile, shown);
  const v = validateManifest(raw);
  if (!v.ok) fail("MANIFEST_INVALID", { path: shown }, v.issues.map((i) => ({ ...i, path: `${shown}#${i.path}` })));
  const m = raw as Manifest;
  checkReferencedFiles(brickDir, m);
  const integrity = brickIntegrity(brickDir, m.name);

  const { lock, platform } = project;
  const installed = lock.bricks[m.name];
  if (installed) {
    if (installed.integrity === integrity) {
      return { name: m.name, version: m.version, status: "unchanged", reattachedVolumes: [], cancelledDeletions: [] };
    }
    fail("BRICK_NAME_CONFLICT", { name: m.name, source: installed.source });
  }

  const conflicts = Object.keys(m.provides ?? {})
    .filter((cap) => lock.capabilities[cap])
    .map((cap) =>
      issue("CAPABILITY_ALREADY_PROVIDED", `/provides/${cap}`, { brick: m.name, capability: cap, provider: lock.capabilities[cap] }),
    );
  if (conflicts.length) throw new PlugbricksError(conflicts);

  const source = brickSource(project.root, brickDir, m.name);

  const missing = Object.keys(m.requires ?? {})
    .filter((cap) => !lock.capabilities[cap])
    .map((cap) => issue("REQUIRED_CAPABILITY_MISSING", `/requires/${cap}`, { brick: m.name, capability: cap }));
  if (missing.length) throw new PlugbricksError(missing);

  // Copy through a temp dir + rename so .platform/bricks/<name> is never half-written.
  const dest = join(project.root, BRICKS_DIR, m.name);
  const tmp = join(project.root, BRICKS_DIR, `.${m.name}.tmp-${process.pid}`);
  mkdirSync(join(project.root, BRICKS_DIR), { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  // The copy is exactly what was hashed: text files are written with LF (a CRLF shell script
  // would fail in a Linux container), binary files byte for byte. File modes are kept.
  for (const f of listBrickFiles(brickDir, m.name)) {
    mkdirSync(dirname(join(tmp, f)), { recursive: true });
    const mode = statSync(join(brickDir, f)).mode & 0o777;
    writeFileSync(join(tmp, f), normalizeLineEndings(readFileSync(join(brickDir, f))), { mode });
    chmodSync(join(tmp, f), mode);
  }
  if (brickIntegrity(tmp, m.name) !== integrity) {
    rmSync(tmp, { recursive: true, force: true });
    fail("BRICK_MODIFIED", { brick: m.name });
  }
  // A leftover copy can only exist after a crash between copy and save: it is not in the lock, so replace it.
  rmSync(dest, { recursive: true, force: true });
  renameSync(tmp, dest);

  lock.bricks[m.name] = {
    version: m.version,
    source,
    integrity,
    provides: Object.keys(m.provides ?? {}).sort(),
    requires: Object.fromEntries(
      Object.entries(m.requires ?? {}).map(([cap, r]) => [
        cap,
        {
          provider: lock.capabilities[cap],
          wait: r.wait ?? MANIFEST_DEFAULTS.wait,
          timeoutSeconds: r.timeoutSeconds ?? MANIFEST_DEFAULTS.timeoutSeconds,
        },
      ]),
    ),
    volumes: m.services.flatMap((s) =>
      (s.volumes ?? []).map((vol) => ({ service: s.name, name: vol.name, retention: vol.retention ?? MANIFEST_DEFAULTS.retention })),
    ),
  };
  for (const cap of Object.keys(m.provides ?? {})) lock.capabilities[cap] = m.name;
  const reattachedVolumes = lock.retainedVolumes.filter((r) => r.brick === m.name);
  lock.retainedVolumes = lock.retainedVolumes.filter((r) => r.brick !== m.name);
  const cancelledDeletions = lock.pendingDeletion.filter((r) => r.brick === m.name);
  lock.pendingDeletion = lock.pendingDeletion.filter((r) => r.brick !== m.name);
  platform.bricks[m.name] = { source };
  save(project);
  return { name: m.name, version: m.version, status: "added", reattachedVolumes, cancelledDeletions };
}

// ---------- remove ----------

export interface RemoveResult {
  name: string;
  retainedVolumes: VolumeRef[];
  /** Added to lock.pendingDeletion. Nothing is deleted here; a driver deletes them only with --prune-volumes. */
  pendingDeletion: VolumeRef[];
}

/** Uninstalls a brick unless another brick still requires a capability it provides. */
export function removeBrick(root: string, name: string): RemoveResult {
  const project = readProject(root);
  const { lock, platform } = project;
  const brick = lock.bricks[name];
  if (!brick) fail("BRICK_NOT_INSTALLED", { name });

  const inUse = brick.provides.flatMap((cap) => {
    const consumers = Object.entries(lock.bricks)
      .filter(([other, b]) => other !== name && b.requires[cap])
      .map(([other]) => `"${other}"`)
      .sort();
    return consumers.length ? [issue("CAPABILITY_IN_USE", "", { brick: name, capability: cap, consumers: consumers.join(", ") })] : [];
  });
  if (inUse.length) throw new PlugbricksError(inUse);

  const ref = (v: LockedBrick["volumes"][number]): VolumeRef => ({ brick: name, service: v.service, name: v.name });
  const retainedVolumes = brick.volumes.filter((v) => v.retention === "retain").map(ref);
  const pendingDeletion = brick.volumes.filter((v) => v.retention === "delete").map(ref);

  delete lock.bricks[name];
  for (const cap of brick.provides) delete lock.capabilities[cap];
  const add = (list: VolumeRef[], entries: VolumeRef[]) => {
    const known = new Set(list.map(volumeKey));
    list.push(...entries.filter((r) => !known.has(volumeKey(r))));
  };
  add(lock.retainedVolumes, retainedVolumes);
  add(lock.pendingDeletion, pendingDeletion);
  delete platform.bricks[name];
  save(project);

  const copy = join(project.root, BRICKS_DIR, name);
  if (resolve(copy).startsWith(resolve(project.root, BRICKS_DIR) + sep)) rmSync(copy, { recursive: true, force: true });
  return { name, retainedVolumes, pendingDeletion };
}

// ---------- status ----------

export interface StatusResult {
  name: string;
  bricks: (LockedBrick & { name: string })[];
  capabilities: Record<string, string>;
  retainedVolumes: VolumeRef[];
  pendingDeletion: VolumeRef[];
  /** Empty when everything matches the lock. */
  problems: Issue[];
}

export function platformStatus(root: string): StatusResult {
  const { root: dir, platform, lock } = readProject(root);
  const problems: Issue[] = [];
  const bricks = Object.keys(lock.bricks)
    .sort()
    .map((name) => {
      const copy = join(dir, BRICKS_DIR, name);
      // One broken brick is reported for that brick; the others are still checked.
      try {
        if (!existsSync(join(copy, "plugin.json"))) problems.push(issue("BRICK_MISSING", "", { brick: name }));
        else if (brickIntegrity(copy, name) !== lock.bricks[name].integrity) problems.push(issue("BRICK_MODIFIED", "", { brick: name }));
      } catch (e) {
        // Our own refusals keep their code; anything else (EACCES, ENOTDIR, …) is reported as
        // BRICK_UNREADABLE for this brick. Either way the next brick is still checked.
        if (e instanceof PlugbricksError) problems.push(...e.issues);
        else problems.push(issue("BRICK_UNREADABLE", "", { brick: name, detail: (e as Error).message }));
      }
      return { name, ...lock.bricks[name] };
    });
  return {
    name: platform.name,
    bricks,
    capabilities: lock.capabilities,
    retainedVolumes: lock.retainedVolumes,
    pendingDeletion: lock.pendingDeletion,
    problems,
  };
}
