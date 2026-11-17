import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  buildLiveStatus,
  composeLiveInput,
  DOCKER_INSPECT_TEMPLATE,
  k8sLiveInput,
  liveStatusText,
  parseComposePs,
  type LiveService,
  type LiveStatus,
} from "../src/live.js";
import { planProject, type Plan } from "../src/plan.js";
import { readProject } from "../src/platform.js";
import type { Exec, ExecResult } from "../src/runtime.js";
import { schemaIssues, statusRuntimeSchema } from "../src/schemas.js";

// status --runtime, without Docker or a cluster: the real plan of a platform postgres + orders + shipping,
// against recorded `docker compose ps` output and hand-written `kubectl get -o json` Lists
// (test/fixtures/runtime/README.md says where each one comes from). Pure parsing: runs on every OS.

const pkg = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(pkg, "test/fixtures/runtime");
const work = join(pkg, ".test-work/live/demo");
const fixture = (path: string) => readFileSync(join(fixtures, path), "utf8");
/** A value every k8s fixture puts in a pod's env; it must never reach the output. */
const SECRETISH = "NEVER-PRINTED-env-value-7f3a";

let plan: Plan;

/** The demo platform, made with the CLI itself; router.port 14109 is the port of the recorded project. */
function makePlatform(): void {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  for (const b of ["postgres", "orders", "shipping"]) cpSync(join(pkg, "examples", b), join(work, b), { recursive: true });
  const io = { cwd: work, stdout: () => {}, stderr: () => {} };
  expect(main(["init", "--name", "demo"], io)).toBe(0);
  for (const b of ["postgres", "orders", "shipping"]) expect(main(["add", b], io)).toBe(0);
  const file = join(work, "platform.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), router: { port: 14109 } }, null, 2) + "\n");
}

beforeAll(() => {
  makePlatform();
  plan = planProject(readProject(work));
});

function compose(ps: string, inspect = "inspect/healthy.ndjson"): LiveStatus {
  return buildLiveStatus({
    plan,
    runtime: "compose",
    context: null,
    problems: [],
    ...composeLiveInput(plan, fixture(ps), fixture(inspect)),
  });
}
function k8s(list: string): LiveStatus {
  return buildLiveStatus({ plan, runtime: "k8s", context: "k3d-pbtest-x", problems: [], ...k8sLiveInput(plan, fixture(list)) });
}
const svc = (s: LiveStatus, name: string): LiveService => s.bricks.flatMap((b) => b.services).find((x) => x.name === name)!;
const brief = (x: { state: string; reason: string | null }) => `${x.state}: ${x.reason ?? ""}`;

/** Every report: valid against the published schema, and free of env values and secrets. */
function checked(s: LiveStatus): LiveStatus {
  expect(schemaIssues(statusRuntimeSchema.validate, s)).toEqual([]);
  const text = [JSON.stringify(s), ...liveStatusText(s)].join("\n");
  for (const forbidden of [SECRETISH, "DATABASE_URL", "PB_", "postgres://", "PASSWORD", "secretKeyRef"])
    expect(text).not.toContain(forbidden);
  return s;
}

describe("status --runtime on Docker Compose (recorded with Compose 5.5.1)", () => {
  it("reads both output formats of `docker compose ps --format json` the same way", () => {
    expect(parseComposePs(fixture("compose/healthy-array.json"))).toEqual(parseComposePs(fixture("compose/healthy.ndjson")));
    expect(compose("compose/healthy-array.json")).toEqual(compose("compose/healthy.ndjson"));
    expect(parseComposePs("")).toEqual([]);
    expect(parseComposePs("\n")).toEqual([]);
  });

  it("healthy: every service healthy; the router runs with no health check, published on 127.0.0.1, with its digest", () => {
    const s = checked(compose("compose/healthy.ndjson"));
    expect(s.state).toBe("healthy");
    for (const n of ["orders-app", "postgres-db", "shipping-app"])
      expect(svc(s, n)).toMatchObject({ state: "healthy", deployed: true, mismatch: null });
    expect(svc(s, "orders-app")).toMatchObject({ subgraph: true, instances: ["demo-orders-app-1"], restarts: 0 });
    expect(svc(s, "postgres-db").subgraph).toBe(false);
    expect(s.router).toMatchObject({
      state: "unknown",
      reason: "running; no health check",
      address: "127.0.0.1:14109",
      digest: "sha256:bfe6d89a89ab70975bc874dc234600fe5a6ba6d9498485465a31be4c5b9d0205",
      subgraphs: [
        { brick: "orders", name: "orders-app", state: "healthy" },
        { brick: "shipping", name: "shipping-app", state: "healthy" },
      ],
    });
    // The one-shot wait and provision tasks are not services, and not "undeclared" either.
    expect(s.undeclared).toEqual([]);
  });

  it("exited: a stopped subgraph is stopped with its exit code, and shows under the router too", () => {
    const s = checked(compose("compose/stopped.ndjson"));
    expect(s.state).toBe("degraded");
    expect(brief(svc(s, "shipping-app"))).toBe("stopped: exited with code 0");
    expect(svc(s, "shipping-app").deployed).toBe(true);
    expect(s.router!.subgraphs.find((g) => g.name === "shipping-app")!.state).toBe("stopped");
  });

  it("restarting: the exit code comes from Status (ExitCode is 0 while restarting), the count from docker inspect", () => {
    const s = checked(compose("compose/stopped.ndjson"));
    expect(brief(s.router!)).toBe("unhealthy: restarting after exit code 255");
    // Not published while restarting: Compose lists no publisher then.
    expect(s.router!.address).toBeNull();
    const r = checked(compose("compose/unhealthy-restarting.ndjson", "inspect/unhealthy-restarting.ndjson"));
    expect(svc(r, "shipping-app")).toMatchObject({ state: "unhealthy", reason: "restarting after exit code 3", restarts: 6 });
  });

  it("unhealthy and starting: the health check's own state", () => {
    const s = checked(compose("compose/unhealthy-restarting.ndjson", "inspect/unhealthy-restarting.ndjson"));
    expect(brief(svc(s, "orders-app"))).toBe("unhealthy: health check failing");
    expect(brief(svc(checked(compose("compose/starting.ndjson")), "postgres-db"))).toBe("starting: health check not passed yet");
  });

  it("created but never started: stopped", () => {
    expect(brief(svc(checked(compose("compose/created.ndjson")), "shipping-app"))).toBe("stopped: created, never started");
  });

  it("a wait task that gave up names WAIT_TIMEOUT as the reason its consumer does not run", () => {
    expect(brief(svc(checked(compose("compose/wait-timeout.ndjson")), "shipping-app"))).toBe(
      "stopped: WAIT_TIMEOUT: gave up waiting for database from postgres after 120s",
    );
  });

  it("image pull failure and partial deployment: no container means not deployed, flagged as a mismatch", () => {
    for (const f of ["compose/pull-failure.ndjson", "compose/partial.ndjson"]) {
      const s = checked(compose(f));
      expect(svc(s, "shipping-app"), f).toMatchObject({ state: "not deployed", deployed: false, enabled: true, mismatch: "not-deployed" });
      expect(s.state).toBe("degraded");
      expect(s.router!.subgraphs.find((g) => g.name === "shipping-app")!.state).toBe("not deployed");
    }
  });

  it("nothing deployed: every enabled service and the router are not deployed", () => {
    const s = checked(compose("compose/nothing.ndjson"));
    expect(s.bricks.flatMap((b) => b.services).map((x) => x.state)).toEqual(["not deployed", "not deployed", "not deployed"]);
    expect(s.router).toMatchObject({ state: "not deployed", deployed: false, address: null, digest: null, mismatch: "not-deployed" });
  });

  it("running but not declared: listed apart, flagged, and never counted in the state", () => {
    const s = checked(compose("compose/undeclared.ndjson"));
    expect(s.undeclared).toEqual([
      {
        name: "cache-redis",
        service: null,
        enabled: false,
        deployed: true,
        state: "unknown",
        reason: "running; no health check",
        restarts: 0,
        instances: ["demo-cache-redis-1"],
        subgraph: false,
        mismatch: "not-declared",
      },
    ]);
    expect(s.state).toBe("healthy");
  });

  it("is deterministic: two reads of the same runtime state give byte-identical JSON", () => {
    expect(JSON.stringify(compose("compose/stopped.ndjson"))).toBe(JSON.stringify(compose("compose/stopped.ndjson")));
  });
});

describe("status --runtime on Kubernetes (Lists written after the Kubernetes API)", () => {
  it("healthy: Running and Ready; the router at its ClusterIP Service, with the digest the node pulled", () => {
    const s = checked(k8s("k8s/healthy.json"));
    expect(s.state).toBe("healthy");
    expect(s.context).toBe("k3d-pbtest-x");
    for (const n of ["orders-app", "postgres-db", "shipping-app"]) expect(svc(s, n).state).toBe("healthy");
    expect(svc(s, "orders-app").instances).toEqual(["orders-app-6f7d9c-x2k4q"]);
    expect(s.router).toMatchObject({
      state: "healthy",
      address: "10.43.0.13:4000",
      digest: "sha256:bfe6d89a89ab70975bc874dc234600fe5a6ba6d9498485465a31be4c5b9d0205",
    });
  });

  it.each([
    ["k8s/crashloop.json", "orders-app", "unhealthy: CrashLoopBackOff (last exit code 1)", 4],
    ["k8s/pending.json", "shipping-app", "unhealthy: Pending: Unschedulable", 0],
    ["k8s/image-pull.json", "shipping-app", "unhealthy: image pull error (ImagePullBackOff)", 0],
    ["k8s/wait-timeout.json", "shipping-app", "unhealthy: WAIT_TIMEOUT: init container wait-database gave up, CrashLoopBackOff", 5],
    ["k8s/starting.json", "orders-app", "starting: readiness probe not passed yet", 0],
    ["k8s/readiness-failing.json", "orders-app", "unhealthy: readiness probe failing", 0],
  ])("%s: %s is %s", (file, name, expected, restarts) => {
    const s = checked(k8s(file));
    expect(brief(svc(s, name))).toBe(expected);
    expect(svc(s, name).restarts).toBe(restarts);
    expect(s.state).toBe("degraded");
  });

  it("partial: a Deployment deleted by hand is not deployed; one of a removed brick is not declared", () => {
    const s = checked(k8s("k8s/partial.json"));
    expect(svc(s, "shipping-app")).toMatchObject({ state: "not deployed", mismatch: "not-deployed" });
    // Not declared, so plugbricks does not know whether it has a health check: unknown, never "healthy".
    expect(s.undeclared.map((u) => [u.name, u.mismatch, u.state])).toEqual([["cache-redis", "not-declared", "unknown"]]);
  });

  it("nothing deployed (an empty namespace)", () => {
    const s = checked(k8s("k8s/nothing.json"));
    expect(s.router!.state).toBe("not deployed");
    expect(s.bricks.flatMap((b) => b.services).every((x) => x.state === "not deployed")).toBe(true);
  });
});

// ---------- the command: exit codes, the calls it makes, and what it refuses ----------

type Call = { cmd: string; args: string[]; timeoutMs?: number };

/** A fake docker/kubectl: answers from fixtures, records every call with its timeout. */
function fakeRuntime(answers: (cmd: string, args: string[]) => Partial<ExecResult> | undefined): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (cmd, args, opts) => {
    calls.push({ cmd, args, timeoutMs: opts.timeoutMs });
    return { status: 0, stdout: "", stderr: "", ...answers(cmd, args) };
  };
  return { exec, calls };
}

const composeAnswers =
  (ps: string) =>
  (_cmd: string, args: string[]): Partial<ExecResult> | undefined => {
    if (args.includes("ps")) return { stdout: fixture(ps) };
    if (args[0] === "inspect") return { stdout: fixture("inspect/healthy.ndjson") };
    return undefined;
  };

function run(args: string[], exec?: Exec): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { cwd: work, stdout: (l) => out.push(l), stderr: (l) => err.push(l), runtime: exec ? { exec } : undefined });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("plugbricks status --runtime", () => {
  it("exits 0 when every enabled service is healthy, and prints one JSON document (no progress line) with --json", () => {
    const f = fakeRuntime(composeAnswers("compose/healthy.ndjson"));
    const r = run(["status", "--runtime", "compose", "--json"], f.exec);
    expect(r.code, r.err).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.version).toBe(1);
    expect(schemaIssues(statusRuntimeSchema.validate, doc)).toEqual([]);
  });

  it("runs only read-only listing calls, each with a timeout", () => {
    const f = fakeRuntime(composeAnswers("compose/healthy.ndjson"));
    run(["status", "--runtime", "compose"], f.exec);
    expect(f.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      "docker compose version",
      "docker compose --project-name demo ps --all --format json",
      `docker inspect --format ${DOCKER_INSPECT_TEMPLATE} ${parseComposePs(fixture("compose/healthy.ndjson"))
        .map((r) => r.ID)
        .join(" ")}`,
    ]);
    for (const c of f.calls) expect(c.timeoutMs, c.args.join(" ")).toBe(15_000);
    // The template prints three named fields; never .Config (and so never the environment).
    expect(DOCKER_INSPECT_TEMPLATE).not.toMatch(/Config|Env|Mounts|Args/);
  });

  it("exits 3 when an enabled service is stopped, and prints the table", () => {
    const f = fakeRuntime(composeAnswers("compose/stopped.ndjson"));
    const r = run(["status", "--runtime", "compose"], f.exec);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^Runtime \(Docker Compose, project demo\): degraded, /m);
    expect(r.out).toMatch(/^ {2}shipping {2}shipping-app +yes +yes +stopped +0 +demo-shipping-app-1 +exited with code 0$/m);
  });

  it.each<[string, Partial<ExecResult>, string]>([
    ["docker is not installed", { error: "ENOENT", status: null }, "docker was not found"],
    [
      "the daemon does not answer",
      { status: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" },
      "Cannot connect",
    ],
    ["a call is too slow", { error: "ETIMEDOUT", status: null }, "did not answer within 15 s"],
  ])("exits 4 with RUNTIME_UNAVAILABLE, not a stack trace, when %s", (_why, failure, detail) => {
    const f = fakeRuntime((_c, args) => (args.includes("ps") || failure.error === "ENOENT" ? failure : undefined));
    const r = run(["status", "--runtime", "compose", "--json"], f.exec);
    expect(r.code).toBe(4);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^error RUNTIME_UNAVAILABLE: cannot read the state of the Docker Compose runtime: /);
    expect(r.err).toContain(detail);
  });

  it("on Kubernetes: one `get deployments,pods,services`, with the named cluster and kubectl's own request timeout; never Secrets", () => {
    const kubeconfig = join(work, "kubeconfig.yaml");
    writeFileSync(kubeconfig, "apiVersion: v1\nkind: Config\n");
    const f = fakeRuntime((_c, args) => (args.includes("get") ? { stdout: fixture("k8s/healthy.json") } : undefined));
    const r = run(["status", "--runtime", "k8s", "--context", "k3d-pbtest-x", "--kubeconfig", kubeconfig, "--json"], f.exec);
    expect(r.code, r.err).toBe(0);
    expect(f.calls.map((c) => [c.cmd, ...c.args].join(" "))).toEqual([
      `kubectl --kubeconfig ${kubeconfig} --context k3d-pbtest-x version --client`,
      `kubectl --kubeconfig ${kubeconfig} --context k3d-pbtest-x --request-timeout=10s --namespace demo get deployments,pods,services --selector app.kubernetes.io/managed-by=plugbricks --output json`,
    ]);
    for (const c of f.calls) {
      expect(c.timeoutMs).toBe(15_000);
      expect(c.args.join(" ")).not.toMatch(/secret|configmap|exec|logs|port-forward/i);
    }
    expect(JSON.parse(r.out).context).toBe("k3d-pbtest-x");
  });

  it("on Kubernetes: the same guards as up, before any call (K8S_CONTEXT_REQUIRED, K8S_CONTEXT_REFUSED)", () => {
    for (const [args, code] of [
      [["status", "--runtime", "k8s"], "K8S_CONTEXT_REQUIRED"],
      [["status", "--runtime", "k8s", "--context", "k3d-platform"], "K8S_CONTEXT_REFUSED"],
      [["status", "--runtime", "k8s", "--context", "platform"], "K8S_CONTEXT_REFUSED"],
    ] as const) {
      const f = fakeRuntime(() => undefined);
      const r = run([...args], f.exec);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toMatch(new RegExp(`^error ${code}:`));
      expect(f.calls).toEqual([]);
    }
  });

  it("on Kubernetes: an unreachable cluster is RUNTIME_UNAVAILABLE (exit 4)", () => {
    const f = fakeRuntime((_c, args) =>
      args.includes("get")
        ? { status: 1, stderr: "Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused" }
        : undefined,
    );
    const r = run(["status", "--runtime", "k8s", "--context", "k3d-pbtest-x"], f.exec);
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/^error RUNTIME_UNAVAILABLE: cannot read the state of the Kubernetes runtime: .*connection refused$/);
  });

  it("checks its options: a known runtime, cluster flags only with k8s", () => {
    expect(run(["status", "--runtime", "swarm"]).code).toBe(2);
    expect(run(["status", "--context", "k3d-pbtest-x"]).code).toBe(2);
    expect(run(["status", "--runtime", "compose", "--context", "k3d-pbtest-x"]).code).toBe(2);
  });

  it("without --runtime, status is unchanged: no runtime call at all", () => {
    const f = fakeRuntime(() => ({ status: 1, error: "ENOENT" }));
    const r = run(["status"], f.exec);
    expect(r.code).toBe(0);
    expect(f.calls).toEqual([]);
    expect(r.out).not.toContain("Runtime (");
  });
});
