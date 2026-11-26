# Before publishing plugbricks

Run through this list before the first publication of a package, and again when a dependency
is added. Each item says what to check and why.

- [ ] **Licences of what we ship.** `npm ls --omit=dev --all` lists what a user installs with
      `plugbricks`. Every package must carry a licence that allows redistribution. Dependencies
      that are not MIT need a look by a person:
  - `@wundergraph/composition` 0.68.2 (decision D8) pulls 116 packages: 114 are MIT. The two
    others are **`@wundergraph/composition` itself (Apache-2.0)** and **`tslib` (0BSD)**. Both
    licence texts were read on 2026-11-25. The composer is a dependency that npm installs: it is not copied into our
    packages, so its `NOTICE`, if it has one (it has none), is not ours to ship. Check this again if it is ever bundled.
  - `@wundergraph/cosmo-shared` 0.50.2 (used from milestone 4b-3 on) adds `@wundergraph/cosmo-shared`,
    `@wundergraph/cosmo-connect`, `@connectrpc/connect-query` and `@connectrpc/connect-query-core`
    (Apache-2.0), `@bufbuild/protobuf` (Apache-2.0 AND BSD-3-Clause) and `split2` (ISC).
  - `@apollo/composition` (Elastic-2.0) is deliberately not used: see D8.
- [ ] **No vulnerable dependency in production.** `npm audit --omit=dev --audit-level=high` finds
      nothing (the CI `quality` job runs it). The `overrides` entry for `@graphql-tools/utils` in
      the root `package.json` (see D8) is checked again: remove it once the composer needs no override.
- [ ] **No secret and no generated file in the package.** `npm pack --dry-run` lists only `dist/`,
      `schemas/`, `LICENSE` and `NOTICE` (the `dist` test checks it).
- [ ] **Redo the network capture** (no DNS lookup, no outbound connection from the router at startup) whenever the router image version changes; the telemetry variable names may change.
- [x] **The licence is chosen** (D23): Apache-2.0, `LICENSE` and `NOTICE` in the root and in both published packages.
      The copyright line of `NOTICE` names the GitHub account; change it if it should be a person's name.
- [ ] **Package names.** The names `plugbricks` and `create-plugbricks` were free on npm on 2026-11-25 (404); check
      again just before the first publish. `"private": true` is gone from both packages (D24): `publishConfig.provenance`
      is meant to make a publish from a person's machine fail (not tested: only the first real publish will show it).
- [x] **Notices of the third-party code in the admin bundle** (D24): `prepack` writes `dist/admin/THIRD_PARTY_NOTICES.txt`
      (React, React Router, their dependencies and Tailwind, with their licence texts); the `dist` test requires it.
- [ ] **The author's right to license.** Check that the employment terms allow publishing this project under this
      licence, since part of it was written on an employer's machine. Only the author can check this.
- [x] **First version number** (D24): 0.1.0, published from a `v0.1.0` tag by `.github/workflows/publish.yml`, under the
      `next` dist-tag. 0.x means the manifest, the lock and the CLI codes can still change in a minor version.
- [x] **Private vulnerability reporting** is enabled (2026-11-26; Settings, Advanced Security, Private vulnerability
      reporting; checked with `GET /repos/rudney5000/plugbricks/private-vulnerability-reporting`), so that the link of
      `SECURITY.md` works.
- [ ] **The accounts and settings that only the owner can create** (D24): an npm account with two-factor authentication,
      the `NPM_TOKEN` repository secret, and an `npm` environment with a required reviewer. Then check the names once more.
- [x] **Example bricks for a new project** (D25, D30): `create-plugbricks` copies `postgres`, `rabbitmq` and `nats` into
      every project, and the starter `demo` the example shop, whose images are public (D29).
- [ ] **Signature of the tool checksums.** `tools.json` verifies each binary against a sha256 read from the checksum
      file of the same release; that proves the download is the file the release lists, not that the release is the
      maintainers'. Verify the signature of the checksum files where the tool publishes one (cosign, minisign or GPG).
- [ ] **Development-dependency vulnerabilities.** `npm audit` of the whole tree lists open advisories in the vitest 2
      chain (vite, esbuild, tinypool); the fix is a major upgrade (D7). The production audit is clean. Settle this, and
      the tree of `tools/wgc-crosscheck`, before depending on the test run for anything beyond this repository.
- [ ] **The CI is green on Linux, macOS and Windows, and the Kubernetes job passed.**
- [ ] **The documentation site** (D40), the owner's choice, before or after the first publication: in the repository's
      settings, Pages, source "GitHub Actions"; then in Settings, Secrets and variables, Actions, Variables, add
      `PAGES_ENABLED` with the value `true`, and run the "Documentation" workflow. The page is public as soon as it is
      published, at `https://<owner>.github.io/plugbricks/`: it carries the GitHub account name.
- [ ] **After the first publication,** remove the "Not published yet" notes (`docs/guide/getting-started.md`,
      `docs/guide/limits.md`, `README.md`).
