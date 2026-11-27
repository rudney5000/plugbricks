# Changelog

What changes from one published version of `plugbricks` and `create-plugbricks` to the next. Both packages are
published together, at the same version. The reasons behind each change are in
[`docs/decisions.md`](docs/decisions.md) (the `D` numbers below).

While the version is 0.x, a minor version may change the manifest, the CLI or the lock (D24): this file says when.

## 0.1.0 (not published yet)

The first version. It will be published under the `next` dist-tag: `npm create plugbricks@next <name>`.

The documentation is the guide in [`docs/guide/`](docs/guide/getting-started.md), also built as a site (D40).

### A project

- `npm create plugbricks <name>` creates a project: `platform.json`, `platform.lock`, the bricks `postgres`,
  `rabbitmq`, `nats`, `redis` and `seaweedfs` in `bricks/`, a README that explains every folder (D25, D41).
- `redis` provides `cache` (a user and a key prefix per consumer) and `seaweedfs` provides `object-storage`, over the
  S3 protocol (a bucket and a key per consumer); a service of a manifest may give `args` to its image (D41).
- `npm create plugbricks <name> -- --starter demo` creates the example shop, ready to `up`: PostgreSQL, the
  `orders-api` and `shipping-api` subgraphs behind the router, and the `orders-web` page (D30).

### Bricks

- A brick is a folder with a `plugin.json`, validated against
  [`plugin-manifest.schema.json`](packages/plugbricks/schemas/plugin-manifest.schema.json): its services, the
  capabilities it provides and requires (optionally, D19), its volumes and what happens to them (D3), a GraphQL
  subgraph, web pages (D17), the bricks it depends on (D21), the roles of its operations (D22). Images are pinned to
  a version or a digest.
- `add` installs a brick by name from `bricks/` or by path (D25), and proposes what it needs, asking before it adds
  anything; `--yes` for a script (D26). `remove`, `enable` and `disable` refuse what would break another brick
  (D14, D21).
- `create <name> --kind api|web` writes a new GraphQL subgraph or web brick, with its code and its image recipe in
  `services/` (D28); `--lang python` or `--lang go` writes the API in that language (D38, D39).

### A rule per field

- `@authenticated` and `@requiresScopes` in a brick's schema are applied by the router. plugbricks refuses a schema
  where such a rule can be gone around through an interface, a union or `@requires` (D43), and gives a consumer the
  scopes its dependencies list (D44). The example APIs apply the rules themselves, for a direct call (D45); the services `create` writes, in Node, Python and Go, check the token (D46).

### Running a platform

- `generate`, `up` and `down` on Docker Compose and on Kubernetes, from files plugbricks writes itself (D5), with
  generated secrets kept in `.secrets/` and restricted to the user (D6). `up --prune-volumes` deletes only the volumes
  listed for deletion (D3).
- The Cosmo router in front of the subgraphs, whose composition is checked when a brick is added (D8, D9); on Docker
  Compose it is published on the loopback address only, and it accepts browser calls only from the platform's own
  pages (D17).
- A gRPC service as a subgraph, through Cosmo Connect: `subgraph.grpc` names the proto and the mapping that
  `wgc grpc-service generate` writes; the router calls the service at `<service>:<port>`, composed with the other
  subgraphs and given the token as gRPC metadata. The proto and the mapping are checked when the brick is added (D35).
- An external subgraph: a brick without services whose subgraph is a GraphQL service that runs elsewhere
  (`subgraph.url`), composed and routed like the others; the token goes to it only when its manifest asks, and
  `schema check <brick>` says when its service no longer serves what the file says (D33).
- Capabilities provided by the example bricks: `database` (PostgreSQL), `queue` (RabbitMQ, NATS: D11 to D13),
  `oidc` (Keycloak: D18, D19).
- With an `oidc` provider: the router requires a token, the APIs check it again themselves, and each operation
  needs its role (D19, D20, D22).
- `status`, and `status --runtime` for what the runtime really runs, read-only (D10). One changing command at a
  time per platform (D16).

### Writing a service

- `dev <brick>` rebuilds the image of a brick from `services/<brick>`, takes its new schema (and proto), restarts that
  service alone, and the router when the schema changed, in a running platform, then follows its logs. Docker Compose
  only; a change of manifest still needs `remove` and `add` (D37).

### When something goes wrong

- `doctor` checks what `up` needs and says what to fix, without changing anything: Node, Docker and Compose or
  kubectl and the cluster, the ports, another platform of the same name, the images to build (D31).
- `logs <brick>` and `exec <brick> -- <command>` reach a brick's service, or the router, on both runtimes, without
  looking for its Docker or Kubernetes name (D32).

### Leaving

- `export <dir>` writes the Compose file (or, with `--runtime k8s`, the Kubernetes manifests) into a new folder, with
  the router's configuration, the provision scripts, a README and the list of the images, to run with `docker compose
  up -d` or `kubectl apply` and no plugbricks. No secret value unless `--with-secrets`; it changes nothing of the
  platform (D34).

### The admin

- `plugbricks admin`: a local web UI with OIDC sign-in, the bricks, their dependencies, the router and an audit log,
  and the actions `add`, `enable`, `disable`, `remove` and `up` run through the CLI (D15, D21).

### Example bricks

- `postgres`, `rabbitmq`, `nats`, `keycloak`, `orders-api`, `shipping-api`, `orders-web`, `queue-consumer`,
  `catalog-grpc` (a gRPC service, D35), `stock-rest` and `stock-api` (a REST service and its GraphQL adapter, D36); the
  images of the application examples are published as `ghcr.io/rudney5000/plugbricks/<name>:0.1.0` (amd64, D29).

### Licence

- Apache-2.0 (D23).
