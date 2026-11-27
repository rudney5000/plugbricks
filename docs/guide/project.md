# A project and its bricks

## Add, remove, disable

```bash
npx plugbricks add postgres              # a brick of bricks/, by name
npx plugbricks add ./my-brick            # or any brick folder, by path
npx plugbricks status                    # add --json for machine-readable output
npx plugbricks disable shipping-api      # installed but no longer deployed
npx plugbricks enable shipping-api       # deploy it again
npx plugbricks remove orders-api
```

A name (`postgres`) adds the brick of the project's `bricks/` folder; a new project has `postgres`, `rabbitmq`, `nats`,
`redis` and `seaweedfs` there, the bricks whose images are public. Without such a brick, a name still adds the folder of that name
where you typed the command; when both exist, `add` refuses and asks for a path (`./postgres` or `bricks/postgres`).
Anything with a `/` is a path.

`add` also proposes what the brick needs from `bricks/`: the providers of what it requires and the bricks it declares
in `dependencies`, and what those need in turn (`add orders-web` proposes `postgres` and `orders-api`). In a terminal it
asks; `--yes` adds them without asking; in a CI or a script without `--yes` it refuses a brick that cannot work without
them, and says what it would add and the command to run again. When several bricks of `bricks/` provide the same
capability, it asks which one, and `--yes` refuses.

A brick can be **disabled without being removed**: `plugbricks disable <name>` writes `enabled: false` in `platform.json`; its services stop (the next `up` removes them), while its volumes and secrets stay. `enable` brings it back, and the federated schema is recomposed either way. `status` marks it `disabled`, and `status --runtime` reports it `stopped` with `enabled: false`, without making the platform degraded.

A brick may also declare `tags` (`api`, `graphql`, `database`, `queue`, …) in its `plugin.json`; they are kept in `platform.lock` and shown in the JSON reports, for filtering in the admin.

## The files of a project

`plugbricks` keeps these in a project:

- `platform.json` — what you want: installed bricks and where each came from, and `router.port` (default 4000, 1024 to 65535): the port the router is published on, on `127.0.0.1` only, with Docker Compose, and the port of its ClusterIP Service on Kubernetes.
- `platform.lock` — what was resolved: versions, an integrity hash per brick, which brick provides each capability, wait settings with their defaults made explicit, the volumes kept after a removal (`retainedVolumes`) and the volumes marked for deletion (`pendingDeletion`). A driver deletes only the volumes in `pendingDeletion`, and only with `up --prune-volumes` (milestone 3); see the [decisions](../decisions.md). Deterministic: the same `add` twice leaves identical files.
- `.platform/bricks/<name>/` — a copy of each installed brick; `status` reports a copy that was edited.
- `.generated/<runtime>/` — what `generate` (and `up`) writes from the lock and the copies: `compose/compose.yaml`, or `k8s/namespace.yaml` and `k8s/resources.yaml`, and `router-config.json` beside them when an installed brick serves a subgraph. Never edited, never committed (the folder ignores itself).
- `.secrets/` — generated passwords (`secrets.env`, and `k8s-secret.yaml` for Kubernetes). Restricted to your user and checked before every write; never committed. Removing a brick keeps its secrets.

## Refusals

Every refusal prints `error <CODE>: <message>` with a stable code from [`messages.ts`](../../packages/plugbricks/src/messages.ts). Exit codes: 0 success, 1 refused or inconsistent, 2 usage error.

Commands that change the platform (`add`, `remove`, `enable`, `disable`, `generate`, `up`, `down`) run **one at a time**: each holds `.platform/lock` while it runs, and another one meanwhile is refused with `PLATFORM_BUSY`, whether it comes from a terminal or from the admin. A lock left by a process that died is taken over.
