import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { COMPOSE_ROUTER_CONFIG } from "../src/drivers/compose.js";
import { generate } from "../src/runtime.js";

// Cross-check of our router configuration against the official tool: `wgc router compose` (Cosmo CLI,
// pinned in tools/wgc-crosscheck, a standalone package that is never a dependency of plugbricks) is given the
// same subgraphs, and its router-config.json must equal ours once the fields that are expected to differ
// are set aside. The comparison is local: wgc router compose reads the schema files and writes the file, with its
// network accesses (update check, telemetry) switched off; it was run in a network namespace without any network. Skipped, with the reason in the title, where the pinned wgc is not installed.

const pkg = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const tool = join(repo, "tools/wgc-crosscheck");
const wgc = join(tool, "node_modules/.bin/wgc");
const pinned: string = JSON.parse(readFileSync(join(tool, "package.json"), "utf8")).devDependencies.wgc;
// wgc checks for a newer version on the network before every command unless DISABLE_UPDATE_CHECK is set, and
// reports telemetry unless COSMO_TELEMETRY_DISABLED or DO_NOT_TRACK is set: all three are set, so the run needs no network.
const env = { ...process.env, COSMO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", DISABLE_UPDATE_CHECK: "true" };

function skipReason(): string | undefined {
  if (process.platform === "win32") return "the cross-check runs on Linux only";
  if (!existsSync(wgc)) return `wgc ${pinned} is not installed: run "npm run crosscheck:install"`;
  const version = spawnSync(wgc, ["--version"], { encoding: "utf8", env });
  if (version.status !== 0 || version.stdout.trim() !== pinned)
    return `wgc ${pinned} is expected, found "${version.stdout.trim() || version.stderr.trim()}"`;
  return undefined;
}
const reason = skipReason();
const why = reason === undefined ? "" : ` (skipped: ${reason})`;

/**
 * Fields set aside before comparing, each with the reason. Nothing else is ignored.
 * - featureFlagConfigs: wgc always writes an empty object for its feature flags, which plugbricks does not use; we do not write the field.
 */
const IGNORED_IN_WGC: { path: string[]; reason: string; expected: unknown }[] = [
  { path: ["featureFlagConfigs"], reason: "wgc writes an empty feature-flag section; plugbricks has no feature flags", expected: {} },
];

/** Every path at which two JSON values differ, with both values (shortened). */
function differences(a: unknown, b: unknown, path = "$"): string[] {
  const show = (v: unknown) => (JSON.stringify(v) ?? "undefined").slice(0, 120);
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = a.length !== b.length ? [`${path}: ${a.length} items (ours) against ${b.length} (wgc)`] : [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) out.push(...differences(a[i], b[i], `${path}[${i}]`));
    return out;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => differences((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`));
  }
  return a === b ? [] : [`${path}: ours ${show(a)} / wgc ${show(b)}`];
}

describe("our router configuration against wgc router compose", () => {
  it.skipIf(reason !== undefined)(
    `is the same configuration for orders and shipping, but the fields listed as ignored${why}`,
    () => {
      const root = join(pkg, ".test-work/crosscheck");
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      cpSync(join(pkg, "examples"), join(root, "examples"), { recursive: true });
      const run = (args: string[]) => main(args, { cwd: root, stdout: () => {}, stderr: () => {} });
      for (const args of [
        ["init", "--name", "demo"],
        ["add", "examples/postgres"],
        ["add", "examples/orders-api"],
        ["add", "examples/shipping-api"],
      ]) {
        expect(run(args), args.join(" ")).toBe(0);
      }
      generate(root, "compose");
      const ours = JSON.parse(readFileSync(join(root, COMPOSE_ROUTER_CONFIG), "utf8"));

      // The same subgraphs for wgc: the installed copies of the schemas, the URLs our runtime names give them.
      const input = join(root, "wgc-input.yaml");
      writeFileSync(
        input,
        [
          "version: 1",
          "subgraphs:",
          ...["orders-api", "shipping-api"].flatMap((brick) => [
            `  - name: ${brick}`,
            `    routing_url: http://${brick}-app:4000/graphql`,
            "    schema:",
            `      file: ${join(root, ".platform/bricks", brick, "schema.graphql")}`,
          ]),
          "",
        ].join("\n"),
      );
      const output = join(root, "wgc-router-config.json");
      const composed = spawnSync(wgc, ["router", "compose", "--input", input, "--out", output], { encoding: "utf8", env });
      expect(composed.status, `${composed.stdout}\n${composed.stderr}`).toBe(0);
      const theirs = JSON.parse(readFileSync(output, "utf8"));

      for (const ignored of IGNORED_IN_WGC) {
        // The ignored field must be exactly what the reason says, so that something real never hides behind it.
        expect(theirs[ignored.path[0]], ignored.reason).toEqual(ignored.expected);
        delete theirs[ignored.path[0]];
      }
      const found = differences(ours, theirs);
      console.log(
        `cross-check: ours ${JSON.stringify(ours).length} bytes, wgc ${composed.stdout.includes("successfully") ? "composed" : "answered"}; ignored in wgc: ${IGNORED_IN_WGC.map((i) => i.path.join(".")).join(", ")}; differences: ${found.length === 0 ? "none" : `\n${found.join("\n")}`}`,
      );
      expect(found, `fields that differ between our router-config.json and wgc router compose:\n${found.join("\n")}`).toEqual([]);
    },
    120_000,
  );
});
