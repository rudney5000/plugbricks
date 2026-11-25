// "plugbricks logs" and "plugbricks exec" (D32): the logs of a brick's service, or a command inside it, without looking
// for the names Docker or Kubernetes gave them. The output goes straight to the terminal (attach), so that --follow and
// an interactive shell work; the exit code is the one of the command. Neither changes the platform: no lock.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTER_NAME } from "./drivers/common.js";
import { issue } from "./issues.js";
import { BRICKS_DIR, isBrickEnabled, PlugbricksError, readProject } from "./platform.js";
import { defaultExec, k8sTargetFlags, type Exec, type K8sTarget, type Runtime } from "./runtime.js";

/** Runs a command with the terminal's input and output, and returns its exit code. */
export type Attach = (cmd: string, args: string[], opts: { cwd: string }) => number;

export const defaultAttach: Attach = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, stdio: "inherit" });
  if (r.error) throw new PlugbricksError([issue("RUNTIME_TOOL_MISSING", "", { tool: cmd, hint: `install ${cmd}` })]);
  // Ended by a signal (Ctrl-C on --follow): the shell's convention, 128 + the signal.
  return r.status ?? (r.signal === "SIGINT" ? 130 : 1);
};

export interface AttachDeps {
  exec?: Exec;
  attach?: Attach;
  k8s?: K8sTarget;
}

/** What a brick name, or `router`, designates at run time. */
export interface Target {
  /** The Compose service, the Kubernetes Deployment: `<brick>-<service>`, or `router`. */
  name: string;
  /** The container in the pod (Kubernetes): the service's name; the pod also has the init containers of its waits. */
  container: string;
}

const fail = (code: Parameters<typeof issue>[0], params: Record<string, string>): never => {
  throw new PlugbricksError([issue(code, "", params)]);
};

/** The runtime names of `brick`'s service (`--service`, or its only one), or of the router. */
export function resolveTarget(root: string, brick: string, service?: string): { platform: string; root: string; target: Target } {
  const project = readProject(root);
  const platform = project.platform.name;
  const installed = Object.hasOwn(project.lock.bricks, brick);
  if (brick === ROUTER_NAME && !installed) {
    if (!project.lock.federation) fail("ROUTER_NOT_IN_PLATFORM", {});
    if (service !== undefined) fail("SERVICE_UNKNOWN", { brick, service, services: ROUTER_NAME });
    return { platform, root: project.root, target: { name: ROUTER_NAME, container: ROUTER_NAME } };
  }
  if (!installed) fail("BRICK_NOT_INSTALLED", { name: brick });
  if (!isBrickEnabled(project.platform, brick)) fail("BRICK_DISABLED_NOT_RUNNING", { brick });
  const manifest = JSON.parse(readFileSync(join(project.root, BRICKS_DIR, brick, "plugin.json"), "utf8")) as {
    services: { name: string }[];
  };
  const names = manifest.services.map((s) => s.name);
  if (service !== undefined && !names.includes(service)) fail("SERVICE_UNKNOWN", { brick, service, services: names.join(", ") });
  if (service === undefined && names.length > 1) fail("SERVICE_REQUIRED", { brick, services: names.join(", ") });
  const chosen = service ?? names[0];
  return { platform, root: project.root, target: { name: `${brick}-${chosen}`, container: chosen } };
}

/** The Compose container of `name` in `platform`, found by its labels: works even when .generated/ was deleted. */
function composeContainer(exec: Exec, root: string, platform: string, name: string, running: boolean): string {
  const r = exec(
    "docker",
    [
      "ps",
      ...(running ? [] : ["--all"]),
      "--filter",
      `label=com.docker.compose.project=${platform}`,
      "--filter",
      `label=com.docker.compose.service=${name}`,
      "--format",
      "{{.ID}}",
    ],
    { cwd: root, timeoutMs: 15_000 },
  );
  if (r.error) fail("RUNTIME_TOOL_MISSING", { tool: "docker", hint: "install Docker with the Compose v2 plugin" });
  if (r.status !== 0)
    fail("RUNTIME_UNAVAILABLE", { runtime: "Docker Compose", detail: (r.stderr || r.stdout).trim().split("\n")[0] ?? "" });
  const id = r.stdout
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!id) fail(running ? "SERVICE_NOT_RUNNING" : "SERVICE_HAS_NO_CONTAINER", { name, platform });
  return id!;
}

export interface LogsOptions {
  service?: string;
  follow?: boolean;
  /** The last lines only. */
  tail?: number;
}

export function logs(root: string, runtime: Runtime, brick: string, opts: LogsOptions, deps: AttachDeps = {}): number {
  const flags = runtime === "k8s" ? k8sTargetFlags(deps.k8s) : [];
  const { platform, root: dir, target } = resolveTarget(root, brick, opts.service);
  const attach = deps.attach ?? defaultAttach;
  const tail = opts.tail !== undefined ? ["--tail", String(opts.tail)] : [];
  const follow = opts.follow ? ["--follow"] : [];
  if (runtime === "k8s") {
    return attach(
      "kubectl",
      [...flags, "--namespace", platform, "logs", `deployment/${target.name}`, "--container", target.container, ...follow, ...tail],
      { cwd: dir },
    );
  }
  // A stopped container keeps its logs: the last ones say why it stopped.
  const id = composeContainer(deps.exec ?? defaultExec, dir, platform, target.name, false);
  return attach("docker", ["logs", ...follow, ...tail, id], { cwd: dir });
}

export interface ExecOptions {
  service?: string;
  /** The command; a shell when empty. */
  command: string[];
  /** A person at a terminal: a TTY is allocated (an interactive shell needs one). */
  tty?: boolean;
}

export function execIn(root: string, runtime: Runtime, brick: string, opts: ExecOptions, deps: AttachDeps = {}): number {
  const flags = runtime === "k8s" ? k8sTargetFlags(deps.k8s) : [];
  const { platform, root: dir, target } = resolveTarget(root, brick, opts.service);
  const attach = deps.attach ?? defaultAttach;
  const command = opts.command.length ? opts.command : ["sh"];
  const io = opts.tty ? ["-i", "-t"] : ["-i"];
  if (runtime === "k8s") {
    return attach(
      "kubectl",
      [...flags, "--namespace", platform, "exec", ...io, `deployment/${target.name}`, "--container", target.container, "--", ...command],
      { cwd: dir },
    );
  }
  const id = composeContainer(deps.exec ?? defaultExec, dir, platform, target.name, true);
  return attach("docker", ["exec", ...io, id, ...command], { cwd: dir });
}
