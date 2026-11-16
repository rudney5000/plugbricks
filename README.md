# plugbricks

Add plugins and infrastructure bricks (PostgreSQL, a message queue, …) to a federated GraphQL project, on Docker Compose or Kubernetes, from a single `platform.json`.

Status: **milestone 1 done** — the plugin manifest contract (JSON Schema `https://plugbricks.dev/schemas/plugin-manifest/v1.json`), its validator with stable error codes, and two example manifests (`postgres`, `orders`).

## Layout

An npm workspaces monorepo. The root `package.json` runs `build`, `test` and `typecheck` in every package.

- `packages/plugbricks/` — the core library.
  - `schemas/plugin-manifest.schema.json` — the plugin contract (runtime-independent).
  - `examples/postgres/` — a base brick that provides the `database` capability; `provision/create-database.sh` creates one role and one database per consumer (idempotent).
  - `examples/orders/` — an API that requires `database` (waits until it is healthy) and exposes a federation v2 subgraph.
  - `src/manifest.ts` — `validateManifest()`: schema validation plus cross-field rules (unique service names, pinned images, referenced services exist). Every issue has a stable `code`, a JSON Pointer `path`, a `message` and its `params`.
  - `src/messages.ts` — the error code catalog. Tools match on `code`, never on the message text.
  - `src/image.ts` — image reference parsing and the pinning rule: a sha256 digest, or a tag starting with at least `MAJOR.MINOR` (`16.4-alpine`, `v1.2.3`). `latest`, `16`, `alpine` are rejected.
  - `test/fixtures/invalid/` — one invalid manifest per file, each with exactly one fault; `expected.json` gives the code and path it must produce.
  - `test/` — Vitest suite.
- `packages/create-plugbricks/` — `npm create plugbricks` entry point (stub for now).

## Develop

```bash
npm ci
npm test
npm run typecheck
```

Run a script in one package only with `npm test -w plugbricks`.

Dependencies are pinned to exact versions (`.npmrc` sets `save-exact`), and `package-lock.json` is committed: always install with `npm ci`.

## Roadmap

1. **Manifest schema + examples** — done
   - `requires` as an object per capability, with an optional `wait` (`healthy` by default, or `started`).
   - Volume `retention` (`retain` by default, or `delete`) for what happens to data when a plugin is removed.
   - Stable error codes and a message catalog; invalid examples kept as files.
   - Images pinned to an exact version or a digest, for services and provision tasks.
   - Versioned schema `$id`; a working, idempotent PostgreSQL provision script.
2. **Docker**: `init`, `add postgres`, `add` a subgraph API, `up`. Brings score-compose, score-k8s, k3d and kubectl into the dev container.
3. **Second API** with `extends`
4. **Message queue** (NATS)
5. **Kubernetes driver** on the same plan
