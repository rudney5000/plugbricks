import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { Exec } from "../src/runtime.js";
import { volumesToPrune, type Lock } from "../src/platform.js";
import { lockSchema, platformSchema, schemaIssues } from "../src/schemas.js";

// One folder per scenario in test/fixtures/cli/<name>/:
//   scenario.json  steps to run, with the expected exit code, error codes and output
//   bricks/        bricks used only by this scenario (optional)
//   expected/      golden platform.json / platform.lock after the last step (optional)
// The scenario runs in .test-work/cli/<name>/ (inside the package, gitignored), with the
// package examples copied to examples/. Set PLUGBRICKS_UPDATE_GOLDEN=1 to rewrite expected/.

interface Step {
  run?: string[];
  mutate?: {
    append?: { file: string; text: string };
    writeJson?: { file: string; json: unknown };
    /** Shallow merge of top-level keys into an existing JSON file (a hand edit). */
    patchJson?: { file: string; set: Record<string, unknown> };
    symlink?: { path: string; target: string };
    /** Copies a folder of the work dir (e.g. examples/postgres) to a path that cannot live in git on every OS. */
    copyDir?: { from: string; to: string };
    writeText?: { file: string; text: string };
    /** POSIX mode, as an octal string ("755"). Scenarios using it declare "needs": ["posix-permissions"]. */
    chmod?: { path: string; mode: string };
  };
  /**
   * Commands the step must run through the runtime executor (docker, kubectl), each as one
   * space-joined line, in order. The fake executor succeeds unless a "fake" entry matches.
   */
  commands?: string[];
  /** Results returned by the fake executor for commands containing `match` (first match wins). */
  fake?: { match: string; status?: number; stdout?: string; stderr?: string; error?: string }[];
  exit?: number;
  codes?: string[];
  stdout?: string;
  /** Substring expected in the error output. */
  stderr?: string;
  unchanged?: boolean;
}
interface Scenario {
  description: string;
  steps: Step[];
  exists?: string[];
  absent?: string[];
  /** Volumes ("brick/service/name") a driver could delete with --prune-volumes, after the last step. */
  expectPrune?: string[];
  /** OS features the scenario needs; it is skipped, with the reason in its title, where they are missing. */
  needs?: ("symlinks" | "posix-file-names" | "posix-permissions")[];
  /** Substrings expected in the raw text of a file after the last step (e.g. a JSON escape). */
  expectRaw?: Record<string, string>;
}

const pkg = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(pkg, "test/fixtures/cli");
const workRoot = join(pkg, ".test-work/cli");
const update = process.env.PLUGBRICKS_UPDATE_GOLDEN === "1";
const GOLDEN = ["platform.json", "platform.lock"];

/** Every file under dir (recursively), as posix paths relative to it. */
function filesUnder(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesUnder(dir, r) : [r];
  });
}

/** Secrets the scenarios get: deterministic, so a failing run can be reproduced. */
function counterSecrets(): () => string {
  let n = 0;
  return () => `secret${String(++n).padStart(4, "0")}`;
}

/** path -> content hash (or link target) of every entry under dir, to prove a step changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel)).sort()) {
      const r = rel ? `${rel}/${e}` : e;
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) out[r] = `link:${readlinkSync(join(dir, r))}`;
      else if (st.isDirectory()) {
        out[`${r}/`] = "dir";
        walk(r);
      } else out[r] = createHash("sha256").update(readFileSync(join(dir, r))).digest("hex");
    }
  };
  walk("");
  return out;
}

function mutate(work: string, m: NonNullable<Step["mutate"]>): void {
  if (m.append) appendFileSync(join(work, m.append.file), m.append.text);
  if (m.writeJson) writeFileSync(join(work, m.writeJson.file), JSON.stringify(m.writeJson.json, null, 2) + "\n");
  if (m.patchJson) {
    const file = join(work, m.patchJson.file);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...m.patchJson.set }, null, 2) + "\n");
  }
  if (m.copyDir) cpSync(join(work, m.copyDir.from), join(work, m.copyDir.to), { recursive: true });
  if (m.writeText) {
    mkdirSync(dirname(join(work, m.writeText.file)), { recursive: true });
    writeFileSync(join(work, m.writeText.file), m.writeText.text);
  }
  if (m.chmod) chmodSync(join(work, m.chmod.path), parseInt(m.chmod.mode, 8));
  if (m.symlink) {
    mkdirSync(dirname(join(work, m.symlink.path)), { recursive: true });
    symlinkSync(m.symlink.target, join(work, m.symlink.path));
  }
}

/**
 * Creating a symlink needs Developer Mode or admin rights on Windows. Probe once instead of
 * guessing from the OS, and say why a scenario is skipped instead of letting it fail.
 */
function symlinkSupport(): { ok: true } | { ok: false; reason: string } {
  const probe = join(workRoot, ".symlink-probe");
  mkdirSync(workRoot, { recursive: true });
  rmSync(probe, { force: true });
  try {
    symlinkSync("target-that-does-not-exist", probe);
    rmSync(probe, { force: true });
    return { ok: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: `this OS refuses to create symbolic links (${code}); on Windows enable Developer Mode or run as administrator`,
    };
  }
}
const support: Record<NonNullable<Scenario["needs"]>[number], { ok: true } | { ok: false; reason: string }> = {
  symlinks: symlinkSupport(),
  "posix-file-names":
    process.platform === "win32"
      ? { ok: false, reason: 'Windows forbids \\ and " in file names' }
      : { ok: true },
  "posix-permissions":
    process.platform === "win32" ? { ok: false, reason: "Windows has no POSIX modes; its ACL check is tested with a fake PowerShell" } : { ok: true },
};

const scenarios = readdirSync(fixtures).sort();
const missing = (name: string): string[] => {
  const needs: NonNullable<Scenario["needs"]> = JSON.parse(readFileSync(join(fixtures, name, "scenario.json"), "utf8")).needs ?? [];
  return needs.flatMap((n) => {
    const s = support[n];
    return s.ok ? [] : [s.reason];
  });
};
const runnable = scenarios.filter((n) => missing(n).length === 0);
const skipped = scenarios.filter((n) => missing(n).length > 0);

/** Every value of a "source" key, at any depth: the paths platform.json and platform.lock store. */
function pathFields(value: unknown, at = ""): [string, string][] {
  if (Array.isArray(value)) return value.flatMap((v, i) => pathFields(v, `${at}/${i}`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      k === "source" && typeof v === "string" ? [[`${at}/${k}`, v] as [string, string]] : pathFields(v, `${at}/${k}`),
    );
  }
  return [];
}

describe("plugbricks CLI scenarios", () => {
  for (const name of skipped) it.skip(`${name} (skipped: ${missing(name).join("; ")})`, () => {});

  it.each(runnable)("%s", (name) => {
    const dir = join(fixtures, name);
    const sc: Scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
    const work = join(workRoot, name);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    cpSync(join(pkg, "examples"), join(work, "examples"), { recursive: true });
    if (existsSync(join(dir, "bricks"))) cpSync(join(dir, "bricks"), join(work, "bricks"), { recursive: true });

    const random = counterSecrets();
    sc.steps.forEach((step, n) => {
      const label = `${name} step ${n + 1}`;
      if (step.mutate) return mutate(work, step.mutate);
      const before = step.unchanged ? snapshot(work) : undefined;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const ran: string[] = [];
      const exec: Exec = (cmd, args) => {
        const line = [cmd, ...args].join(" ");
        ran.push(line);
        const f = step.fake?.find((x) => line.includes(x.match));
        return { status: f?.status ?? 0, stdout: f?.stdout ?? "", stderr: f?.stderr ?? "", ...(f?.error ? { error: f.error } : {}) };
      };
      const code = main(step.run!, {
        cwd: work,
        stdout: (l) => stdout.push(l),
        stderr: (l) => stderr.push(l),
        runtime: { exec, random },
      });
      const detail = `${label}: plugbricks ${step.run!.join(" ")}\nstdout: ${stdout.join("\n")}\nstderr: ${stderr.join("\n")}\nran: ${ran.join("\n")}`;
      expect(code, detail).toBe(step.exit ?? 0);
      const codes = stderr.map((l) => /^error (\w+)/.exec(l)?.[1]).filter(Boolean);
      expect(codes, detail).toEqual(step.codes ?? []);
      if (step.stdout) expect(stdout.join("\n"), detail).toContain(step.stdout);
      if (step.stderr) expect(stderr.join("\n"), detail).toContain(step.stderr);
      if (step.commands) expect(ran, detail).toEqual(step.commands);
      if (before) expect(snapshot(work), `${label} must not change any file`).toEqual(before);
    });

    for (const p of sc.exists ?? []) expect(existsSync(join(work, p)), `${p} should exist`).toBe(true);
    for (const p of sc.absent ?? []) expect(existsSync(join(work, p)), `${p} should not exist`).toBe(false);

    // Paths are stored with "/" on every OS. Only path fields are checked: JSON itself writes
    // backslashes to escape quotes or newlines in other values.
    for (const f of GOLDEN) {
      if (!existsSync(join(work, f))) continue;
      for (const [at, p] of pathFields(JSON.parse(readFileSync(join(work, f), "utf8")))) {
        expect(p.includes("\\"), `${name}: ${f}#${at} contains a backslash: ${p}`).toBe(false);
      }
    }
    for (const [f, text] of Object.entries(sc.expectRaw ?? {})) {
      expect(readFileSync(join(work, f), "utf8"), `${name}: raw ${f}`).toContain(text);
    }
    if (sc.expectPrune) {
      const lock: Lock = JSON.parse(readFileSync(join(work, "platform.lock"), "utf8"));
      expect(volumesToPrune(lock).map((v) => `${v.brick}/${v.service}/${v.name}`), `${name}: volumes a driver may prune`).toEqual(
        sc.expectPrune,
      );
    }

    // Whatever the scenario did, the files it left must match their schemas.
    if (existsSync(join(work, "platform.lock")) && !sc.steps.some((s) => s.mutate?.writeJson || s.mutate?.patchJson)) {
      expect(schemaIssues(platformSchema.validate, JSON.parse(readFileSync(join(work, "platform.json"), "utf8")))).toEqual([]);
      expect(schemaIssues(lockSchema.validate, JSON.parse(readFileSync(join(work, "platform.lock"), "utf8")))).toEqual([]);
    }

    const expectedDir = join(dir, "expected");
    if (update && existsSync(expectedDir)) {
      for (const f of filesUnder(expectedDir)) cpSync(join(work, f), join(expectedDir, f));
    }
    if (existsSync(expectedDir)) {
      for (const f of filesUnder(expectedDir)) {
        expect(readFileSync(join(work, f), "utf8"), `${name}: ${f} differs from expected/${f}`).toBe(
          readFileSync(join(expectedDir, f), "utf8"),
        );
      }
    }
  });
});

// A file-system error in one installed brick (here EACCES) must not stop `status`: it is reported
// for that brick, and the next brick is still checked. Not a fixture scenario: the unreadable
// folder must be made readable again afterwards, or the next run could not clean the work dir.
const canDenyRead = process.platform !== "win32" && process.getuid?.() !== 0;
describe("status survives an unreadable brick", () => {
  it.skipIf(!canDenyRead)(
    `reports BRICK_UNREADABLE for that brick and still checks the others${canDenyRead ? "" : " (skipped: needs POSIX permissions and a non-root user)"}`,
    () => {
      const work = join(workRoot, "_status-unreadable");
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      cpSync(join(pkg, "examples"), join(work, "examples"), { recursive: true });
      cpSync(join(fixtures, "remove-deletes-volume/bricks"), join(work, "bricks"), { recursive: true });
      const out: string[] = [];
      const io = { cwd: work, stdout: () => {}, stderr: (l: string) => out.push(l) };
      expect(main(["init", "--name", "demo"], io)).toBe(0);
      expect(main(["add", "examples/postgres"], io)).toBe(0);
      expect(main(["add", "bricks/cache"], io)).toBe(0);
      appendFileSync(join(work, ".platform/bricks/postgres/plugin.json"), "\n");
      const locked = join(work, ".platform/bricks/cache");
      mkdirSync(join(locked, "private"));
      chmodSync(join(locked, "private"), 0o000);
      try {
        expect(main(["status"], io)).toBe(1);
      } finally {
        chmodSync(join(locked, "private"), 0o755);
      }
      expect(out.map((l) => /^error (\w+)/.exec(l)?.[1])).toEqual(["BRICK_UNREADABLE", "BRICK_MODIFIED"]);
      expect(out[0]).toMatch(/^error BRICK_UNREADABLE: the installed copy of "cache" cannot be read: EACCES/);
    },
  );
});
