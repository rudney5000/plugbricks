# plugbricks

plugbricks is a command-line tool that assembles a federated GraphQL platform from bricks (APIs, a database, a message queue, …), each described by a manifest, and runs it on Docker Compose or Kubernetes from a single `platform.json`.

## What plugbricks is, and what it is not

- **A tool, not a library.** Your code never imports plugbricks. A brick is a container image and a manifest (`plugin.json`); plugbricks starts it and hands it what it needs as environment variables (`DATABASE_URL`, `OIDC_*`, `AUTHORIZATION_*`). The example APIs in `apis/` do not depend on it.
- **Not an application framework.** It does not run your code or decide how you write it: it does not care what is inside the image, as long as the brick honours its manifest and reads the variables it was promised.
- **It does set conventions.** The project layout (`platform.json`, `platform.lock`, the bricks), the manifest, and the variables injected into a brick are the contract between a brick and the platform. This contract is what a brick author depends on, more than the command line. While the version is 0.x it can change in a minor version.
- **A small programmatic API exists** (the `plugbricks` package exports its manifest validation, composition and planning), used by the admin and by `create-plugbricks`. It is not the way to use the tool.

Status: not published yet (see [the checklist](docs/pre-publication-checklist.md)). Docker Compose and Kubernetes both run
end to end in the tests; what is built and what is planned is in the [roadmap](#roadmap) below.

## Quick start

```bash
npm create plugbricks mon-saas -- --starter demo   # the example shop (D30); without --starter, an empty project
cd mon-saas && npm install
npx plugbricks up                                  # Docker Compose; the router answers at http://127.0.0.1:4000/graphql
npx plugbricks down                                # stops everything; volumes and secrets are kept
```

Until the first publication, run these from a clone: see [Getting started](docs/guide/getting-started.md).

## Documentation

The guide is in [`docs/guide/`](docs/guide/getting-started.md), and the same files make the documentation site (D40).

| Page                                                          | For                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Getting started](docs/guide/getting-started.md)              | a first API behind the router, step by step                         |
| [A project and its bricks](docs/guide/project.md)             | `add`, `remove`, `disable`, the files of a project, refusals        |
| [Writing a service](docs/guide/services.md)                   | `create` (TypeScript, Python, Go), `dev`, `logs`, `exec`            |
| [Writing a brick](docs/guide/bricks.md)                       | the manifest, field by field; web pages                             |
| [Databases, queues and tokens](docs/guide/capabilities.md)    | `postgres`, `rabbitmq`, `nats`, `keycloak`, roles                   |
| [Existing services](docs/guide/existing-services.md)          | a subgraph that runs elsewhere, gRPC, REST                          |
| [Running a platform](docs/guide/running.md)                   | `up`, `status --runtime`, `doctor`, Kubernetes, `export`            |
| [The admin](docs/guide/admin.md)                              | the local web interface                                             |
| [Known limits](docs/guide/limits.md)                          | what it does not do                                                 |

How it is built: [architecture](docs/architecture.md), [decisions](docs/decisions.md).

![The Bricks page of the admin: four healthy bricks, their tags, ports, subgraphs and router endpoint](docs/screenshots/admin-bricks.png)

## Layout

An npm workspaces monorepo. The root `package.json` runs `build`, `test` and `typecheck` in every package.

- `packages/plugbricks/` — the core library and the `plugbricks` CLI.
  - `schemas/plugin-manifest.schema.json` — the plugin contract (runtime-independent).
  - `schemas/platform.schema.json`, `schemas/platform-lock.schema.json` — the two project files, as strict as the manifest.
  - `schemas/status-runtime.schema.json` — the report of `status --runtime --json`, version 1 (D10).
  - `examples/postgres/` — a base brick that provides the `database` capability; `provision/create-database.sh` creates one role and one database per consumer (idempotent).
  - `examples/orders-api/` — an API that requires `database` (waits until it is healthy) and exposes a federation v2 subgraph.
  - `examples/rabbitmq/` — a base brick that provides the `queue` capability: one RabbitMQ broker shared by every consumer, each getting its own vhost, user and `QUEUE_NAME` (D11, D12); its provision script creates them through the management API.
  - `examples/nats/` — a second `queue` provider: a NATS server (core publish/subscribe), `NATS_URL` and `SUBJECT` per consumer, no accounts or JetStream (D13).
  - `examples/queue-consumer/` — an API that requires `queue`: it declares its queue, publishes one message, consumes it, and exposes the round-trip on `/health` (`apis/queue-consumer`).
  - `src/manifest.ts` — `validateManifest()`: schema validation plus cross-field rules (unique service names, pinned images, referenced services exist). Every issue has a stable `code`, a JSON Pointer `path`, a `message` and its `params`.
  - `src/messages.ts` — the error code catalog. Tools match on `code`, never on the message text.
  - `src/platform.ts` — `initPlatform`, `addBrick`, `removeBrick`, `platformStatus`: the CLI logic, with no console output.
  - `src/cli.ts`, `src/bin.ts` — argument parsing, output and exit codes; `bin.ts` is the `plugbricks` executable.
  - `src/schemas.ts`, `src/issues.ts` — schema loading (each `$id` checked at startup) and the Ajv-to-code mapping shared by the four schemas.
  - `src/templates.ts` — `${provider.host}`, `${provider.port}`, `${consumer.name}`, `${secrets.<name>}`: which field accepts which.
  - `src/plan.ts` — the runtime-independent plan built from the lock and the installed copies: services, wait and provision steps, volumes, secrets; runtime name checks.
  - `src/drivers/compose.ts`, `src/drivers/k8s.ts` — pure functions plan → files. `src/yaml.ts` writes them deterministically.
  - `src/runtime.ts` — `generate`, `up`, `down`, `status --runtime`: secrets, files, then `docker compose` or `kubectl`, through an injectable executor.
  - `src/live.ts` — pure parsing and the report of `status --runtime`: state, reason, restarts and instances per brick, service and router, `enabled` vs `deployed` (D10).
  - `src/secrets.ts` — restricting and checking `.secrets/`, generating and reading secrets.
  - `src/image.ts` — image reference parsing and the pinning rule: a sha256 digest, or a tag starting with at least `MAJOR.MINOR` (`16.4-alpine`, `v1.2.3`). `latest`, `16`, `alpine` are rejected.
  - `test/fixtures/invalid/` — one invalid manifest per file, each with exactly one fault; `expected.json` gives the code and path it must produce.
  - `test/fixtures/cli/` — one folder per CLI scenario: `scenario.json` (steps, expected exit code, error codes, output, and the exact `docker`/`kubectl` commands, run by a fake executor), optional `bricks/` and golden `expected/` files (including `.generated/` output). Regenerate the golden files with `PLUGBRICKS_UPDATE_GOLDEN=1 npm test -w plugbricks`, then review the diff.
  - `test/` — Vitest suite, including `dist.test.ts`, which packs the package with `npm pack` and runs the built CLI, and `e2e-compose.test.ts`, which runs `up`/`down` against a real Docker engine (skipped, with the reason, where no Linux engine answers).
- `apis/orders-api/` — the source of the `orders-api` example API (Node 22, GraphQL Yoga, `@apollo/subgraph`, `pg`): a federation v2 subgraph with its own migrations and `/health`. Built as the image `ghcr.io/rudney5000/plugbricks/orders-api:0.1.0` (`docker build -t ghcr.io/rudney5000/plugbricks/orders-api:0.1.0 apis/orders-api`), which `examples/orders-api/plugin.json` runs. A standalone package with its own lockfile: the brick folder holds only the manifest and the SDL, so `add` never copies `node_modules`. Its tests check that its SDL is the brick's. The images workflow publishes it (D29); a Kubernetes cluster pulls it itself.
- `apis/shipping-api/` — the source of the `shipping-api` example API, same shape as `apis/orders-api` (its own lockfile, migrations, `/health`, image `ghcr.io/rudney5000/plugbricks/shipping-api:0.1.0`, built with `docker build -t ghcr.io/rudney5000/plugbricks/shipping-api:0.1.0 apis/shipping-api`). Its subgraph extends the `Order` entity of the orders API with a `shipment` field (`examples/shipping-api/plugin.json` declares `extends: [{ plugin: "orders", entities: ["Order"] }]`) and keeps its data in its own database, which the orders API cannot reach. Its tests check that its SDL is the brick's, and a test composes all the example bricks together.
- `apis/queue-consumer/` — the source of the queue consumer example (Node 22, `amqplib`, `/health`), same shape as `apis/orders-api`: a standalone package with its own lockfile, image `ghcr.io/rudney5000/plugbricks/queue-consumer:0.1.0`, built with `docker build -t ghcr.io/rudney5000/plugbricks/queue-consumer:0.1.0 apis/queue-consumer`. It connects with its own `AMQP_URL`, declares `QUEUE_NAME`, publishes one message and consumes it; `/health` answers 200 only after that round-trip. Its tests check the health state machine.
- `packages/create-plugbricks/` — `npm create plugbricks <name>`: copies `template/`, writes `package.json`, and calls `initPlatform` from `plugbricks`.
- `docs/` — the documentation site (D40): the guide (`docs/guide/`), the architecture, the decisions; `npm ci && npm run dev` in that folder serves it.
- `docs/decisions.md` — design decisions taken ahead of their implementation, with their evidence.
- `docs/architecture.md` — how the pieces fit together, from the manifest to the running containers, with what is built and what is planned.

Tests write only inside `.test-work/` folders of each package (gitignored).

## Develop

How to contribute, and what a change needs: [CONTRIBUTING.md](CONTRIBUTING.md). A vulnerability is reported
privately: [SECURITY.md](SECURITY.md). What each version changes: [CHANGELOG.md](CHANGELOG.md).

```bash
npm ci
npm run hooks:install   # once per clone: turns on the git hooks of .githooks/
npm test
npm run typecheck
```

Code quality, all from the repository root:

| Command                | What it does                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run format`       | Prettier rewrites the code, JSON and YAML                                                              |
| `npm run format:check` | Prettier only checks (what CI runs)                                                                    |
| `npm run lint`         | ESLint (flat config, typescript-eslint)                                                                |
| `npm run typecheck`    | `tsc --noEmit` in each package                                                                         |
| `npm test`             | every test, including the Docker end-to-end ones                                                       |
| `npm run test:unit`    | every test except the Docker and Kubernetes end-to-end ones (what the pre-push hook runs)              |
| `npm run coverage`     | unit tests with a V8 coverage report, no threshold                                                     |
| `npm run quality`      | `format:check`, `lint`, `typecheck`, `test`, in this order: the CI `quality` job runs exactly this     |

Test inputs, golden files, the example bricks and the project template are never formatted or linted:
they are hashed or compared byte for byte. Hooks, CI jobs and the reasons are in `docs/decisions.md` (D7).

Supported on Linux, macOS and Windows with Node 22.12 or newer (`engines` says so; the exact version CI and the dev container use is in `.node-version`). The router configuration loads `@wundergraph/cosmo-shared`, an ES module, with `require()`, which Node supports without a flag from 22.12; Node 20.19 also built the configuration in a manual check, but CI does not test it, so it is not claimed.
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

## License

Apache License 2.0: see `LICENSE` and `NOTICE`. The packages are not published yet; the steps are in `docs/pre-publication-checklist.md`, the reasons for the licence in D23 of `docs/decisions.md`.

## Roadmap

What comes next (publication, an easy start for a newcomer, a documentation site, bringing existing services in) is in `docs/roadmap.md`, with the order of work.

1. **Manifest schema + examples** — done
   - `requires` as an object per capability, with an optional `wait` (`healthy` by default, or `started`).
   - Volume `retention` (`retain` by default, or `delete`) for what happens to data when a plugin is removed.
   - Stable error codes and a message catalog; invalid examples kept as files.
   - Images pinned to an exact version or a digest, for services and provision tasks.
   - Schema `$id` set to the raw GitHub URL of the schema file; a working, idempotent PostgreSQL provision script.
2. **CLI core** — done: `init`, `add`, `remove`, `status`, `platform.json` / `platform.lock`, `npm create plugbricks`
   - Manifest: `requires.<cap>.timeoutSeconds`, `provides.<cap>.ready`, healthcheck `timeoutSeconds` and `startPeriodSeconds` (from experiment D).
3. **Drivers** — done: `generate`, `up`, `down`, `up --prune-volumes` on Docker Compose and Kubernetes, rendered by plugbricks itself (D5, Score dropped); generated secrets (D6); templates checked at `add`.
   - Done: the Kubernetes end-to-end test (`packages/plugbricks/test/e2e-k8s.test.ts`) and the CI job "kubernetes (k3d)": `up` with postgres and orders, a GraphQL call, `down`, `remove` + `up --prune-volumes`, `WAIT_TIMEOUT`, on a throwaway k3d cluster named `pbtest-*` (it is skipped for any other context). Its `WAIT_TIMEOUT` scenario used to wait about five minutes for the rollout deadline; `up` now reads the wait init containers every 15 s and reports it at once (D5).
   - Later pass: kill the database pod, then `up` again, and check that the platform recovers and the data is kept.
4. **Federation**: real APIs, the Cosmo router, composition checked at `add`, a second API with `extends`
   - Done: the `orders-api` API (`apis/orders-api`), tested alone and on a platform.
   - Done: composition of the subgraphs checked at `add`, `remove` and `status` (`@wundergraph/composition`, D8): `COMPOSITION_FAILED`, `SUBGRAPH_SCHEMA_INVALID`, `EXTENDS_*`; a `federation` section in `platform.lock`.
   - Done (4b-2): the `shipping-api` API (`apis/shipping-api`) extends `Order` of `orders-api` (`examples/shipping-api`), tested alone, composed with `orders-api` in the tests, and end to end on Docker Compose (own database, no access to the orders database, `_entities` answered, data kept across `down` and `up`).
   - Done (4b-3): the router is rendered for Docker Compose and Kubernetes: `router-config.json` built in process from the composition, the router image pinned by digest (`tools.json`), `router.port` in `platform.json`, golden-file tests (D9).
   - Done (4b-4): real requests through the router on Docker Compose (`e2e-compose`): an order created through the router, then shipped, then read back in one request that reaches both `orders-api` and `shipping-api`; a validation error does not crash it; the playground is off; `remove shipping-api` then `up` recreates the router without the `shipment` field, `add shipping-api` brings it back; `remove orders-api` stays refused while shipping extends it; after `down` no router and no published port; with no subgraph, no router. The known limits observed there are in D8.
   - Done (4b-5): the cross-check of our router configuration against `wgc router compose` (wgc 0.133.12, pinned in `tools/wgc-crosscheck`): equal except an empty `featureFlagConfigs` (D9). The end-to-end test of the router and shipping on k3d, with requests through the router, a rollout when the composition changes and `down`, runs green in the `kubernetes (k3d)` job since 2026-11-18 (PR #14, and on `main`).
   - Done (5a): `status --runtime compose|k8s [--json]`: what the runtime really runs next to what is declared, read-only (D10), with a versioned JSON report (`schemas/status-runtime.schema.json`) and its own exit codes (3 degraded, 4 `RUNTIME_UNAVAILABLE`). Tested with recorded Compose output and hand-written Kubernetes Lists, end to end on Docker Compose, and on k3d in CI.
   - Before the first publication: the licence (Apache-2.0, D23), the version (0.1.0) and the publish workflow are in place (D24); what is left is in `docs/pre-publication-checklist.md`: the npm account and token, the example bricks for a new project, the signature of the tool checksums and the open audit items.
5. **Message queue**
   - Done (5b): `examples/rabbitmq` provides `queue`: one broker, any number of consumers, each with its own vhost, user and `QUEUE_NAME`; golden scenario, end to end on Docker Compose, and the same scenario in the k3d job (D11).
   - Done (5b-bis): `services[].extraPorts` and one RabbitMQ account per consumer, through the management API (D12).
   - Done (5b-ter): a real consumer (`examples/queue-consumer`, source `apis/queue-consumer`) publishes and consumes a message through the broker, on Docker Compose and k3d.
   - Done (5c): `examples/nats` provides `queue` with core NATS (`NATS_URL`, `SUBJECT`), tested with a pinned `nats-box` client on Docker Compose and k3d (D13). Kafka stays deferred.
   - Deferred: Kafka, and NATS accounts/JetStream, which need a configuration file or command line the manifest cannot express today.
6. **Admin** — done
   - Done (5d): `enabled` in `platform.json` (`enable` / `disable`: installed but not deployed) and `tags` in `plugin.json` (D14).
   - Done (6b): one changing command at a time, `.platform/lock` and `PLATFORM_BUSY` (D16).
   - Done (6, 6c, 6d): `plugbricks admin` on `127.0.0.1:4100`, the Bricks, Router and Audit pages, OIDC sign-in with the roles `plugbricks-viewer` and `plugbricks-admin`, actions (`add`, `enable`, `disable`, `remove`, `up`) run through the CLI and written to `.admin/audit.log`, the UI shipped in the package (D15).
   - Done (7a): the router accepts browser calls only from the origins it lists; it used to accept every origin, and a cross-site mutation ran (D17).
   - Done (7b): web bricks: `web` in the manifest, `webPort` in `platform.json`, published on 127.0.0.1 only, `GRAPHQL_URL` and `PUBLIC_GRAPHQL_URL`, the example `orders-web`, tested end to end on Docker Compose and on k3d (D17).
   - Done (7c): a Keycloak brick (`examples/keycloak`, image from `apis/keycloak`): the platform's own identity provider for the admin, tested end to end on Docker Compose with a real sign-in, and on k3d with its realm, its clients and their tokens (the sign-in to the admin stays on Compose) (D18).
   - Done (8a): optional requirements, `"optional": true` in a brick's `requires`: without a provider the brick runs as it is, with one it is wired, even when the provider is added later (D19).
   - Done (8b): `examples/keycloak` provides `oidc`: each brick that requires it gets its own confidential client and `OIDC_TOKEN_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; `orders-web` requires it optionally (D19).
   - Done (8c): with a brick that provides `oidc`, the router requires a token of its issuer and audience (`router.yaml`, D19), starts after the provider, and `orders-web` sends its own; without one, nothing changes. Tested end to end on Docker Compose.
   - Done (8d): `plugbricks admin` finds the issuer of the platform's own oidc provider when `--issuer` is not given (D19).
   - Done (9a, 9b): with a brick that provides `oidc`, the router passes the token on and `orders-api` and `shipping-api` check it themselves (401 without a valid token, even called directly inside the platform) (D20).
   - Done (9c): `orders-api` records who created an order, `Order.createdBy` (the verified caller's `preferred_username`, else `sub`, never a header; null without a token check); the tokens, `createdBy` and the direct call refused without a token are tested end to end on Docker Compose and on k3d (D20).
   - Done (10): `dependencies` in the manifest (`orders-web` declares `orders-api`), and a panel in the admin under the Bricks table: what a brick needs, transitively, in what order, and who requires it (D21). `remove orders-api` is refused while `orders-web` declares it, `disable orders-api` while `orders-web` is enabled (both `DEPENDENCY_IN_USE`), and `add` warns when the declared brick is missing; `up` does not wait for it.
   - Done (11): an API says who may call it with an `authorization` block (`orders-api`: `orders:read`, `orders:write`; `shipping-api`: `shipping:read`, `shipping:write`). With an `oidc` provider, a valid token without the role of the operation (query or mutation) is refused by the API itself, `FORBIDDEN` and HTTP 403, even called directly; a token that is not valid is still 401. The Keycloak brick creates the roles on the API's own client and gives a brick that lists the API in `dependencies` the roles of the operations it says it uses (`orders-web` reads orders and shipments and cannot write; `"optional": true` for a dependency that is not needed to run). Without an `oidc` provider nothing changes. Tested end to end with a real Keycloak on Docker Compose and on k3d (D22). Not built: a rule on one field (`@requiresScopes`), the router enforcing the roles, and taking a role back at once (a token keeps its roles for its 300 s).
   - Done (12): the admin shows what each API asks of a token and what its service account holds (D22): the "Authorization" and "Roles held" rows of the Details tab, and `open` for an API that requires `oidc` but declares no roles.
