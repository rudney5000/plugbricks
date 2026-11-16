# plugbricks

Add plugins and infrastructure bricks (PostgreSQL, a message queue, …) to a federated GraphQL project, on Docker Compose or Kubernetes, from a single `platform.json`.

Status: **milestone 1** — the plugin manifest JSON Schema and its two example manifests (`postgres`, `orders`).

## Layout

An npm workspaces monorepo. The root `package.json` runs `build`, `test` and `typecheck` in every package.

- `packages/plugbricks/` — the core library.
  - `schemas/plugin-manifest.schema.json` — the plugin contract (runtime-independent).
  - `examples/postgres/` — a base brick that provides the `database` capability.
  - `examples/orders/` — an API that requires `database` and exposes a federation v2 subgraph.
  - `src/manifest.ts` — `validateManifest()`: schema validation plus cross-field rules (unique service names, pinned image tags, referenced services exist).
  - `test/` — Vitest suite.
- `packages/create-plugbricks/` — `npm create plugbricks` entry point (stub for now).

## Develop

```bash
npm ci
npm test
npm run typecheck
```

Run a script in one package only with `npm test -w plugbricks`.

## Roadmap

1. Manifest schema + examples (done)
2. Docker: `init`, `add postgres`, `add` a subgraph API, `up`
3. Second API with `extends`
4. Message queue (NATS)
5. Kubernetes driver on the same plan
