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
import { ROUTER_IMAGE } from "./drivers/common.js";
import { composeSubgraphs, composerVersion, type FederationLock, type SubgraphInput } from "./federation.js";
import { writeFileAtomic } from "./fsutil.js";
import { issue, type Issue } from "./issues.js";
import { validateManifest } from "./manifest.js";
import { buildPlan, type BrickManifest } from "./plan.js";
import type { IssueCode, IssueParams } from "./messages.js";
import {
  LOCK_SCHEMA_ID,
  lockSchema,
  MANIFEST_DEFAULTS,
  PLATFORM_DEFAULTS,
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
  /** Absent in files written before the router existed: the default port applies. */
  router?: { port?: number };
  /** webPort: the loopback port of a web brick's pages (D17), written by add. */
  bricks: Record<string, { source: string; enabled?: boolean; webPort?: number }>;
}

/** A brick is deployed unless platform.json says otherwise; absent means enabled. Only an own key is read. */
export function isBrickEnabled(platform: Platform, name: string): boolean {
  return !Object.hasOwn(platform.bricks, name) || platform.bricks[name].enabled !== false;
}

/**
 * The lock entry of an installed brick, only for an own key. A name such as "__proto__" (from the
 * command line or a library call) must never reach Object.prototype through a plain index access.
 */
function installedBrick(lock: Lock, name: string): LockedBrick | undefined {
  return Object.hasOwn(lock.bricks, name) ? lock.bricks[name] : undefined;
}

export interface VolumeRef {
  brick: string;
  service: string;
  name: string;
}

export type LockedRequirement = { wait: "healthy" | "started"; timeoutSeconds: number } & (
  { provider: string; optional?: undefined } | { optional: true; provider?: undefined }
);

export interface LockedBrick {
  version: string;
  source: string;
  /** Labels of the manifest, sorted; absent when the brick declares none. */
  tags?: string[];
  integrity: string;
  provides: string[];
  /** A requirement records its provider; an optional one (D19) records none, the plan resolves it. */
  requires: Record<string, LockedRequirement>;
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
  /** Only when at least one installed brick serves a subgraph. */
  federation?: FederationLock;
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
export function listBrickFiles(dir: string, brick: string): string[] {
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
  tags?: string[];
  services: { name: string; port: number; volumes?: { name: string; retention?: "retain" | "delete" }[] }[];
  provides?: Record<string, { provision: { command: string[]; scripts?: string } }>;
  requires?: Record<string, { wait?: "healthy" | "started"; timeoutSeconds?: number; optional?: boolean }>;
  subgraph?: { service: string; schema: string; path?: string };
  web?: { service: string; path?: string };
  extends?: { plugin: string; entities: string[] }[];
  dependencies?: { plugin: string; description?: string }[];
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
  // .platform/lock (D16) exists only while a command runs, and is never committed.
  writeFileAtomic(join(dir, ".platform/.gitignore"), "# Written by plugbricks: the lock exists only while a command runs.\n/lock\n");
  const platform: Platform = {
    $schema: PLATFORM_SCHEMA_ID,
    name: platformName,
    router: { port: PLATFORM_DEFAULTS.routerPort },
    bricks: {},
  };
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
  checkWebPorts(p);
  return { root: dir, platform: p, lock: l };
}

/** First port tried for a web brick's pages; the next free one is taken (D17). */
export const FIRST_WEB_PORT = 8080;

/**
 * The ports a platform publishes on the host, each with who uses it: router.port, then each webPort in
 * brick-name order. A port already taken is reported with WEB_PORT_CONFLICT (D17), naming its first user.
 */
function hostPorts(platform: Platform): { used: Map<number, string>; conflicts: Issue[] } {
  const used = new Map<number, string>([[platform.router?.port ?? PLATFORM_DEFAULTS.routerPort, "router.port"]]);
  const conflicts: Issue[] = [];
  for (const [brick, b] of Object.entries(platform.bricks).sort(([a], [c]) => a.localeCompare(c))) {
    if (b.webPort === undefined) continue;
    const other = used.get(b.webPort);
    if (other) {
      conflicts.push(issue("WEB_PORT_CONFLICT", `${PLATFORM_FILE}#/bricks/${brick}/webPort`, { port: String(b.webPort), brick, other }));
    } else {
      used.set(b.webPort, `the webPort of "${brick}"`);
    }
  }
  return { used, conflicts };
}

/** Every command refuses a webPort that the router or another web brick already uses (D17). */
function checkWebPorts(platform: Platform): void {
  const { conflicts } = hostPorts(platform);
  if (conflicts.length) throw new PlugbricksError(conflicts);
}

/** The first port from FIRST_WEB_PORT that the platform does not publish yet. */
function nextWebPort(platform: Platform): number {
  const { used } = hostPorts(platform);
  let port = FIRST_WEB_PORT;
  while (used.has(port)) port++;
  return port;
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
  for (const [list, entries] of [
    ["retainedVolumes", lock.retainedVolumes],
    ["pendingDeletion", lock.pendingDeletion],
  ] as const) {
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

/**
 * Called by a driver after it deleted volumes with --prune-volumes: removes exactly those
 * entries from pendingDeletion. An entry that is not pending (any more) is ignored.
 */
export function confirmPruned(root: string, deleted: VolumeRef[]): void {
  if (!deleted.length) return;
  const project = readProject(root);
  const gone = new Set(deleted.map(volumeKey));
  project.lock.pendingDeletion = project.lock.pendingDeletion.filter((v) => !gone.has(volumeKey(v)));
  save(project);
}

/** The federation section exists only while at least one subgraph is installed. */
function setFederation(lock: Lock, federation: FederationLock | undefined): void {
  if (federation) lock.federation = federation;
  else delete lock.federation;
}

function save(project: Project): void {
  project.lock.retainedVolumes.sort(byKey);
  project.lock.pendingDeletion.sort(byKey);
  // Lock first: if the second write fails, readProject reports LOCK_OUT_OF_SYNC instead of silently drifting.
  writeFileAtomic(join(project.root, LOCK_FILE), canonicalJson(project.lock));
  writeFileAtomic(join(project.root, PLATFORM_FILE), canonicalJson(project.platform));
}

// ---------- federation ----------

/** Where the router will reach a brick's subgraph: the runtime name of its service, its port, the manifest's path. */
function subgraphUrl(brick: string, m: Manifest): string {
  const service = m.services.find((s) => s.name === m.subgraph!.service);
  return `http://${brick}-${m.subgraph!.service}:${service?.port ?? 80}${m.subgraph!.path ?? "/graphql"}`;
}

/** The subgraph of a brick, or undefined when it has none. `dir` is where its files are, `file` how messages name them. */
function subgraphOf(brick: string, m: Manifest, dir: string, shown: (rel: string) => string): SubgraphInput | undefined {
  if (!m.subgraph) return undefined;
  return {
    brick,
    file: shown(m.subgraph.schema),
    sdl: readFileSync(join(dir, m.subgraph.schema), "utf8"),
    url: subgraphUrl(brick, m),
    extends: m.extends ?? [],
  };
}

/**
 * The subgraphs of the installed bricks (read from their copies in .platform/bricks), without
 * `leaving`, plus `joining`. A copy that cannot be read is listed in `unreadable` and left out,
 * like in the runtime name check: "status" says which brick it is.
 */
function installedSubgraphs(
  project: Project,
  leaving?: string,
  joining?: SubgraphInput,
  /** true for the checks that must also see disabled bricks (removal, disabling). */
  includeDisabled = false,
): { inputs: SubgraphInput[]; manifests: Map<string, Manifest>; unreadable: Issue[] } {
  const inputs: SubgraphInput[] = [];
  const manifests = new Map<string, Manifest>();
  const unreadable: Issue[] = [];
  for (const brick of Object.keys(project.lock.bricks).sort()) {
    if (brick === leaving) continue;
    if (!includeDisabled && !isBrickEnabled(project.platform, brick)) continue;
    const dir = join(project.root, BRICKS_DIR, brick);
    try {
      const m = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) as Manifest;
      const input = subgraphOf(brick, m, dir, (rel) => `${BRICKS_DIR}/${brick}/${rel}`);
      manifests.set(brick, m);
      if (input) inputs.push(input);
    } catch (e) {
      unreadable.push(issue("BRICK_UNREADABLE", "", { brick, detail: (e as Error).message }));
    }
  }
  if (joining) inputs.push(joining);
  return { inputs, manifests, unreadable };
}

/**
 * Composes the subgraphs the platform would have; throws the refusals, returns what the lock records.
 * An unreadable installed copy only matters when there is a federation to get right: a subgraph is
 * joining, or the lock already records one (the broken brick may be one of its subgraphs).
 */
function checkFederation(project: Project, leaving?: string, joining?: SubgraphInput): FederationLock | undefined {
  const { inputs, unreadable } = installedSubgraphs(project, leaving, joining);
  if (unreadable.length && (joining || project.lock.federation)) throw new PlugbricksError(unreadable);
  const result = composeSubgraphs(inputs);
  if (!result.ok) throw new PlugbricksError(result.issues);
  return result.federation;
}

// ---------- add ----------

/**
 * Builds the plan the platform would have with `name` added and keeps only its naming problems.
 * Installed copies that cannot be read are left out: "status" and "generate" report them.
 */
function checkRuntimeNames(project: Project, name: string, manifest: BrickManifest, entry: LockedBrick): void {
  const manifests = new Map<string, BrickManifest>();
  for (const b of Object.keys(project.lock.bricks)) {
    try {
      const raw = JSON.parse(readFileSync(join(project.root, BRICKS_DIR, b, "plugin.json"), "utf8"));
      if (validateManifest(raw).ok) manifests.set(b, raw as BrickManifest);
    } catch {
      // reported by status and generate
    }
  }
  manifests.set(name, manifest);
  // Leave out consumers whose provider could not be read: their requirements cannot be planned.
  // Repeated until stable: leaving out a provider can leave out one of its own consumers.
  for (let changed = true; changed;) {
    changed = false;
    for (const [b, m] of [...manifests]) {
      const requires = (b === name ? entry : project.lock.bricks[b]).requires;
      const unplannable = (cap: string) => {
        const r = requires[cap];
        return r?.optional ? false : !manifests.has(r?.provider ?? "");
      };
      if (Object.keys(m.requires ?? {}).some(unplannable)) {
        manifests.delete(b);
        changed = true;
      }
    }
  }
  if (!manifests.has(name)) return;
  // The plan must see the wiring the new brick adds: its capabilities resolve the optional requirements of
  // installed consumers (D19), and its webPort (or the one it will get) resolves ${web.origin} (D17, D18).
  // Without them buildPlan throws WEB_PORT_MISSING before the name checks, and the catch below swallows it.
  const capabilities = { ...project.lock.capabilities };
  for (const cap of Object.keys(manifest.provides ?? {})) capabilities[cap] = name;
  const webPorts: Record<string, number> = {};
  for (const [brick, b] of Object.entries(project.platform.bricks)) if (b.webPort !== undefined) webPorts[brick] = b.webPort;
  if (manifest.web) webPorts[name] = nextWebPort(project.platform);
  const lock: Lock = { ...project.lock, capabilities, bricks: { ...project.lock.bricks, [name]: entry } };
  try {
    buildPlan(project.platform.name, lock, manifests, () => [], undefined, undefined, webPorts);
  } catch (e) {
    if (!(e instanceof PlugbricksError)) throw e;
    const naming = e.issues.filter((i) => i.code === "RUNTIME_NAME_CONFLICT" || i.code === "RUNTIME_NAME_INVALID");
    if (naming.length) throw new PlugbricksError(naming);
  }
}

export interface AddResult {
  name: string;
  version: string;
  status: "added" | "unchanged";
  reattachedVolumes: VolumeRef[];
  /** Volumes of this brick that were pending deletion; adding the brick back cancels that. */
  cancelledDeletions: VolumeRef[];
  /** Declared dependencies (D21) that are not installed; "add" prints one warning line per name. */
  missingDependencies: string[];
}

/** Declared dependencies of `m` that no installed brick provides, sorted (the "add" warning, D21). */
function missingDeclaredDependencies(m: Manifest, lock: Lock): string[] {
  return [...new Set((m.dependencies ?? []).map((d) => d.plugin))].filter((dep) => !Object.hasOwn(lock.bricks, dep)).sort();
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
  if (!v.ok)
    fail(
      "MANIFEST_INVALID",
      { path: shown },
      v.issues.map((i) => ({ ...i, path: `${shown}#${i.path}` })),
    );
  const m = raw as Manifest;
  checkReferencedFiles(brickDir, m);
  const integrity = brickIntegrity(brickDir, m.name);

  const { lock, platform } = project;
  const missingDependencies = missingDeclaredDependencies(m, lock);
  const installed = lock.bricks[m.name];
  if (installed) {
    if (installed.integrity === integrity) {
      return {
        name: m.name,
        version: m.version,
        status: "unchanged",
        reattachedVolumes: [],
        cancelledDeletions: [],
        missingDependencies,
      };
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

  // An optional requirement (D19) needs no provider now: the plan wires it once there is one.
  const mandatory = Object.keys(m.requires ?? {}).filter((cap) => !m.requires![cap].optional);
  const missing = mandatory
    .filter((cap) => !lock.capabilities[cap])
    .map((cap) => issue("REQUIRED_CAPABILITY_MISSING", `/requires/${cap}`, { brick: m.name, capability: cap }));
  if (missing.length) throw new PlugbricksError(missing);

  // A disabled provider is still installed, but its capability is not deployed: refuse rather than
  // add a consumer that could never start. Enabling the provider is one command away.
  const disabledProviders = mandatory
    .filter((cap) => !isBrickEnabled(platform, lock.capabilities[cap]))
    .map((cap) => issue("PROVIDER_DISABLED", `/requires/${cap}`, { capability: cap, provider: lock.capabilities[cap] }));
  if (disabledProviders.length) throw new PlugbricksError(disabledProviders);

  const entry: LockedBrick = {
    version: m.version,
    source,
    ...(m.tags?.length ? { tags: [...m.tags].sort() } : {}),
    integrity,
    provides: Object.keys(m.provides ?? {}).sort(),
    requires: Object.fromEntries(
      Object.entries(m.requires ?? {}).map(([cap, r]): [string, LockedRequirement] => [
        cap,
        {
          ...(r.optional ? { optional: true as const } : { provider: lock.capabilities[cap] }),
          wait: r.wait ?? MANIFEST_DEFAULTS.wait,
          timeoutSeconds: r.timeoutSeconds ?? MANIFEST_DEFAULTS.timeoutSeconds,
        },
      ]),
    ),
    volumes: m.services.flatMap((s) =>
      (s.volumes ?? []).map((vol) => ({ service: s.name, name: vol.name, retention: vol.retention ?? MANIFEST_DEFAULTS.retention })),
    ),
  };
  // Runtime names (services, tasks, volumes, secrets) must stay unique with the installed bricks,
  // or "generate" could never succeed. Checked on the plan the platform would have after this add.
  checkRuntimeNames(project, m.name, raw as BrickManifest, entry);
  // The subgraphs must compose with the installed ones, and what `extends` promises must exist.
  const federation = checkFederation(
    project,
    undefined,
    subgraphOf(m.name, m, brickDir, (rel) => portableRelative(project.root, join(brickDir, rel)) || rel),
  );

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

  lock.bricks[m.name] = entry;
  for (const cap of Object.keys(m.provides ?? {})) lock.capabilities[cap] = m.name;
  const reattachedVolumes = lock.retainedVolumes.filter((r) => r.brick === m.name);
  lock.retainedVolumes = lock.retainedVolumes.filter((r) => r.brick !== m.name);
  const cancelledDeletions = lock.pendingDeletion.filter((r) => r.brick === m.name);
  lock.pendingDeletion = lock.pendingDeletion.filter((r) => r.brick !== m.name);
  platform.bricks[m.name] = { source, ...(m.web ? { webPort: nextWebPort(platform) } : {}) };
  setFederation(lock, federation);
  save(project);
  return { name: m.name, version: m.version, status: "added", reattachedVolumes, cancelledDeletions, missingDependencies };
}

// ---------- remove ----------

export interface RemoveResult {
  name: string;
  retainedVolumes: VolumeRef[];
  /** Added to lock.pendingDeletion. Nothing is deleted here; a driver deletes them only with --prune-volumes. */
  pendingDeletion: VolumeRef[];
}

/** Uninstalls a brick unless another brick still requires a capability it provides. */
/**
 * The installed bricks that list `name` in their manifest's `dependencies` (D21). `enabledOnly` keeps the ones that
 * are enabled: `disable` uses it (a disabled brick does not run), while `remove` keeps disabled dependers too (they
 * would break when enabled again). A copy that cannot be read is left out; "status" reports it.
 */
function declaredDependents(project: Project, name: string, enabledOnly = false): string[] {
  const found: string[] = [];
  for (const other of Object.keys(project.lock.bricks).sort()) {
    if (other === name) continue;
    if (enabledOnly && !isBrickEnabled(project.platform, other)) continue;
    try {
      const m = JSON.parse(readFileSync(join(project.root, BRICKS_DIR, other, "plugin.json"), "utf8")) as Manifest;
      if ((m.dependencies ?? []).some((d) => d.plugin === name)) found.push(`"${other}"`);
    } catch {
      // Unreadable or missing: reported by status, and it cannot be told what it declares.
    }
  }
  return found;
}

/**
 * Why `remove <name>` would be refused because of other installed bricks, before composition: the
 * capabilities they still require (CAPABILITY_IN_USE), else the entities they still extend
 * (EXTENDS_IN_USE), else the plugins they declare as dependencies (DEPENDENCY_IN_USE, D21). Empty when nothing
 * depends on it. The admin shows the same list before a removal.
 */
export function removeRefusals(project: Project, name: string): Issue[] {
  const brick = installedBrick(project.lock, name);
  if (!brick) return [];
  const inUse = brick.provides.flatMap((cap) => {
    const consumers = Object.entries(project.lock.bricks)
      .filter(([other, b]) => other !== name && b.requires[cap] && !b.requires[cap].optional)
      .map(([other]) => `"${other}"`)
      .sort();
    return consumers.length ? [issue("CAPABILITY_IN_USE", "", { brick: name, capability: cap, consumers: consumers.join(", ") })] : [];
  });
  if (inUse.length) return inUse;

  // Entities of this brick that an installed brick extends (disabled ones included: they would break
  // when re-enabled).
  const { manifests } = installedSubgraphs(project, name, undefined, true);
  const extenders = [...manifests]
    .filter(([, other]) => (other.extends ?? []).some((e) => e.plugin === name))
    .map(([other]) => `"${other}"`);
  if (extenders.length) return [issue("EXTENDS_IN_USE", "", { brick: name, consumers: extenders.join(", ") })];

  const dependents = declaredDependents(project, name);
  return dependents.length ? [issue("DEPENDENCY_IN_USE", "", { brick: name, consumers: dependents.join(", "), action: "remove" })] : [];
}

export function removeBrick(root: string, name: string): RemoveResult {
  const project = readProject(root);
  const { lock, platform } = project;
  const brick = installedBrick(lock, name);
  if (!brick) fail("BRICK_NOT_INSTALLED", { name });

  const refusals = removeRefusals(project, name);
  if (refusals.length) throw new PlugbricksError(refusals);
  // Then composition of what stays.
  const federation = checkFederation(project, name);

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
  setFederation(lock, federation);
  save(project);

  const copy = join(project.root, BRICKS_DIR, name);
  if (resolve(copy).startsWith(resolve(project.root, BRICKS_DIR) + sep)) rmSync(copy, { recursive: true, force: true });
  return { name, retainedVolumes, pendingDeletion };
}

// ---------- status ----------

export interface StatusResult {
  name: string;
  /** webPort: where a web brick's pages are published (D17), from platform.json. */
  bricks: (LockedBrick & { name: string; enabled: boolean; webPort?: number })[];
  capabilities: Record<string, string>;
  retainedVolumes: VolumeRef[];
  pendingDeletion: VolumeRef[];
  /** Present when at least one subgraph is installed. The composer version is informational. */
  federation?: { subgraphs: string[]; composer: string; lockedComposer?: string; schemaSha256: string };
  /** Present with the federation: how the router is published. */
  router?: { port: number; image: string };
  /** Empty when everything matches the lock. */
  problems: Issue[];
}

/**
 * Enables or disables an installed brick. A disabled brick stays installed (its volumes and secrets
 * are kept) but generate and up no longer render it; enabling renders it again. Refused when it would
 * break an enabled consumer: disabling a capability still required, or enabling a consumer whose
 * provider is disabled. The federated schema is recomposed either way.
 */
export function setBrickEnabled(root: string, name: string, enabled: boolean): { name: string; enabled: boolean } {
  const project = readProject(root);
  const { lock, platform } = project;
  const brick = installedBrick(lock, name);
  if (!brick) fail("BRICK_NOT_INSTALLED", { name });
  const entry = Object.hasOwn(platform.bricks, name) ? platform.bricks[name] : undefined;
  if (!entry) fail("BRICK_NOT_INSTALLED", { name });
  if (enabled === isBrickEnabled(platform, name)) return { name, enabled };

  if (!enabled) {
    const inUse = brick.provides.flatMap((cap) => {
      const consumers = Object.entries(lock.bricks)
        .filter(
          ([other, b]) => other !== name && isBrickEnabled(platform, other) && b.requires[cap] !== undefined && !b.requires[cap].optional,
        )
        .map(([other]) => `"${other}"`)
        .sort();
      return consumers.length ? [issue("CAPABILITY_IN_USE", "", { brick: name, capability: cap, consumers: consumers.join(", ") })] : [];
    });
    if (inUse.length) throw new PlugbricksError(inUse);
    // An enabled brick extending one of its entities would lose its owner.
    const { manifests } = installedSubgraphs(project, undefined, undefined, true);
    const extenders = [...manifests]
      .filter(([other, m]) => other !== name && isBrickEnabled(platform, other) && (m.extends ?? []).some((e) => e.plugin === name))
      .map(([other]) => `"${other}"`)
      .sort();
    if (extenders.length) throw new PlugbricksError([issue("EXTENDS_IN_USE", "", { brick: name, consumers: extenders.join(", ") })]);
    // A declared dependency (D21): only an enabled brick can run, so only it blocks a disable. remove keeps the
    // stricter rule (disabled dependers included).
    const dependents = declaredDependents(project, name, true);
    if (dependents.length)
      throw new PlugbricksError([issue("DEPENDENCY_IN_USE", "", { brick: name, consumers: dependents.join(", "), action: "disable" })]);
  } else {
    const blocked = Object.entries(brick.requires).flatMap(([cap, r]) =>
      r.optional || isBrickEnabled(platform, r.provider) ? [] : [issue("PROVIDER_DISABLED", "", { capability: cap, provider: r.provider })],
    );
    if (blocked.length) throw new PlugbricksError(blocked);
  }

  if (enabled) delete entry.enabled;
  else entry.enabled = false;
  setFederation(lock, checkFederation(project));
  save(project);
  return { name, enabled };
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
      const webPort = Object.hasOwn(platform.bricks, name) ? platform.bricks[name].webPort : undefined;
      return { name, enabled: isBrickEnabled(platform, name), ...lock.bricks[name], ...(webPort !== undefined ? { webPort } : {}) };
    });
  const federation = federationStatus({ root: dir, platform, lock }, problems);
  return {
    name: platform.name,
    bricks,
    capabilities: lock.capabilities,
    retainedVolumes: lock.retainedVolumes,
    pendingDeletion: lock.pendingDeletion,
    ...(federation ? { federation, router: { port: platform.router?.port ?? PLATFORM_DEFAULTS.routerPort, image: ROUTER_IMAGE } } : {}),
    problems,
  };
}

/**
 * Composes again and compares the schema hash with the lock. Only a different hash is a problem:
 * a different composer version that produces the same schema is reported, not refused. A broken
 * brick is already reported above, so composition is skipped when its copy cannot be read.
 */
function federationStatus(project: Project, problems: Issue[]): StatusResult["federation"] {
  const locked = project.lock.federation;
  const { inputs, unreadable } = installedSubgraphs(project);
  if (unreadable.length) return undefined;
  const result = composeSubgraphs(inputs);
  if (!result.ok) {
    problems.push(...result.issues);
    return undefined;
  }
  const actual = result.federation;
  if (actual?.schemaSha256 !== locked?.schemaSha256) {
    problems.push(issue("FEDERATION_CHANGED", "", { actual: actual?.schemaSha256 ?? "none", locked: locked?.schemaSha256 ?? "none" }));
  }
  if (!actual) return undefined;
  return {
    subgraphs: actual.subgraphs,
    composer: `${actual.composer.name} ${composerVersion()}`,
    ...(locked && locked.composer.version !== actual.composer.version
      ? { lockedComposer: `${locked.composer.name} ${locked.composer.version}` }
      : {}),
    schemaSha256: actual.schemaSha256,
  };
}
