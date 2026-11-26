# Getting started

From nothing to a GraphQL API behind a router, running on your machine.

::: warning Not published yet
The packages are not on npm yet, so `npm create plugbricks` does not work today. Until the first publication, clone the
[repository](https://github.com/rudney5000/plugbricks), run `npm ci` and `npm run build`, then run
`node <clone>/packages/create-plugbricks/bin/create-plugbricks.js` where this page says `npm create plugbricks@next`,
and `node <clone>/packages/plugbricks/dist/bin.js` where it says `npx plugbricks`.
:::

You need Node 22.12 or newer, and Docker with Compose v2.

## 1. Create a project

```bash
npm create plugbricks@next my-shop
cd my-shop
npm install
```

The new folder has a `README.md` that explains each of its files.

## 2. Create your first API

```bash
npx plugbricks create inventory --kind api
docker build -t my-shop/inventory-api:0.1.0 -f services/inventory-api/Dockerfile .
```

`create` wrote two folders and added the brick to the platform:

- `bricks/inventory-api/`: the brick, that is its manifest (`plugin.json`) and its GraphQL schema (`schema.graphql`);
- `services/inventory-api/`: the code, in TypeScript, and the recipe of its image.

The image is yours to build, with the command `create` printed. `--lang python` or `--lang go` writes the service in
another language ([Writing a service](./services.md)).

## 3. Start the platform

```bash
npx plugbricks doctor
npx plugbricks up
```

`doctor` says what is missing before anything starts. `up` returns once every service passes its health check. The
router is the only thing published on your machine; ask it for your items (if the first request gets no answer, the
router is still starting: ask again):

```bash
curl -s -H 'content-type: application/json' -d '{"query":"{ inventoryItems { id name } }"}' http://127.0.0.1:4000/graphql
```

## 4. Change your API

Add a field to the schema, at the end of `bricks/inventory-api/schema.graphql`:

```graphql
extend type Query {
  hello: String!
}
```

Then give it a resolver in `services/inventory-api/src/main.ts`, on the line after `inventoryItems: () => items,`:

```ts
    hello: () => "hello",
```

Rebuild and restart that service alone:

```bash
npx plugbricks dev inventory-api --no-follow
curl -s -H 'content-type: application/json' -d '{"query":"{ hello }"}' http://127.0.0.1:4000/graphql
```

`dev` checks that the new schema composes, builds the image, restarts the service and the router, and shows the logs
(without `--no-follow`, it keeps following them).

## 5. Add a ready-made brick

A new project ships three bricks in `bricks/`: `postgres`, `rabbitmq` and `nats`.

```bash
npx plugbricks add postgres
npx plugbricks status
npx plugbricks up
```

An API gets its own database when its manifest requires one ([Databases, queues and tokens](./capabilities.md)).

## 6. Stop

```bash
npx plugbricks down
```

The volumes and the secrets are kept.

## Or start from the example shop

```bash
npm create plugbricks@next shop -- --starter demo
cd shop
npm install
npx plugbricks up
```

PostgreSQL, two subgraphs (`orders-api`, and `shipping-api` which extends its `Order`) and a web page, with public
images: nothing to build. The router answers at `http://127.0.0.1:4000/graphql`, the page at
`http://127.0.0.1:8080/orders`.

```bash
curl -s -H 'content-type: application/json' -d '{"query":"{ orders { id shipment { carrier } } }"}' http://127.0.0.1:4000/graphql
```
