import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { COMPOSE_ROUTER_CONFIG, renderCompose } from "../src/drivers/compose.js";
import { ROUTER_IMAGE } from "../src/drivers/common.js";
import { K8S_ROUTER_CONFIG_FILE, renderK8s } from "../src/drivers/k8s.js";
import { checkImagePin } from "../src/image.js";
import type { Plan } from "../src/plan.js";
import { planProject } from "../src/plan.js";
import { readProject } from "../src/platform.js";
import { generate } from "../src/runtime.js";

// The router, rendered by plugbricks: its configuration, its pinned image, and what it exposes.
const pkg = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkg, ".test-work/router");

// Windows spells the paths of require.cache with backslashes: compare them with "/".
const cacheLoaded = (name: string) => Object.keys(createRequire(import.meta.url).cache).some((p) => p.replaceAll("\\", "/").includes(name));

function run(root: string, args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { cwd: root, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function project(name: string, bricks: string[]): string {
  const root = join(work, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "examples"), join(root, "examples"), { recursive: true });
  expect(run(root, ["init", "--name", "demo"]).code).toBe(0);
  for (const b of bricks) expect(run(root, ["add", `examples/${b}`]).code, b).toBe(0);
  return root;
}

let withRouter: string;
let withoutRouter: string;

describe("without a subgraph", () => {
  // Must stay the first test of the file: it looks at what this process has loaded so far.
  it("does not load the composer or the router configuration libraries, and writes no router file", () => {
    withoutRouter = project("none", ["postgres"]);
    for (const runtime of ["compose", "k8s"] as const) {
      const g = generate(withoutRouter, runtime);
      expect(g.plan.router).toBeUndefined();
      expect(g.files.filter((f) => f.endsWith("router-config.json"))).toEqual([]);
    }
    expect(cacheLoaded("@wundergraph/composition/dist/index.js")).toBe(false);
    expect(cacheLoaded("@wundergraph/cosmo-shared")).toBe(false);
    expect(readFileSync(join(withoutRouter, ".generated/compose/compose.yaml"), "utf8")).not.toContain("router");
    expect(readFileSync(join(withoutRouter, ".generated/k8s/resources.yaml"), "utf8")).not.toContain("router");
  });

  it("status shows no router", () => {
    expect(run(withoutRouter, ["status"]).out).not.toContain("Router:");
    expect(run(withoutRouter, ["status", "--json"]).out).not.toContain('"router"');
  });
});

describe("with orders and shipping", () => {
  beforeAll(() => {
    withRouter = project("both", ["postgres", "orders", "shipping"]);
  });

  it("the router configuration is the same text on every generate, on both runtimes, and after the generated folder is deleted", () => {
    const first = generate(withRouter, "compose");
    const text = readFileSync(join(withRouter, COMPOSE_ROUTER_CONFIG), "utf8");
    expect(text.length).toBeGreaterThan(1000);
    generate(withRouter, "compose");
    expect(readFileSync(join(withRouter, COMPOSE_ROUTER_CONFIG), "utf8")).toBe(text);
    rmSync(join(withRouter, ".generated"), { recursive: true });
    generate(withRouter, "compose");
    expect(readFileSync(join(withRouter, COMPOSE_ROUTER_CONFIG), "utf8")).toBe(text);
    generate(withRouter, "k8s");
    expect(readFileSync(join(withRouter, K8S_ROUTER_CONFIG_FILE), "utf8")).toBe(text);
    expect(first.plan.router?.configSha256).toBe(createHash("sha256").update(text).digest("hex"));
  });

  it("the configuration names both subgraphs with the URLs of our runtime names", () => {
    const config = JSON.parse(readFileSync(join(withRouter, COMPOSE_ROUTER_CONFIG), "utf8"));
    expect(config.subgraphs).toEqual([
      { id: "0", name: "orders", routingUrl: "http://orders-app:4000/graphql" },
      { id: "1", name: "shipping", routingUrl: "http://shipping-app:4000/graphql" },
    ]);
    expect(config.version).toBe("00000000-0000-0000-0000-000000000000");
  });

  it.skipIf(process.platform === "win32")("the router configuration is readable by the non-root user of the container (mode 0644)", () => {
    generate(withRouter, "compose");
    expect(statSync(join(withRouter, COMPOSE_ROUTER_CONFIG)).mode & 0o777).toBe(0o644);
  });

  it("a changed subgraph changes the configuration hash, which recreates the router", () => {
    const before = planProject(readProject(withRouter)).router!.configSha256;
    const other = project("both-other", ["postgres", "orders"]);
    expect(planProject(readProject(other)).router!.configSha256).not.toBe(before);
  });

  it("status shows the router: port and pinned image", () => {
    const out = run(withRouter, ["status"]).out;
    expect(out).toContain(`Router: port 4000 (Compose: 127.0.0.1 only; Kubernetes: ClusterIP service); image ${ROUTER_IMAGE}`);
    expect(JSON.parse(run(withRouter, ["status", "--json"]).out).router).toEqual({ port: 4000, image: ROUTER_IMAGE });
  });

  describe("what the router exposes", () => {
    const plan = (): Plan => planProject(readProject(withRouter));

    it("Compose: the router is the only published service, on 127.0.0.1, and runs as a non-root user without capabilities", () => {
      const yaml = renderCompose(plan())[".generated/compose/compose.yaml"];
      expect(yaml.match(/^ {4}ports:$/gm)).toHaveLength(1);
      expect(yaml.match(/published:/g)).toHaveLength(1);
      expect(yaml.match(/host_ip: /g)).toHaveLength(1);
      expect(yaml).toContain('host_ip: "127.0.0.1"');
      expect(yaml).toContain('user: "65532:65532"');
      for (const needle of ["read_only: true", "no-new-privileges:true", "cap_drop:\n      - ALL", "network_mode", "privileged"]) {
        expect(yaml.includes(needle), needle).toBe(needle !== "network_mode" && needle !== "privileged");
      }
    });

    it("Compose: it starts after every subgraph service is healthy", () => {
      const yaml = renderCompose(plan())[".generated/compose/compose.yaml"];
      const router = yaml.slice(yaml.indexOf("\n  router:\n"));
      expect(router).toContain(
        "    depends_on:\n      orders-app:\n        condition: service_healthy\n      shipping-app:\n        condition: service_healthy\n",
      );
    });

    it("Kubernetes: a ClusterIP Service only, no Ingress, NodePort, LoadBalancer, hostPort or hostNetwork, and the router is non-root with a read-only filesystem", () => {
      const yaml = renderK8s(plan())[".generated/k8s/resources.yaml"];
      for (const forbidden of [
        "kind: Ingress",
        "NodePort",
        "LoadBalancer",
        "hostPort",
        "hostNetwork",
        "hostPID",
        "privileged: true",
        "externalIPs",
      ]) {
        expect(yaml, forbidden).not.toContain(forbidden);
      }
      expect(yaml).toContain("type: ClusterIP");
      expect(yaml.match(/^kind: Service$/gm)).toHaveLength(4); // postgres-db, orders-app, shipping-app and router
      const router = yaml.slice(yaml.indexOf("name: router\n", yaml.indexOf("kind: Deployment", yaml.indexOf("name: router\n"))));
      for (const needle of [
        "runAsNonRoot: true",
        "runAsUser: 65532",
        "readOnlyRootFilesystem: true",
        "allowPrivilegeEscalation: false",
        "path: /health/ready",
        "path: /health/live",
      ]) {
        expect(router, needle).toContain(needle);
      }
    });
  });
});

describe("rendering rules on a hand-made plan", () => {
  const base: Plan = { platform: "demo", services: [], requirements: [], scripts: [], volumes: [], secrets: [] };
  const router = (
    config: string,
    subgraphs: NonNullable<Plan["router"]>["subgraphs"] = [{ service: "a-api", brick: "a", healthy: true }],
  ) => ({
    name: "router",
    image: ROUTER_IMAGE,
    port: 4000,
    config,
    configSha256: createHash("sha256").update(config).digest("hex"),
    subgraphs,
  });

  it("a subgraph service without a healthcheck is waited for until started, which is all Compose can do", () => {
    const yaml = renderCompose({
      ...base,
      router: router("{}", [
        { service: "a-api", brick: "a", healthy: true },
        { service: "b-api", brick: "b", healthy: false },
      ]),
    })[".generated/compose/compose.yaml"];
    expect(yaml).toContain("      a-api:\n        condition: service_healthy\n      b-api:\n        condition: service_started\n");
  });

  it("Kubernetes refuses a router configuration that does not fit in a ConfigMap, with ROUTER_CONFIG_TOO_LARGE, and Compose does not care", () => {
    const big = router("x".repeat(1_000_000));
    expect(() => renderK8s({ ...base, router: big })).toThrowError(/ROUTER_CONFIG_TOO_LARGE/);
    try {
      renderK8s({ ...base, router: big });
    } catch (e) {
      const issue = (e as { issues: { code: string; message: string; params: Record<string, string> }[] }).issues[0];
      expect(issue.code).toBe("ROUTER_CONFIG_TOO_LARGE");
      expect(issue.params).toEqual({ size: String(1_000_000 + "router-config.json".length), max: "1000000" });
      expect(issue.message).toBe(
        "the router configuration takes 1000018 bytes; a Kubernetes ConfigMap holds at most 1000000; remove a subgraph or use the Compose runtime",
      );
    }
    expect(Object.keys(renderCompose({ ...base, router: big }))).toContain(COMPOSE_ROUTER_CONFIG);
    expect(() => renderK8s({ ...base, router: router("x".repeat(900_000)) })).not.toThrow();
  });

  it("the size is checked before anything is written: generate on Kubernetes leaves the folder as it was", () => {
    // renderK8s runs before generate writes a file (see runtime.generate); this pins that order.
    const source = readFileSync(join(pkg, "src/runtime.ts"), "utf8");
    expect(source.indexOf("renderK8s(plan)")).toBeLessThan(source.indexOf("ensureSecrets("));
    expect(source.indexOf("renderK8s(plan)")).toBeLessThan(source.indexOf("writeFileAtomic("));
  });
});

describe("the router image", () => {
  it("passes the same pinning rule as every brick image", () => {
    const check = checkImagePin(ROUTER_IMAGE);
    expect(check.ok, JSON.stringify(check)).toBe(true);
    expect(checkImagePin("ghcr.io/wundergraph/cosmo/router:latest").ok).toBe(false);
  });
});
