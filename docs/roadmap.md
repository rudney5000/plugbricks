# Roadmap

What is planned after the work in `README.md` ("Roadmap") and the decisions in `docs/decisions.md`. Nothing here is
built yet unless a line says so. Each chantier says why, what is known, and what is **not verified**. Written on
2026-11-25; an item leaves this file when a decision (D-number) takes it over.

## Order of work

Recommended order, so that any reader (a person or an AI assistant) knows what comes next. A step starts only
when the one before it that it depends on is merged.

| #   | Chantier                                                                              | Section        | Depends on                                    | Who                               |
| --- | ------------------------------------------------------------------------------------- | -------------- | --------------------------------------------- | --------------------------------- |
| 1   | First publication to npm                                                              | 1              | the owner's accounts and checks               | the owner                         |
| 2   | ~~Community files (`SECURITY.md`, `CONTRIBUTING.md`, issue templates, `CHANGELOG.md`)~~ | 1              | nothing                                       | docs                              |
| 3   | ~~`add` by name from `bricks/`; the bricks copied into a new project~~ (done, D25)     | 2, step 1      | nothing                                       | code                              |
| 4   | ~~The dependencies a brick needs, with confirmation~~ (done, D26)                     | 2, step 2      | step 3                                        | code                              |
| 5   | ~~`plugbricks doctor`~~ (done, D31)                                                   | 2, step 6      | nothing                                       | code                              |
| 6   | Documentation site on GitHub Pages                                                    | 3              | steps 3 and 4, for its "Getting started" page | code, and the owner enables Pages |
| 7   | ~~External subgraph~~ (D33, with `schema check`)                                       | 4, item 1      | nothing                                       | decision, then code               |
| 8   | ~~`create --kind`~~ (D28), ~~a starter~~ (D30), ~~public images of the examples~~ (D29) | 2, steps 3 to 5 | steps 3 and 4                                | code                              |
| 9   | ~~`logs` and `exec`~~ (D32), ~~a development loop~~ (D37), ~~a Python template~~ (D38), a Go template | 5              | step 8 for the templates                      | code                              |
| 10  | ~~`export`: leave plugbricks with plain Compose or Kubernetes files~~ (done, D34)     | 8, item 1      | nothing                                       | code                              |
| 11  | Production confidence: observability, environments and secrets, breaking changes, upgrade | 6          | a decision for each                           | decision, then code               |
| 12  | More ready-made bricks (Redis, MySQL or MariaDB, object storage, a test mail server)  | 7              | step 3                                        | code                              |
| 13  | ~~gRPC through Cosmo Connect (D35), a REST adapter example (D36)~~ (done)               | 4, items 2 and 3 | step 7                                      | study, then docs                  |
| 14  | Signed images and an SBOM; a short demo video                                         | 8, items 2 and 3 | step 8 (public images)                      | code, then the owner              |
| 15  | What was decided earlier and is not done                                              | 9              | nothing                                       | code or docs                      |

The newcomer's test (`npm create plugbricks`, then `npm install`) resumes after steps 1 and 3.

## 1. First publication (prepared: D24)

The workflow, the version (0.1.0), the licence (D23) and the notices are in place. What only the owner can do:
an npm account with two-factor authentication, the `NPM_TOKEN` secret, an `npm` environment with a required
reviewer, a last check of the package names, and a check of the employment terms. Then a `v0.1.0` tag publishes
under the `next` dist-tag. See `docs/pre-publication-checklist.md`.

**Also before the first tag: the files a public repository is expected to have.** Done on 2026-11-26: `SECURITY.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, the issue forms and the pull request template; no code of conduct yet (it needs a
contact the owner chooses), and private vulnerability reporting is the owner's to enable. None exists today (checked on
2026-11-25: no `SECURITY.md`, `CONTRIBUTING.md`, code of conduct, `CHANGELOG.md` or issue templates; `.github/` holds
`dependabot.yml` and the workflows only). The first matters most: plugbricks generates passwords and runs
containers, so a person who finds a flaw needs a private way to report it (GitHub's private vulnerability reporting
named in `SECURITY.md`, which the owner must enable in the settings).

Not verified: that the workflow runs on its first try; that npm leaves `latest` empty when only `next` is
published (if it does not, `npm create plugbricks` without `@next` would fail until a version is promoted).

## 2. An easy start for a newcomer

The first thing a person does is `npm create plugbricks`, then adds bricks. Today they have no brick to add: the
archive carries none, and the application examples (`orders-api`, `shipping-api`, `orders-web`, `keycloak`,
`queue-consumer`) use images `plugbricks-example/*:0.1.0` that only this repository can build.

In this order:

1. **`add` by name, from the project's `bricks/` folder.** `plugbricks add postgres` looks for `bricks/postgres`;
   `create-plugbricks` copies `postgres`, `rabbitmq` and `nats` (the bricks whose images are public: Docker Hub)
   into a new project. No catalogue to host: the folder is the catalogue, and the person's own bricks live there too.
   **Done (D25):** a name is `bricks/<name>`, or the folder of that name here as before; both at once are refused.
2. **Adding what a brick needs, with confirmation.** `add orders-api` proposes the providers of what it requires
   (`postgres` for `database`) and the dependencies its manifest declares (D21: `orders-web` brings `orders-api`, and
   never the other way round). In a terminal it asks. Without one (a CI, a script) it does not wait: it refuses and
   prints what it would add and the command to run again, `plugbricks add orders-api --yes`. `--yes` accepts all and lists
   each brick added. When several bricks provide the same capability, the person chooses; nothing is picked silently.
   **Done (D26):** the proposals come from `bricks/`; a brick only declared in `dependencies` is left out without a
   terminal, with the usual warning, instead of refusing.
3. **`plugbricks create <name> --kind api|web`.** Writes a brick (manifest, schema, image recipe) named `<name>-api`
   or `<name>-web` and registers it. The suffixes are a convention of this command, not a rule: `postgres` and
   `keycloak` are neither. At most a soft warning for a brick that serves a subgraph or a web page and has no suffix.
   **Done (D28):** the brick in `bricks/`, its code in `services/`; no warning for a name without a suffix (it would
   warn on `keycloak`).
4. **A starter.** `npm create plugbricks mon-saas --starter demo` creates the project and adds a chosen set of
   bricks without asking (the person chose the starter); it prints what it did.
   **Done (D30):** `npm create plugbricks mon-saas -- --starter demo` (npm needs the `--`); `demo` is the example shop.
5. **Public images for the application examples**, built and published by a second workflow to GitHub Container
   Registry (`ghcr.io/<owner>/…`), so that `up` works for a newcomer. Docker downloads them at `up`; a cluster
   needs access to `ghcr.io`. They are public, they carry the owner's name, and they must be rebuilt when a
   dependency has an advisory. The starter above needs them.
   **Done (D29):** `.github/workflows/images.yml`, `ghcr.io/rudney5000/plugbricks/<name>:<version>`, amd64 only; each
   package is made public once by the owner.

6. **`plugbricks doctor`.** One read-only command that checks what `up` needs and says what to fix: the Node
   version (`engines`), that Docker answers, that the ports of `platform.json` are free, that the `kubectl` context
   named exists. A newcomer, and a person on a managed machine where some rights are missing, learn from it why
   `up` would fail, instead of reading a Docker error. Today the CLI has `init`, `add`, `remove`, `enable`,
   `disable`, `status`, `generate`, `up`, `down` and `admin`, and nothing of the kind.
   **Done (D31):** also the ports held by another platform of the same name, and the images that `create` wrote the
   code of and that are not built yet.

Not verified: how the Compose and Kubernetes drivers treat a missing image today (pull policy); that the
repository's CI token may publish packages (a repository setting).

## 3. A documentation site on GitHub Pages

For a person who comes to use plugbricks: today the documentation is `README.md` and the decision log, written for
the people who build it, with no path for a newcomer.

- **Tool.** VitePress, the Markdown files of `docs/` as sources (no copy). Deployed by a workflow to GitHub Pages,
  with actions pinned by commit SHA as in `ci.yml`. The address, without a domain of the owner's, is
  `https://<owner>.github.io/plugbricks/` and it carries the GitHub account name.
- **Pages.** Home (the positioning sentence of the README), Getting started, Writing a brick (the manifest), the
  capabilities (database, queue, tokens), the admin, Kubernetes, Known limits. The decisions (D1 to D24) go in a
  separate "Decisions" section, not in the first pages.
- **Rules.** One source per fact: the site does not copy `decisions.md`. The commands of "Getting started" run in CI,
  as the CLI scenarios do, so that the guide cannot go stale without a red build.
- **The owner's part.** Enabling Pages in the repository settings with the source "GitHub Actions". Not done
  without their agreement; the page is public as soon as it is on.
- **Why after steps 2 and 3.** "Getting started" cannot be true before `npm create plugbricks` and `add postgres`
  work end to end, and it would be rewritten when they do. The pages that are already true (positioning, the
  manifest, the limits) can be written first if the owner wants.

Not verified: that the repository's workflow token may deploy to Pages (a repository setting).

## 4. Bringing existing services in

plugbricks can be added to an existing project (checked on 2026-11-25: `init`, `add` and `generate` in a project with
its own `package.json`, `.gitignore` and git history touched none of its files; `.generated/` and `.secrets/` ignore
themselves). What it federates today is a **GraphQL service in Federation v2 that plugbricks starts itself**.

1. **External subgraph.** A brick without a container that points to a GraphQL service running elsewhere: the
   manifest gives an address and the schema file; composition, `extends` checks and the router configuration are
   the same. Open points, to settle in a decision first:
   - the router must reach the address from Docker or the cluster (network, firewall);
   - composition reads a file, not the service, so the file can drift from the real schema: a command that compares
     them is needed;
   - plugbricks cannot supervise or restart it: the admin shows "external, state unknown";
   - tokens go to a service whose configuration is not ours; D22 roles are that service's business;
   - `up`, `down`, volumes and dependencies assume a brick has services: what a brick without one means.

   **Decided and built (D33, step 1):** `subgraph.url` and `services: []`, the token only when the brick asks for it,
   `http` with a warning; `plugbricks schema check <brick>` compares the schema file with the service's (step 2).
2. **gRPC services, through Cosmo Connect** (the router can call a gRPC service as a subgraph: a GraphQL schema is
   written, `wgc grpc-service generate` produces the Protocol Buffers, the service implements them). A study first:
   does the router pinned in `tools.json` support it, does the configuration reach `router-config.json`
   through our composition, which GraphQL features are limited over gRPC. **Studied and built (D35)**: the pinned router calls a
   gRPC service, in both directions of a federation with an HTTP subgraph, with no flag; `subgraph.grpc` (proto and mapping
   from `wgc grpc-service generate`) does it in plugbricks, with the example `catalog-grpc`, and our router configuration is
   the same as `wgc`'s. Not done: generating the proto in plugbricks, `create --kind grpc`, TLS, and running it on
   Kubernetes (D35).
3. **REST services.** No OpenAPI-to-GraphQL converter is built into the router. Until something better exists: an
   adapter brick (a GraphQL subgraph that calls the REST API, written from the OpenAPI contract). Worth one documented
   example. **Done (D36):** `examples/stock-api` in front of `examples/stock-rest`. Not shown: an adapter that checks
   tokens or sends a credential to the REST API.

Not covered: a federation already run by Apollo (Router or Gateway): plugbricks replaces it, it does not join it.

## 5. For people who write services

Aim: the daily gesture of someone who creates `order-api`, once the first minutes are solved.

1. **`plugbricks logs <brick>`**, and possibly `exec`. To see why a service falls today one leaves plugbricks for
   `docker compose logs` or `kubectl logs`. Not verified: what the drivers can reach without more access than
   `up` already needs.
   **Done (D32):** `logs <brick> [--service] [--follow] [--tail]` and `exec <brick> [--service] [-- <command>]`, on both
   runtimes.
2. **A development loop**, `plugbricks dev <brick>`: rebuild the image of one brick and restart it alone, and show its logs.
   **Done (D37):** on Docker Compose, with the new schema taken and the router restarted; a changed manifest is still
   `remove` then `add`.
3. **Service templates in other languages** (Go, Python) for `create`. The README says plugbricks does not care what is
   inside the image; only Node bricks exist today, so that claim is **not tested** with another language. A template
   would test it. **Python done (D38):** `create --kind api --lang python`, and the claim holds with it. Go is not done.

## 6. Confidence for production

Each item needs a written decision before code, like D22.

1. **An observability brick** (Prometheus, Grafana, a trace viewer) that provides `metrics` and `tracing` in the
   model of `database` and `oidc`. D9 turned them off on purpose: the router starts with `TRACING_ENABLED`,
   `METRICS_OTLP_ENABLED` and `PROMETHEUS_ENABLED` set to `false`, and with its usage tracking disabled
   (`COSMO_TELEMETRY_DISABLED`, `DO_NOT_TRACK`), after a capture showed it reaching a third-party host. A brick would
   turn the first three on **only when it is installed**, and the decision must say that nothing else changes.
2. **Environments and secrets.** Values per environment (development, staging, production) in `platform.json`, and
   secrets that come from a vault or from Kubernetes Secrets managed elsewhere. Today passwords are generated
   into `.secrets/` (`secrets.env`, `k8s-secret.yaml`): fine for development, not an answer for production.
3. **Breaking-change detection** between two versions of a subgraph schema. `add` checks that composition still
   passes, not that a client is broken. `wgc` has a schema check; whether it works without a Cosmo control plane is
   **not verified**, and an offline comparison of two composed schemas may be needed.
4. **`plugbricks upgrade <brick>`** with migration notes, once bricks have versions that people depend on.

## 7. More ready-made bricks

Each is small because the capability model exists (`postgres` is the pattern): Redis (cache), MySQL or MariaDB, an
object store (MinIO), a test mail server (Mailpit). Kafka stays deferred (section 9). A brick needs a public image
(Docker Hub) to work for a newcomer; this is why these come after step 3.

## 8. Trust, and the way out

1. **`plugbricks export`**: write the Compose file or the Kubernetes manifests into a folder to keep, usable without
   plugbricks. It answers the first objection of a team (what if we want to leave?). **Done (D34):** `export <dir>
   [--runtime] [--with-secrets]`, no secret value unless asked, nothing of the platform changed; run with plain
   `docker compose` by hand. Not run: the Kubernetes files on a cluster.
2. **Signed images and an SBOM** (a list of the components of each image), next to the provenance npm already gets
   (D24). After the images are public.
3. **A demo of about 60 seconds**: `npm create plugbricks` to the admin. It needs the public images (section 2,
   step 5) and the starter.

## 9. Decided earlier, not done

- **README screenshot** (`docs/screenshots/admin-dependencies.png`) is out of date: no optional links, no
  Authorization rows.
- **Sign-in to the admin on k3d.** The sign-in is tested end to end on Docker Compose only; the k3d job covers the
  tokens through the router (D18).
- **D22 step B**: a rule per field (`@requiresScopes`) and the router enforcing it too. Only if a real field asks for it.
- ~~**A Dependabot `ignore` rule** for `graphql` and `@graphql-tools/utils`~~: done on 2026-11-25 (majors ignored for the
  root directory, D8).
- **Kafka**, deferred (and section 7 for the other bricks).
- **Taking grants back** in Keycloak when a dependency is removed (D22 limit).
- **The newcomer's test** (`npm create plugbricks`, then `npm install`) resumes when the packages are published; the
  frictions found so far are the two 404s and the missing bricks (sections 1 and 2).
