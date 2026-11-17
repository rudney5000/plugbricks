# plugbricks

Add plugins and infrastructure bricks (PostgreSQL, a message queue, …) to a federated GraphQL project, on Docker Compose or Kubernetes, from a single `platform.json`.

Status: **milestone 4, first part merged** — the real `orders` API, a GraphQL subgraph with its own database, on top of the drivers (`generate`, `up`, `down`), the CLI core (`init`, `add`, `remove`, `status`) and the manifest contract. The Compose driver has run end to end against Docker; **the Kubernetes driver has not run on a cluster yet** (golden files and a fake `kubectl` only). The Cosmo router and a second API with `extends` are still to come.

## Use

```bash
npm create plugbricks mon-saas      # a new project; its README explains every folder
cd mon-saas
npx plugbricks add path/to/postgres # a brick that provides "database"
npx plugbricks add services/orders  # requires "database"
npx plugbricks status               # add --json for machine-readable output
npx plugbricks up                    # Docker Compose
npx plugbricks up --runtime k8s --context my-cluster   # Kubernetes: you always name the cluster
npx plugbricks down                  # stops everything; volumes and secrets are kept
npx plugbricks remove orders
npx plugbricks up --prune-volumes    # deletes only the volumes listed in pendingDeletion
```

`plugbricks` manages three things in a project:

- `platform.json` — what you want: installed bricks and where each came from.
- `platform.lock` — what was resolved: versions, an integrity hash per brick, which brick provides each capability, wait settings with their defaults made explicit, the volumes kept after a removal (`retainedVolumes`) and the volumes marked for deletion (`pendingDeletion`). A driver deletes only the volumes in `pendingDeletion`, and only with `up --prune-volumes` (milestone 3); see `docs/decisions.md`. Deterministic: the same `add` twice leaves identical files.
- `.platform/bricks/<name>/` — a copy of each installed brick; `status` reports a copy that was edited.
- `.generated/<runtime>/` — what `generate` (and `up`) writes from the lock and the copies: `compose/compose.yaml`, or `k8s/namespace.yaml` and `k8s/resources.yaml`. Never edited, never committed (the folder ignores itself).
- `.secrets/` — generated passwords (`secrets.env`, and `k8s-secret.yaml` for Kubernetes). Restricted to your user and checked before every write; never committed. Removing a brick keeps its secrets.

`up` returns once every service runs and passes its healthcheck (Compose `--wait`, Kubernetes `rollout status`). It starts, for each consumer and capability, a wait step (the provider's `ready` command, up to `timeoutSeconds`), then the provider's provision task, then the consumer. A wait that gives up is reported as `WAIT_TIMEOUT`. Nothing is published on the host until the router arrives. See `docs/decisions.md` (D5, D6).

Every refusal prints `error <CODE>: <message>` with a stable code from `src/messages.ts`. Exit codes: 0 success, 1 refused or inconsistent, 2 usage error.

## Layout

An npm workspaces monorepo. The root `package.json` runs `build`, `test` and `typecheck` in every package.

- `packages/plugbricks/` — the core library and the `plugbricks` CLI.
  - `schemas/plugin-manifest.schema.json` — the plugin contract (runtime-independent).
  - `schemas/platform.schema.json`, `schemas/platform-lock.schema.json` — the two project files, as strict as the manifest.
  - `examples/postgres/` — a base brick that provides the `database` capability; `provision/create-database.sh` creates one role and one database per consumer (idempotent).
  - `examples/orders/` — an API that requires `database` (waits until it is healthy) and exposes a federation v2 subgraph.
  - `src/manifest.ts` — `validateManifest()`: schema validation plus cross-field rules (unique service names, pinned images, referenced services exist). Every issue has a stable `code`, a JSON Pointer `path`, a `message` and its `params`.
  - `src/messages.ts` — the error code catalog. Tools match on `code`, never on the message text.
  - `src/platform.ts` — `initPlatform`, `addBrick`, `removeBrick`, `platformStatus`: the CLI logic, with no console output.
  - `src/cli.ts`, `src/bin.ts` — argument parsing, output and exit codes; `bin.ts` is the `plugbricks` executable.
  - `src/schemas.ts`, `src/issues.ts` — schema loading (each `$id` checked at startup) and the Ajv-to-code mapping shared by all three schemas.
  - `src/templates.ts` — `${provider.host}`, `${provider.port}`, `${consumer.name}`, `${secrets.<name>}`: which field accepts which.
  - `src/plan.ts` — the runtime-independent plan built from the lock and the installed copies: services, wait and provision steps, volumes, secrets; runtime name checks.
  - `src/drivers/compose.ts`, `src/drivers/k8s.ts` — pure functions plan → files. `src/yaml.ts` writes them deterministically.
  - `src/runtime.ts` — `generate`, `up`, `down`: secrets, files, then `docker compose` or `kubectl`, through an injectable executor.
  - `src/secrets.ts` — restricting and checking `.secrets/`, generating and reading secrets.
  - `src/image.ts` — image reference parsing and the pinning rule: a sha256 digest, or a tag starting with at least `MAJOR.MINOR` (`16.4-alpine`, `v1.2.3`). `latest`, `16`, `alpine` are rejected.
  - `test/fixtures/invalid/` — one invalid manifest per file, each with exactly one fault; `expected.json` gives the code and path it must produce.
  - `test/fixtures/cli/` — one folder per CLI scenario: `scenario.json` (steps, expected exit code, error codes, output, and the exact `docker`/`kubectl` commands, run by a fake executor), optional `bricks/` and golden `expected/` files (including `.generated/` output). Regenerate the golden files with `PLUGBRICKS_UPDATE_GOLDEN=1 npm test -w plugbricks`, then review the diff.
  - `test/` — Vitest suite, including `dist.test.ts`, which packs the package with `npm pack` and runs the built CLI, and `e2e-compose.test.ts`, which runs `up`/`down` against a real Docker engine (skipped, with the reason, where no Linux engine answers).
- `apis/orders/` — the source of the `orders` example API (Node 22, GraphQL Yoga, `@apollo/subgraph`, `pg`): a federation v2 subgraph with its own migrations and `/health`. Built as the image `plugbricks-example/orders:0.1.0` (`docker build -t plugbricks-example/orders:0.1.0 apis/orders`), which `examples/orders/plugin.json` runs. A standalone package with its own lockfile: the brick folder holds only the manifest and the SDL, so `add` never copies `node_modules`. Its tests check that its SDL is the brick's. The image is built locally and is not published to a registry yet: build it before `up`, and load it into a Kubernetes cluster (for example `k3d image import`) before `up --runtime k8s`.
- `packages/create-plugbricks/` — `npm create plugbricks <name>`: copies `template/`, writes `package.json`, and calls `initPlatform` from `plugbricks`.
- `docs/decisions.md` — design decisions taken ahead of their implementation, with their evidence.

Tests write only inside `.test-work/` folders of each package (gitignored).

## Develop

```bash
npm ci
npm test
npm run typecheck
```

Supported on Linux, macOS and Windows with Node 22 (the exact version is in `.node-version`).
CI (`.github/workflows/ci.yml`) runs the three commands above on all three systems; see
`docs/decisions.md` (D4) for what differs between them and how it is handled. `tools.json` pins
k3d and kubectl per OS and architecture, for a Kubernetes end-to-end test.

Run a script in one package only with `npm test -w plugbricks`.

### Dev container

Open the repo in a dev container ("Dev Containers: Reopen in Container" in VS Code); it runs `npm ci` on creation. Then:

```bash
npm test
```

The container has Node 22 and access to the host's Docker, so `npm test` runs the Compose end-to-end test there too.

Dependencies are pinned to exact versions (`.npmrc` sets `save-exact`), and `package-lock.json` is committed: always install with `npm ci`.

## Roadmap

1. **Manifest schema + examples** — done
   - `requires` as an object per capability, with an optional `wait` (`healthy` by default, or `started`).
   - Volume `retention` (`retain` by default, or `delete`) for what happens to data when a plugin is removed.
   - Stable error codes and a message catalog; invalid examples kept as files.
   - Images pinned to an exact version or a digest, for services and provision tasks.
   - Schema `$id` set to the raw GitHub URL of the schema file; a working, idempotent PostgreSQL provision script.
2. **CLI core** — done: `init`, `add`, `remove`, `status`, `platform.json` / `platform.lock`, `npm create plugbricks`
   - Manifest: `requires.<cap>.timeoutSeconds`, `provides.<cap>.ready`, healthcheck `timeoutSeconds` and `startPeriodSeconds` (from experiment D).
3. **Drivers** — done: `generate`, `up`, `down`, `up --prune-volumes` on Docker Compose and Kubernetes, rendered by plugbricks itself (D5, Score dropped); generated secrets (D6); templates checked at `add`.
   - Written, not yet seen green: the Kubernetes end-to-end test (`packages/plugbricks/test/e2e-k8s.test.ts`) and the CI job "kubernetes (k3d)": `up` with postgres and orders, a GraphQL call, `down`, `remove` + `up --prune-volumes`, `WAIT_TIMEOUT`, on a throwaway k3d cluster named `pbtest-*` (it is skipped for any other context).
   - Later pass: kill the database pod, then `up` again, and check that the platform recovers and the data is kept.
4. **Federation**: real APIs, the Cosmo router, composition checked at `add`, a second API with `extends`
   - Done: the `orders` API (`apis/orders`), tested alone and on a platform.
5. **Message queue** (NATS)
