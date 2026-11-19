import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { LiveStatus } from "../src/live.js";
import { schemaIssues, statusRuntimeSchema } from "../src/schemas.js";
import { ask, get, through, until, type Answer } from "./helpers/graphql.js";
import { k8sTestTarget } from "./helpers/k8s-guard.js";
import { portForward, stopAllForwards } from "./helpers/port-forward.js";

// Runs the Kubernetes driver against a real, throwaway k3d cluster: up with postgres and orders, a
// GraphQL call, down, remove + up --prune-volumes; the router in front of orders and shipping, with real requests
// through it, a rollout when the composition changes, and down; WAIT_TIMEOUT; a RabbitMQ broker with two consumers
// and a real publish/consume; and recovery after the database pod is killed.
//
// It runs only when PLUGBRICKS_K8S_CONTEXT starts with "k3d-pbtest-" and PLUGBRICKS_K8S_KUBECONFIG
// is set (see test/helpers/k8s-guard.ts); otherwise it is skipped, with the reason in the title.
// Every kubectl command, the driver's and this test's own, names the cluster explicitly: the
// current kubectl context is never used. The CI job "k8s" creates the cluster; to run it locally:
//   k3d cluster create pbtest-local --image <tools.json images.k3s.reference> --no-lb \
//     --kubeconfig-update-default=false --kubeconfig-switch-context=false
//   k3d kubeconfig write pbtest-local --output /path/to/pbtest-local.yaml
//   PLUGBRICKS_K8S_CONTEXT=k3d-pbtest-local PLUGBRICKS_K8S_KUBECONFIG=/path/to/pbtest-local.yaml npm test -w plugbricks -- e2e-k8s

const pkg = fileURLToPath(new URL("../", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const workRoot = join(pkg, ".test-work/e2e-k8s");
const target = k8sTestTarget(process.env);
const k3d = process.env.PLUGBRICKS_K3D ?? "k3d";

function skipReason(): string | undefined {
  if (!target.ok) return target.reason;
  const docker = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (docker.status !== 0 || docker.stdout.trim() !== "linux") return "needs a Linux Docker engine";
  if (spawnSync("kubectl", ["version", "--client"], { encoding: "utf8" }).status !== 0) return "kubectl was not found";
  if (spawnSync(k3d, ["version"], { encoding: "utf8" }).status !== 0) return "k3d was not found (set PLUGBRICKS_K3D to its path)";
  return undefined;
}
const reason = skipReason();
const ready = reason === undefined;
const why = ready ? "" : ` (skipped: ${reason})`;

const context = target.ok ? target.context : "";
const kubeconfig = target.ok ? resolve(target.kubeconfig) : "";
const namespaces: string[] = [];

/** The test's own kubectl calls: same explicit cluster as the driver's. */
function kc(args: string[]) {
  return spawnSync("kubectl", ["--kubeconfig", kubeconfig, "--context", context, ...args], { encoding: "utf8" });
}

function project(name: string, bricks: string[]): string {
  const work = join(workRoot, name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(join(pkg, "examples/postgres"), join(work, "postgres"), { recursive: true });
  for (const b of bricks) cpSync(join(pkg, "test/fixtures/e2e", b), join(work, b), { recursive: true });
  // A namespace left over by an interrupted run would keep its volumes and its old passwords.
  kc(["delete", "namespace", name, "--ignore-not-found", "--wait=true"]);
  namespaces.push(name);
  return work;
}

/** Runs the CLI; up and down get the cluster flags the driver requires. */
function cli(work: string, args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const cluster = ["up", "down"].includes(args[0]) ? ["--runtime", "k8s", "--context", context, "--kubeconfig", kubeconfig] : [];
  const code = main([...args, ...cluster], { cwd: work, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const names = (ns: string, kind: string) => {
  const r = kc(["--namespace", ns, "get", kind, "--output", "name"]);
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split("\n").filter(Boolean).sort();
};

/** Builds an example API and loads it into the cluster, once: the cluster has no registry to pull it from. */
const loaded = new Set<string>();
function loadImage(api: string): void {
  if (loaded.has(api)) return;
  const tag = `plugbricks-example/${api}:0.1.0`;
  const build = spawnSync("docker", ["build", "--quiet", "--tag", tag, join(repo, "apis", api)], { encoding: "utf8" });
  expect(build.status, build.stderr).toBe(0);
  const imported = spawnSync(k3d, ["image", "import", tag, "--cluster", target.ok ? target.cluster : ""], { encoding: "utf8" });
  expect(imported.status, imported.stderr).toBe(0);
  loaded.add(api);
}

// ---------- reaching the router: kubectl port-forward ----------
// The router is reached through `kubectl port-forward service/router`, bound to 127.0.0.1 on a free local port, and
// not from a client pod in the cluster: it needs no extra image (a client pod would need one pinned by digest), it
// uses the same HTTP client as the Docker Compose test, and the Service is still used (kubectl resolves it to a pod
// and maps the Service port to the container port). The path from the router to the subgraphs, Service names and
// ClusterIPs through kube-proxy, is exercised by the federated queries themselves. Every forward is stopped in a
// finally block, and again in afterAll if a test is interrupted.

const forward = (ns: string, service: string, servicePort: number) =>
  portForward({
    kubectl: "kubectl",
    clusterArgs: ["--kubeconfig", kubeconfig, "--context", context, "--namespace", ns],
    service,
    servicePort,
  });

/**
 * Runs `use` with a forward to the router Service (its port is router.port, 4000 by default), and stops the forward.
 * `preflight` is a query every subgraph of the current composition can answer: it proves the router's path to them.
 */
async function viaRouter<T>(ns: string, use: (port: number) => Promise<T>, preflight = "{ orders(limit: 1) { id } }"): Promise<T> {
  const f = await forward(ns, "router", 4000);
  try {
    await until("the router through the forward", async () => (await get(f.port, "/health/ready")) === 200);
    // /health/ready is the router's own state: it does not say the router can reach a subgraph. Right after `up`, or
    // after a router rollout, the first call through a fresh Service can still fail (the pod-to-Service call of the
    // first test retries exactly that). One federated read proves the paths before the scenario; the mutations of the
    // scenario itself are never retried, so no order is ever created twice.
    let last: Answer | undefined;
    try {
      await until(
        "the router to answer a federated query",
        async () => {
          last = await ask(f.port, preflight);
          return last.status === 200 && !last.body?.errors?.length;
        },
        120_000,
      );
    } catch (e) {
      console.log(`pre-flight query never succeeded; last answer: HTTP ${last?.status} ${JSON.stringify(last?.body)}`);
      throw e;
    }
    return await use(f.port);
  } finally {
    f.stop();
  }
}

type Pod = {
  metadata: { name: string; deletionTimestamp?: string };
  status: { phase: string; containerStatuses?: { ready: boolean; restartCount: number }[] };
};
const podsOf = (ns: string, ...selector: string[]): Pod[] => {
  const r = kc(["--namespace", ns, "get", "pods", ...selector, "--output", "json"]);
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout).items;
};

/** The router Deployment: the config hash its pod template carries, its generation, and its live pods. */
function routerState(ns: string): { hash: string; generation: number; pods: string[] } {
  const r = kc(["--namespace", ns, "get", "deployment", "router", "--output", "json"]);
  expect(r.status, r.stderr).toBe(0);
  const deployment = JSON.parse(r.stdout);
  return {
    hash: deployment.spec.template.metadata.annotations["plugbricks/router-config-sha256"],
    generation: deployment.metadata.generation,
    // A pod that is being deleted after a rollout is not one of the router's pods any more.
    pods: podsOf(ns, "--selector", "plugbricks/service=router")
      .filter((p) => !p.metadata.deletionTimestamp)
      .map((p) => p.metadata.name)
      .sort(),
  };
}

afterAll(() => {
  if (!ready) return;
  stopAllForwards();
  // The namespaces of this test only; the cluster itself is deleted by whoever created it.
  for (const ns of namespaces) kc(["delete", "namespace", ns, "--ignore-not-found", "--wait=false"]);
});

describe("Kubernetes driver against a real k3d cluster", () => {
  it.skipIf(!ready)(
    `runs postgres and orders, answers GraphQL, keeps data on down, prunes only the pending volume${why}`,
    () => {
      const nodes = kc(["get", "nodes", "--no-headers"]);
      expect(nodes.status, `the cluster ${context} does not answer: ${nodes.stderr}`).toBe(0);

      loadImage("orders");

      const ns = "pbtest-k8s";
      const work = project(ns, ["scratch"]);
      cpSync(join(pkg, "examples/orders"), join(work, "orders"), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders"],
        ["add", "scratch"],
      ])
        expect(cli(work, args).code).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const pods = kc(["--namespace", ns, "get", "pods", "--output", "wide"]);
      console.log(`kubectl get pods (namespace ${ns}):\n${pods.stdout}`);
      const podList = JSON.parse(kc(["--namespace", ns, "get", "pods", "--output", "json"]).stdout).items as {
        metadata: { name: string };
        status: { phase: string };
      }[];
      expect(podList.map((p) => p.metadata.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")).sort()).toEqual([
        "orders-app",
        "postgres-db",
        // orders serves a subgraph, so plugbricks also deploys the router (4b-3). This is the first time it
        // runs on a cluster: its probes, security context and image pull are checked here.
        "router",
        "scratch-redis",
      ]);
      expect(podList.map((p) => p.status.phase)).toEqual(["Running", "Running", "Running", "Running"]);

      // status --runtime on the running project, through the same cluster guards as up: nothing degraded,
      // the router Ready behind its ClusterIP Service, and a report valid against the published schema.
      const live = cli(work, ["status", "--runtime", "k8s", "--context", context, "--kubeconfig", kubeconfig, "--json"]);
      console.log(`status --runtime k8s --json: exit ${live.code}\n${live.out}${live.err ? `\n${live.err}` : ""}`);
      expect(live.code, live.err).toBe(0);
      const report = JSON.parse(live.out) as LiveStatus;
      expect(schemaIssues(statusRuntimeSchema.validate, report)).toEqual([]);
      expect(report).toMatchObject({ runtime: "k8s", context, state: "healthy", undeclared: [] });
      const states = Object.fromEntries(report.bricks.flatMap((b) => b.services).map((x) => [x.name, x.state]));
      expect(states).toMatchObject({ "orders-app": "healthy", "postgres-db": "healthy" });
      expect(report.router).toMatchObject({ state: "healthy", deployed: true });
      expect(report.router!.address).toMatch(/^\d+\.\d+\.\d+\.\d+:\d+$/);
      expect(report.router!.digest).toMatch(/^sha256:[a-f0-9]{64}$/);

      // Nothing is published outside the cluster: call the API by its Service name from inside a pod, and from
      // ANOTHER pod than the one the Service sends the request to (postgres-db, an Alpine image with wget). A pod that
      // reaches its own Service through the ClusterIP (hairpin) depends on how the node sets up its bridge: it timed
      // out once in CI (a connection to 10.43.x.x that never answered, in a run whose pods were all Running) after
      // passing in the runs before. A connection error is retried a few times, which also covers the moment before
      // kube-proxy has programmed the Service; any other failure is reported at once.
      const gql = (query: string) => {
        let last = kc(["version", "--client"]);
        for (let attempt = 1; attempt <= 6; attempt++) {
          last = kc([
            "--namespace",
            ns,
            "exec",
            "deployment/postgres-db",
            "--",
            "wget",
            "-qO-",
            "-T",
            "10",
            "--header",
            "content-type: application/json",
            "--post-data",
            JSON.stringify({ query }),
            "http://orders-app:4000/graphql",
          ]);
          if (last.status === 0) return JSON.parse(last.stdout);
          if (!/can't connect|timed out|bad address/i.test(last.stderr)) break;
          console.log(`gql attempt ${attempt} failed (${last.stderr.trim().split("\n").pop()}); trying again in 5 s`);
          spawnSync("sleep", ["5"]);
        }
        expect(last.status, last.stderr).toBe(0);
        return JSON.parse(last.stdout);
      };
      const created = gql("mutation { createOrder(total: 42.5) { id total status } }");
      expect(created.data.createOrder).toMatchObject({ total: 42.5, status: "pending" });
      const id = created.data.createOrder.id;

      // down removes the workloads and keeps the data.
      const down = cli(work, ["down"]);
      expect(down.code, down.err).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
      expect(names(ns, "persistentvolumeclaim")).toEqual([
        "persistentvolumeclaim/postgres-db-data",
        "persistentvolumeclaim/scratch-redis-data",
      ]);

      // remove marks the retention-delete volume; only up --prune-volumes deletes it, and only it.
      expect(cli(work, ["remove", "scratch"]).code).toBe(0);
      const pruned = cli(work, ["up", "--prune-volumes"]);
      expect(pruned.code, `${pruned.out}\n${pruned.err}`).toBe(0);
      expect(pruned.out).toContain("deleted volume scratch/redis/data");
      expect(names(ns, "persistentvolumeclaim")).toEqual(["persistentvolumeclaim/postgres-db-data"]);
      expect(JSON.parse(readFileSync(join(work, "platform.lock"), "utf8")).pendingDeletion).toEqual([]);

      // The orders data survived down and up: the database volume was kept.
      expect(gql(`{ order(id: "${id}") { id total } }`)).toEqual({ data: { order: { id, total: 42.5 } } });

      // Stopped here, so that the next test does not share a single-node cluster with a second set of workloads.
      expect(cli(work, ["down"]).code).toBe(0);
    },
    900_000,
  );

  it.skipIf(!ready)(
    `serves orders and shipping through the router, rolls the router when the composition changes, and down removes the workloads${why}`,
    async () => {
      loadImage("orders");
      loadImage("shipping");
      const ns = "pbtest-k8s-router";
      const work = project(ns, []);
      for (const brick of ["orders", "shipping"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders"],
        ["add", "shipping"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      // up returns only when every rollout is done (kubectl rollout status, which waits for readiness).
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      console.log(`kubectl get pods (namespace ${ns}):\n${kc(["--namespace", ns, "get", "pods", "--output", "wide"]).stdout}`);
      const pods = podsOf(ns);
      expect(pods.map((p) => p.metadata.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")).sort()).toEqual([
        "orders-app",
        "postgres-db",
        "router",
        "shipping-app",
      ]);
      for (const p of pods) {
        expect(p.status.phase, p.metadata.name).toBe("Running");
        expect(
          p.status.containerStatuses?.every((c) => c.ready),
          `${p.metadata.name} is ready`,
        ).toBe(true);
      }
      console.log(
        `restarts: ${pods.map((p) => `${p.metadata.name}=${p.status.containerStatuses?.map((c) => c.restartCount).join("+")}`).join(" ")}`,
      );

      // Nothing reaches the router, or anything else, from outside the cluster: no Ingress, and only ClusterIP services.
      expect(names(ns, "ingress")).toEqual([]);
      const services = JSON.parse(kc(["--namespace", ns, "get", "service", "--output", "json"]).stdout).items;
      expect(services.map((s: { metadata: { name: string } }) => s.metadata.name).sort()).toEqual([
        "orders-app",
        "postgres-db",
        "router",
        "shipping-app",
      ]);
      expect(services.map((s: { spec: { type: string } }) => s.spec.type)).toEqual(["ClusterIP", "ClusterIP", "ClusterIP", "ClusterIP"]);
      const everything = JSON.stringify(services) + kc(["--namespace", ns, "get", "pods", "--output", "json"]).stdout;
      for (const forbidden of ["nodePort", "hostPort", '"hostNetwork":true', "LoadBalancer", "NodePort"])
        expect(everything, forbidden).not.toContain(forbidden);
      console.log(
        `services: ${services.map((s: { metadata: { name: string }; spec: { type: string } }) => `${s.metadata.name}=${s.spec.type}`).join(" ")}; ingresses: none`,
      );

      const before = routerState(ns);
      expect(before.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(before.pods).toHaveLength(1);
      const ORDER = "query($id: ID!) { order(id: $id) { id total status shipment { carrier trackingNumber status } } }";

      // The same scenario as on Docker Compose, through the router only.
      const { id, tracking } = await viaRouter(
        ns,
        async (port) => {
          expect(await get(port, "/")).toBe(404);
          expect(await get(port, "/health/ready")).toBe(200);
          const created = await through(port, "createOrder", "mutation { createOrder(total: 42.5) { id total status } }");
          const orderId = created.body.data.createOrder.id;
          expect(created.body.data.createOrder).toEqual({ id: orderId, total: 42.5, status: "pending" });
          expect((await through(port, "order before shipping", ORDER, { id: orderId })).body).toEqual({
            data: { order: { id: orderId, total: 42.5, status: "pending", shipment: null } },
          });
          const shipped = await through(
            port,
            "shipOrder",
            'mutation($id: ID!) { shipOrder(orderId: $id, carrier: "ups") { carrier trackingNumber status } }',
            { id: orderId },
          );
          const trackingNumber = shipped.body.data.shipOrder.trackingNumber;
          expect(shipped.body.data.shipOrder).toEqual({
            carrier: "ups",
            trackingNumber: expect.stringMatching(/^TRK-[0-9A-F]{10}$/),
            status: "SHIPPED",
          });
          // total and status exist only in orders; carrier, trackingNumber and the shipment status only in shipping.
          expect((await through(port, "order after shipping", ORDER, { id: orderId })).body).toEqual({
            data: {
              order: {
                id: orderId,
                total: 42.5,
                status: "pending",
                shipment: { carrier: "ups", trackingNumber: trackingNumber, status: "SHIPPED" },
              },
            },
          });
          const unknown = await through(port, "unknown field", 'query { order(id: "1") { nope } }');
          expect(unknown.status).toBe(200);
          expect(unknown.body.data).toBeUndefined();
          expect(unknown.body.errors[0].message).toContain('Cannot query field "nope" on type "Order"');
          expect(await get(port, "/health/ready")).toBe(200);
          return { id: orderId, tracking: trackingNumber };
        },
        '{ orders(limit: 1) { id } shipment(orderId: "1") { carrier } }',
      );
      const shipmentOf = { carrier: "ups", trackingNumber: tracking, status: "SHIPPED" };

      // remove shipping, then up: the router Deployment is rolled (its pod template carries a new config hash), and the field is gone.
      expect(cli(work, ["remove", "shipping"]).code).toBe(0);
      const removed = cli(work, ["up"]);
      expect(removed.code, `${removed.out}\n${removed.err}`).toBe(0);
      const without = routerState(ns);
      expect(without.hash).not.toBe(before.hash);
      expect(without.generation).toBeGreaterThan(before.generation);
      expect(without.pods).toHaveLength(1);
      expect(without.pods).not.toEqual(before.pods);
      expect(names(ns, "deployment")).toEqual(["deployment.apps/orders-app", "deployment.apps/postgres-db", "deployment.apps/router"]);
      console.log(
        `router after remove shipping: hash ${without.hash.slice(0, 12)} (was ${before.hash.slice(0, 12)}), generation ${without.generation} (was ${before.generation}), pod ${without.pods[0]} (was ${before.pods[0]})`,
      );
      await viaRouter(ns, async (port) => {
        const gone = await through(port, "shipment after remove shipping", ORDER, { id });
        expect(gone.body.data).toBeUndefined();
        expect(gone.body.errors[0].message).toContain('Cannot query field "shipment" on type "Order"');
        expect((await through(port, "orders alone", "query($id: ID!) { order(id: $id) { id total status } }", { id })).body).toEqual({
          data: { order: { id, total: 42.5, status: "pending" } },
        });
      });

      // add shipping again, then up: rolled again, the annotation is back to the original value, and so is the field with its data.
      expect(cli(work, ["add", "shipping"]).code).toBe(0);
      const added = cli(work, ["up"]);
      expect(added.code, `${added.out}\n${added.err}`).toBe(0);
      const again = routerState(ns);
      expect(again.hash).toBe(before.hash);
      expect(again.generation).toBeGreaterThan(without.generation);
      expect(again.pods).toHaveLength(1);
      expect(again.pods).not.toEqual(without.pods);
      console.log(
        `router after add shipping: hash ${again.hash.slice(0, 12)} (the original), generation ${again.generation}, pod ${again.pods[0]}`,
      );
      await viaRouter(
        ns,
        async (port) => {
          expect((await through(port, "order after add shipping", ORDER, { id })).body).toEqual({
            data: { order: { id, total: 42.5, status: "pending", shipment: shipmentOf } },
          });
        },
        '{ orders(limit: 1) { id } shipment(orderId: "1") { carrier } }',
      );

      // down removes what plugbricks created, router included, and keeps the data (D3) and the secrets (D6).
      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
      expect(names(ns, "service")).toEqual([]);
      const managed = kc([
        "--namespace",
        ns,
        "get",
        "configmap",
        "--selector",
        "app.kubernetes.io/managed-by=plugbricks",
        "--output",
        "name",
      ]);
      expect(managed.stdout.trim()).toBe("");
      expect(names(ns, "persistentvolumeclaim")).toEqual(["persistentvolumeclaim/postgres-db-data"]);
      expect(names(ns, "secret")).toContain("secret/plugbricks-secrets");
      console.log(
        `after down: deployments=[] services=[] managed configmaps=[] volumes=[${names(ns, "persistentvolumeclaim").join(", ")}]`,
      );
    },
    900_000,
  );

  it.skipIf(!ready)(
    `reports WAIT_TIMEOUT when a capability never becomes ready${why}`,
    () => {
      const ns = "pbtest-k8s-timeout";
      const work = project(ns, ["never", "patient"]);
      for (const args of [
        ["init", "--name", ns],
        ["add", "never"],
        ["add", "patient"],
      ])
        expect(cli(work, args).code).toBe(0);
      // Kubernetes has no fast failure for a crash-looping init container: up gives up when the
      // rollout deadline (the waits plus 300 s) passes, then reads the exit code 124 from the pod.
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(1);
      expect(up.err).toContain('error WAIT_TIMEOUT: "patient" gave up waiting for capability "slow" from "never" after 3s');
    },
    900_000,
  );

  it.skipIf(!ready)(
    `one RabbitMQ broker serves two queue consumers, each with its own AMQP_URL and QUEUE_NAME${why}`,
    () => {
      const ns = "pbtest-k8s-queue";
      const work = project(ns, ["queue-a", "queue-b"]);
      cpSync(join(pkg, "examples/rabbitmq"), join(work, "rabbitmq"), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "rabbitmq"],
        ["add", "queue-a"],
        ["add", "queue-b"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const pods = podsOf(ns);
      expect(pods.map((p) => p.metadata.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")).sort()).toEqual([
        "queue-a-app",
        "queue-b-app",
        "rabbitmq-broker",
      ]);
      for (const p of pods) {
        expect(p.status.phase, p.metadata.name).toBe("Running");
        expect(
          p.status.containerStatuses?.every((c) => c.ready),
          `${p.metadata.name} is ready`,
        ).toBe(true);
      }

      // Each consumer got its own vhost and user in AMQP_URL, and its own queue name. The shell prints
      // only "ok": AMQP_URL holds the generated password, so it is never printed (D6, D11, D12).
      for (const [deploy, queue] of [
        ["queue-a-app", "queue-a"],
        ["queue-b-app", "queue-b"],
      ] as const) {
        const r = kc([
          "--namespace",
          ns,
          "exec",
          `deployment/${deploy}`,
          "--",
          "sh",
          "-c",
          `case "$AMQP_URL" in amqp://${queue}:*) ;; *) echo "AMQP_URL does not use the ${queue} user"; exit 1;; esac;` +
            `case "$AMQP_URL" in */${queue}) ;; *) echo "AMQP_URL does not use the ${queue} vhost"; exit 1;; esac;` +
            `[ "$QUEUE_NAME" = "${queue}" ] && echo ok`,
        ]);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout.trim()).toBe("ok");
      }

      // The Service exposes the management port, so the provision task could reach it (D12).
      const service = JSON.parse(kc(["--namespace", ns, "get", "service", "rabbitmq-broker", "--output", "json"]).stdout);
      expect(service.spec.ports.map((p: { name: string; port: number }) => [p.name, p.port])).toEqual([
        ["main", 5672],
        ["management", 15672],
      ]);
      // One vhost per consumer, created by the provision task.
      const vhosts = kc(["--namespace", ns, "exec", "deployment/rabbitmq-broker", "--", "rabbitmqctl", "list_vhosts", "name"]);
      expect(vhosts.status, vhosts.stderr).toBe(0);
      expect(vhosts.stdout).toContain("queue-a");
      expect(vhosts.stdout).toContain("queue-b");

      // The broker answers on the cluster and listens on AMQP.
      const ping = kc(["--namespace", ns, "exec", "deployment/rabbitmq-broker", "--", "rabbitmq-diagnostics", "-q", "ping"]);
      expect(ping.status, ping.stderr).toBe(0);
      const listeners = kc(["--namespace", ns, "exec", "deployment/rabbitmq-broker", "--", "rabbitmq-diagnostics", "-q", "listeners"]);
      expect(listeners.status, listeners.stderr).toBe(0);
      expect(listeners.stdout).toContain("5672");

      // down keeps the broker's PersistentVolumeClaim and the Secret.
      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
      expect(names(ns, "persistentvolumeclaim")).toEqual(["persistentvolumeclaim/rabbitmq-broker-data"]);
      expect(names(ns, "secret")).toContain("secret/plugbricks-secrets");
    },
    900_000,
  );

  it.skipIf(!ready)(
    `a real consumer publishes and consumes a message through the broker${why}`,
    () => {
      loadImage("queue-consumer");
      const ns = "pbtest-k8s-queue-flow";
      const work = project(ns, []);
      for (const brick of ["rabbitmq", "queue-consumer"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "rabbitmq"],
        ["add", "queue-consumer"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const pods = podsOf(ns);
      expect(pods.map((p) => p.metadata.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")).sort()).toEqual([
        "queue-consumer-app",
        "rabbitmq-broker",
      ]);
      for (const p of pods) {
        expect(p.status.phase, p.metadata.name).toBe("Running");
        expect(
          p.status.containerStatuses?.every((c) => c.ready),
          `${p.metadata.name} is ready`,
        ).toBe(true);
      }

      // /health is 200 only after the consumer declared its queue, published a message and consumed it,
      // with its own vhost and user; the JSON says what happened.
      const health = kc(["--namespace", ns, "exec", "deployment/queue-consumer-app", "--", "wget", "-qO-", "http://localhost:4000/health"]);
      expect(health.status, health.stderr).toBe(0);
      expect(JSON.parse(health.stdout)).toMatchObject({ ok: true, connected: true, delivered: true, queue: "queue-consumer" });

      // The queue exists on the broker, in the consumer's vhost.
      const queues = kc([
        "--namespace",
        ns,
        "exec",
        "deployment/rabbitmq-broker",
        "--",
        "rabbitmqctl",
        "list_queues",
        "-p",
        "queue-consumer",
        "name",
      ]);
      expect(queues.status, queues.stderr).toBe(0);
      expect(queues.stdout).toContain("queue-consumer");

      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "persistentvolumeclaim")).toEqual(["persistentvolumeclaim/rabbitmq-broker-data"]);
    },
    900_000,
  );

  // The "later pass" of milestone 3: the database pod is killed, `up` runs again, and the platform
  // recovers with its data (the PersistentVolumeClaim is reattached to the new pod).
  it.skipIf(!ready)(
    `recovers after the database pod is killed, and keeps the data${why}`,
    async () => {
      loadImage("orders");
      const ns = "pbtest-k8s-recovery";
      const work = project(ns, []);
      cpSync(join(pkg, "examples/orders"), join(work, "orders"), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      // A GraphQL call inside the orders pod (localhost), with the connection race retried.
      const gql = (query: string) => {
        let last = kc(["version", "--client"]);
        for (let attempt = 1; attempt <= 6; attempt++) {
          last = kc([
            "--namespace",
            ns,
            "exec",
            "deployment/orders-app",
            "--",
            "wget",
            "-qO-",
            "-T",
            "10",
            "--header",
            "content-type: application/json",
            "--post-data",
            JSON.stringify({ query }),
            "http://localhost:4000/graphql",
          ]);
          if (last.status === 0) return JSON.parse(last.stdout);
          if (!/can't connect|timed out|bad address/i.test(last.stderr)) break;
          console.log(`gql attempt ${attempt} failed (${last.stderr.trim().split("\n").pop()}); trying again in 5 s`);
          spawnSync("sleep", ["5"]);
        }
        expect(last.status, last.stderr).toBe(0);
        return JSON.parse(last.stdout);
      };

      const created = gql("mutation { createOrder(total: 42.5) { id total status } }");
      const id = created.data.createOrder.id;
      expect(created.data.createOrder).toEqual({ id, total: 42.5, status: "pending" });

      // Kill the database pod; the Deployment recreates it on the same PersistentVolumeClaim.
      const before = podsOf(ns).find((p) => p.metadata.name.startsWith("postgres-db-"))!.metadata.name;
      const deleted = kc(["--namespace", ns, "delete", "pod", before, "--wait=false"]);
      expect(deleted.status, deleted.stderr).toBe(0);
      const rolled = kc(["--namespace", ns, "rollout", "status", "deployment/postgres-db", "--timeout=180s"]);
      expect(rolled.status, rolled.stderr).toBe(0);
      const after = podsOf(ns).find((p) => p.metadata.name.startsWith("postgres-db-") && p.metadata.name !== before)?.metadata.name;
      expect(after, "a new postgres pod replaced the killed one").toBeDefined();

      // up again: the platform is applied and every rollout is waited for.
      const again = cli(work, ["up"]);
      expect(again.code, `${again.out}\n${again.err}`).toBe(0);

      // The orders API recovers its database connection, and the order is still there.
      await until(
        "the orders API to answer /health again",
        async () => {
          const r = kc(["--namespace", ns, "exec", "deployment/orders-app", "--", "wget", "-qO-", "http://localhost:4000/health"]);
          return r.status === 0;
        },
        120_000,
      );
      const read = gql(`query { order(id: "${id}") { id total status } }`);
      expect(read.data.order).toEqual({ id, total: 42.5, status: "pending" });

      // down keeps the data and the secret.
      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "persistentvolumeclaim")).toEqual(["persistentvolumeclaim/postgres-db-data"]);
      expect(names(ns, "secret")).toContain("secret/plugbricks-secrets");
    },
    900_000,
  );

  it.skipIf(!ready)(
    `a real client publishes and receives a message through NATS${why}`,
    async () => {
      const ns = "pbtest-k8s-nats";
      const work = project(ns, ["queue-a"]);
      cpSync(join(pkg, "examples/nats"), join(work, "nats"), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "nats"],
        ["add", "queue-a"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const pods = podsOf(ns);
      expect(pods.map((p) => p.metadata.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")).sort()).toEqual(["nats-broker", "queue-a-app"]);
      for (const p of pods) {
        expect(p.status.phase, p.metadata.name).toBe("Running");
        expect(
          p.status.containerStatuses?.every((c) => c.ready),
          `${p.metadata.name} is ready`,
        ).toBe(true);
      }

      // The consumer got the broker URL and its subject.
      const env = kc([
        "--namespace",
        ns,
        "exec",
        "deployment/queue-a-app",
        "--",
        "sh",
        "-c",
        '[ "$NATS_URL" = "nats://nats-broker:4222" ] && [ "$SUBJECT" = "queue-a" ] && echo ok',
      ]);
      expect(env.status, env.stderr).toBe(0);
      expect(env.stdout.trim()).toBe("ok");

      // A pinned nats-box pod subscribes; publish from inside it; its log shows the message.
      const sub = kc([
        "--namespace",
        ns,
        "run",
        "nats-sub",
        "--image=natsio/nats-box:0.19.2",
        "--restart=Never",
        "--command",
        "--",
        "nats",
        "--server",
        "nats://nats-broker:4222",
        "sub",
        "hello",
        "--count",
        "1",
      ]);
      expect(sub.status, sub.stderr).toBe(0);
      try {
        const ready = kc(["--namespace", ns, "wait", "--for=condition=Ready", "pod/nats-sub", "--timeout=120s"]);
        expect(ready.status, ready.stderr).toBe(0);
        const pub = kc([
          "--namespace",
          ns,
          "exec",
          "nats-sub",
          "--",
          "nats",
          "--server",
          "nats://nats-broker:4222",
          "pub",
          "hello",
          "world",
        ]);
        expect(pub.status, pub.stderr).toBe(0);
        await until(
          "the NATS subscriber to receive the message",
          async () => {
            const pod = JSON.parse(kc(["--namespace", ns, "get", "pod", "nats-sub", "--output", "json"]).stdout) as {
              status?: { phase?: string };
            };
            return pod.status?.phase === "Succeeded";
          },
          60_000,
        );
        const logs = kc(["--namespace", ns, "logs", "nats-sub"]);
        expect(logs.status, logs.stderr).toBe(0);
        expect(logs.stdout).toContain("Received on");
        expect(logs.stdout).toContain("world");
      } finally {
        kc(["--namespace", ns, "delete", "pod", "nats-sub", "--ignore-not-found"]);
      }

      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
    },
    900_000,
  );
});
