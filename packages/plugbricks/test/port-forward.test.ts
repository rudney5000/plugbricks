import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { freePort, portForward, runningForwards, stopAllForwards } from "./helpers/port-forward.js";

// The port-forward helper of the Kubernetes end-to-end test, checked with a fake kubectl (a Node script): there is
// no cluster here. The fake prints what kubectl prints and listens on the local port it was given.
const pkg = fileURLToPath(new URL("../", import.meta.url));
const dir = join(pkg, ".test-work/port-forward");

function fakeKubectl(behaviour: "forward" | "exit" | "silent", argsFile?: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "kubectl");
  writeFileSync(
    file,
    `#!${process.execPath}
// An ES module: the package has "type": "module" and this file has no extension.
import http from "node:http";
const args = process.argv.slice(2);
const local = args[args.length - 1].split(":")[0];
const behaviour = ${JSON.stringify(behaviour)};
import { writeFileSync } from "node:fs";
if (${JSON.stringify(argsFile ?? "")}) writeFileSync(${JSON.stringify(argsFile ?? "")}, JSON.stringify(args));
if (behaviour === "exit") {
  console.error("error: unable to forward port because pod is not running");
  process.exit(1);
} else if (behaviour === "silent") {
  setInterval(() => {}, 1000);
} else {
  http.createServer((req, res) => res.end("ok")).listen(Number(local), "127.0.0.1", () => {
    console.log("Forwarding from 127.0.0.1:" + local + " -> 3002");
  });
}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

afterEach(() => stopAllForwards());

describe.skipIf(process.platform === "win32")("portForward", () => {
  it("finds a free port, starts kubectl on it bound to 127.0.0.1, and stops it", async () => {
    const f = await portForward({
      kubectl: fakeKubectl("forward"),
      clusterArgs: ["--kubeconfig", "k", "--context", "k3d-pbtest-x", "--namespace", "ns"],
      service: "router",
      servicePort: 4000,
    });
    expect(f.port).toBeGreaterThan(1023);
    expect(runningForwards()).toBe(1);
    expect(await (await fetch(`http://127.0.0.1:${f.port}/`)).text()).toBe("ok");
    f.stop();
    expect(runningForwards()).toBe(0);
    await expect(fetch(`http://127.0.0.1:${f.port}/`)).rejects.toThrow();
  });

  it("always names the cluster before port-forward, and binds 127.0.0.1 explicitly", async () => {
    const log = join(dir, "args.json");
    const kubectl = fakeKubectl("forward", log);
    const clusterArgs = ["--kubeconfig", "k.yaml", "--context", "k3d-pbtest-x", "--namespace", "ns"];
    const f = await portForward({ kubectl, clusterArgs, service: "router", servicePort: 4000 });
    f.stop();
    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      ...clusterArgs,
      "port-forward",
      "--address",
      "127.0.0.1",
      "service/router",
      `${f.port}:4000`,
    ]);
  });

  it("fails with kubectl's own message when kubectl exits", async () => {
    await expect(
      portForward({ kubectl: fakeKubectl("exit"), clusterArgs: ["--context", "k3d-pbtest-x"], service: "router", servicePort: 4000 }),
    ).rejects.toThrow(/did not start: error: unable to forward port because pod is not running/);
    expect(runningForwards()).toBe(0);
  });

  it("gives up and kills kubectl when it never says it listens", async () => {
    await expect(
      portForward({
        kubectl: fakeKubectl("silent"),
        clusterArgs: ["--context", "k3d-pbtest-x"],
        service: "router",
        servicePort: 4000,
        timeoutMs: 600,
      }),
    ).rejects.toThrow(/did not start: no output/);
    expect(runningForwards()).toBe(0);
  });

  it("stopAllForwards stops every forward that is still running", async () => {
    const kubectl = fakeKubectl("forward");
    const a = await portForward({ kubectl, clusterArgs: [], service: "router", servicePort: 4000 });
    const b = await portForward({ kubectl, clusterArgs: [], service: "router", servicePort: 4000 });
    expect(new Set([a.port, b.port]).size).toBe(2);
    expect(runningForwards()).toBe(2);
    stopAllForwards();
    expect(runningForwards()).toBe(0);
  });

  it("freePort answers a port nothing listens on", async () => {
    const port = await freePort();
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });
});
