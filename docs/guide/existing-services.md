# Existing services

plugbricks can be added to a project you already have: `init`, `add` and `generate` leave your files alone, and what
they write (`.generated/`, `.secrets/`) ignores itself.

## A subgraph that runs elsewhere

A brick can federate a GraphQL service that plugbricks does not run: no services, and the address in its
subgraph. Composition, `extends` and the router are the same as for any subgraph; `up` starts nothing for it, and
`status` says it is not supervised.

```json
{
  "name": "catalog",
  "version": "0.1.0",
  "services": [],
  "subgraph": { "url": "https://catalog.example.com/graphql", "schema": "schema.graphql" }
}
```

`plugbricks schema check catalog` compares the schema file with what the service serves, and exits 1 with the
differences when the service changed. The router does not pass the caller's token on to it unless the subgraph says
`"forwardAuthorization": true`. A service
of this machine is `http://host.docker.internal:<port>/...` (never `localhost`, which would be the router's own
container); on a Linux Docker engine it must listen on the address of Docker's bridge, not on 127.0.0.1 only.

## A gRPC service

The router can call a gRPC service as a subgraph, through Cosmo Connect. You write the GraphQL contract, `wgc`
generates the Protocol Buffers from it, the service implements them, and the brick says where the three files are:

```bash
wgc grpc-service generate catalog -i schema.graphql -o .   # writes service.proto, mapping.json and service.proto.lock.json
```

```json
{
  "name": "catalog-grpc",
  "version": "0.1.0",
  "services": [{ "name": "app", "image": "ghcr.io/example/catalog-grpc:0.1.0", "port": 50051 }],
  "subgraph": { "service": "app", "schema": "schema.graphql", "grpc": { "proto": "service.proto", "mapping": "mapping.json" } }
}
```

Composition, `extends` and the router are the same as for any subgraph, and a gRPC subgraph joins an HTTP one through
`@key`. The router checks the token and passes it on to the service as gRPC metadata; the service decides what to do
with it. The call is in plain text on the platform's network. [`examples/catalog-grpc`](../../packages/plugbricks/examples/catalog-grpc/plugin.json) is a working service (source in
[`apis/catalog-grpc`](../../apis/catalog-grpc)). Not supported over gRPC, per the documentation of Cosmo: subscriptions and nested keys.

## A REST service, behind an adapter

The router calls GraphQL and gRPC subgraphs, not REST: a REST service joins the platform through a small adapter, a
GraphQL subgraph written from its OpenAPI contract. [`examples/stock-api`](../../packages/plugbricks/examples/stock-api/plugin.json) is a worked one, in front of
[`examples/stock-rest`](../../packages/plugbricks/examples/stock-rest/plugin.json), which stands for the service you already run:

```bash
# the two example bricks are in a clone of the repository, under packages/plugbricks/examples/
npx plugbricks add path/to/stock-rest
npx plugbricks add path/to/stock-api     # needs stock-rest
npx plugbricks up
```

Its source ([`apis/stock-api`](../../apis/stock-api)) shows what such an adapter has to get right: ids checked before they enter a URL, the
REST errors turned into GraphQL ones without leaking the upstream's details, a timeout, no redirect followed. It passes
no credential to the REST API: that is a decision to make for each service. For your own API, change `STOCK_API_URL` in
the brick's manifest to its address, drop the dependency, and write your operations.
