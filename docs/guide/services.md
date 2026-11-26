# Writing a service

## Create one

```bash
npx plugbricks create inventory --kind api
npx plugbricks create checkout --kind api --lang python
npx plugbricks create billing --kind api --lang go
npx plugbricks create shop --kind web
```

| `--kind` | `--lang`         | What `services/<name>` holds                                                                       |
| -------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `api`    | `node` (default) | A federation subgraph in TypeScript (GraphQL Yoga, `@apollo/subgraph`), with its lock file.       |
| `api`    | `python`         | The same subgraph with Ariadne; requirements pinned with their hashes.                             |
| `api`    | `go`             | The same subgraph with gqlgen; `go.mod` and `go.sum`.                                              |
| `web`    |                  | A web page served by a Node server with no dependency, which asks the router.                       |

`create <name> --kind api` makes the brick `<name>-api` (a name that already ends with the suffix keeps it). The brick
(`plugin.json`, `schema.graphql`) goes to `bricks/<name>-api`, the code to `services/<name>-api`, and the brick is added.
The brick is the same in every language: its contract is the schema.

The image is yours to build, from the project folder, with the command `create` prints. The manifest names it
`<platform>/<name>-api:0.1.0`; `--image ghcr.io/<you>/<name>:0.1.0` names a registry image from the start.

### Go: the code is generated

The image build generates the Go code of the schema (gqlgen); your code is `graph/resolver.go`. A field added to the
schema without a resolver stops the build and names the method to write. For your editor, in the service folder:
`cp ../../bricks/<name>/schema.graphql . && go tool gqlgen generate`.

## The development loop

In a platform that is up:

```bash
npx plugbricks dev inventory-api              # rebuild, restart it alone, follow its logs
npx plugbricks dev inventory-api --no-follow  # the same, showing the last lines only
```

`dev` builds `services/<brick>`, recreates that service alone and, when the schema changed, takes it into the platform
and restarts the router. A schema that does not compose is refused before anything is built, and a failed build changes
nothing. It works on Docker Compose.

Only the schema (and, for gRPC, the proto and its mapping) may change this way. After a change to `plugin.json` or to
another file of the brick: `npx plugbricks remove <brick>`, then `npx plugbricks add <brick>`.

## When a service misbehaves

```bash
npx plugbricks logs inventory-api --follow       # logs router: the router's
npx plugbricks exec inventory-api -- env         # a command inside it; a shell when none is given
npx plugbricks status --runtime compose          # what really runs
```

## What a service must do

plugbricks does not look inside your image. A service honours its manifest:

- it listens on the port the manifest names, and answers its health check;
- an API serves a [federation 2](https://www.apollographql.com/docs/federation/) subgraph at the path of
  `subgraph.path` (`/graphql` by default), matching the schema of the brick;
- it reads what it needs from the [variables it is given](./capabilities.md);
- with an identity provider, it [checks the token](./capabilities.md#tokens) itself.
