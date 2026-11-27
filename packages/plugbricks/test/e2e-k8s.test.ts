import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import type { LiveStatus } from "../src/live.js";
import { schemaIssues, statusRuntimeSchema } from "../src/schemas.js";
import { ask, get, through, until, type Answer } from "./helpers/graphql.js";
import { k8sTestTarget } from "./helpers/k8s-guard.js";
import { freePort, portForward, stopAllForwards } from "./helpers/port-forward.js";
import { exampleImage } from "./helpers/images.js";
import { checkIsolation, readStores, writeStores, type Exec } from "./helpers/stores.js";

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
  const tag = exampleImage(api);
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

      loadImage("orders-api");

      const ns = "pbtest-k8s";
      const work = project(ns, ["scratch"]);
      cpSync(join(pkg, "examples/orders-api"), join(work, "orders-api"), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders-api"],
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
        "orders-api-app",
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
      expect(states).toMatchObject({ "orders-api-app": "healthy", "postgres-db": "healthy" });
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
            "http://orders-api-app:4000/graphql",
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
      loadImage("orders-api");
      loadImage("shipping-api");
      const ns = "pbtest-k8s-router";
      const work = project(ns, []);
      for (const brick of ["orders-api", "shipping-api"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders-api"],
        ["add", "shipping-api"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      // up returns only when every rollout is done (kubectl rollout status, which waits for readiness).
      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      console.log(`kubectl get pods (namespace ${ns}):\n${kc(["--namespace", ns, "get", "pods", "--output", "wide"]).stdout}`);
      const pods = podsOf(ns);
      expect(pods.map((p) => p.metadata.name.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")).sort()).toEqual([
        "orders-api-app",
        "postgres-db",
        "router",
        "shipping-api-app",
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
        "orders-api-app",
        "postgres-db",
        "router",
        "shipping-api-app",
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
      expect(cli(work, ["remove", "shipping-api"]).code).toBe(0);
      const removed = cli(work, ["up"]);
      expect(removed.code, `${removed.out}\n${removed.err}`).toBe(0);
      const without = routerState(ns);
      expect(without.hash).not.toBe(before.hash);
      expect(without.generation).toBeGreaterThan(before.generation);
      expect(without.pods).toHaveLength(1);
      expect(without.pods).not.toEqual(before.pods);
      expect(names(ns, "deployment")).toEqual(["deployment.apps/orders-api-app", "deployment.apps/postgres-db", "deployment.apps/router"]);
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
      expect(cli(work, ["add", "shipping-api"]).code).toBe(0);
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
      // Kubernetes restarts a crash-looping init container, so the rollout alone would only fail at its
      // deadline (the waits plus 300 s). up waits in slices and reads the wait init container between them:
      // the exit code 124 is reported after the first slice or so, as Compose does.
      const started = Date.now();
      const up = cli(work, ["up"]);
      const seconds = Math.round((Date.now() - started) / 1000);
      expect(up.code, `${up.out}\n${up.err}`).toBe(1);
      expect(up.err).toContain('error WAIT_TIMEOUT: "patient" gave up waiting for capability "slow" from "never" after 3s');
      console.log(`WAIT_TIMEOUT reported by up after ${seconds} s`);
      // Well under the old 303 s deadline: pulling the images and starting the pod, a 3 s wait, a slice or two.
      expect(seconds).toBeLessThan(120);
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
    `Redis and SeaweedFS give each consumer its own keys and bucket${why}`,
    () => {
      const ns = "pbtest-k8s-stores";
      const work = project(ns, ["store-a", "store-b"]);
      for (const brick of ["redis", "seaweedfs"]) cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "redis"],
        ["add", "seaweedfs"],
        ["add", "store-a"],
        ["add", "store-b"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const exec: Exec = (consumer, service, script) => {
        const r = kc(["--namespace", ns, "exec", `deployment/${consumer}-${service}`, "--", "sh", "-c", script]);
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      writeStores(exec);
      readStores(exec);
      const address = kc([
        "--namespace",
        ns,
        "get",
        "pods",
        "--selector",
        "plugbricks/service=seaweedfs-s3",
        "--output",
        "jsonpath={.items[0].status.podIP}",
      ]);
      expect(address.status, address.stderr).toBe(0);
      expect(address.stdout).toMatch(/^\d+(\.\d+){3}$/);
      checkIsolation(exec, address.stdout);

      // down keeps both volumes; up finds the data again.
      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
      expect(names(ns, "persistentvolumeclaim")).toEqual([
        "persistentvolumeclaim/redis-server-data",
        "persistentvolumeclaim/seaweedfs-s3-data",
      ]);
      const again = cli(work, ["up"]);
      expect(again.code, `${again.out}\n${again.err}`).toBe(0);
      readStores(exec);
      expect(cli(work, ["down"]).code).toBe(0);
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

  // D17 on a cluster: a web brick is not published (its Service is a ClusterIP like every other); it is reached with
  // kubectl port-forward on its webPort, the local port the router's allowed origins name.
  it.skipIf(!ready)(
    `serves a web brick's page through port-forward on its webPort, with the router accepting its origin only${why}`,
    async () => {
      for (const api of ["orders-api", "shipping-api", "orders-web"]) loadImage(api);
      const ns = "pbtest-k8s-web";
      const work = project(ns, []);
      for (const brick of ["orders-api", "shipping-api", "orders-web"])
        cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders-api"],
        ["add", "shipping-api"],
        ["add", "orders-web"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);
      // The local port of the forward must be the webPort: that is the origin the router accepts.
      const webPort = await freePort();
      const file = join(work, "platform.json");
      const platform = JSON.parse(readFileSync(file, "utf8"));
      platform.bricks["orders-web"].webPort = webPort;
      writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      // Nothing is published: every Service is a ClusterIP, the web brick's too.
      const services = JSON.parse(kc(["--namespace", ns, "get", "services", "--output", "json"]).stdout).items as {
        metadata: { name: string };
        spec: { type: string };
      }[];
      expect(services.map((s) => s.metadata.name).sort()).toEqual([
        "orders-api-app",
        "orders-web-app",
        "postgres-db",
        "router",
        "shipping-api-app",
      ]);
      expect(services.every((s) => s.spec.type === "ClusterIP")).toBe(true);

      // The web service is given the router inside the cluster (its Service port) and the router as a browser here reaches it.
      const env = JSON.parse(kc(["--namespace", ns, "get", "deployment", "orders-web-app", "--output", "json"]).stdout).spec.template.spec
        .containers[0].env as { name: string; value?: string }[];
      expect(Object.fromEntries(env.map((e) => [e.name, e.value]))).toMatchObject({
        GRAPHQL_URL: "http://router:4000/graphql",
        PUBLIC_GRAPHQL_URL: "http://127.0.0.1:4000/graphql",
      });

      const origin = `http://127.0.0.1:${webPort}`;
      const orderId = await viaRouter(
        ns,
        async (routerPort) => {
          const created = await through(routerPort, "createOrder (k8s)", "mutation { createOrder(total: 42.5) { id } }");
          const id = created.body.data.createOrder.id as string;
          // Checked here, so that a failed mutation is reported as such and not, later, as a page without the shipment.
          const shipped = await through(
            routerPort,
            "shipOrder (k8s)",
            `mutation { shipOrder(orderId: "${id}", carrier: "dhl") { status } }`,
          );
          expect(shipped.body, "shipOrder through the router").toEqual({ data: { shipOrder: { status: "SHIPPED" } } });
          // The router accepts the page's origin, and refuses another one before running anything.
          const pre = await fetch(`http://127.0.0.1:${routerPort}/graphql`, {
            method: "OPTIONS",
            headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
          });
          expect([pre.status, pre.headers.get("access-control-allow-origin")]).toEqual([204, origin]);
          const elsewhere = await fetch(`http://127.0.0.1:${routerPort}/graphql`, {
            method: "POST",
            headers: { origin: "http://evil.example", "content-type": "text/plain" },
            body: JSON.stringify({ query: "mutation { createOrder(total: 1) { id } }" }),
          });
          expect(elsewhere.status).toBe(403);
          return id;
        },
        // shipment(...) is a root field of shipping: the router must reach it before the first mutation. Asking only for
        // orders (and their shipment) proves nothing while there is no order: the router then never calls shipping.
        '{ orders(limit: 1) { id } shipment(orderId: "1") { carrier } }',
      );

      // The page, through a forward on its webPort: rendered by its server through GRAPHQL_URL, inside the cluster.
      const page = await portForward({
        kubectl: "kubectl",
        clusterArgs: ["--kubeconfig", kubeconfig, "--context", context, "--namespace", ns],
        service: "orders-web-app",
        servicePort: 3000,
        localPort: webPort,
      });
      try {
        const html = async () => (await fetch(`${origin}/orders`)).text();
        // The page's server calls the router, which calls shipping, at every request. Right after `up`, a call through
        // a fresh Service can still fail once (see viaRouter): then that one page shows the shipment "Unavailable". So the
        // page is read until it shows the shipped order, and the last row it showed is printed if it never does.
        const rowOf = (text: string) => text.match(new RegExp(`<tr><td>#${orderId}</td>.*?</tr>`))?.[0] ?? "(order not listed)";
        let shown = "";
        try {
          await until(
            "the page to show the shipped order",
            async () => {
              shown = await html();
              return shown.includes(`#${orderId}`) && shown.includes("dhl · SHIPPED");
            },
            120_000,
          );
        } catch (e) {
          console.log(`last row of order #${orderId} on the page: ${rowOf(shown)}`);
          throw e;
        }
        expect(shown).toContain('data-graphql="http://127.0.0.1:4000/graphql"');

        // Shipping scaled to zero: the page still lists the order, its shipment unavailable.
        expect(kc(["--namespace", ns, "scale", "deployment/shipping-api-app", "--replicas=0"]).status).toBe(0);
        let degraded = "";
        await until(
          "the degraded page",
          async () => {
            degraded = await html();
            return degraded.includes("Unavailable");
          },
          120_000,
        );
        expect(degraded).toContain(`#${orderId}`);
        console.log(`k8s page on ${origin}/orders with shipping scaled to 0: order #${orderId} listed, shipment "Unavailable"`);
      } finally {
        page.stop();
      }

      expect(cli(work, ["down"]).code).toBe(0);
    },
    900_000,
  );

  // D18, D19 and D20 on a cluster: the Keycloak brick provides oidc, the router requires its tokens and passes them on,
  // and orders checks them again itself and records who created an order. Keycloak's issuer is its web origin, so it
  // is reached here, as a browser would, through a port-forward on its webPort.
  it.skipIf(!ready)(
    `requires Keycloak's tokens through the router and in orders itself, and records who created an order${why}`,
    async () => {
      for (const api of ["keycloak", "orders-api", "orders-web"]) loadImage(api);
      const ns = "pbtest-k8s-oidc";
      const work = project(ns, []);
      for (const brick of ["keycloak", "orders-api", "orders-web"])
        cpSync(join(pkg, "examples", brick), join(work, brick), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "keycloak"],
        ["add", "orders-web"],
        ["add", "orders-api"],
      ])
        expect(cli(work, args).code, args.join(" ")).toBe(0);
      // The issuer the tokens carry is Keycloak's web origin: the local port of its forward must be its webPort.
      const kcPort = await freePort();
      const file = join(work, "platform.json");
      const platform = JSON.parse(readFileSync(file, "utf8"));
      platform.bricks.keycloak.webPort = kcPort;
      platform.bricks["orders-web"].webPort = await freePort();
      writeFileSync(file, JSON.stringify(platform, null, 2) + "\n");

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);

      const secretOf = (key: string) => {
        const line = readFileSync(join(work, ".secrets/secrets.env"), "utf8")
          .split("\n")
          .find((l) => l.startsWith(`${key}=`));
        expect(line, key).toBeDefined();
        return line!.slice(key.length + 1);
      };
      const keycloak = await portForward({
        kubectl: "kubectl",
        clusterArgs: ["--kubeconfig", kubeconfig, "--context", context, "--namespace", ns],
        service: "keycloak-app",
        servicePort: 8080,
        localPort: kcPort,
      });
      const router = await forward(ns, "router", 4000);
      try {
        // orders-web's own client, as its server asks for it: client credentials, from the issuer the browser reaches.
        const asOrdersWeb = async () => {
          const asked = await fetch(`http://127.0.0.1:${kcPort}/realms/plugbricks/protocol/openid-connect/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: "orders-web",
              client_secret: secretOf("PB_KEYCLOAK__ORDERS_WEB__CLIENT_SECRET"),
            }),
          });
          expect(asked.status).toBe(200);
          return ((await asked.json()) as { access_token: string }).access_token;
        };
        // D22: orders-web lists orders, so its service account holds orders:read, and not orders:write.
        const token = await asOrdersWeb();

        const graphql = async (query: string, bearer?: string) => {
          const r = await fetch(`http://127.0.0.1:${router.port}/graphql`, {
            method: "POST",
            headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
            body: JSON.stringify({ query }),
          });
          return { status: r.status, body: (await r.json().catch(() => null)) as { data?: any; errors?: unknown[] } | null }; // eslint-disable-line @typescript-eslint/no-explicit-any
        };
        await until("the router through the forward", async () => (await get(router.port, "/health/ready")) === 200);
        // A read with the token proves the router's path to orders before the mutation, which is never retried.
        await until(
          "the router to answer with a token",
          async () => {
            const r = await graphql("{ orders(limit: 1) { id } }", token);
            return r.status === 200 && !r.body?.errors?.length;
          },
          120_000,
        );

        // No token: nothing runs through the router, not even a read.
        expect((await graphql("{ orders(limit: 1) { id } }")).status).toBe(401);
        expect((await graphql("mutation { createOrder(total: 1) { id } }")).status).toBe(401);
        // orders-web's token is valid but has no write role: the router passes it on and orders refuses the mutation (D22).
        const refused = await graphql("mutation { createOrder(total: 1) { id } }", token);
        expect(refused.body?.data?.createOrder ?? null).toBeNull();
        expect(JSON.stringify(refused.body)).toMatch(/FORBIDDEN|forbidden/);
        // The operator gives the service account the write role in Keycloak, with kcadm inside its pod. A token asked
        // afterwards has it; the one above keeps what it had until it expires.
        const keycloakPod = podsOf(ns, "--selector", "plugbricks/service=keycloak-app").find((p) => !p.metadata.deletionTimestamp)!;
        const grant = kc([
          "--namespace",
          ns,
          "exec",
          keycloakPod.metadata.name,
          "--",
          "env",
          `KC_CLI_PASSWORD=${secretOf("PB_KEYCLOAK__ADMIN_PASSWORD")}`,
          "bash",
          "-c",
          [
            "set -e",
            "k=/opt/keycloak/bin/kcadm.sh; c=$(mktemp -d)",
            'login() { "$k" "$@" --config "$c/kcadm.config"; }',
            "login config credentials --server http://127.0.0.1:8080 --realm master --user admin >/dev/null",
            "login add-roles -r plugbricks --uusername service-account-orders-web --cclientid orders-api --rolename orders:write",
          ].join("; "),
        ]);
        expect(grant.status, grant.stderr).toBe(0);
        // With a token asked after the grant, the router passes it on, orders checks it again and records who created the order.
        const writer = await asOrdersWeb();
        const created = await graphql("mutation { createOrder(total: 42.5) { id createdBy } }", writer);
        expect(created.status).toBe(200);
        expect(created.body?.data?.createOrder?.createdBy).toBe("service-account-orders-web");
        const id = created.body!.data.createOrder.id as string;
        console.log(`k8s: order #${id} created through the router with orders-web's token, createdBy service-account-orders-web`);

        // A pod of the platform calling orders directly, past the router: 401 without a token, 200 with one (D20).
        const pod = podsOf(ns, "--selector", "plugbricks/service=orders-web-app").find((p) => !p.metadata.deletionTimestamp)!;
        const direct = (bearer: string) =>
          kc([
            "--namespace",
            ns,
            "exec",
            pod.metadata.name,
            "--",
            "node",
            "-e",
            `const h = { "content-type": "application/json", "x-user-sub": "admin-forged" };
             if (process.argv[1]) h.authorization = "Bearer " + process.argv[1];
             const r = await fetch("http://orders-api-app:4000/graphql", { method: "POST", headers: h, body: '{"query":"{ orders(limit: 1) { id } }"}' });
             console.log(r.status);`,
            bearer,
          ]);
        const directMutation = (bearer: string) =>
          kc([
            "--namespace",
            ns,
            "exec",
            pod.metadata.name,
            "--",
            "node",
            "-e",
            `const r = await fetch("http://orders-api-app:4000/graphql", { method: "POST",
               headers: { "content-type": "application/json", authorization: "Bearer " + process.argv[1] },
               body: '{"query":"mutation { createOrder(total: 1) { id } }"}' });
             console.log(r.status);`,
            bearer,
          ]);
        const without = direct("");
        expect(without.status, without.stderr).toBe(0);
        expect(without.stdout.trim().split("\n").pop()).toBe("401");
        const withToken = direct(token);
        expect(withToken.stdout.trim().split("\n").pop()).toBe("200");
        // Past the router the roles apply too: the read-only token is refused a mutation by orders itself (403).
        const readOnlyWrites = directMutation(token);
        expect(readOnlyWrites.stdout.trim().split("\n").pop()).toBe("403");
        expect(directMutation(writer).stdout.trim().split("\n").pop()).toBe("200");
      } finally {
        router.stop();
        keycloak.stop();
      }

      // orders-web asks for its own token inside the cluster and reads the orders through the router with it.
      const page = await portForward({
        kubectl: "kubectl",
        clusterArgs: ["--kubeconfig", kubeconfig, "--context", context, "--namespace", ns],
        service: "orders-web-app",
        servicePort: 3000,
        localPort: platform.bricks["orders-web"].webPort,
      });
      try {
        let rows = "";
        await until(
          "orders-web to list the order",
          async () => {
            rows = ((await (await fetch(`http://127.0.0.1:${page.port}/api/orders`)).json()) as { rows: string }).rows;
            return rows.includes("42.50");
          },
          120_000,
        );
        expect(rows).not.toContain("401");
      } finally {
        page.stop();
      }

      expect(cli(work, ["down"]).code).toBe(0);
    },
    1_200_000,
  );

  // The "later pass" of milestone 3: the database pod is killed, `up` runs again, and the platform
  // recovers with its data (the PersistentVolumeClaim is reattached to the new pod).
  it.skipIf(!ready)(
    `recovers after the database pod is killed, and keeps the data${why}`,
    async () => {
      loadImage("orders-api");
      const ns = "pbtest-k8s-recovery";
      const work = project(ns, []);
      cpSync(join(pkg, "examples/orders-api"), join(work, "orders-api"), { recursive: true });
      for (const args of [
        ["init", "--name", ns],
        ["add", "postgres"],
        ["add", "orders-api"],
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
            "deployment/orders-api-app",
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
          const r = kc(["--namespace", ns, "exec", "deployment/orders-api-app", "--", "wget", "-qO-", "http://localhost:4000/health"]);
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

      // A pinned nats-box pod subscribes; a second pod publishes. Publishing with "kubectl exec" in the
      // subscriber is flaky: when the subscriber exits on the message, the exec is killed (exit 137) even
      // though the publish happened.
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
        await new Promise((r) => setTimeout(r, 2_000));
        const pub = kc([
          "--namespace",
          ns,
          "run",
          "nats-pub",
          "--image=natsio/nats-box:0.19.2",
          "--restart=Never",
          "--command",
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
            const logs = kc(["--namespace", ns, "logs", "nats-sub"]);
            const text = `${logs.stdout}${logs.stderr}`;
            return text.includes("Received on") && text.includes("world");
          },
          60_000,
        );
      } finally {
        kc(["--namespace", ns, "delete", "pod", "nats-sub", "nats-pub", "--ignore-not-found"]);
      }

      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
    },
    900_000,
  );

  it.skipIf(!ready)(
    `runs an API written by create once its image is imported into the cluster (D28)${why}`,
    async () => {
      const ns = "pbtest-k8s-create";
      const work = project(ns, []);
      expect(cli(work, ["init", "--name", ns]).code).toBe(0);
      const created = cli(work, ["create", "inventory", "--kind", "api"]);
      expect(created.code, created.err).toBe(0);
      const image = `${ns}/inventory-api:0.1.0`;
      // What create prints: build from the project folder, then import into a local cluster (k3d here).
      expect(created.out).toContain(`docker build -t ${image} -f services/inventory-api/Dockerfile .`);
      expect(created.out).toContain(`k3d image import ${image} --cluster <name>`);
      const build = spawnSync("docker", ["build", "--quiet", "-t", image, "-f", "services/inventory-api/Dockerfile", "."], {
        cwd: work,
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      const imported = spawnSync(k3d, ["image", "import", image, "--cluster", target.ok ? target.cluster : ""], { encoding: "utf8" });
      expect(imported.status, imported.stderr).toBe(0);

      const up = cli(work, ["up"]);
      expect(up.code, `${up.out}\n${up.err}`).toBe(0);
      const items = await viaRouter(
        ns,
        async (port) => (await through(port, "inventoryItems", "{ inventoryItems { id name } }")).body,
        "{ inventoryItems { id } }",
      );
      expect(items).toEqual({
        data: {
          inventoryItems: [
            { id: "1", name: "first" },
            { id: "2", name: "second" },
          ],
        },
      });
      console.log(`k8s: ${image} imported with k3d, inventoryItems answered through the router`);

      expect(cli(work, ["down"]).code).toBe(0);
      expect(names(ns, "deployment")).toEqual([]);
    },
    900_000,
  );
});
