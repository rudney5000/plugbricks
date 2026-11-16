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
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
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
  };
  exit?: number;
  codes?: string[];
  stdout?: string;
  unchanged?: boolean;
}
interface Scenario {
  description: string;
  steps: Step[];
  exists?: string[];
  absent?: string[];
  /** Volumes ("brick/service/name") a driver could delete with --prune-volumes, after the last step. */
  expectPrune?: string[];
}

const pkg = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(pkg, "test/fixtures/cli");
const workRoot = join(pkg, ".test-work/cli");
const update = process.env.PLUGBRICKS_UPDATE_GOLDEN === "1";
const GOLDEN = ["platform.json", "platform.lock"];

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
  if (m.symlink) {
    mkdirSync(dirname(join(work, m.symlink.path)), { recursive: true });
    symlinkSync(m.symlink.target, join(work, m.symlink.path));
  }
}

const scenarios = readdirSync(fixtures).sort();

describe("plugbricks CLI scenarios", () => {
  it.each(scenarios)("%s", (name) => {
    const dir = join(fixtures, name);
    const sc: Scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
    const work = join(workRoot, name);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    cpSync(join(pkg, "examples"), join(work, "examples"), { recursive: true });
    if (existsSync(join(dir, "bricks"))) cpSync(join(dir, "bricks"), join(work, "bricks"), { recursive: true });

    sc.steps.forEach((step, n) => {
      const label = `${name} step ${n + 1}`;
      if (step.mutate) return mutate(work, step.mutate);
      const before = step.unchanged ? snapshot(work) : undefined;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = main(step.run!, { cwd: work, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
      const detail = `${label}: plugbricks ${step.run!.join(" ")}\nstdout: ${stdout.join("\n")}\nstderr: ${stderr.join("\n")}`;
      expect(code, detail).toBe(step.exit ?? 0);
      const codes = stderr.map((l) => /^error (\w+)/.exec(l)?.[1]).filter(Boolean);
      expect(codes, detail).toEqual(step.codes ?? []);
      if (step.stdout) expect(stdout.join("\n"), detail).toContain(step.stdout);
      if (before) expect(snapshot(work), `${label} must not change any file`).toEqual(before);
    });

    for (const p of sc.exists ?? []) expect(existsSync(join(work, p)), `${p} should exist`).toBe(true);
    for (const p of sc.absent ?? []) expect(existsSync(join(work, p)), `${p} should not exist`).toBe(false);
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
      for (const f of GOLDEN) cpSync(join(work, f), join(expectedDir, f));
    }
    if (existsSync(expectedDir)) {
      for (const f of readdirSync(expectedDir)) {
        expect(readFileSync(join(work, f), "utf8"), `${name}: ${f} differs from expected/${f}`).toBe(
          readFileSync(join(expectedDir, f), "utf8"),
        );
      }
    }
  });
});
