import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { WAIT_TIMEOUT_EXIT } from "./drivers/common.js";
import { COMPOSE_FILE, composeVolumeName, renderCompose } from "./drivers/compose.js";
import {
  BRICK_LABEL,
  DISPOSABLE_KINDS,
  K8S_NAMESPACE_FILE,
  K8S_RESOURCES_FILE,
  K8S_SECRET_FILE,
  MANAGED_BY,
  renderK8s,
  renderK8sSecret,
  SERVICE_LABEL,
} from "./drivers/k8s.js";
import { writeFileAtomic } from "./fsutil.js";
import { issue, type Issue } from "./issues.js";
import { initContainerName, planProject, volumeName, type Plan } from "./plan.js";
import { confirmPruned, PlugbricksError, readProject, volumesToPrune, type VolumeRef } from "./platform.js";
import { ensureSecrets, SECRETS_DIR, SECRETS_FILE, writePrivateFile, type RestrictOptions } from "./secrets.js";

export const RUNTIMES = ["compose", "k8s"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const GENERATED_DIR = ".generated";
/** Docker Compose reads the secrets from this file (--env-file). */
export const COMPOSE_ENV_FILE = `${SECRETS_DIR}/${SECRETS_FILE}`;

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started at all (ENOENT: not installed). */
  error?: string;
}
/** Runs a program without a shell. Injectable so tests can check the exact commands. */
export type Exec = (cmd: string, args: string[], opts: { cwd: string }) => ExecResult;

export const defaultExec: Exec = (cmd, args, opts) => {
  // stdio inherited for stderr would hide it from error reports; output is captured and shown on failure.
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(r.error ? { error: (r.error as NodeJS.ErrnoException).code ?? r.error.message } : {}),
  };
};

export interface RuntimeDeps {
  exec?: Exec;
  restrict?: RestrictOptions;
  /** Secret generator; tests pass a deterministic one. */
  random?: () => string;
  /** Progress lines (the commands run). */
  log?: (line: string) => void;
}

// ---------- generate ----------

export interface GenerateResult {
  runtime: Runtime;
  plan: Plan;
  /** Files written or confirmed, relative to the platform root, with "/". */
  files: string[];
  /** Secret variables created by this run (values are never returned). */
  secretsCreated: string[];
}

/** Files under dir, as posix paths relative to it. */
function listFiles(dir: string, rel = ""): string[] {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? listFiles(dir, r) : [r];
  });
}

/**
 * Builds the plan, makes sure every secret it uses exists in .secrets/, and writes the runtime
 * files into .generated/<runtime>/ (stale files there are removed). Deterministic: the same lock
 * gives byte-identical files.
 */
export function generate(root: string, runtime: Runtime, deps: RuntimeDeps = {}): GenerateResult {
  const project = readProject(root);
  const plan = planProject(project);
  const files = runtime === "compose" ? renderCompose(plan) : renderK8s(plan);

  const secrets = ensureSecrets(project.root, plan.secrets.map((s) => s.env), { ...deps.restrict, random: deps.random });
  if (!secrets.ok) throw new PlugbricksError([secrets.issue]);
  const out = [COMPOSE_ENV_FILE];
  if (runtime === "k8s") {
    writePrivateFile(join(project.root, K8S_SECRET_FILE), renderK8sSecret(plan, secrets.result.values));
    out.push(K8S_SECRET_FILE);
  }

  writeFileAtomic(join(project.root, GENERATED_DIR, ".gitignore"), "# Written by plugbricks: rebuilt on demand, never committed.\n*\n");
  const dir = `${GENERATED_DIR}/${runtime}`;
  for (const [path, content] of Object.entries(files)) writeFileAtomic(join(project.root, path), content);
  for (const stale of listFiles(join(project.root, dir))) {
    if (!files[`${dir}/${stale}`]) rmSync(join(project.root, dir, stale), { force: true });
  }
  return { runtime, plan, files: [...Object.keys(files), ...out].sort(), secretsCreated: secrets.result.created };
}

// ---------- running tools ----------

const shown = (cmd: string, args: string[]) => [cmd, ...args].join(" ");

function lastLines(text: string, n = 5): string {
  const ls = text.trim().split(/\r?\n/).filter(Boolean);
  return ls.slice(-n).join("\n");
}

function run(deps: RuntimeDeps, root: string, cmd: string, args: string[]): ExecResult {
  deps.log?.(`$ ${shown(cmd, args)}`);
  return (deps.exec ?? defaultExec)(cmd, args, { cwd: root });
}

function failed(cmd: string, args: string[], r: ExecResult): Issue {
  const why = lastLines(r.stderr || r.stdout);
  return issue("RUNTIME_COMMAND_FAILED", "", { command: shown(cmd, args), status: String(r.status), detail: why ? `:\n${why}` : "" });
}

function requireTool(deps: RuntimeDeps, root: string, cmd: string, args: string[], tool: string, hint: string): void {
  const r = run(deps, root, cmd, args);
  if (r.error || r.status !== 0) throw new PlugbricksError([issue("RUNTIME_TOOL_MISSING", "", { tool, hint })]);
}

// ---------- Docker Compose ----------

const composeBase = (plan: Plan) => ["compose", "--project-name", plan.platform, "--file", COMPOSE_FILE, "--env-file", COMPOSE_ENV_FILE];

/**
 * Wait tasks that made this `up` fail by giving up: named in Compose's error output AND exited
 * with the timeout code in `docker compose ps --all`. Both are required, so a wait task left
 * at 124 by an earlier run never hides the real cause of this failure.
 */
function composeWaitTimeouts(deps: RuntimeDeps, root: string, plan: Plan, failure: string): Issue[] {
  const named = plan.requirements.filter((req) => req.wait && failure.includes(`"${req.wait.name}"`));
  if (!named.length) return [];
  const r = run(deps, root, "docker", [...composeBase(plan), "ps", "--all", "--format", "json"]);
  if (r.status !== 0) return [];
  const text = r.stdout.trim();
  let rows: { Service?: string; ExitCode?: number }[] = [];
  try {
    // Compose prints either one JSON array or one JSON object per line, depending on its version.
    rows = text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
  return named.flatMap((req) =>
    rows.some((row) => row.Service === req.wait!.name && row.ExitCode === WAIT_TIMEOUT_EXIT)
      ? [
          issue("WAIT_TIMEOUT", "", {
            consumer: req.consumer,
            capability: req.capability,
            provider: req.provider,
            timeoutSeconds: String(req.wait!.timeoutSeconds),
          }),
        ]
      : [],
  );
}

// ---------- Kubernetes ----------

const kubectlBase = (plan: Plan) => ["--namespace", plan.platform];

/** Wait init containers that exited with the timeout code, from the pods of one service. */
function k8sWaitTimeouts(deps: RuntimeDeps, root: string, plan: Plan, service: string): Issue[] {
  const r = run(deps, root, "kubectl", [...kubectlBase(plan), "get", "pods", "--selector", `${SERVICE_LABEL}=${service}`, "--output", "json"]);
  if (r.status !== 0) return [];
  let pods: { status?: { initContainerStatuses?: { name: string; state?: any; lastState?: any }[] } }[];
  try {
    pods = JSON.parse(r.stdout).items ?? [];
  } catch {
    return [];
  }
  const s = plan.services.find((x) => x.name === service)!;
  return plan.requirements.flatMap((req) => {
    if (req.consumer !== s.brick || !req.wait) return [];
    const timedOut = pods.some((p) =>
      (p.status?.initContainerStatuses ?? []).some(
        // The current state, or the last one while the container waits to be restarted
        // (CrashLoopBackOff). A 124 followed by a success is history, not the cause.
        (c) =>
          c.name === initContainerName("wait", req.capability) &&
          (c.state?.terminated?.exitCode === WAIT_TIMEOUT_EXIT ||
            (c.state?.waiting !== undefined && c.lastState?.terminated?.exitCode === WAIT_TIMEOUT_EXIT)),
      ),
    );
    return timedOut
      ? [
          issue("WAIT_TIMEOUT", "", {
            consumer: req.consumer,
            capability: req.capability,
            provider: req.provider,
            timeoutSeconds: String(req.wait.timeoutSeconds),
          }),
        ]
      : [];
  });
}

/** Label selector of everything plugbricks created for bricks that are no longer installed. */
export function removedBricksSelector(plan: Plan): string {
  const installed = [...new Set(plan.services.map((s) => s.brick))].sort();
  return installed.length ? `${MANAGED_BY}=plugbricks,${BRICK_LABEL},${BRICK_LABEL} notin (${installed.join(",")})` : `${MANAGED_BY}=plugbricks,${BRICK_LABEL}`;
}

/** How long `docker compose up --wait` may take: the longest chain of waits, plus time to pull images and start. */
function composeWaitTimeout(plan: Plan): number {
  return Math.max(0, ...plan.services.map((s) => rolloutTimeout(plan, s.name)));
}

/** How long `up` waits for one Deployment: its own wait timeouts, plus time to pull images and start. */
function rolloutTimeout(plan: Plan, service: string): number {
  const s = plan.services.find((x) => x.name === service)!;
  const waits = plan.requirements.filter((r) => r.consumer === s.brick && r.wait).reduce((n, r) => n + r.wait!.timeoutSeconds, 0);
  return waits + 300;
}

// ---------- up / down ----------

export interface UpResult {
  generated: GenerateResult;
  /** Volumes deleted by --prune-volumes (removed from pendingDeletion). */
  pruned: VolumeRef[];
  /** Volumes still pending deletion (not pruned: no flag, or deletion failed). */
  pending: VolumeRef[];
  /** Deletion failures; up still succeeded. */
  problems: Issue[];
}

/**
 * Generates, then applies the platform. With pruneVolumes, deletes exactly the volumes of
 * platform.lock pendingDeletion, once the runtime no longer uses them, and removes each one
 * deleted from the lock. Nothing else is ever deleted.
 */
export function up(root: string, runtime: Runtime, opts: { pruneVolumes?: boolean } = {}, deps: RuntimeDeps = {}): UpResult {
  const generated = generate(root, runtime, deps);
  const { plan } = generated;
  const dir = resolve(root);

  if (runtime === "compose") {
    requireTool(deps, dir, "docker", ["compose", "version"], "docker compose", "install Docker with the Compose v2 plugin");
    // --remove-orphans removes the containers of removed bricks; their volumes stay. Compose
    // refuses "up" on a project without services: with no brick left, "down" does the same job.
    // --wait: return only once every service runs (and is healthy when it has a healthcheck) and
    // every wait and provision task has exited 0, as `kubectl rollout status` does on Kubernetes.
    const args = plan.services.length
      ? [...composeBase(plan), "up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", String(composeWaitTimeout(plan))]
      : ["compose", "--project-name", plan.platform, "down", "--remove-orphans"];
    const r = run(deps, dir, "docker", args);
    if (r.status !== 0) {
      const timeouts = composeWaitTimeouts(deps, dir, plan, r.stderr + r.stdout);
      throw new PlugbricksError(timeouts.length ? timeouts : [failed("docker", args, r)]);
    }
  } else {
    requireTool(deps, dir, "kubectl", ["version", "--client"], "kubectl", "install kubectl and select a cluster context");
    for (const f of [K8S_NAMESPACE_FILE, K8S_SECRET_FILE, K8S_RESOURCES_FILE]) {
      // kubectl refuses a file with no object in it.
      if (f === K8S_RESOURCES_FILE && plan.services.length === 0) continue;
      const args = ["apply", "--filename", f];
      const r = run(deps, dir, "kubectl", args);
      if (r.status !== 0) throw new PlugbricksError([failed("kubectl", args, r)]);
    }
    const cleanup = [...kubectlBase(plan), "delete", DISPOSABLE_KINDS, "--selector", removedBricksSelector(plan), "--ignore-not-found"];
    const c = run(deps, dir, "kubectl", cleanup);
    if (c.status !== 0) throw new PlugbricksError([failed("kubectl", cleanup, c)]);
    for (const s of plan.services) {
      const args = [...kubectlBase(plan), "rollout", "status", `deployment/${s.name}`, `--timeout=${rolloutTimeout(plan, s.name)}s`];
      const r = run(deps, dir, "kubectl", args);
      if (r.status !== 0) {
        const timeouts = k8sWaitTimeouts(deps, dir, plan, s.name);
        throw new PlugbricksError(timeouts.length ? timeouts : [failed("kubectl", args, r)]);
      }
    }
  }

  const candidates = volumesToPrune(readProject(root).lock);
  const pruned: VolumeRef[] = [];
  const problems: Issue[] = [];
  if (opts.pruneVolumes) {
    for (const v of candidates) {
      const name = volumeName(v);
      const args =
        runtime === "compose"
          ? ["volume", "rm", composeVolumeName(plan.platform, name)]
          : [...kubectlBase(plan), "delete", "persistentvolumeclaim", name, "--ignore-not-found"];
      const cmd = runtime === "compose" ? "docker" : "kubectl";
      const r = run(deps, dir, cmd, args);
      // A volume that is already gone counts as deleted.
      if (r.status === 0 || (runtime === "compose" && /no such volume/i.test(r.stderr))) pruned.push(v);
      else problems.push(issue("VOLUME_PRUNE_FAILED", "", { volume: `${v.brick}/${v.service}/${v.name}`, detail: lastLines(r.stderr || r.stdout, 1) }));
    }
    confirmPruned(root, pruned);
  }
  const prunedKeys = new Set(pruned.map(volumeName));
  return { generated, pruned, pending: candidates.filter((v) => !prunedKeys.has(volumeName(v))), problems };
}

/** Stops the platform. Never deletes a volume, a PersistentVolumeClaim or the secrets. */
export function down(root: string, runtime: Runtime, deps: RuntimeDeps = {}): void {
  const project = readProject(root);
  const platform = project.platform.name;
  if (runtime === "compose") {
    requireTool(deps, project.root, "docker", ["compose", "version"], "docker compose", "install Docker with the Compose v2 plugin");
    // By project name only: works even when .generated/ was deleted. No --volumes, ever.
    const args = ["compose", "--project-name", platform, "down", "--remove-orphans"];
    const r = run(deps, project.root, "docker", args);
    if (r.status !== 0) throw new PlugbricksError([failed("docker", args, r)]);
  } else {
    requireTool(deps, project.root, "kubectl", ["version", "--client"], "kubectl", "install kubectl and select a cluster context");
    const args = ["--namespace", platform, "delete", DISPOSABLE_KINDS, "--selector", `${MANAGED_BY}=plugbricks`, "--ignore-not-found"];
    const r = run(deps, project.root, "kubectl", args);
    if (r.status !== 0) throw new PlugbricksError([failed("kubectl", args, r)]);
  }
}
