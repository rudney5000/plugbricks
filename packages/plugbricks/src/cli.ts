import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { issue, type Issue } from "./issues.js";
import { addBrick, initPlatform, PlugbricksError, platformStatus, removeBrick, type VolumeRef } from "./platform.js";

export interface Io {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `Usage: plugbricks <command> [options]

Commands:
  init [--name <name>]   Create platform.json, platform.lock and .platform/bricks/ here
  add <path>             Install the brick at <path> (a directory with a plugin.json)
  remove <name>          Uninstall a brick
  status [--json]        Show installed bricks, capabilities and retained volumes

Options:
  --dir <path>           Run in <path> instead of the current directory
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 success, 1 refused or inconsistent, 2 usage error.`;

const vol = (v: VolumeRef) => `${v.brick}/${v.service}/${v.name}`;

function printIssues(io: Io, issues: Issue[]): void {
  for (const i of issues) io.stderr(`error ${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`);
}

class UsageError extends Error {
  constructor(readonly issueValue: Issue) {
    super(issueValue.message);
  }
}
const usage = (...args: Parameters<typeof issue>) => new UsageError(issue(...args));

function version(): string {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

/** Runs one CLI invocation and returns the exit code. Never calls process.exit, so tests can run it in-process. */
export function main(argv: string[], io: Io): number {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: {
          dir: { type: "string" },
          name: { type: "string" },
          json: { type: "boolean" },
          help: { type: "boolean", short: "h" },
          version: { type: "boolean", short: "v" },
        },
      });
    } catch (e) {
      throw usage("USAGE_INVALID_OPTION", "", { detail: (e as Error).message });
    }
    const { values, positionals } = parsed;
    if (values.version) {
      io.stdout(version());
      return 0;
    }
    const [command, ...args] = positionals;
    if (values.help || !command) {
      io.stdout(HELP);
      return values.help ? 0 : 2;
    }
    const root = resolve(io.cwd, values.dir ?? ".");
    const only = (n: number, argument: string) => {
      if (args.length < n) throw usage("USAGE_MISSING_ARGUMENT", "", { command, argument });
      if (args.length > n) throw usage("USAGE_UNEXPECTED_ARGUMENT", "", { command, argument: args[n] });
    };
    const optionFor = (opt: string, allowed: string) => {
      if (command !== allowed) throw usage("USAGE_INVALID_OPTION", "", { detail: `--${opt} only applies to "plugbricks ${allowed}"` });
    };
    if (values.name !== undefined) optionFor("name", "init");
    if (values.json !== undefined) optionFor("json", "status");

    switch (command) {
      case "init": {
        only(0, "");
        const r = initPlatform(root, values.name);
        io.stdout(`Initialised platform "${r.name}": ${r.created.join(", ")}`);
        return 0;
      }
      case "add": {
        only(1, "a brick path");
        // A relative path is relative to where the user typed the command, not to --dir.
        const r = addBrick(root, resolve(io.cwd, args[0]));
        if (r.status === "unchanged") io.stdout(`${r.name} ${r.version} is already installed; nothing changed`);
        else io.stdout(`Added ${r.name} ${r.version}`);
        for (const v of r.reattachedVolumes) io.stdout(`  re-attached retained volume ${vol(v)}`);
        return 0;
      }
      case "remove": {
        only(1, "a brick name");
        const r = removeBrick(root, args[0]);
        io.stdout(`Removed ${r.name}`);
        for (const v of r.retainedVolumes) io.stdout(`  volume ${vol(v)} kept (retention: retain)`);
        for (const v of r.volumesToDelete) io.stdout(`  volume ${vol(v)} will be deleted at the next "up" (retention: delete)`);
        return 0;
      }
      case "status": {
        only(0, "");
        const s = platformStatus(root);
        if (values.json) {
          io.stdout(JSON.stringify(s, null, 2));
        } else {
          io.stdout(`Platform ${s.name}: ${s.bricks.length} brick(s)`);
          for (const b of s.bricks) {
            const parts = [
              ...(b.provides.length ? [`provides ${b.provides.join(", ")}`] : []),
              ...Object.entries(b.requires).map(([cap, r]) => `requires ${cap} from ${r.provider} (wait ${r.wait}, ${r.timeoutSeconds}s)`),
            ];
            io.stdout(`  ${b.name} ${b.version}${parts.length ? `  ${parts.join("; ")}` : ""}`);
          }
          io.stdout(`Retained volumes: ${s.retainedVolumes.length ? s.retainedVolumes.map(vol).join(", ") : "none"}`);
        }
        printIssues(io, s.problems);
        return s.problems.length ? 1 : 0;
      }
      default:
        throw usage("USAGE_UNKNOWN_COMMAND", "", { command });
    }
  } catch (e) {
    if (e instanceof UsageError) {
      printIssues(io, [e.issueValue]);
      return 2;
    }
    if (e instanceof PlugbricksError) {
      printIssues(io, e.issues);
      return 1;
    }
    throw e;
  }
}
