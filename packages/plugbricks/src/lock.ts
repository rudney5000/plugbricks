import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { issue } from "./issues.js";
import { PLATFORM_FILE, PlugbricksError } from "./platform.js";

/**
 * One command at a time changes a platform (D16): add, remove, enable, disable, generate, up and down
 * take this lock, whether they come from a terminal or from the admin. Created with O_EXCL, so two
 * processes cannot both get it; it holds the pid, the command and the time, and is removed when the
 * command ends. A lock whose process no longer exists (killed, crashed) is taken over.
 */
export const PLATFORM_LOCK_FILE = ".platform/lock";

/** How long an empty lock file (its holder still writing it) is given before it counts as stale. */
const EMPTY_LOCK_WAIT_MS = 100;

export interface LockHolder {
  pid: number;
  command: string;
  since: string;
}

export interface LockOptions {
  /** Whether a process exists; tests replace it. */
  isAlive?: (pid: number) => boolean;
  pid?: number;
  now?: () => Date;
}

/** process.kill(pid, 0) sends nothing: it only checks the process exists (EPERM: it exists, under another user). */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The holder written in the lock file, or undefined when it is missing, empty or not ours to read. */
export function readLockHolder(root: string): LockHolder | undefined {
  try {
    const h = JSON.parse(readFileSync(join(root, PLATFORM_LOCK_FILE), "utf8")) as Partial<LockHolder>;
    return Number.isInteger(h.pid) && typeof h.command === "string" && typeof h.since === "string" ? (h as LockHolder) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` holding the platform lock. A folder without platform.json is not locked: `fn` then reports
 * PLATFORM_NOT_INITIALIZED itself. Refuses with PLATFORM_BUSY while another living process holds it.
 */
export function withPlatformLock<T>(root: string, command: string, fn: () => T, opts: LockOptions = {}): T {
  if (!existsSync(join(root, PLATFORM_FILE))) return fn();
  const file = join(root, PLATFORM_LOCK_FILE);
  const pid = opts.pid ?? process.pid;
  const holder: LockHolder = { pid, command, since: (opts.now?.() ?? new Date()).toISOString() };
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o644);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const current = readLockHolder(root);
      // A lock being written right now has no content yet: look again shortly before calling it stale.
      if (!current && attempt === 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EMPTY_LOCK_WAIT_MS);
        continue;
      }
      const stale = current ? !(opts.isAlive ?? processIsAlive)(current.pid) : true;
      if (stale && attempt < 3) {
        rmSync(file, { force: true });
        continue;
      }
      throw new PlugbricksError([
        issue("PLATFORM_BUSY", "", {
          command: current?.command ?? "unknown",
          pid: String(current?.pid ?? "unknown"),
          since: current?.since ?? "unknown",
          file: PLATFORM_LOCK_FILE,
        }),
      ]);
    }
    try {
      writeSync(fd, JSON.stringify(holder) + "\n");
    } finally {
      closeSync(fd);
    }
    break;
  }
  try {
    return fn();
  } finally {
    // Only our own lock: never one another process took over after a stale-lock check.
    if (readLockHolder(root)?.pid === pid) rmSync(file, { force: true });
  }
}
