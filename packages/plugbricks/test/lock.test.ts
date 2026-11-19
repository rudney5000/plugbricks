import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { PLATFORM_LOCK_FILE, processIsAlive, readLockHolder, withPlatformLock } from "../src/lock.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const root = join(pkg, ".test-work/lock");
const lockFile = join(root, PLATFORM_LOCK_FILE);
const children: ChildProcess[] = [];

function cli(args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const holderOf = (pid: number, command = "up") => JSON.stringify({ pid, command, since: "2026-11-19T12:00:00.000Z" });

/** Another process that holds the lock, the way a running `plugbricks up` would: it writes its own pid, then waits. */
async function holdingProcess(): Promise<ChildProcess> {
  const script = `require("node:fs").writeFileSync(${JSON.stringify(lockFile)}, JSON.stringify({ pid: process.pid, command: "up", since: new Date().toISOString() })); console.log("held"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  await new Promise<void>((ok) => child.stdout!.once("data", () => ok()));
  return child;
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "examples/postgres"), join(root, "postgres"), { recursive: true });
  expect(cli(["init", "--name", "demo"]).code).toBe(0);
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
});

describe("the platform lock (one changing command at a time)", () => {
  it("holds the lock while the command runs, with its pid and command, and removes it after", () => {
    let seen: unknown;
    const r = withPlatformLock(root, "enable orders", () => {
      seen = readLockHolder(root);
      return 7;
    });
    expect(r).toBe(7);
    expect(seen).toMatchObject({ pid: process.pid, command: "enable orders" });
    expect(existsSync(lockFile)).toBe(false);
    // init wrote .platform/.gitignore: the lock is never committed.
    expect(readFileSync(join(root, ".platform/.gitignore"), "utf8")).toContain("/lock");
  });

  it("removes the lock when the command fails", () => {
    expect(() =>
      withPlatformLock(root, "up", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockFile)).toBe(false);
  });

  it("refuses with PLATFORM_BUSY while a living process holds it, and leaves that lock alone", () => {
    writeFileSync(lockFile, holderOf(4242));
    let ran = false;
    expect(() => withPlatformLock(root, "down", () => (ran = true), { isAlive: () => true })).toThrow(
      expect.objectContaining({
        issues: [expect.objectContaining({ code: "PLATFORM_BUSY", params: expect.objectContaining({ pid: "4242", command: "up" }) })],
      }),
    );
    expect(ran).toBe(false);
    expect(readFileSync(lockFile, "utf8")).toBe(holderOf(4242));
  });

  it("takes over the lock of a process that no longer exists", () => {
    writeFileSync(lockFile, holderOf(4242));
    expect(withPlatformLock(root, "up", () => readLockHolder(root)?.pid, { isAlive: () => false })).toBe(process.pid);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("gives an empty lock file (still being written) a second look, then takes it over", () => {
    writeFileSync(lockFile, "");
    const started = Date.now();
    expect(withPlatformLock(root, "up", () => "ran")).toBe("ran");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it("does not remove a lock another process took over meanwhile", () => {
    withPlatformLock(root, "up", () => writeFileSync(lockFile, holderOf(4242)));
    expect(readLockHolder(root)?.pid).toBe(4242);
  });

  it("does not lock a folder without platform.json: the command reports it", () => {
    const empty = join(root, "nothing-here");
    mkdirSync(empty);
    expect(withPlatformLock(empty, "up", () => "ran")).toBe("ran");
    expect(existsSync(join(empty, PLATFORM_LOCK_FILE))).toBe(false);
  });

  it("knows a living process from a dead one", async () => {
    expect(processIsAlive(process.pid)).toBe(true);
    const child = await holdingProcess();
    expect(processIsAlive(child.pid!)).toBe(true);
    child.kill("SIGKILL");
    await new Promise((ok) => child.once("exit", ok));
    expect(processIsAlive(child.pid!)).toBe(false);
  });
});

describe("the CLI with the lock", () => {
  it("refuses every changing command while another process holds the lock, then runs once it is gone", async () => {
    const child = await holdingProcess();
    for (const args of [
      ["add", "postgres"],
      ["enable", "postgres"],
      ["disable", "postgres"],
      ["remove", "postgres"],
      ["generate"],
      ["up"],
      ["down"],
    ]) {
      const r = cli(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toContain("PLATFORM_BUSY");
      expect(r.err).toContain(`process ${child.pid}`);
    }
    // Reading is never locked.
    expect(cli(["status"]).code).toBe(0);
    expect(cli(["status", "--json"]).code).toBe(0);

    child.kill("SIGKILL");
    await new Promise((ok) => child.once("exit", ok));
    // The holder died without removing its lock: the next command takes it over.
    expect(existsSync(lockFile)).toBe(true);
    const r = cli(["add", "postgres"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("names the command and its arguments in the lock", () => {
    writeFileSync(lockFile, holderOf(process.pid, "remove orders"));
    const r = cli(["up"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"remove orders"');
  });
});
