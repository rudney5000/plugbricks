# Contributing to plugbricks

Thank you for wanting to help. This page says how the repository is laid out, how to run what CI runs, and what
a change needs before it is merged. For a vulnerability, do not open an issue: see [SECURITY.md](SECURITY.md).

## Before you start

- For a bug, open an issue with the form: the version, the runtime and the error code that plugbricks printed
  (`error SOME_CODE: ...`) are what makes it reproducible.
- For a new feature or a change of behaviour, open an issue first. plugbricks keeps a written record of its
  decisions ([`docs/decisions.md`](docs/decisions.md), D1 to D30 and on); a change of what the manifest, the
  `platform.json`, the lock or a command means gets a decision entry, and it is easier to agree on it before the
  code is written. [`docs/roadmap.md`](docs/roadmap.md) lists what is planned and in what order.

## The repository

| Path | What it is |
| --- | --- |
| `packages/plugbricks` | The CLI and its programmatic API: manifest validation, planning, the Compose and Kubernetes drivers, the router configuration, the admin server. Its example bricks are in `examples/`, the templates of `plugbricks create` in `templates/`. |
| `packages/create-plugbricks` | `npm create plugbricks`: the project template, the bricks a new project gets, the starters. |
| `packages/admin` | The admin UI (React), built into the `plugbricks` package. |
| `apis/` | The source of the example services, one standalone package each (its own lock file, not an npm workspace), and their images. |
| `docs/` | The architecture, the decisions, the roadmap, the Keycloak notes. |
| `tools/`, `tools.json` | The pinned external tools (wgc for a cross-check, k3d and kubectl for CI), with their checksums. |

## Setting up

You need Node at the exact version of [`.node-version`](.node-version) (22.23.5), and npm. The end-to-end tests also
need Docker with the Compose v2 plugin, on Linux (or Docker Desktop's Linux engine).

```bash
npm ci
npm run hooks:install   # git hooks: staged-file checks before a commit, typecheck and unit tests before a push
```

## Checks

```bash
npm run quality         # what CI runs: format check, lint, typecheck, then every test
npm run test:unit       # the tests without Docker: fast, and what the pre-push hook runs
npm run format          # Prettier writes the formatting it checks
```

- **End-to-end tests** (`packages/plugbricks/test/e2e-*.test.ts`) run real platforms on Docker Compose and are
  skipped, with the reason in their title, when Docker is missing. The Kubernetes ones run on a throwaway k3d
  cluster in CI (job "kubernetes (k3d)"); the comment at the top of `e2e-k8s.test.ts` says how to run them locally.
- **CLI scenarios** are folders in `packages/plugbricks/test/fixtures/cli/<name>/`: a `scenario.json` with the
  commands and what they must print, and optionally golden files in `expected/`. After a change that alters the
  golden files on purpose, `PLUGBRICKS_UPDATE_GOLDEN=1 npx vitest run test/cli.test.ts` (in `packages/plugbricks`)
  rewrites the existing ones; read their diff before committing it.
- **The example APIs** are tested in their own folder: `cd apis/orders-api && npm ci && npm test`.

## What a change needs

- **Tests** that fail without the change. A new refusal comes with its error code in
  `packages/plugbricks/src/messages.ts`: codes are stable, tools match on them, never on the message text.
- **The decision**, when the change alters behaviour or a contract: a new entry in `docs/decisions.md`, or the
  status of the entry it completes, with what was tested and what was not.
- **The docs** it makes wrong: the README, `docs/architecture.md`, `docs/roadmap.md`, the README of the project
  template.
- **LF line endings** everywhere (`.gitattributes`): brick scripts run in Linux containers.
- **Pinned versions**: dependencies at an exact version, actions by commit SHA, images by version or digest.

## Commits and pull requests

- Branch from `main`, and bring the latest `main` into your branch before you open or update a pull request.
- Commit messages follow the types used in the history: `feat`, `fix`, `docs`, `test`, `build`, `ci`, `refactor`,
  `chore`, with a scope when it helps (`feat(create): ...`). The first line says what changes; the body says why,
  and what was verified.
- One pull request per change; the template asks what it changes, which decision it follows, and how it was
  tested. CI must be green on Linux, macOS and Windows, and on the Kubernetes job.

## Licence

plugbricks is licensed under the [Apache License 2.0](LICENSE). A contribution submitted for inclusion is licensed
under the same terms (section 5 of the licence); there is no separate agreement to sign.
