import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { issue, type Issue } from "./issues.js";
import {
  addBrick,
  brickByName,
  isBrickName,
  initPlatform,
  PlugbricksError,
  platformStatus,
  readProject,
  removeBrick,
  setBrickEnabled,
  type StatusResult,
  type VolumeRef,
} from "./platform.js";
import { liveStatusText } from "./live.js";
import { startAdmin } from "./admin/server.js";
import { platformOidcIssuer } from "./plan.js";
import { withPlatformLock } from "./lock.js";
import { needsOf, type Choice } from "./needs.js";
import { BRICK_KINDS, createBrick, type BrickKind } from "./create.js";
import { doctor } from "./doctor.js";
import { execIn, logs } from "./attach.js";
import {
  down,
  generate,
  RuntimeUnavailableError,
  RUNTIMES,
  STATUS_DEGRADED_EXIT,
  STATUS_UNAVAILABLE_EXIT,
  statusRuntime,
  up,
  type Runtime,
  type RuntimeDeps,
} from "./runtime.js";

export interface Io {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** How generate/up/down run tools and create secrets; tests inject fakes. */
  runtime?: Omit<RuntimeDeps, "log">;
  /**
   * Asks the person a question and returns the line they typed, or undefined when there is none (end of input).
   * Given only when someone can answer: a terminal on both ends (bin.ts). Without it, nothing waits for an answer.
   */
  ask?: (question: string) => string | undefined;
}

const HELP = `Usage: plugbricks <command> [options]

Commands:
  init [--name <name>]   Create platform.json, platform.lock and .platform/bricks/ here
  add <name>             Install the brick bricks/<name> of this project (or the folder <name> here)
  add <path>             Install the brick at <path> (a directory with a plugin.json)
                         Either way, what it needs from bricks/ is proposed first (--yes: add it without asking)
  create <name> --kind api|web [--image <ref>]
                         Write a new brick <name>-api or <name>-web in bricks/ and its code in services/, and add it
  remove <name>          Uninstall a brick
  enable <name>          Deploy an installed brick again (it was disabled)
  disable <name>         Stop deploying an installed brick; its volumes and secrets are kept
  status [--json]        Show installed bricks, capabilities and retained volumes
  logs <brick> [--service <name>] [--follow] [--tail <n>]
                         Show the logs of a brick's service (or of the router: logs router)
  exec <brick> [--service <name>] [-- <command>...]
                         Run a command inside a brick's service, a shell (sh) when none is given
  doctor                 Check what up needs (Node, Docker or kubectl, ports, images) and say what to fix; read-only
  status --runtime <name> [--json]
                         Also read what the runtime really runs (read-only): state, reason, restarts
  generate               Write the runtime files to .generated/<runtime>/ and create missing secrets
  up [--prune-volumes]   Generate, then start or update the platform
  down                   Stop the platform; volumes and secrets are kept
  admin [--port <port>] [--dev]
                         Serve the read-only admin on 127.0.0.1 (default 4100); OIDC unless --dev

Options:
  --runtime <name>       compose (Docker Compose, default) or k8s (Kubernetes)
  --context <name>       With --runtime k8s (up, down, status, doctor): the kubectl context to use (required;
                         the current context is never used)
  --kubeconfig <file>    With --context: the kubeconfig file that defines it (default: kubectl's own)
  --allow-context <name> Lets --context name a protected cluster ("platform", "k3d-platform")
  --prune-volumes        With up: delete the volumes listed in pendingDeletion of platform.lock
  -y, --yes              With add: also add what the brick needs from bricks/, without asking
  --kind api|web         With create: a GraphQL subgraph or a web brick
  --image <ref>          With create: the image its manifest names (default <platform>/<name>:0.1.0), pinned
  --dir <path>           Run in <path> instead of the current directory
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 success, 1 refused or inconsistent, 2 usage error.
status --runtime also: 3 an enabled service is starting, unhealthy, stopped or not deployed;
4 the runtime cannot be read (RUNTIME_UNAVAILABLE).`;

const vol = (v: VolumeRef) => `${v.brick}/${v.service}/${v.name}`;

function printIssues(io: Io, issues: Issue[]): void {
  for (const i of issues) io.stderr(`error ${i.code}${i.path ? ` at ${i.path}` : ""}: ${i.message}`);
}

/** The declared state, as `plugbricks status` prints it. */
function printDeclared(io: Io, s: StatusResult): void {
  io.stdout(`Platform ${s.name}: ${s.bricks.length} brick(s)`);
  for (const b of s.bricks) {
    const parts = [
      ...(b.enabled ? [] : ["disabled"]),
      ...(b.webPort !== undefined ? [`pages on 127.0.0.1:${b.webPort}`] : []),
      ...(b.provides.length ? [`provides ${b.provides.join(", ")}`] : []),
      ...Object.entries(b.requires).map(([cap, r]) => {
        if (!r.optional) return `requires ${cap} from ${r.provider} (wait ${r.wait}, ${r.timeoutSeconds}s)`;
        // An optional requirement (D19) is wired to the current provider, when there is one and it is enabled.
        const provider = Object.hasOwn(s.capabilities, cap) ? s.capabilities[cap] : undefined;
        const enabled = provider !== undefined && s.bricks.some((x) => x.name === provider && x.enabled);
        if (provider === undefined) return `optionally requires ${cap} (no provider: not wired)`;
        if (!enabled) return `optionally requires ${cap} (${provider} is disabled: not wired)`;
        return `optionally requires ${cap} from ${provider} (wait ${r.wait}, ${r.timeoutSeconds}s)`;
      }),
    ];
    io.stdout(`  ${b.name} ${b.version}${parts.length ? `  ${parts.join("; ")}` : ""}`);
  }
  if (s.federation) {
    const locked = s.federation.lockedComposer ? ` (platform.lock was written with ${s.federation.lockedComposer})` : "";
    io.stdout(`Federation: ${s.federation.subgraphs.join(", ")}; composed with ${s.federation.composer}${locked}`);
  }
  if (s.router) {
    io.stdout(`Router: port ${s.router.port} (Compose: 127.0.0.1 only; Kubernetes: ClusterIP service); image ${s.router.image}`);
  }
  io.stdout(`Retained volumes: ${s.retainedVolumes.length ? s.retainedVolumes.map(vol).join(", ") : "none"}`);
  io.stdout(`Pending deletion: ${s.pendingDeletion.length ? s.pendingDeletion.map(vol).join(", ") : "none"}`);
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

/** The commands that write platform.json, platform.lock, .generated/, .secrets/ or the runtime. */
const CHANGING_COMMANDS = new Set(["add", "create", "remove", "enable", "disable", "generate", "up", "down"]);

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
          runtime: { type: "string" },
          context: { type: "string" },
          kubeconfig: { type: "string" },
          "allow-context": { type: "string" },
          "prune-volumes": { type: "boolean" },
          yes: { type: "boolean", short: "y" },
          kind: { type: "string" },
          service: { type: "string" },
          follow: { type: "boolean", short: "f" },
          tail: { type: "string" },
          image: { type: "string" },
          port: { type: "string" },
          dev: { type: "boolean" },
          issuer: { type: "string" },
          "client-id": { type: "string" },
          "ui-dir": { type: "string" },
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
    const optionFor = (opt: string, ...allowed: string[]) => {
      if (!allowed.includes(command)) {
        const list = allowed.map((a) => `"plugbricks ${a}"`).join(", ");
        throw usage("USAGE_INVALID_OPTION", "", { detail: `--${opt} only applies to ${list}` });
      }
    };
    if (values.name !== undefined) optionFor("name", "init");
    if (values.json !== undefined) optionFor("json", "status");
    if (values.runtime !== undefined) optionFor("runtime", "generate", "up", "down", "status", "admin", "doctor", "logs", "exec");
    for (const opt of ["port", "dev", "issuer", "client-id", "ui-dir"] as const) {
      if (values[opt] !== undefined) optionFor(opt, "admin");
    }
    if (values["prune-volumes"] !== undefined) optionFor("prune-volumes", "up");
    if (values.yes !== undefined) optionFor("yes", "add");
    if (values.kind !== undefined) optionFor("kind", "create");
    if (values.service !== undefined) optionFor("service", "logs", "exec");
    if (values.follow !== undefined) optionFor("follow", "logs");
    if (values.tail !== undefined) optionFor("tail", "logs");
    if (values.image !== undefined) optionFor("image", "create");
    const runtime = (values.runtime ?? "compose") as Runtime;
    if (!RUNTIMES.includes(runtime)) {
      throw usage("USAGE_INVALID_OPTION", "", { detail: `--runtime must be one of: ${RUNTIMES.join(", ")} (got "${values.runtime}")` });
    }
    for (const opt of ["context", "kubeconfig", "allow-context"] as const) {
      if (values[opt] === undefined) continue;
      optionFor(opt, "up", "down", "status", "admin", "doctor", "logs", "exec");
      if (runtime !== "k8s") throw usage("USAGE_INVALID_OPTION", "", { detail: `--${opt} only applies with --runtime k8s` });
    }
    if (values["allow-context"] !== undefined && values["allow-context"] !== values.context) {
      throw usage("USAGE_INVALID_OPTION", "", { detail: "--allow-context must name the same context as --context" });
    }
    const k8s = {
      context: values.context,
      // Like a brick path, relative to where the user typed the command, not to --dir.
      kubeconfig: values.kubeconfig === undefined ? undefined : resolve(io.cwd, values.kubeconfig),
      allowContext: values["allow-context"],
    };
    const deps: RuntimeDeps = { ...io.runtime, k8s, log: (l) => io.stdout(l) };

    // Commands that change the platform run one at a time, from a terminal or from the admin (D16).
    if (CHANGING_COMMANDS.has(command)) return withPlatformLock(root, [command, ...args].join(" "), () => run(command));
    return run(command);

    /**
     * Adds first what the brick at `dir` needs from bricks/ (D26), once the person agreed: in a terminal they are
     * asked, --yes agrees in advance, and otherwise nothing waits. A brick it cannot do without and that was not agreed
     * refuses the whole add; one it only declares in "dependencies" is left out, with the usual warning.
     */
    function addNeeds(arg: string, dir: string): void {
      const ask = values.yes ? undefined : io.ask;
      const choose = ask
        ? (c: Choice) => {
            for (let tries = 0; tries < 3; tries++) {
              const a = ask(
                `Several bricks of bricks/ provide "${c.capability}", which ${c.consumer} requires: ${c.candidates.join(", ")}. Which one? (empty to cancel)`,
              )?.trim();
              if (!a) return undefined;
              if (c.candidates.includes(a)) return a;
            }
            return undefined;
          }
        : undefined;
      const plan = needsOf(readProject(root), dir, choose);
      if (!plan) return;
      const again = (brick: string, ...extra: string[]) =>
        ["plugbricks", "add", brick, ...(values.dir !== undefined ? ["--dir", values.dir] : []), ...extra].join(" ");
      if (plan.open.length) {
        throw new PlugbricksError(
          plan.open.map((c) =>
            issue("CAPABILITY_PROVIDER_CHOICE", "", {
              capability: c.capability,
              brick: c.consumer,
              folder: "bricks/",
              candidates: c.candidates.join(", "),
              command: again(c.candidates[0]),
            }),
          ),
        );
      }
      io.stdout(`${plan.brick} needs:`);
      for (const p of plan.add) io.stdout(`  ${p.name} (bricks/${p.name}): ${p.reason}`);
      const required = plan.add.filter((p) => p.required).map((p) => p.name);
      const names = plan.add.map((p) => p.name).join(", ");
      let agreed = values.yes === true;
      if (!agreed && ask) agreed = /^(y|yes)$/i.test(ask(`Add ${names} too? [y/N]`)?.trim() ?? "");
      if (!agreed) {
        if (required.length) {
          throw new PlugbricksError([
            ask
              ? issue("ADD_NOT_CONFIRMED", "", { brick: plan.brick, bricks: required.join(", ") })
              : issue("ADD_NEEDS_CONFIRMATION", "", {
                  brick: plan.brick,
                  bricks: required.join(", "),
                  folder: "bricks/",
                  command: again(arg, "--yes"),
                }),
          ]);
        }
        io.stdout(`  not added; "${again(arg, "--yes")}" adds them too`);
        return;
      }
      for (const p of plan.add) {
        const r = addBrick(root, p.dir, { byName: p.name });
        io.stdout(`Added ${r.name} ${r.version} (${p.reason})`);
        for (const v of r.reattachedVolumes) io.stdout(`  re-attached retained volume ${vol(v)}`);
        for (const v of r.cancelledDeletions) io.stdout(`  cancelled the pending deletion of volume ${vol(v)}`);
      }
    }

    function run(command: string): number {
      switch (command) {
        case "init": {
          only(0, "");
          const r = initPlatform(root, values.name);
          io.stdout(`Initialised platform "${r.name}": ${r.created.join(", ")}`);
          return 0;
        }
        case "add": {
          only(1, "a brick name or path");
          // A name is a brick of the project's bricks/ folder, or a folder of that name here (D25); a path is relative
          // to where the user typed the command, not to --dir.
          const arg = args[0];
          const byName = isBrickName(arg) ? brickByName(root, arg, io.cwd) : undefined;
          const dir = byName ? byName.dir : resolve(io.cwd, arg);
          addNeeds(arg, dir);
          const r = addBrick(root, dir, { byName: byName?.byName });
          if (r.status === "unchanged") io.stdout(`${r.name} ${r.version} is already installed; nothing changed`);
          else io.stdout(`Added ${r.name} ${r.version}`);
          for (const v of r.reattachedVolumes) io.stdout(`  re-attached retained volume ${vol(v)}`);
          for (const v of r.cancelledDeletions) io.stdout(`  cancelled the pending deletion of volume ${vol(v)}`);
          for (const dep of r.missingDependencies) {
            io.stdout(`  dependency "${dep}" is not installed; ${r.name} will not work without it`);
          }
          if (r.openApi) {
            io.stdout(
              `  ${r.name} serves GraphQL and requires oidc but has no "authorization" block: with an oidc provider, any valid token can call it`,
            );
          }
          return 0;
        }
        case "create": {
          only(1, "a name");
          const kind = values.kind as BrickKind | undefined;
          if (kind === undefined || !BRICK_KINDS.includes(kind)) {
            throw usage("USAGE_INVALID_OPTION", "", {
              detail: `create needs --kind ${BRICK_KINDS.join(" or ")}${values.kind === undefined ? "" : ` (got "${values.kind}")`}`,
            });
          }
          const r = createBrick(root, args[0], kind, { image: values.image });
          io.stdout(`Created ${r.name}: ${r.brickDir} (the brick) and ${r.serviceDir} (its code and image recipe)`);
          io.stdout(`Added ${r.added.name} ${r.added.version}`);
          // The build context is the project folder: the image of an API carries the schema of its brick.
          const here = relative(io.cwd, root).split("\\").join("/");
          const at = (p: string) => (here ? `${here}/${p}` : p);
          io.stdout("Next, build its image, then start the platform:");
          io.stdout(`  docker build -t ${r.image} -f ${at(`${r.serviceDir}/Dockerfile`)} ${here || "."}`);
          io.stdout(`  plugbricks up${values.dir !== undefined ? ` --dir ${values.dir}` : ""}`);
          // On Kubernetes the image must be where the cluster pulls it: imported into a local cluster (kept, since a
          // pinned tag is pulled only when missing), or pushed to a registry it reads.
          io.stdout(`On Kubernetes, the cluster needs the image: import it (k3d image import ${r.image} --cluster <name>,`);
          io.stdout(`  kind load docker-image ${r.image}), or push it to a registry the cluster reads.`);
          if (values.image === undefined)
            io.stdout("  To name a registry image from the start, create with --image <registry>/<name>:<version>.");
          return 0;
        }
        case "logs": {
          only(1, "a brick name");
          let tail: number | undefined;
          if (values.tail !== undefined) {
            if (!/^\d+$/.test(values.tail))
              throw usage("USAGE_INVALID_OPTION", "", { detail: `--tail takes a number of lines (got "${values.tail}")` });
            tail = Number(values.tail);
          }
          return logs(root, runtime, args[0], { service: values.service, follow: values.follow, tail }, { ...io.runtime, k8s });
        }
        case "exec": {
          if (args.length < 1) throw usage("USAGE_MISSING_ARGUMENT", "", { command, argument: "a brick name" });
          // A TTY only for a person at a terminal: the same test as the questions of add (bin.ts gives ask then).
          return execIn(
            root,
            runtime,
            args[0],
            { service: values.service, command: args.slice(1), tty: io.ask !== undefined },
            { ...io.runtime, k8s },
          );
        }
        case "doctor": {
          only(0, "");
          // Read-only (D31): no lock, nothing written, every external call a query.
          const checks = doctor(root, runtime, { exec: io.runtime?.exec, k8s });
          io.stdout(`plugbricks doctor (${runtime === "k8s" ? "Kubernetes" : "Docker Compose"})`);
          for (const c of checks) {
            io.stdout(`  ${c.state.padEnd(8)} ${c.detail}`);
            if (c.fix) io.stdout(`           fix: ${c.fix}`);
          }
          const problems = checks.filter((c) => c.state === "problem").length;
          const warnings = checks.filter((c) => c.state === "warning").length;
          const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
          io.stdout(
            problems
              ? `${count(problems, "problem")}, ${count(warnings, "warning")}: up would fail; fix the problems above`
              : `no problem${warnings ? `, ${count(warnings, "warning")}` : ""}: up has what it needs`,
          );
          return problems ? 1 : 0;
        }
        case "remove": {
          only(1, "a brick name");
          const r = removeBrick(root, args[0]);
          io.stdout(`Removed ${r.name}`);
          for (const v of r.retainedVolumes) io.stdout(`  volume ${vol(v)} kept (retention: retain)`);
          for (const v of r.pendingDeletion) {
            io.stdout(`  volume ${vol(v)} marked for deletion (retention: delete); only "up --prune-volumes" deletes it`);
          }
          return 0;
        }
        case "enable":
        case "disable": {
          only(1, "a brick name");
          const enabled = command === "enable";
          const r = setBrickEnabled(root, args[0], enabled);
          io.stdout(`${enabled ? "Enabled" : "Disabled"} ${r.name}`);
          for (const dep of r.disabledDependencies) {
            io.stdout(`  dependency "${dep}" is disabled; ${r.name} will not work until it is enabled`);
          }
          return 0;
        }
        case "admin": {
          only(0, "");
          const port = values.port === undefined ? 4100 : Number(values.port);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw usage("USAGE_INVALID_OPTION", "", { detail: `--port must be an integer between 1 and 65535 (got "${values.port}")` });
          }
          const dev = values.dev === true;
          const clientSecret = process.env.PLUGBRICKS_OIDC_CLIENT_SECRET;
          // The issuer: --issuer, else the platform's own oidc provider (D19). A public client (PKCE, no secret) is
          // enough; a confidential client adds the env secret.
          const found = dev || values.issuer ? undefined : platformOidcIssuer(readProject(root));
          const issuer = values.issuer ?? found?.issuer;
          if (!dev && (!issuer || !values["client-id"])) {
            throw new PlugbricksError([issue("ADMIN_OIDC_NOT_CONFIGURED", "")]);
          }
          if (found) io.stdout(`admin: OIDC issuer ${found.issuer} (from the ${found.brick} brick; --issuer overrides it)`);
          const cliDir = dirname(fileURLToPath(import.meta.url));
          const packagedUi = join(cliDir, "admin", "ui");
          const uiDir =
            values["ui-dir"] === undefined
              ? existsSync(join(packagedUi, "index.html"))
                ? packagedUi
                : join(cliDir, "../../admin/dist")
              : resolve(io.cwd, values["ui-dir"]);
          if (!existsSync(join(uiDir, "index.html"))) throw new PlugbricksError([issue("ADMIN_UI_MISSING", "", { dir: uiDir })]);
          // Read-only: statusRuntime is bounded and never mutates; the server only serves the project.
          readProject(root);
          const s = startAdmin({
            root,
            runtime,
            port,
            dev,
            uiDir,
            k8s,
            runtimeDeps: io.runtime,
            issuer,
            clientId: values["client-id"],
            clientSecret,
            log: (line) => io.stdout(line),
          });
          s.ready.catch((e: unknown) => {
            io.stderr(`error ADMIN_START_FAILED: ${(e as Error).message}`);
            process.exitCode = 1;
            s.close();
          });
          return 0;
        }
        case "status": {
          only(0, "");
          const s = platformStatus(root);
          if (values.runtime !== undefined) {
            // Read-only: what the runtime runs, next to what is declared (D10). Its own deps: no progress lines.
            const live = statusRuntime(root, runtime, s.problems, { ...io.runtime, k8s });
            if (values.json) io.stdout(JSON.stringify(live, null, 2));
            else {
              printDeclared(io, s);
              for (const line of liveStatusText(live)) io.stdout(line);
            }
            printIssues(io, s.problems);
            if (s.problems.length) return 1;
            return live.state === "degraded" ? STATUS_DEGRADED_EXIT : 0;
          }
          if (values.json) {
            io.stdout(JSON.stringify(s, null, 2));
          } else printDeclared(io, s);
          printIssues(io, s.problems);
          return s.problems.length ? 1 : 0;
        }
        case "generate": {
          only(0, "");
          const g = generate(root, runtime, deps);
          io.stdout(`Generated ${runtime} files for ${g.plan.platform}:`);
          for (const f of g.files) io.stdout(`  ${f}`);
          if (g.secretsCreated.length)
            io.stdout(`Created ${g.secretsCreated.length} secret(s) in .secrets/: ${g.secretsCreated.join(", ")}`);
          return 0;
        }
        case "up": {
          only(0, "");
          const r = up(root, runtime, { pruneVolumes: values["prune-volumes"] }, deps);
          if (r.generated.secretsCreated.length) io.stdout(`Created ${r.generated.secretsCreated.length} secret(s) in .secrets/`);
          io.stdout(`Platform ${r.generated.plan.platform} is up (${runtime}): ${r.generated.plan.services.length} service(s)`);
          for (const v of r.pruned) io.stdout(`  deleted volume ${vol(v)}`);
          if (r.pending.length && !values["prune-volumes"]) {
            io.stdout(`Pending deletion, kept until "plugbricks up --prune-volumes": ${r.pending.map(vol).join(", ")}`);
          }
          printIssues(io, r.problems);
          return r.problems.length ? 1 : 0;
        }
        case "down": {
          only(0, "");
          down(root, runtime, deps);
          io.stdout(`Platform stopped (${runtime}); volumes and secrets are kept`);
          return 0;
        }
        default:
          throw usage("USAGE_UNKNOWN_COMMAND", "", { command });
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      printIssues(io, [e.issueValue]);
      return 2;
    }
    if (e instanceof RuntimeUnavailableError) {
      printIssues(io, e.issues);
      return STATUS_UNAVAILABLE_EXIT;
    }
    if (e instanceof PlugbricksError) {
      printIssues(io, e.issues);
      return 1;
    }
    throw e;
  }
}
