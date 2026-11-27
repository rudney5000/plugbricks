import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROUTER_NAME, WAIT_TIMEOUT_EXIT } from "./drivers/common.js";
import { COMPOSE_FILE, composeVolumeName, renderCompose } from "./drivers/compose.js";
import {
  BRICK_LABEL,
  COMPONENT_LABEL,
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
import {
  buildLiveStatus,
  composeLiveInput,
  DOCKER_INSPECT_TEMPLATE,
  k8sLiveInput,
  MANAGED_SELECTOR,
  parseComposePs,
  type ComposeRow,
  type LiveStatus,
} from "./live.js";
import { initContainerName, loadInstalledBricks, planProject, serviceName, volumeName, type Plan } from "./plan.js";
import { confirmPruned, isBrickEnabled, PlugbricksError, readProject, volumesToPrune, type VolumeRef } from "./platform.js";
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
/**
 * Runs a program without a shell. Injectable so tests can check the exact commands. With timeoutMs the
 * program is killed when it runs longer, and `error` is "ETIMEDOUT".
 */
export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => ExecResult;

export const defaultExec: Exec = (cmd, args, opts) => {
  // stdio inherited for stderr would hide it from error reports; output is captured and shown on failure.
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    ...(r.error ? { error: (r.error as NodeJS.ErrnoException).code ?? r.error.message } : {}),
  };
};

export interface RuntimeDeps {
  exec?: Exec;
  /** logs and exec (D32): a command attached to the terminal; tests pass a fake. */
  attach?: import("./attach.js").Attach;
  restrict?: RestrictOptions;
  /** Secret generator; tests pass a deterministic one. */
  random?: () => string;
  /** Progress lines (the commands run). */
  log?: (line: string) => void;
  /** The cluster the Kubernetes runtime acts on. Required for up and down with `k8s`. */
  k8s?: K8sTarget;
}

/** The cluster kubectl is pointed at. There is no default: the current kubectl context is never used. */
export interface K8sTarget {
  /** kubectl context name (--context). */
  context?: string;
  /** Absolute path of the kubeconfig file (--kubeconfig); omitted: kubectl's own default lookup. */
  kubeconfig?: string;
  /** Names a protected context on purpose; must equal `context` to have any effect. */
  allowContext?: string;
}

/**
 * Contexts plugbricks refuses unless told twice: the cluster named "platform" and the context
 * k3d gives it ("k3d-" + cluster name).
 */
export const PROTECTED_CONTEXTS = ["platform", "k3d-platform"] as const;

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

  const secrets = ensureSecrets(
    project.root,
    plan.secrets.map((s) => s.env),
    { ...deps.restrict, random: deps.random },
  );
  if (!secrets.ok) throw new PlugbricksError([secrets.issue]);
  const out = [COMPOSE_ENV_FILE];
  if (runtime === "k8s") {
    writePrivateFile(join(project.root, K8S_SECRET_FILE), renderK8sSecret(plan, secrets.result.values));
    out.push(K8S_SECRET_FILE);
  }

  writeFileAtomic(join(project.root, GENERATED_DIR, ".gitignore"), "# Written by plugbricks: rebuilt on demand, never committed.\n*\n");
  const dir = `${GENERATED_DIR}/${runtime}`;
  // Mode 0644: none of these files holds a secret, and the router container reads its configuration as another user.
  for (const [path, content] of Object.entries(files)) writeFileAtomic(join(project.root, path), content, 0o644);
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

function run(deps: RuntimeDeps, root: string, cmd: string, args: string[], timeoutMs?: number): ExecResult {
  deps.log?.(`$ ${shown(cmd, args)}`);
  return (deps.exec ?? defaultExec)(cmd, args, { cwd: root, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
}

function failed(cmd: string, args: string[], r: ExecResult): Issue {
  const why = lastLines(r.stderr || r.stdout);
  return issue("RUNTIME_COMMAND_FAILED", "", { command: shown(cmd, args), status: String(r.status), detail: why ? `:\n${why}` : "" });
}

function requireTool(deps: RuntimeDeps, root: string, cmd: string, args: string[], tool: string, hint: string): void {
  const r = run(deps, root, cmd, args);
  if (r.error || r.status !== 0) throw new PlugbricksError([issue("RUNTIME_TOOL_MISSING", "", { tool, hint })]);
}

function requireKubectl(deps: RuntimeDeps, root: string, target: string[]): void {
  const r = kubectl(deps, root, target, ["version", "--client"]);
  if (r.error || r.status !== 0)
    throw new PlugbricksError([issue("RUNTIME_TOOL_MISSING", "", { tool: "kubectl", hint: "install kubectl" })]);
}

// ---------- Docker Compose ----------

export const composeBase = (plan: Plan) => [
  "compose",
  "--project-name",
  plan.platform,
  "--file",
  COMPOSE_FILE,
  "--env-file",
  COMPOSE_ENV_FILE,
];

/**
 * Wait tasks that made this `up` fail by giving up: named in Compose's error output AND exited
 * with the timeout code in `docker compose ps --all`. Both are required, so a wait task left
 * at 124 by an earlier run never hides the real cause of this failure.
 */
/**
 * A port the platform publishes that something else on the machine already uses. `add` picks a webPort that this
 * platform does not use, not one that is free on the machine (D17, D18): another platform, or any program, may hold it.
 * Docker then says "Bind for 127.0.0.1:<port> failed: port is already allocated"; this names the platform.json field.
 */
export function composeBusyPorts(plan: Plan, failure: string): Issue[] {
  // Two wordings: another container holds the port ("port is already allocated"), or a program of the host does
  // ("listen tcp4 127.0.0.1:<port>: bind: address already in use").
  const host = String.raw`(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\])`;
  // The third is Docker 28 and later, which no longer goes through "listen tcp".
  const patterns = [
    new RegExp(String.raw`Bind for ${host}:(\d+) failed: port is already allocated`, "g"),
    new RegExp(String.raw`listen tcp[46]? ${host}:(\d+): bind: address already in use`, "g"),
    new RegExp(String.raw`failed to bind host port ${host}:(\d+)/tcp: address already in use`, "g"),
  ];
  const ports = new Set(patterns.flatMap((re) => [...failure.matchAll(re)].map((m) => Number(m[1]))));
  return [...ports]
    .sort((a, b) => a - b)
    .map((port) => {
      const web = plan.services.find((s) => s.web?.port === port);
      const field = web ? `bricks.${web.brick}.webPort` : plan.router?.port === port ? "router.port" : undefined;
      return issue("HOST_PORT_BUSY", field ? `platform.json#/${field.replaceAll(".", "/")}` : "", {
        port: String(port),
        what: web ? `the pages of "${web.brick}"` : plan.router?.port === port ? "the router" : "a service of this platform",
        field: field ?? "the port in platform.json",
      });
    });
}

/** The services of the plan that publish one of these ports on the host: the router, and the service of a web brick. */
function servicesPublishing(plan: Plan, ports: number[]): string[] {
  return [
    ...(plan.router && ports.includes(plan.router.port) ? [plan.router.name] : []),
    ...plan.services.filter((s) => s.web && ports.includes(s.web.port)).map((s) => s.name),
  ];
}

/**
 * The services that run without the host port the plan gives them (the router, a web brick's service). Docker can start a
 * container whose first start failed to bind its port, after which it runs with no published port and `up` would say
 * the platform is up (seen on Docker 28: the router "Up", `bound = {}`). `rows` are the running containers of the project.
 */
export function composeUnpublished(plan: Plan, rows: ComposeRow[]): { service: string; issue: Issue }[] {
  const expected = [
    ...(plan.router ? [{ service: plan.router.name, port: plan.router.port, what: "the router", field: "router.port" }] : []),
    ...plan.services.flatMap((s) =>
      s.web ? [{ service: s.name, port: s.web.port, what: `the pages of "${s.brick}"`, field: `bricks.${s.brick}.webPort` }] : [],
    ),
  ];
  return expected.flatMap((e) => {
    const row = rows.find((r) => r.Service === e.service);
    if (!row || row.State !== "running") return [];
    if ((row.Publishers ?? []).some((p) => p.PublishedPort === e.port)) return [];
    return [
      {
        service: e.service,
        issue: issue("HOST_PORT_NOT_PUBLISHED", `platform.json#/${e.field.replaceAll(".", "/")}`, {
          port: String(e.port),
          what: e.what,
          field: e.field,
        }),
      },
    ];
  });
}

/** Removes (stopped first) these containers of the project, so that the next `up` creates them again with their port. */
function composeRemove(deps: RuntimeDeps, root: string, plan: Plan, services: string[]): void {
  if (services.length) run(deps, root, "docker", [...composeBase(plan), "rm", "--stop", "--force", ...services]);
}

function composeWaitTimeouts(deps: RuntimeDeps, root: string, plan: Plan, failure: string): Issue[] {
  const named = plan.requirements.filter((req) => req.wait && failure.includes(`"${req.wait.name}"`));
  if (!named.length) return [];
  const r = run(deps, root, "docker", [...composeBase(plan), "ps", "--all", "--format", "json"]);
  if (r.status !== 0) return [];
  const text = r.stdout.trim();
  let rows: { Service?: string; ExitCode?: number }[] = [];
  try {
    // Compose prints either one JSON array or one JSON object per line, depending on its version.
    rows = text.startsWith("[")
      ? JSON.parse(text)
      : text
          .split(/\r?\n/)
          .filter(Boolean)
          .map((l) => JSON.parse(l));
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

/**
 * Checks the cluster the user named and returns the kubectl flags that pin it. Called first by
 * up and down, before any file is written or any command run.
 */
export function k8sTargetFlags(target: K8sTarget | undefined): string[] {
  const { context, kubeconfig, allowContext } = target ?? {};
  if (!context) throw new PlugbricksError([issue("K8S_CONTEXT_REQUIRED", "")]);
  if ((PROTECTED_CONTEXTS as readonly string[]).includes(context) && allowContext !== context) {
    throw new PlugbricksError([issue("K8S_CONTEXT_REFUSED", "", { context })]);
  }
  if (kubeconfig !== undefined && !(existsSync(kubeconfig) && statSync(kubeconfig).isFile())) {
    throw new PlugbricksError([issue("K8S_KUBECONFIG_NOT_FOUND", "", { path: kubeconfig })]);
  }
  return [...(kubeconfig !== undefined ? ["--kubeconfig", kubeconfig] : []), "--context", context];
}

/**
 * The only way the drivers call kubectl: the cluster flags always come first, so no command can
 * run against whatever context happens to be current.
 */
function kubectl(deps: RuntimeDeps, root: string, target: string[], args: string[], timeoutMs?: number): ExecResult {
  return run(deps, root, "kubectl", [...target, ...args], timeoutMs);
}

const kubectlBase = (plan: Plan) => ["--namespace", plan.platform];

/** The wait init containers of one Deployment: a service's waits on capabilities, or the router's wait for its oidc provider (D19). */
function k8sWaits(
  plan: Plan,
  name: string,
): { init: string; consumer: string; capability: string; provider: string; timeoutSeconds: number }[] {
  if (plan.router?.name === name) {
    const auth = plan.router.auth;
    return auth
      ? [
          {
            init: initContainerName("wait", "oidc"),
            consumer: "router",
            capability: "oidc",
            provider: auth.provider,
            timeoutSeconds: auth.wait.timeoutSeconds,
          },
        ]
      : [];
  }
  const s = plan.services.find((x) => x.name === name);
  if (!s) return [];
  return plan.requirements
    .filter((req) => req.consumer === s.brick && req.wait)
    .map((req) => ({
      init: initContainerName("wait", req.capability),
      consumer: req.consumer,
      capability: req.capability,
      provider: req.provider,
      timeoutSeconds: req.wait!.timeoutSeconds,
    }));
}

/** Wait init containers that exited with the timeout code, from the pods of one Deployment. */
function k8sWaitTimeouts(deps: RuntimeDeps, root: string, target: string[], plan: Plan, service: string): Issue[] {
  const waits = k8sWaits(plan, service);
  if (!waits.length) return [];
  const r = kubectl(deps, root, target, [
    ...kubectlBase(plan),
    "get",
    "pods",
    "--selector",
    `${SERVICE_LABEL}=${service}`,
    "--output",
    "json",
  ]);
  if (r.status !== 0) return [];
  type ContainerState = { terminated?: { exitCode?: number }; waiting?: object };
  let pods: { status?: { initContainerStatuses?: { name: string; state?: ContainerState; lastState?: ContainerState }[] } }[];
  try {
    pods = JSON.parse(r.stdout).items ?? [];
  } catch {
    return [];
  }
  return waits.flatMap((w) => {
    const timedOut = pods.some((p) =>
      (p.status?.initContainerStatuses ?? []).some(
        // The current state, or the last one while the container waits to be restarted
        // (CrashLoopBackOff). A 124 followed by a success is history, not the cause.
        (c) =>
          c.name === w.init &&
          (c.state?.terminated?.exitCode === WAIT_TIMEOUT_EXIT ||
            (c.state?.waiting !== undefined && c.lastState?.terminated?.exitCode === WAIT_TIMEOUT_EXIT)),
      ),
    );
    return timedOut
      ? [
          issue("WAIT_TIMEOUT", "", {
            consumer: w.consumer,
            capability: w.capability,
            provider: w.provider,
            timeoutSeconds: String(w.timeoutSeconds),
          }),
        ]
      : [];
  });
}

/** How long one `kubectl rollout status` waits, for a service that waits on a capability, before its wait init containers are looked at again. */
export const ROLLOUT_SLICE_SECONDS = 15;

/**
 * Waits for one Deployment's rollout. A service that waits on a capability is waited for in slices, and its wait init
 * containers are looked at after each one: a wait that exited with the timeout code (124) is reported as WAIT_TIMEOUT
 * at once, as Docker Compose does, instead of after the whole rollout deadline (the timeouts of its waits plus 300 s).
 * Kubernetes restarts a failed init container, so the rollout itself would only fail at that deadline. Any other
 * failure of `rollout status` is reported as it is, at once.
 */
function waitForRollout(deps: RuntimeDeps, root: string, target: string[], plan: Plan, name: string): void {
  const total = rolloutTimeout(plan, name);
  // A service's waits, or the router's wait for its oidc provider: both are init containers that exit 124.
  const waits = k8sWaits(plan, name).length > 0;
  const slice = waits ? ROLLOUT_SLICE_SECONDS : total;
  for (let waited = 0; ; waited += slice) {
    const seconds = Math.min(slice, total - waited);
    const args = [...kubectlBase(plan), "rollout", "status", `deployment/${name}`, `--timeout=${seconds}s`];
    const r = kubectl(deps, root, target, args);
    if (r.status === 0) return;
    const timeouts = waits ? k8sWaitTimeouts(deps, root, target, plan, name) : [];
    if (timeouts.length) throw new PlugbricksError(timeouts);
    const sliceEnded = /timed out waiting/i.test(r.stderr + r.stdout);
    if (!sliceEnded || waited + seconds >= total) throw new PlugbricksError([failed("kubectl", [...target, ...args], r)]);
  }
}

/** Label selector of everything plugbricks created for bricks that are no longer installed. */
export function removedBricksSelector(plan: Plan): string {
  const installed = [...new Set(plan.services.map((s) => s.brick))].sort();
  return installed.length
    ? `${MANAGED_BY}=plugbricks,${BRICK_LABEL},${BRICK_LABEL} notin (${installed.join(",")})`
    : `${MANAGED_BY}=plugbricks,${BRICK_LABEL}`;
}

/** How long `docker compose up --wait` may take: the longest chain of waits, plus time to pull images and start. */
function composeWaitTimeout(plan: Plan): number {
  const services = plan.services.map((s) => rolloutTimeout(plan, s.name));
  // The router starts only once its oidc provider is healthy (D19): its chain is the provider's, then its own start.
  const auth = plan.router?.auth;
  const provider = auth && plan.services.some((s) => s.name === auth.service) ? rolloutTimeout(plan, auth.service) : 0;
  const router = plan.router ? provider + 300 : 0;
  return Math.max(0, router, ...services);
}

/** How long `up` waits for one Deployment: its own wait timeouts, plus time to pull images and start. */
function rolloutTimeout(plan: Plan, service: string): number {
  // The router: time to pull its image and start, plus its wait for the oidc provider when it checks tokens (D19).
  if (plan.router?.name === service) return 300 + (plan.router.auth?.wait.timeoutSeconds ?? 0);
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
  // First, so a refused cluster changes nothing: not even .generated/ or .secrets/.
  const target = runtime === "k8s" ? k8sTargetFlags(deps.k8s) : [];
  const generated = generate(root, runtime, deps);
  const { plan } = generated;
  const dir = resolve(root);

  if (runtime === "compose") {
    requireTool(deps, dir, "docker", ["compose", "version"], "docker compose", "install Docker with the Compose v2 plugin");
    // --remove-orphans removes the containers of removed bricks; their volumes stay. Compose
    // refuses "up" on a project without services: with no brick left, "down" does the same job.
    // --wait: return only once every service runs (and is healthy when it has a healthcheck) and
    // every wait and provision task has exited 0, as `kubectl rollout status` does on Kubernetes.
    // A router alone runs too: a platform whose only subgraphs run elsewhere (D33).
    const args =
      plan.services.length || plan.router
        ? [...composeBase(plan), "up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", String(composeWaitTimeout(plan))]
        : ["compose", "--project-name", plan.platform, "down", "--remove-orphans"];
    const r = run(deps, dir, "docker", args);
    if (r.status !== 0) {
      const timeouts = composeWaitTimeouts(deps, dir, plan, r.stderr + r.stdout);
      const busy = composeBusyPorts(plan, r.stderr + r.stdout);
      // A container that failed to bind its port stays created: left there, the next `up` would start it with no port.
      if (!timeouts.length && busy.length)
        composeRemove(
          deps,
          dir,
          plan,
          servicesPublishing(
            plan,
            busy.map((i) => Number(i.params!.port)),
          ),
        );
      throw new PlugbricksError(timeouts.length ? timeouts : busy.length ? busy : [failed("docker", args, r)]);
    }
    if (plan.router || plan.services.some((s) => s.web)) {
      const listed = run(deps, dir, "docker", [...composeBase(plan), "ps", "--format", "json"]);
      if (listed.status === 0) {
        let rows: ComposeRow[] = [];
        try {
          rows = parseComposePs(listed.stdout);
        } catch {
          // a listing that cannot be read says nothing: the check is only made on one that can
        }
        const missing = composeUnpublished(plan, rows);
        if (missing.length) {
          composeRemove(
            deps,
            dir,
            plan,
            missing.map((m) => m.service),
          );
          throw new PlugbricksError(missing.map((m) => m.issue));
        }
      }
    }
  } else {
    requireKubectl(deps, dir, target);
    for (const f of [K8S_NAMESPACE_FILE, K8S_SECRET_FILE, K8S_RESOURCES_FILE]) {
      // kubectl refuses a file with no object in it.
      if (f === K8S_RESOURCES_FILE && plan.services.length === 0 && !plan.router) continue;
      const args = ["apply", "--filename", f];
      const r = kubectl(deps, dir, target, args);
      if (r.status !== 0) throw new PlugbricksError([failed("kubectl", [...target, ...args], r)]);
    }
    const cleanup = [...kubectlBase(plan), "delete", DISPOSABLE_KINDS, "--selector", removedBricksSelector(plan), "--ignore-not-found"];
    const c = kubectl(deps, dir, target, cleanup);
    if (c.status !== 0) throw new PlugbricksError([failed("kubectl", [...target, ...cleanup], c)]);
    if (!plan.router) {
      // The router belongs to no brick: with the last subgraph gone, it goes too.
      const router = [
        ...kubectlBase(plan),
        "delete",
        DISPOSABLE_KINDS,
        "--selector",
        `${MANAGED_BY}=plugbricks,${COMPONENT_LABEL}=${ROUTER_NAME}`,
        "--ignore-not-found",
      ];
      const gone = kubectl(deps, dir, target, router);
      if (gone.status !== 0) throw new PlugbricksError([failed("kubectl", [...target, ...router], gone)]);
    }
    for (const name of [...plan.services.map((s) => s.name), ...(plan.router ? [plan.router.name] : [])]) {
      waitForRollout(deps, dir, target, plan, name);
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
      const r = runtime === "compose" ? run(deps, dir, "docker", args) : kubectl(deps, dir, target, args);
      // A volume that is already gone counts as deleted.
      if (r.status === 0 || (runtime === "compose" && /no such volume/i.test(r.stderr))) pruned.push(v);
      else
        problems.push(
          issue("VOLUME_PRUNE_FAILED", "", { volume: `${v.brick}/${v.service}/${v.name}`, detail: lastLines(r.stderr || r.stdout, 1) }),
        );
    }
    confirmPruned(root, pruned);
  }
  const prunedKeys = new Set(pruned.map(volumeName));
  return { generated, pruned, pending: candidates.filter((v) => !prunedKeys.has(volumeName(v))), problems };
}

/** Stops the platform. Never deletes a volume, a PersistentVolumeClaim or the secrets. */
export function down(root: string, runtime: Runtime, deps: RuntimeDeps = {}): void {
  const target = runtime === "k8s" ? k8sTargetFlags(deps.k8s) : [];
  const project = readProject(root);
  const platform = project.platform.name;
  if (runtime === "compose") {
    requireTool(deps, project.root, "docker", ["compose", "version"], "docker compose", "install Docker with the Compose v2 plugin");
    // By project name only: works even when .generated/ was deleted. No --volumes, ever.
    const args = ["compose", "--project-name", platform, "down", "--remove-orphans"];
    const r = run(deps, project.root, "docker", args);
    if (r.status !== 0) throw new PlugbricksError([failed("docker", args, r)]);
  } else {
    requireKubectl(deps, project.root, target);
    const args = ["--namespace", platform, "delete", DISPOSABLE_KINDS, "--selector", `${MANAGED_BY}=plugbricks`, "--ignore-not-found"];
    const r = kubectl(deps, project.root, target, args);
    if (r.status !== 0) throw new PlugbricksError([failed("kubectl", [...target, ...args], r)]);
  }
}

// ---------- status --runtime ----------

/** The runtime could not be read: not installed, not answering, or too slow. `status --runtime` exits with STATUS_UNAVAILABLE_EXIT. */
export class RuntimeUnavailableError extends PlugbricksError {}

/** Exit code of `status --runtime` when an enabled service is starting, unhealthy, stopped or not deployed. */
export const STATUS_DEGRADED_EXIT = 3;
/** Exit code of `status --runtime` when the runtime cannot be read (RUNTIME_UNAVAILABLE). */
export const STATUS_UNAVAILABLE_EXIT = 4;
/** Every call `status --runtime` makes is killed after this long. */
export const STATUS_CALL_TIMEOUT_MS = 15_000;
/** kubectl's own limit for one request to the API server, below STATUS_CALL_TIMEOUT_MS. */
export const KUBECTL_REQUEST_TIMEOUT = "10s";

function unavailable(runtime: Runtime, detail: string): RuntimeUnavailableError {
  return new RuntimeUnavailableError([
    issue("RUNTIME_UNAVAILABLE", "", { runtime: runtime === "k8s" ? "Kubernetes" : "Docker Compose", detail }),
  ]);
}

/** Why one read call failed, in one line: not installed, timed out, or the tool's last line of error output. */
function callFailure(cmd: string, args: string[], r: ExecResult): string {
  if (r.error === "ENOENT") return `${cmd} was not found`;
  if (r.error === "ETIMEDOUT") return `"${shown(cmd, args)}" did not answer within ${STATUS_CALL_TIMEOUT_MS / 1000} s`;
  if (r.error) return `"${shown(cmd, args)}" could not run (${r.error})`;
  return `"${shown(cmd, args)}" exited with ${r.status}${lastLines(r.stderr || r.stdout, 1) ? `: ${lastLines(r.stderr || r.stdout, 1)}` : ""}`;
}

/**
 * Reads what the runtime runs for this platform and compares it with the plan. Read-only (D10): one
 * listing call, plus `docker inspect` for the restart counts on Compose; never exec, logs, Secrets,
 * environment variables or a request to a service. Every call has a timeout. For Kubernetes the
 * cluster must be named, with the same guards as up and down. `problems` are the declared state's.
 */
export function statusRuntime(root: string, runtime: Runtime, problems: Issue[], deps: RuntimeDeps = {}): LiveStatus {
  const steps = statusSteps(root, runtime, problems, deps);
  const quiet: RuntimeDeps = { ...deps, log: undefined };
  let next = steps.next();
  while (!next.done) {
    const c = next.value;
    next = steps.next(run(quiet, c.cwd, c.cmd, c.args, STATUS_CALL_TIMEOUT_MS));
  }
  return next.value;
}

/** Runs a program without a shell, without blocking the event loop. Same result shape as Exec. */
export type AsyncExec = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<ExecResult>;

const ASYNC_MAX_OUTPUT = 64 * 1024 * 1024;

export const defaultAsyncExec: AsyncExec = (cmd, args, opts) =>
  new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    let settled = false;
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const stop = (why: string) => {
      error ??= why;
      child.kill("SIGKILL");
    };
    const timer = opts.timeoutMs !== undefined ? setTimeout(() => stop("ETIMEDOUT"), opts.timeoutMs) : undefined;
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
      if (stdout.length > ASYNC_MAX_OUTPUT) stop("ENOBUFS");
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
      if (stderr.length > ASYNC_MAX_OUTPUT) stop("ENOBUFS");
    });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ status: null, stdout, stderr, error: e.code ?? e.message }));
    child.on("close", (code) => finish({ status: error ? null : code, stdout, stderr, ...(error ? { error } : {}) }));
  });

/**
 * statusRuntime for a server: the same calls and the same report, but each call runs without
 * blocking the event loop. `execAsync` replaces the programs (tests); a synchronous `exec` is also
 * accepted and wrapped.
 */
export async function statusRuntimeAsync(
  root: string,
  runtime: Runtime,
  problems: Issue[],
  deps: RuntimeDeps & { execAsync?: AsyncExec } = {},
): Promise<LiveStatus> {
  const exec: AsyncExec = deps.execAsync ?? (deps.exec ? async (c, a, o) => deps.exec!(c, a, o) : defaultAsyncExec);
  const steps = statusSteps(root, runtime, problems, deps);
  let next = steps.next();
  while (!next.done) {
    const c = next.value;
    next = steps.next(await exec(c.cmd, c.args, { cwd: c.cwd, timeoutMs: STATUS_CALL_TIMEOUT_MS }));
  }
  return next.value;
}

/** One read call statusSteps needs; the driver runs it and passes the result back. */
interface StatusCall {
  cmd: string;
  args: string[];
  cwd: string;
}

/** The single definition of what status --runtime reads and how it builds the report. */
function* statusSteps(root: string, runtime: Runtime, problems: Issue[], deps: RuntimeDeps): Generator<StatusCall, LiveStatus, ExecResult> {
  // First, as for up and down: a refused cluster is refused before anything runs.
  const target = runtime === "k8s" ? k8sTargetFlags(deps.k8s) : [];
  const project = readProject(root);
  const plan = planProject(project);
  const dir = project.root;
  // Labels per installed brick, for the report; the lock is the source of truth. A disabled brick is
  // still reported, with its services from the installed copy.
  const tags = new Map(Object.entries(project.lock.bricks).map(([brick, locked]) => [brick, locked.tags ?? []]));
  const installed = loadInstalledBricks(project);
  const disabled = Object.entries(project.lock.bricks)
    .filter(([brick]) => !isBrickEnabled(project.platform, brick))
    .map(([brick, locked]) => ({
      name: brick,
      tags: locked.tags ?? [],
      services: (installed.get(brick)?.services ?? []).map((service) => ({
        name: serviceName(brick, service.name),
        service: service.name,
      })),
    }));
  // No progress lines (the drivers run quietly): stdout may be a JSON document.
  const call = (cmd: string, args: string[]): StatusCall => ({ cmd, args, cwd: dir });

  if (runtime === "compose") {
    const version = ["compose", "version"];
    const v = yield call("docker", version);
    if (v.error || v.status !== 0) throw unavailable(runtime, callFailure("docker", version, v));
    // By project name, like down: works even when .generated/ was deleted.
    const ps = ["compose", "--project-name", plan.platform, "ps", "--all", "--format", "json"];
    const listed = yield call("docker", ps);
    if (listed.error || listed.status !== 0) throw unavailable(runtime, callFailure("docker", ps, listed));
    let ids: string[];
    try {
      ids = parseComposePs(listed.stdout)
        .map((r) => r.ID ?? "")
        .filter(Boolean);
    } catch {
      throw unavailable(runtime, `unexpected output from "${shown("docker", ps)}"`);
    }
    // Restart counts only; a container removed between the two calls just has no count.
    const inspected = ids.length ? yield call("docker", ["inspect", "--format", DOCKER_INSPECT_TEMPLATE, ...ids]) : undefined;
    const inspectText = (inspected?.stdout ?? "")
      .split(/\r?\n/)
      .filter((l) => l.startsWith("{"))
      .join("\n");
    return buildLiveStatus({
      plan,
      runtime,
      context: null,
      problems,
      tags,
      disabled,
      ...composeLiveInput(plan, listed.stdout, inspectText),
    });
  }

  const client = yield call("kubectl", [...target, "version", "--client"]);
  if (client.error || client.status !== 0) throw unavailable(runtime, callFailure("kubectl", ["version", "--client"], client));
  // Deployments, Pods and Services only: never Secrets, never ConfigMaps.
  const get = [
    `--request-timeout=${KUBECTL_REQUEST_TIMEOUT}`,
    ...kubectlBase(plan),
    "get",
    "deployments,pods,services",
    "--selector",
    MANAGED_SELECTOR,
    "--output",
    "json",
  ];
  const listed = yield call("kubectl", [...target, ...get]);
  if (listed.error || listed.status !== 0) throw unavailable(runtime, callFailure("kubectl", [...target, ...get], listed));
  try {
    return buildLiveStatus({
      plan,
      runtime,
      context: deps.k8s?.context ?? null,
      problems,
      tags,
      disabled,
      ...k8sLiveInput(plan, listed.stdout),
    });
  } catch (e) {
    if (e instanceof PlugbricksError) throw e;
    throw unavailable(runtime, `unexpected output from "${shown("kubectl", [...target, ...get])}"`);
  }
}
