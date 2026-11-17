# Before publishing plugbricks

Run through this list before the first publication of a package, and again when a dependency
is added. Each item says what to check and why.

- [ ] **Licences of what we ship.** `npm ls --omit=dev --all` lists what a user installs with
      `plugbricks`. Every package must carry a licence that allows redistribution. Dependencies
      that are not MIT need a look by a person:
  - `@wundergraph/composition` 0.68.1 (decision D8) pulls 116 packages: 114 are MIT. The two
    others are **`@wundergraph/composition` itself (Apache-2.0)** and **`tslib` (0BSD)**. Check
    both licence texts, and whether Apache-2.0 asks us to ship its `NOTICE` file with the package.
  - `@wundergraph/cosmo-shared` 0.50.1 (used from milestone 4b-3 on) adds `@wundergraph/cosmo-shared`,
    `@wundergraph/cosmo-connect`, `@connectrpc/connect-query` and `@connectrpc/connect-query-core`
    (Apache-2.0), `@bufbuild/protobuf` (Apache-2.0 AND BSD-3-Clause) and `split2` (ISC).
  - `@apollo/composition` (Elastic-2.0) is deliberately not used: see D8.
- [ ] **No vulnerable dependency in production.** `npm audit --omit=dev --audit-level=high` finds
      nothing (the CI `quality` job runs it). The `overrides` entry for `@graphql-tools/utils` in
      the root `package.json` (see D8) is checked again: remove it once the composer needs no override.
- [ ] **No secret and no generated file in the package.** `npm pack --dry-run` lists only `dist/`
      and `schemas/`.
- [ ] **Redo the network capture** (no DNS lookup, no outbound connection from the router at startup) whenever the router image version changes; the telemetry variable names may change.
- [ ] **The CI is green on Linux, macOS and Windows, and the Kubernetes job passed.**
