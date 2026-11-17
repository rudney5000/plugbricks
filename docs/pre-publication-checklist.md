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
- [ ] **Package names and the licence field.** The npm names `plugbricks` and `create-plugbricks` are not checked for
      availability, and every package is `"private": true` with `"license": "UNLICENSED"`: choose the licence, drop
      `private` on what is published, and check the names before the first publish.
- [ ] **First version number.** Everything is 0.0.1. Decide what the first published version is (and what 0.x means for
      the lockfile, the manifest schema and the CLI codes, which are meant to be stable) before tagging it.
- [ ] **Signature of the tool checksums.** `tools.json` verifies each binary against a sha256 read from the checksum
      file of the same release; that proves the download is the file the release lists, not that the release is the
      maintainers'. Verify the signature of the checksum files where the tool publishes one (cosign, minisign or GPG).
- [ ] **Development-dependency vulnerabilities.** `npm audit` of the whole tree lists open advisories in the vitest 2
      chain (vite, esbuild, tinypool); the fix is a major upgrade (D7). The production audit is clean. Settle this, and
      the tree of `tools/wgc-crosscheck`, before depending on the test run for anything beyond this repository.
- [ ] **The CI is green on Linux, macOS and Windows, and the Kubernetes job passed.**
