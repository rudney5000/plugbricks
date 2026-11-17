import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { k8sTestTarget } from "./helpers/k8s-guard.js";

// Runs the Kubernetes driver against a real, throwaway k3d cluster: up with postgres and orders, a
// GraphQL call, down, remove + up --prune-volumes, and WAIT_TIMEOUT.
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

afterAll(() => {
  if (!ready) return;
  // The namespaces of this test only; the cluster itself is deleted by whoever created it.
  for (const ns of namespaces) kc(["delete", "namespace", ns, "--ignore-not-found", "--wait=false"]);
});

describe("Kubernetes driver against a real k3d cluster", () => {
  it.skipIf(!ready)(
    `runs postgres and orders, answers GraphQL, keeps data on down, prunes only the pending volume${why}`,
    () => {
      const nodes = kc(["get", "nodes", "--no-headers"]);
      expect(nodes.status, `the cluster ${context} does not answer: ${nodes.stderr}`).toBe(0);

      // The orders image is built here, so the cluster has no registry to pull it from.
      const build = spawnSync("docker", ["build", "--quiet", "--tag", "plugbricks-example/orders:0.1.0", join(repo, "apis/orders")], {
        encoding: "utf8",
      });
      expect(build.status, build.stderr).toBe(0);
      const imported = spawnSync(
        k3d,
        ["image", "import", "plugbricks-example/orders:0.1.0", "--cluster", target.ok ? target.cluster : ""],
        { encoding: "utf8" },
      );
      expect(imported.status, imported.stderr).toBe(0);

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
        "scratch-redis",
      ]);
      expect(podList.map((p) => p.status.phase)).toEqual(["Running", "Running", "Running"]);

      // Nothing is published outside the cluster: call the API by its Service name from inside a pod.
      const gql = (query: string) => {
        const r = kc([
          "--namespace",
          ns,
          "exec",
          "deployment/orders-app",
          "--",
          "wget",
          "-qO-",
          "--header",
          "content-type: application/json",
          "--post-data",
          JSON.stringify({ query }),
          "http://orders-app:4000/graphql",
        ]);
        expect(r.status, r.stderr).toBe(0);
        return JSON.parse(r.stdout);
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
});
