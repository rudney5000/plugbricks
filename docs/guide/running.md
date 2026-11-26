# Running a platform

```bash
npx plugbricks doctor                                   # what up needs, and what to fix first; changes nothing
npx plugbricks up                                       # Docker Compose
npx plugbricks up --runtime k8s --context my-cluster    # Kubernetes: you always name the cluster
npx plugbricks down                                     # stops everything; volumes and secrets are kept
npx plugbricks up --prune-volumes                       # deletes only the volumes listed in pendingDeletion
```

## `up`

`up` returns once every service runs and passes its healthcheck (Compose `--wait`, Kubernetes `rollout status`). It starts, for each consumer and capability, a wait step (the provider's `ready` command, up to `timeoutSeconds`), then the provider's provision task, then the consumer. A wait that gives up is reported as `WAIT_TIMEOUT`. When at least one brick serves a subgraph, plugbricks also starts the Cosmo router in front of them (`generate` builds its configuration from the subgraphs; it is not a brick). It is the only thing published on the host: with Compose on `127.0.0.1:<router.port>`, with Kubernetes as a ClusterIP Service (no Ingress, no NodePort). `status` shows its port and its image, pinned by digest. See the [decisions](../decisions.md).

`doctor` checks, without changing anything, what `up` needs: Node, Docker and Compose or kubectl and the cluster, the
ports, another platform of the same name, the images to build.

`logs <brick>` and `exec <brick> -- <command>` reach a brick's service, or the router, on both runtimes
([Writing a service](./services.md)).

## Kubernetes

`--context` names the cluster and is always required: the current kubectl context is never used. Add
`--kubeconfig <file>` for a file other than kubectl's default. The cluster pulls the images itself: import an image you
built into a local cluster (`k3d image import`, `kind load docker-image`), or push it to a registry the cluster reads.

## Leaving: `export`

```bash
npx plugbricks export ./deploy                      # the Compose file, to run with plain docker compose
npx plugbricks export ./deploy-k8s --runtime k8s    # or the Kubernetes manifests, for kubectl apply
```

The folder holds what `up` runs, with a `README.md` that gives the commands and lists the images. No secret value is
written unless you add `--with-secrets`. The folder must not exist yet, and plugbricks never reads it again.

## What really runs: `status --runtime`

`plugbricks status` shows the declared state: the installed bricks, the composition, the router. `plugbricks status --runtime <compose|k8s>` also asks the runtime what it really runs, and puts the two side by side. It only reads: one `docker compose ps --all --format json` and one `docker inspect` restricted to the restart counts, or one `kubectl get deployments,pods,services --output json`. It never execs into a container, never reads logs, Secrets or environment variables, and never sends a request to a service: the health it reports is the runtime's own. Every call has a 15 s timeout (kubectl also gets `--request-timeout=10s`).

```bash
npx plugbricks status --runtime compose            # a table
npx plugbricks status --runtime compose --json     # the versioned JSON report
npx plugbricks status --runtime k8s --context my-cluster [--kubeconfig file] [--json]
```

There is no runtime field in `platform.json`: name the runtime, as for `up` and `down`. Kubernetes needs the same explicit `--context` (and optional `--kubeconfig`) as `up`, with the same refusals (`K8S_CONTEXT_REQUIRED`, `K8S_CONTEXT_REFUSED`, `K8S_KUBECONFIG_NOT_FOUND`).

For each installed brick and each of its services, and for the router: `enabled` (installed and not disabled in `platform.json`, see [disabling a brick](./project.md)), `deployed` (the runtime has a container or a Deployment for it), `state`, a short `reason`, the restart count and the container or pod names. A difference between the two is flagged: `mismatch` is `not-deployed` (enabled, nothing running) or `not-declared` (running under the platform's name, not in `platform.json`, listed under `undeclared`). The router also gives its published address (Compose: `127.0.0.1:<port>`; Kubernetes: `<cluster IP>:<port>` of its Service), the digest of the image the runtime reports, and the state of each subgraph service it calls.

| `state`        | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `healthy`      | Running, and its health check (Compose healthcheck, Kubernetes readiness probe) passes.                    |
| `starting`     | Not ready yet: health check not passed yet, init containers running, rollout in progress.                  |
| `unhealthy`    | Running but failing: failing health check, restart loop, CrashLoopBackOff, image pull error, unschedulable. |
| `stopped`      | Exited (with its exit code), created but never started, or scaled to 0.                                    |
| `not deployed` | The runtime has nothing for it.                                                                             |
| `unknown`      | Running with no health check to tell (the router on Compose: its image has no shell), or a state plugbricks does not know. Never counted as a problem. |

Exit codes of `status --runtime`: **0** every enabled service and the router are `healthy` or `unknown`; **1** the declared state is inconsistent (the same problems as `status`) or the cluster is refused; **2** usage error; **3** an enabled service or the router is `starting`, `unhealthy`, `stopped` or `not deployed`; **4** the runtime cannot be read (`RUNTIME_UNAVAILABLE`: not installed, not answering, or slower than the timeout). Something running but not declared is reported and does not change the exit code.

`--json` prints one document, `"version": 1`, described by [`packages/plugbricks/schemas/status-runtime.schema.json`](../../packages/plugbricks/schemas/status-runtime.schema.json). Key names are stable within a version; no field holds a time, so two reads of the same runtime state give the same bytes. Shortened example (Compose, the shipping service stopped):

```json
{
  "version": 1,
  "platform": "demo",
  "runtime": "compose",
  "context": null,
  "state": "degraded",
  "bricks": [
    {
      "name": "shipping",
      "enabled": true,
      "tags": ["api", "graphql"],
      "services": [
        {
          "name": "shipping-api-app",
          "service": "app",
          "enabled": true,
          "deployed": true,
          "state": "stopped",
          "reason": "exited with code 0",
          "restarts": 0,
          "instances": ["demo-shipping-app-1"],
          "subgraph": true,
          "mismatch": null
        }
      ]
    }
  ],
  "router": {
    "name": "router",
    "enabled": true,
    "deployed": true,
    "state": "unknown",
    "reason": "running; no health check",
    "restarts": 0,
    "instances": ["demo-router-1"],
    "mismatch": null,
    "address": "127.0.0.1:4000",
    "image": "ghcr.io/wundergraph/cosmo/router:0.372.0@sha256:bfe6d89a…0205",
    "digest": "sha256:bfe6d89a…0205",
    "subgraphs": [
      { "brick": "orders", "name": "orders-api-app", "state": "healthy" },
      { "brick": "shipping", "name": "shipping-api-app", "state": "stopped" }
    ]
  },
  "undeclared": [],
  "problems": []
}
```
