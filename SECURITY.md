# Security

plugbricks generates passwords, writes them to disk, starts containers, and puts a GraphQL router and, with
an `oidc` provider, token checks in front of your services. A flaw in any of this can expose a platform, so
please report it privately first.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the **Security** tab of
[rudney5000/plugbricks](https://github.com/rudney5000/plugbricks/security), then **Report a vulnerability**
([direct link](https://github.com/rudney5000/plugbricks/security/advisories/new)). Only the maintainers see
the report.

Please do not open a public issue, pull request or discussion for a vulnerability before it is fixed.

A useful report says:

- the version of plugbricks (`npx plugbricks --version`), the runtime (Docker Compose or Kubernetes) and the
  operating system;
- what an attacker can do, and from where (another user of the same machine, another container of the
  platform, a web page in a browser, anyone on the network, ...);
- the smallest steps that show it, with the `platform.json` and the manifests involved.

Leave out the content of `.secrets/` and any real password or token: describe them instead.

The project is maintained by one person. A report is acknowledged as soon as it is read, and the fix is
discussed in the private advisory; once a fixed version is published, the advisory is made public with
credit to the reporter, unless they ask otherwise.

## Supported versions

plugbricks is in 0.x: only the latest published version gets fixes. The packages are published under the
`next` dist-tag first (`npm install plugbricks@next`).

## What is in scope

- The `plugbricks` CLI and its programmatic API, `create-plugbricks`, and the admin (`plugbricks admin`).
- What they generate: the Docker Compose files and Kubernetes manifests, the generated secrets and the
  permissions of `.secrets/`, the router configuration (allowed origins, token checks), the provisioning of
  databases, queues and identity clients.
- The example bricks and their images (`ghcr.io/rudney5000/plugbricks/...`), as far as a person who starts
  from them could be harmed: for instance an API that accepts a request it should refuse.

Out of scope: the third-party software the bricks run (PostgreSQL, RabbitMQ, NATS, Keycloak, the Cosmo
router) unless plugbricks configures it insecurely; report the rest to their own projects. The decisions
in [`docs/decisions.md`](docs/decisions.md) say what each mechanism is meant to protect, and their known
limits.
