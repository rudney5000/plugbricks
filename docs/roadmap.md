# Roadmap

What is planned after the work in `README.md` ("Roadmap") and the decisions in `docs/decisions.md`. Nothing here is
built yet unless a line says so. Each chantier says why, what is known, and what is **not verified**. Written on
2026-11-25; an item leaves this file when a decision (D-number) takes it over.

## Order of work

Recommended order, so that any reader (a person or an AI assistant) knows what comes next. A step starts only
when the one before it that it depends on is merged.

| # | Chantier | Section | Depends on | Who |
|---|----------|---------|------------|-----|
| 1 | First publication to npm | 1 | the owner's accounts and checks | the owner |
| 2 | `add` by name from `bricks/`; the bricks copied into a new project | 2, step 1 | nothing | code |
| 3 | The dependencies a brick needs, with confirmation | 2, step 2 | step 2 | code |
| 4 | Documentation site on GitHub Pages | 3 | steps 2 and 3, for its "Getting started" page | code, and the owner enables Pages |
| 5 | External subgraph (a decision first) | 4, item 1 | nothing | decision, then code |
| 6 | `create --kind`, a starter, public images of the examples | 2, steps 3 to 5 | steps 2 and 3 | code |
| 7 | gRPC through Cosmo Connect (a study), a REST adapter example | 4, items 2 and 3 | step 5 | study, then docs |
| 8 | What was decided earlier and is not done | 5 | nothing | code or docs |

The newcomer's test (`npm create plugbricks`, then `npm install`) resumes after step 1 and step 2.

## 1. First publication (prepared: D24)

The workflow, the version (0.1.0), the licence (D23) and the notices are in place. What only the owner can do:
an npm account with two-factor authentication, the `NPM_TOKEN` secret, an `npm` environment with a required
reviewer, a last check of the package names, and a check of the employment terms. Then a `v0.1.0` tag publishes
under the `next` dist-tag. See `docs/pre-publication-checklist.md`.

Not verified: that the workflow runs on its first try; that npm leaves `latest` empty when only `next` is
published (if it does not, `npm create plugbricks` without `@next` would fail until a version is promoted).

## 2. An easy start for a newcomer

The first thing a person does is `npm create plugbricks`, then adds bricks. Today they have no brick to add: the
archive carries none, and the application examples (`orders`, `shipping`, `orders-web`, `keycloak`,
`queue-consumer`) use images `plugbricks-example/*:0.1.0` that only this repository can build.

In this order:

1. **`add` by name, from the project's `bricks/` folder.** `plugbricks add postgres` looks for `bricks/postgres`;
   `create-plugbricks` copies `postgres`, `rabbitmq` and `nats` (the bricks whose images are public: Docker Hub)
   into a new project. No catalogue to host: the folder is the catalogue, and the person's own bricks live there too.
2. **Adding what a brick needs, with confirmation.** `add orders` proposes the providers of what it requires
   (`postgres` for `database`) and the dependencies its manifest declares (D21: `orders-web` brings `orders`, and
   never the other way round). In a terminal it asks. Without one (a CI, a script) it does not wait: it refuses and
   prints what it would add and the command to run again, `plugbricks add orders --yes`. `--yes` accepts all and lists
   each brick added. When several bricks provide the same capability, the person chooses; nothing is picked silently.
3. **`plugbricks create <name> --kind api|web`.** Writes a brick (manifest, schema, image recipe) named `<name>-api`
   or `<name>-web` and registers it. The suffixes are a convention of this command, not a rule: `postgres` and
   `keycloak` are neither. At most a soft warning for a brick that serves a subgraph or a web page and has no suffix.
4. **A starter.** `npm create plugbricks mon-saas --starter demo` creates the project and adds a chosen set of
   bricks without asking (the person chose the starter); it prints what it did.
5. **Public images for the application examples**, built and published by a second workflow to GitHub Container
   Registry (`ghcr.io/<owner>/…`), so that `up` works for a newcomer. Docker downloads them at `up`; a cluster
   needs access to `ghcr.io`. They are public, they carry the owner's name, and they must be rebuilt when a
   dependency has an advisory. The starter above needs them.

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
2. **gRPC services, through Cosmo Connect** (the router can call a gRPC service as a subgraph: a GraphQL schema is
   written, `wgc grpc-service generate` produces the Protocol Buffers, the service implements them). A study first:
   does the router pinned in `tools.json` support it, does the configuration reach `router-config.json`
   through our composition, which GraphQL features are limited over gRPC. **Not verified at all in plugbricks**; the
   description comes from WunderGraph's documentation.
3. **REST services.** No OpenAPI-to-GraphQL converter is built into the router. Until something better exists: an
   adapter brick (a GraphQL subgraph that calls the REST API, written from the OpenAPI contract). Worth one documented
   example.

Not covered: a federation already run by Apollo (Router or Gateway): plugbricks replaces it, it does not join it.

## 5. Decided earlier, not done

- **README screenshot** (`docs/screenshots/admin-dependencies.png`) is out of date: no optional links, no
  Authorization rows.
- **Sign-in to the admin on k3d.** The sign-in is tested end to end on Docker Compose only; the k3d job covers the
  tokens through the router (D18).
- **D22 step B**: a rule per field (`@requiresScopes`) and the router enforcing it too. Only if a real field asks for it.
- **A Dependabot `ignore` rule** for `graphql` and `@graphql-tools/utils`: the composer needs 16 and 12, and Dependabot
  proposes 17 and 13 again (#62 and #65). Note it in D8.
- **Kafka**, deferred.
- **Taking grants back** in Keycloak when a dependency is removed (D22 limit).
- **The newcomer's test** (`npm create plugbricks`, then `npm install`) resumes when the packages are published; the
  frictions found so far are the two 404s and the missing bricks (sections 1 and 2).
