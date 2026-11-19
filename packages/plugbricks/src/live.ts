import { WAIT_TIMEOUT_EXIT } from "./drivers/common.js";
import { BRICK_LABEL, MANAGED_BY, SERVICE_LABEL } from "./drivers/k8s.js";
import { initContainerName, type Plan } from "./plan.js";
import type { Issue } from "./issues.js";

/**
 * `plugbricks status --runtime`: what the runtime really runs, next to what platform.json declares.
 * Read-only by design (docs/decisions.md, D10): it lists containers, Deployments, Pods and Services
 * and reads their state. It never execs into a container, never reads logs, Secrets or environment
 * variables, and never sends a request to a service: the health it reports is the runtime's own.
 *
 * Everything in this file is pure: the runtime's output goes in as text, the report comes out. The
 * commands that produce that text live in runtime.ts (statusRuntime), with a bounded timeout each.
 * The report's shape is schemas/status-runtime.schema.json, version 1.
 */

export const LIVE_STATUS_VERSION = 1;

export const LIVE_STATES = ["healthy", "starting", "unhealthy", "stopped", "not deployed", "unknown"] as const;
export type LiveState = (typeof LIVE_STATES)[number];

/** States that make `status --runtime` exit with STATUS_DEGRADED_EXIT when an enabled service is in one. */
export const DEGRADED_STATES: readonly LiveState[] = ["starting", "unhealthy", "stopped", "not deployed"];

/** What the runtime says about one service (all its containers or pods together). */
export interface Observed {
  state: LiveState;
  /** Short, fixed wording built from numbers and the runtime's reason codes; never a log line or a message. */
  reason: string | null;
  restarts: number;
  /** Container names (Compose) or pod names (Kubernetes), sorted. */
  instances: string[];
  /** Image the runtime reports for the first instance, as a reference (tag and digest when it has them). */
  image: string | null;
  /** Kubernetes: the brick label of the Deployment. Compose has no such label. */
  brick?: string | null;
}

export interface LiveService {
  /** Runtime name: Compose service, Kubernetes Deployment. */
  name: string;
  /** Name of the service in its brick's plugin.json; null for something plugbricks did not declare. */
  service: string | null;
  /** Installed in platform.json. plugbricks has no switch to disable an installed brick yet: every installed one is enabled. */
  enabled: boolean;
  /** The runtime has at least one container (Compose) or a Deployment (Kubernetes) for it, in any state. */
  deployed: boolean;
  state: LiveState;
  reason: string | null;
  restarts: number;
  instances: string[];
  /** Serves a subgraph behind the router. */
  subgraph: boolean;
  /** "not-deployed": enabled but the runtime has nothing; "not-declared": the runtime runs it but platform.json does not list it. */
  mismatch: "not-deployed" | "not-declared" | null;
}

export interface LiveBrick {
  name: string;
  enabled: boolean;
  /** Labels of the manifest, from the lock (empty when it declares none). */
  tags: string[];
  services: LiveService[];
}

export interface LiveRouter {
  name: string;
  enabled: boolean;
  deployed: boolean;
  state: LiveState;
  reason: string | null;
  restarts: number;
  instances: string[];
  mismatch: "not-deployed" | "not-declared" | null;
  /** Compose: the host address it is published on (127.0.0.1:<port>). Kubernetes: its Service, <cluster IP>:<port>. Null when not deployed. */
  address: string | null;
  /** The pinned reference platform.json's plan asks for. */
  image: string;
  /** sha256 digest of the image the runtime reports running, or null when it reports none. */
  digest: string | null;
  /** State of each subgraph service the router calls, so that a subgraph that is down shows here too. */
  subgraphs: { brick: string; name: string; state: LiveState }[];
}

export interface LiveStatus {
  version: typeof LIVE_STATUS_VERSION;
  platform: string;
  runtime: "compose" | "k8s";
  /** The kubectl context it was read from; null on Compose. */
  context: string | null;
  /** "healthy" when no enabled service is in a degraded state (DEGRADED_STATES). */
  state: "healthy" | "degraded";
  bricks: LiveBrick[];
  router: LiveRouter | null;
  /** Things the runtime runs under this platform's name that platform.json does not declare (a removed brick before the next up). */
  undeclared: LiveService[];
  /** Problems of the declared state (the same issues as `plugbricks status`). */
  problems: { code: string; path: string; message: string; params: Record<string, string> }[];
}

/** How bad each state is, the worst last: the one order used by status --runtime and the admin. */
export const SEVERITY: Record<LiveState, number> = { healthy: 0, unknown: 1, starting: 2, stopped: 3, "not deployed": 4, unhealthy: 5 };

/** The worst of several instances: one unhealthy pod among two makes the service unhealthy. */
function worst(parts: Observed[]): Observed {
  const sorted = [...parts].sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state]);
  return {
    ...sorted[0],
    restarts: parts.reduce((n, p) => n + p.restarts, 0),
    instances: parts.flatMap((p) => p.instances).sort(),
  };
}

export const digestOf = (image: string | null | undefined): string | null => /@(sha256:[a-f0-9]{64})$/.exec(image ?? "")?.[1] ?? null;

// ---------- Docker Compose ----------

/** The fields of `docker compose ps --all --format json` that plugbricks reads. */
export interface ComposeRow {
  ID?: string;
  Name?: string;
  Service?: string;
  State?: string;
  Health?: string;
  Status?: string;
  ExitCode?: number;
  Image?: string;
  Publishers?: { URL?: string; TargetPort?: number; PublishedPort?: number; Protocol?: string }[] | null;
}

/**
 * Parses `docker compose ps --format json`. Compose up to 2.20 prints one JSON array; later versions
 * print one JSON object per line. An empty output means no container. Throws on anything else.
 */
export function parseComposePs(text: string): ComposeRow[] {
  const t = text.trim();
  if (t === "") return [];
  if (t.startsWith("[")) return JSON.parse(t) as ComposeRow[];
  return t
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as ComposeRow);
}

export interface InspectRow {
  id: string;
  restartCount: number;
  oomKilled: boolean;
}

/**
 * Go template for `docker inspect --format`: the restart count and the OOM flag, nothing else. The
 * template names each field it prints, so the configuration (and its environment) is never output.
 */
export const DOCKER_INSPECT_TEMPLATE = '{"id":{{json .Id}},"restartCount":{{.RestartCount}},"oomKilled":{{.State.OOMKilled}}}';

export function parseInspect(text: string): InspectRow[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as InspectRow);
}

/** One container: its state from the Compose listing, its restart count from inspect. */
export function composeContainerState(row: ComposeRow, inspect?: InspectRow, hasHealthcheck = true): Observed {
  const base = {
    restarts: inspect?.restartCount ?? 0,
    instances: row.Name ? [row.Name] : [],
    image: row.Image ?? null,
  };
  const exit = row.ExitCode ?? 0;
  const oom = inspect?.oomKilled ? ", out of memory" : "";
  switch (row.State) {
    case "running":
      if (row.Health === "healthy") return { ...base, state: "healthy", reason: null };
      if (row.Health === "starting") return { ...base, state: "starting", reason: "health check not passed yet" };
      if (row.Health === "unhealthy") return { ...base, state: "unhealthy", reason: "health check failing" };
      return { ...base, state: "unknown", reason: hasHealthcheck ? "running; no health reported" : "running; no health check" };
    case "restarting": {
      // ExitCode is 0 while restarting: the code of the last exit is only in Status, "Restarting (255) 3 seconds ago".
      const code = /^Restarting \((\d+)\)/.exec(row.Status ?? "")?.[1];
      return { ...base, state: "unhealthy", reason: `restarting${code ? ` after exit code ${code}` : ""}${oom}` };
    }
    case "exited":
      return { ...base, state: "stopped", reason: `exited with code ${exit}${oom}` };
    case "created":
      return { ...base, state: "stopped", reason: "created, never started" };
    case "paused":
      return { ...base, state: "stopped", reason: "paused" };
    case "dead":
      return { ...base, state: "stopped", reason: "dead" };
    case "removing":
      return { ...base, state: "stopped", reason: "being removed" };
    default:
      return { ...base, state: "unknown", reason: `Docker state "${row.State ?? ""}"` };
  }
}

/**
 * Groups the containers by Compose service. inspect rows are matched by id: Compose prints the short
 * id (12 characters), docker inspect the full one.
 */
export function observeCompose(rows: ComposeRow[], inspect: InspectRow[], healthchecks: Set<string>): Map<string, Observed> {
  const byService = new Map<string, Observed[]>();
  for (const row of rows) {
    if (!row.Service) continue;
    const ins = inspect.find((i) => row.ID !== undefined && row.ID !== "" && i.id.startsWith(row.ID));
    const list = byService.get(row.Service) ?? [];
    list.push(composeContainerState(row, ins, healthchecks.has(row.Service)));
    byService.set(row.Service, list);
  }
  return new Map([...byService].map(([s, parts]) => [s, worst(parts)]));
}

/** Compose: the address the router is published on, from the Publishers of its container. */
export function composePublished(rows: ComposeRow[], service: string): string | null {
  for (const row of rows) {
    if (row.Service !== service) continue;
    const p = (row.Publishers ?? []).find((x) => (x.PublishedPort ?? 0) > 0);
    if (p) return `${p.URL || "0.0.0.0"}:${p.PublishedPort}`;
  }
  return null;
}

/** Why a consumer that does not run is stuck: its wait or provision task, read from the same listing. */
function composeTaskReason(plan: Plan, brick: string, rows: ComposeRow[]): string | null {
  for (const req of plan.requirements.filter((r) => r.consumer === brick)) {
    const row = (name: string) => rows.find((r) => r.Service === name);
    const wait = req.wait && row(req.wait.name);
    if (wait && wait.State === "exited" && wait.ExitCode === WAIT_TIMEOUT_EXIT) {
      return `WAIT_TIMEOUT: gave up waiting for ${req.capability} from ${req.provider} after ${req.wait!.timeoutSeconds}s`;
    }
    if (wait && wait.State === "exited" && wait.ExitCode !== 0) return `wait task ${req.wait!.name} exited with code ${wait.ExitCode}`;
    const prov = row(req.provision.name);
    if (prov && prov.State === "exited" && prov.ExitCode !== 0)
      return `provision task ${req.provision.name} exited with code ${prov.ExitCode}`;
  }
  return null;
}

// ---------- Kubernetes ----------

type K8sContainerState = {
  waiting?: { reason?: string };
  running?: object;
  terminated?: { exitCode?: number; reason?: string };
};
type K8sContainerStatus = {
  name: string;
  ready?: boolean;
  started?: boolean;
  restartCount?: number;
  image?: string;
  imageID?: string;
  state?: K8sContainerState;
  lastState?: K8sContainerState;
};
export interface K8sObject {
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    replicas?: number;
    clusterIP?: string;
    ports?: { port?: number }[];
    /** Pod. */
    containers?: { image?: string }[];
    /** Deployment. */
    template?: { spec?: { containers?: { image?: string }[] } };
  };
  status?: {
    phase?: string;
    replicas?: number;
    readyReplicas?: number;
    conditions?: { type?: string; status?: string; reason?: string }[];
    containerStatuses?: K8sContainerStatus[];
    initContainerStatuses?: K8sContainerStatus[];
  };
}

/** `kubectl get deployments,pods,services --output json`: a List of items. */
export function parseK8sList(text: string): K8sObject[] {
  const doc = JSON.parse(text) as { items?: K8sObject[] };
  if (!Array.isArray(doc.items)) throw new Error("kubectl did not return a List");
  return doc.items;
}

const PULL_ERRORS = new Set(["ImagePullBackOff", "ErrImagePull", "InvalidImageName", "ErrImageNeverPull"]);

/** One pod. `rollingOut`: the Deployment is still rolling out, so a pod not ready yet is starting, not failing. */
export function k8sPodState(pod: K8sObject, rollingOut: boolean, hasHealthcheck = true): Observed {
  const st = pod.status ?? {};
  const all = [...(st.initContainerStatuses ?? []), ...(st.containerStatuses ?? [])];
  const base = {
    restarts: all.reduce((n, c) => n + (c.restartCount ?? 0), 0),
    instances: pod.metadata?.name ? [pod.metadata.name] : [],
    image: st.containerStatuses?.[0]?.imageID || st.containerStatuses?.[0]?.image || pod.spec?.containers?.[0]?.image || null,
  };
  const exitOf = (s?: K8sContainerState) => s?.terminated?.exitCode;

  for (const c of st.initContainerStatuses ?? []) {
    const waiting = c.state?.waiting?.reason;
    if (waiting && PULL_ERRORS.has(waiting))
      return { ...base, state: "unhealthy", reason: `image pull error (${waiting}) in init container ${c.name}` };
    if (waiting === "CrashLoopBackOff") {
      const code = exitOf(c.lastState);
      if (code === WAIT_TIMEOUT_EXIT && c.name.startsWith(initContainerName("wait", ""))) {
        return { ...base, state: "unhealthy", reason: `WAIT_TIMEOUT: init container ${c.name} gave up, CrashLoopBackOff` };
      }
      return {
        ...base,
        state: "unhealthy",
        reason: `init container ${c.name}: CrashLoopBackOff${code !== undefined ? ` (exit code ${code})` : ""}`,
      };
    }
    const code = exitOf(c.state);
    if (code !== undefined && code !== 0) {
      return {
        ...base,
        state: "unhealthy",
        reason:
          code === WAIT_TIMEOUT_EXIT && c.name.startsWith(initContainerName("wait", ""))
            ? `WAIT_TIMEOUT: init container ${c.name} gave up`
            : `init container ${c.name} exited with code ${code}`,
      };
    }
    if (c.state?.running) return { ...base, state: "starting", reason: `init container ${c.name} running` };
    if (waiting) return { ...base, state: "starting", reason: `init container ${c.name}: ${waiting}` };
  }

  if (st.phase === "Pending" && !(st.containerStatuses ?? []).some((c) => c.state?.running)) {
    const scheduled = st.conditions?.find((c) => c.type === "PodScheduled");
    if (scheduled?.status === "False") return { ...base, state: "unhealthy", reason: `Pending: ${scheduled.reason ?? "not scheduled"}` };
  }
  if (st.phase === "Failed" || st.phase === "Succeeded") return { ...base, state: "stopped", reason: `pod ${st.phase}` };

  const main = st.containerStatuses ?? [];
  if (main.length === 0) return { ...base, state: "starting", reason: st.phase ? `pod ${st.phase}` : "pod created" };
  for (const c of main) {
    const waiting = c.state?.waiting?.reason;
    if (waiting && PULL_ERRORS.has(waiting)) return { ...base, state: "unhealthy", reason: `image pull error (${waiting})` };
    if (waiting === "CrashLoopBackOff") {
      const code = exitOf(c.lastState);
      return { ...base, state: "unhealthy", reason: `CrashLoopBackOff${code !== undefined ? ` (last exit code ${code})` : ""}` };
    }
    if (waiting) return { ...base, state: "starting", reason: waiting };
    if (c.state?.terminated) {
      const t = c.state.terminated;
      return {
        ...base,
        state: "stopped",
        reason: t.reason === "OOMKilled" ? "out of memory (OOMKilled)" : `exited with code ${t.exitCode ?? "?"}`,
      };
    }
  }
  if (main.every((c) => c.ready)) {
    return hasHealthcheck ? { ...base, state: "healthy", reason: null } : { ...base, state: "unknown", reason: "running; no health check" };
  }
  if (main.some((c) => c.started === false)) return { ...base, state: "starting", reason: "startup probe not passed yet" };
  return rollingOut
    ? { ...base, state: "starting", reason: "readiness probe not passed yet" }
    : { ...base, state: "unhealthy", reason: "readiness probe failing" };
}

/** Deployments and their pods, by Deployment name. */
export function observeK8s(items: K8sObject[], healthchecks: Set<string>): Map<string, Observed> {
  const out = new Map<string, Observed>();
  const pods = items.filter((i) => i.kind === "Pod");
  for (const d of items.filter((i) => i.kind === "Deployment")) {
    const name = d.metadata?.name ?? "";
    const brick = d.metadata?.labels?.[BRICK_LABEL] ?? null;
    const image = d.spec?.template?.spec?.containers?.[0]?.image ?? null;
    if ((d.spec?.replicas ?? 1) === 0) {
      out.set(name, { state: "stopped", reason: "scaled to 0 replicas", restarts: 0, instances: [], image, brick });
      continue;
    }
    const progressing = d.status?.conditions?.find((c) => c.type === "Progressing");
    const rollingOut = progressing?.reason !== "NewReplicaSetAvailable";
    const mine = pods.filter((p) => p.metadata?.labels?.[SERVICE_LABEL] === name);
    if (mine.length === 0) {
      out.set(name, { state: rollingOut ? "starting" : "unhealthy", reason: "no pod", restarts: 0, instances: [], image, brick });
      continue;
    }
    out.set(name, { ...worst(mine.map((p) => k8sPodState(p, rollingOut, healthchecks.has(name)))), brick });
  }
  return out;
}

/** Kubernetes: the router Service, <cluster IP>:<port>. */
export function k8sServiceAddress(items: K8sObject[], name: string): string | null {
  const s = items.find((i) => i.kind === "Service" && i.metadata?.name === name);
  const ip = s?.spec?.clusterIP;
  const port = s?.spec?.ports?.[0]?.port;
  return ip && ip !== "None" && port ? `${ip}:${port}` : null;
}

// ---------- the report ----------

export interface LiveInput {
  plan: Plan;
  runtime: "compose" | "k8s";
  context: string | null;
  observed: Map<string, Observed>;
  /** Names of the runtime objects plugbricks knows (services, tasks, router): everything else observed is undeclared. */
  routerAddress: string | null;
  /** Compose: a task-based reason for consumers that do not run. */
  taskReason?: (brick: string) => string | null;
  /** Labels per installed brick (from the lock); absent means none. */
  tags?: Map<string, string[]>;
  /** Installed bricks that platform.json disables: still reported, never counted as degraded. */
  disabled?: { name: string; tags: string[]; services: { name: string; service: string }[] }[];
  problems: Issue[];
}

const NOT_DEPLOYED: Observed = { state: "not deployed", reason: "nothing deployed", restarts: 0, instances: [], image: null };

/** Names of the one-shot tasks (Compose services that run once): never reported as services. */
export function taskNames(plan: Plan): Set<string> {
  return new Set(plan.requirements.flatMap((r) => [...(r.wait ? [r.wait.name] : []), r.provision.name]));
}

export function buildLiveStatus(input: LiveInput): LiveStatus {
  const { plan, observed } = input;
  const subgraphServices = new Set(plan.router?.subgraphs.map((s) => s.service) ?? []);
  const stateOf = (name: string) => observed.get(name) ?? NOT_DEPLOYED;

  const bricks = new Map<string, LiveService[]>();
  for (const s of plan.services) {
    const o = stateOf(s.name);
    const deployed = observed.has(s.name);
    let reason = o.reason;
    if (o.state !== "healthy" && input.taskReason) reason = input.taskReason(s.brick) ?? reason;
    const list = bricks.get(s.brick) ?? [];
    list.push({
      name: s.name,
      service: s.service,
      enabled: true,
      deployed,
      state: o.state,
      reason,
      restarts: o.restarts,
      instances: o.instances,
      subgraph: subgraphServices.has(s.name),
      mismatch: deployed ? null : "not-deployed",
    });
    bricks.set(s.brick, list);
  }
  // A disabled brick is installed but not rendered: report it as stopped, with its own reason, and
  // never let it make the platform degraded.
  const disabledBricks = new Map((input.disabled ?? []).map((d) => [d.name, d]));
  for (const d of input.disabled ?? []) {
    if (bricks.has(d.name)) continue;
    bricks.set(
      d.name,
      d.services.map((s) => {
        const o = observed.get(s.name);
        return {
          name: s.name,
          service: s.service,
          enabled: false,
          deployed: o !== undefined,
          state: o?.state ?? ("stopped" as const),
          reason: o?.reason ?? "disabled in platform.json",
          restarts: o?.restarts ?? 0,
          instances: o?.instances ?? [],
          subgraph: false,
          mismatch: null,
        };
      }),
    );
  }

  let router: LiveRouter | null = null;
  if (plan.router) {
    const o = stateOf(plan.router.name);
    const deployed = observed.has(plan.router.name);
    router = {
      name: plan.router.name,
      enabled: true,
      deployed,
      state: o.state,
      reason: o.reason,
      restarts: o.restarts,
      instances: o.instances,
      mismatch: deployed ? null : "not-deployed",
      address: deployed ? input.routerAddress : null,
      image: plan.router.image,
      digest: deployed ? digestOf(o.image) : null,
      subgraphs: plan.router.subgraphs
        .map((s) => ({ brick: s.brick, name: s.service, state: stateOf(s.service).state }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  const known = new Set([
    ...plan.services.map((s) => s.name),
    ...(input.disabled ?? []).flatMap((d) => d.services.map((s) => s.name)),
    ...taskNames(plan),
    ...(plan.router ? [plan.router.name] : []),
  ]);
  const undeclared: LiveService[] = [...observed]
    .filter(([name]) => !known.has(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, o]) => ({
      name,
      service: null,
      enabled: false,
      deployed: true,
      state: o.state,
      reason: o.reason,
      restarts: o.restarts,
      instances: o.instances,
      subgraph: false,
      mismatch: "not-declared",
    }));

  const enabled = [...[...bricks.values()].flat().filter((s) => s.enabled), ...(router ? [router] : [])];
  const degraded = enabled.some((s) => DEGRADED_STATES.includes(s.state));
  return {
    version: LIVE_STATUS_VERSION,
    platform: plan.platform,
    runtime: input.runtime,
    context: input.context,
    state: degraded ? "degraded" : "healthy",
    bricks: [...bricks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, services]) => ({
        name,
        enabled: !disabledBricks.has(name),
        tags: input.tags?.get(name) ?? disabledBricks.get(name)?.tags ?? [],
        services: services.sort((a, b) => a.name.localeCompare(b.name)),
      })),
    router,
    undeclared,
    problems: input.problems.map((p) => ({ code: p.code, path: p.path, message: p.message, params: p.params })),
  };
}

/** Compose inputs to buildLiveStatus, from the two listings. */
export function composeLiveInput(
  plan: Plan,
  psText: string,
  inspectText: string,
): Pick<LiveInput, "observed" | "routerAddress" | "taskReason"> {
  const rows = parseComposePs(psText);
  const healthchecks = new Set(plan.services.filter((s) => s.healthcheck).map((s) => s.name));
  return {
    observed: observeCompose(rows, parseInspect(inspectText), healthchecks),
    routerAddress: plan.router ? composePublished(rows, plan.router.name) : null,
    taskReason: (brick) => composeTaskReason(plan, brick, rows),
  };
}

/** Kubernetes inputs to buildLiveStatus, from one `kubectl get deployments,pods,services -o json`. */
export function k8sLiveInput(plan: Plan, listText: string): Pick<LiveInput, "observed" | "routerAddress"> {
  const items = parseK8sList(listText);
  // The router has HTTP probes, so its readiness is a health check too.
  const healthchecks = new Set([
    ...plan.services.filter((s) => s.healthcheck).map((s) => s.name),
    ...(plan.router ? [plan.router.name] : []),
  ]);
  return {
    observed: observeK8s(items, healthchecks),
    routerAddress: plan.router ? k8sServiceAddress(items, plan.router.name) : null,
  };
}

/** The label selector of everything plugbricks created in the namespace. */
export const MANAGED_SELECTOR = `${MANAGED_BY}=plugbricks`;

// ---------- text ----------

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd(),
  );
}

/** The readable form of the report: one table, then the router and what is not declared. */
export function liveStatusText(s: LiveStatus): string[] {
  const enabled = [...s.bricks.flatMap((b) => b.services), ...(s.router ? [s.router] : [])];
  const ok = enabled.filter((x) => !DEGRADED_STATES.includes(x.state)).length;
  const where = s.runtime === "k8s" ? `Kubernetes, context ${s.context}, namespace ${s.platform}` : `Docker Compose, project ${s.platform}`;
  const yesNo = (b: boolean) => (b ? "yes" : "no");
  const rows: string[][] = [["BRICK", "SERVICE", "ENABLED", "DEPLOYED", "STATE", "RESTARTS", "INSTANCE", "REASON"]];
  for (const b of s.bricks) {
    for (const x of b.services) {
      rows.push([
        b.name,
        x.name,
        yesNo(x.enabled),
        yesNo(x.deployed),
        x.state,
        String(x.restarts),
        x.instances.join(",") || "-",
        x.reason ?? "",
      ]);
    }
  }
  if (s.router) {
    const r = s.router;
    rows.push([
      "(router)",
      r.name,
      yesNo(r.enabled),
      yesNo(r.deployed),
      r.state,
      String(r.restarts),
      r.instances.join(",") || "-",
      r.reason ?? "",
    ]);
  }
  for (const x of s.undeclared) {
    rows.push(["-", x.name, "no", "yes", x.state, String(x.restarts), x.instances.join(",") || "-", "not declared in platform.json"]);
  }
  const out = [
    `Runtime (${where}): ${s.state}, ${ok} of ${enabled.length} enabled service(s) without a problem`,
    ...table(rows).map((l) => `  ${l}`),
  ];
  if (s.router) {
    const r = s.router;
    const subs = r.subgraphs.map((g) => `${g.name} ${g.state}`).join(", ");
    out.push(`Router (runtime): ${r.address ?? "not published"}; image digest ${r.digest ?? "unknown"}; subgraphs: ${subs || "none"}`);
  }
  return out;
}
