// "plugbricks doctor" (D31) with a fake docker and kubectl: what each answer of the tools gives, the fix it prints,
// and that doctor writes nothing. The real tools are tried by hand (D31, "Tested").
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { doctor, satisfiesMinimum, type Check, type DoctorDeps } from "../src/doctor.js";
import type { Exec, ExecResult } from "../src/runtime.js";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkg, ".test-work/doctor");
const root = join(work, "demo");

/** A fake tool: the first rule whose text appears in "<cmd> <args>" answers; anything else succeeds with no output. */
function fake(rules: [string, Partial<ExecResult>][]): Exec {
  return (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    const r = rules.find(([match]) => line.includes(match))?.[1] ?? {};
    return { status: 0, stdout: "", stderr: "", ...r } as ExecResult;
  };
}
const healthyDocker: [string, Partial<ExecResult>][] = [
  ["docker version", { stdout: "29.8.0 linux\n" }],
  ["docker compose version", { stdout: "5.8.0\n" }],
];
const run = (deps: DoctorDeps, runtime: "compose" | "k8s" = "compose") =>
  doctor(root, runtime, { nodeVersion: "22.23.5", portFree: () => true, ...deps });
const byId = (checks: Check[], id: Check["id"]) => checks.find((c) => c.id === id);
const cli = (args: string[]) => main(args, { cwd: root, stdout: () => {}, stderr: () => {} });

beforeEach(() => {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(pkg, "examples/postgres"), join(root, "bricks/postgres"), { recursive: true });
  expect(cli(["init", "--name", "demo"])).toBe(0);
  expect(cli(["add", "postgres"])).toBe(0);
  // An API that create wrote: a subgraph (so a router port) and an image to build from services/.
  expect(cli(["create", "inventory", "--kind", "api"])).toBe(0);
});

describe("satisfiesMinimum", () => {
  it("compares a version with a >= range, and lets any other range through", () => {
    expect(satisfiesMinimum("22.23.5", ">=22.12.0")).toBe(true);
    expect(satisfiesMinimum("v22.12.0", ">=22.12.0")).toBe(true);
    expect(satisfiesMinimum("22.11.9", ">=22.12.0")).toBe(false);
    expect(satisfiesMinimum("20.20.0", ">=22.12.0")).toBe(false);
    expect(satisfiesMinimum("24.0.0", ">=22.12.0")).toBe(true);
    expect(satisfiesMinimum("22.0.0", "^22 || ^24")).toBe(true);
  });
});

describe("doctor on Docker Compose", () => {
  it("passes a platform whose tools answer, and warns about an image create wrote the code of and that is not built", () => {
    const checks = run({ exec: fake([...healthyDocker, ["docker image inspect --format {{.Id}} demo/inventory-api", { status: 1 }]]) });
    expect(checks.map((c) => `${c.id}:${c.state}`)).toEqual([
      "node:ok",
      "platform:ok",
      "secrets:ok",
      "docker:ok",
      "compose:ok",
      "project-name:ok",
      "ports:ok",
      "images:warning",
    ]);
    expect(byId(checks, "images")!.fix).toBe("docker build -t demo/inventory-api:0.1.0 -f services/inventory-api/Dockerfile .");
  });

  it("says an image that is not here is pulled by up, when nothing builds it here", () => {
    const checks = run({ exec: fake([...healthyDocker, ["docker image inspect --format {{.Id}} postgres", { status: 1 }]]) });
    expect(byId(checks, "images")).toEqual({ id: "images", state: "ok", detail: "1 image on this machine, 1 to be pulled by up" });
  });

  it("refuses an old Node", () => {
    expect(byId(run({ nodeVersion: "20.20.0", exec: fake(healthyDocker) }), "node")).toMatchObject({
      state: "problem",
      fix: "install Node 22.12.0 or later",
    });
  });

  it("stops at Docker when it is missing, does not answer, or runs Windows containers", () => {
    const missing = run({ exec: fake([["docker version", { status: null, error: "spawn docker ENOENT" }]]) });
    expect(missing.map((c) => c.id)).not.toContain("compose");
    expect(byId(missing, "docker")).toMatchObject({ state: "problem", detail: "the docker command was not found" });
    const down = run({
      exec: fake([["docker version", { status: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n" }]]),
    });
    expect(byId(down, "docker")!.detail).toBe("Docker does not answer: Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    const windows = run({ exec: fake([["docker version", { stdout: "29.8.0 windows\n" }]]) });
    expect(byId(windows, "docker")).toMatchObject({ state: "problem", fix: "switch Docker to Linux containers" });
  });

  it("finds the Compose plugin missing", () => {
    const checks = run({
      exec: fake([
        ["docker version", { stdout: "29.8.0 linux\n" }],
        ["docker compose version", { status: 1 }],
      ]),
    });
    expect(byId(checks, "compose")!.state).toBe("problem");
  });

  it("finds another platform of the same name running from another folder (they would share containers and volumes)", () => {
    const other = "/elsewhere/shop/.generated/compose";
    const here = join(root, ".generated/compose");
    const exec = fake([...healthyDocker, ["--format {{.Label", { stdout: `${other}\n${here}\n` }]]);
    expect(byId(run({ exec }), "project-name")).toMatchObject({
      state: "problem",
      detail: 'another platform named "demo" has containers on this machine, from /elsewhere/shop',
    });
    expect(byId(run({ exec: fake([...healthyDocker, ["--format {{.Label", { stdout: `${here}\n` }]]) }), "project-name")!.state).toBe("ok");
  });

  it("tells a port held by another program from one held by this platform, up already", () => {
    const busy = run({ exec: fake(healthyDocker), portFree: (p) => p !== 4000 });
    expect(byId(busy, "ports")).toMatchObject({ state: "problem", detail: "port 4000 (router.port) is used by another program" });
    const ours = run({
      exec: fake([...healthyDocker, ["--format {{.Ports}}", { stdout: "127.0.0.1:4000->3002/tcp\n" }]]),
      portFree: () => false,
    });
    expect(byId(ours, "ports")!.state).toBe("ok");
  });

  it.skipIf(process.platform === "win32")("finds .secrets/ readable by others", () => {
    expect(cli(["generate"])).toBe(0);
    chmodSync(join(root, ".secrets"), 0o755);
    const checks = run({ exec: fake(healthyDocker) });
    expect(byId(checks, "secrets")).toMatchObject({ state: "problem" });
    expect(byId(checks, "secrets")!.fix).toContain("chmod 700 .secrets");
  });

  it("says where to run it when there is no platform, and still checks the tools", () => {
    const checks = doctor(work, "compose", { nodeVersion: "22.23.5", exec: fake(healthyDocker) });
    expect(byId(checks, "platform")).toMatchObject({ state: "problem" });
    expect(checks.map((c) => c.id)).toEqual(["node", "platform", "docker", "compose"]);
  });

  it("writes nothing", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(join(dir, e.name))
          : [`${join(dir, e.name)} ${statSync(join(dir, e.name)).mtimeMs} ${readFileSync(join(dir, e.name), "utf8").length}`],
      );
    const before = files(root);
    run({ exec: fake(healthyDocker) });
    // The real port check runs here: its answer depends on the machine, what is checked is that nothing is written.
    main(["doctor"], { cwd: root, stdout: () => {}, stderr: () => {}, runtime: { exec: fake(healthyDocker) } });
    expect(files(root)).toEqual(before);
  });
});

describe("doctor on Kubernetes", () => {
  const k8s = { context: "k3d-dev" };
  const healthyKubectl: [string, Partial<ExecResult>][] = [
    ["config get-contexts", { stdout: "k3d-dev\nother\n" }],
    ["get --raw /readyz", { stdout: "ok" }],
  ];

  it("passes a named context that answers, and warns about an image the cluster must be given", () => {
    const checks = run({ exec: fake(healthyKubectl), k8s }, "k8s");
    expect(checks.map((c) => `${c.id}:${c.state}`)).toEqual([
      "node:ok",
      "platform:ok",
      "secrets:ok",
      "kubectl:ok",
      "context:ok",
      "cluster:ok",
      "images:warning",
    ]);
    expect(byId(checks, "images")!.fix).toContain("k3d image import");
  });

  it("needs kubectl, a context, an allowed one, and one the kubeconfig has", () => {
    expect(byId(run({ exec: fake([["kubectl version", { status: null, error: "ENOENT" }]]) }, "k8s"), "kubectl")!.state).toBe("problem");
    expect(byId(run({ exec: fake(healthyKubectl) }, "k8s"), "context")).toMatchObject({ state: "problem" });
    expect(byId(run({ exec: fake(healthyKubectl), k8s: { context: "platform" } }, "k8s"), "context")!.detail).toContain('"platform"');
    expect(byId(run({ exec: fake(healthyKubectl), k8s: { context: "gone" } }, "k8s"), "context")!.detail).toBe(
      'the kubeconfig has no context "gone"',
    );
  });

  it("finds a cluster that does not answer", () => {
    const exec = fake([
      healthyKubectl[0],
      ["get --raw /readyz", { status: 1, stderr: "Unable to connect to the server: dial tcp 127.0.0.1:6443\n" }],
    ]);
    expect(byId(run({ exec, k8s }, "k8s"), "cluster")!.detail).toBe(
      "the cluster does not answer: Unable to connect to the server: dial tcp 127.0.0.1:6443",
    );
  });
});
