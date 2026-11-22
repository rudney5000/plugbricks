import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

// `kubectl port-forward` to a Service, bound to 127.0.0.1 on a free local port, for the Kubernetes end-to-end test.
// Every forward is tracked, so that a test that is interrupted can still stop all of them (stopAllForwards).

const forwards = new Set<ChildProcess>();

/** A TCP port that is free on 127.0.0.1 right now. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });
}

export interface ForwardOptions {
  /** The kubectl program, and the arguments that name the cluster (--kubeconfig, --context, --namespace). */
  kubectl: string;
  clusterArgs: string[];
  service: string;
  servicePort: number;
  /** The local port to listen on; a free one when absent. A web brick's page needs its webPort (D17). */
  localPort?: number;
  timeoutMs?: number;
}

/** Starts the forward and returns once kubectl says it listens. `stop` kills it; it never outlives its test. */
export async function portForward(o: ForwardOptions): Promise<{ port: number; stop: () => void }> {
  const port = o.localPort ?? (await freePort());
  const child = spawn(
    o.kubectl,
    [...o.clusterArgs, "port-forward", "--address", "127.0.0.1", `service/${o.service}`, `${port}:${o.servicePort}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  forwards.add(child);
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const stop = () => {
    child.kill();
    forwards.delete(child);
  };
  const deadline = Date.now() + (o.timeoutMs ?? 30_000);
  while (!log.includes(`Forwarding from 127.0.0.1:${port}`)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stop();
      throw new Error(`kubectl port-forward to ${o.service} did not start: ${log.trim() || "no output"}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, stop };
}

export function stopAllForwards(): void {
  for (const f of forwards) f.kill();
  forwards.clear();
}

/** How many forwards are still tracked (for tests). */
export const runningForwards = () => forwards.size;
