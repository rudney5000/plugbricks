# services/

The code of your own services: one folder per brick that `npx plugbricks create` wrote.

```bash
npx plugbricks create inventory --kind api   # bricks/inventory-api (the brick) and services/inventory-api (its code)
npx plugbricks create shop --kind web        # bricks/shop-web and services/shop-web
```

The brick (its `plugin.json` and, for an API, its GraphQL schema) lives in `bricks/`, where plugbricks
finds it and copies it when it is added. The code, its dependencies and its image recipe live here,
outside the brick: plugbricks never copies them. Build the image from the project folder, with the
command `create` prints, for example:

```bash
docker build -t mon-saas/inventory-api:0.1.0 -f services/inventory-api/Dockerfile .
```

On Kubernetes the cluster pulls the image itself. For a local cluster, import it after the build
(`k3d image import mon-saas/inventory-api:0.1.0 --cluster <name>`, or
`kind load docker-image mon-saas/inventory-api:0.1.0`). For any other cluster, push it to a registry
the cluster reads, and name it that way from the start:
`npx plugbricks create inventory --kind api --image ghcr.io/<you>/inventory-api:0.1.0`.

An API in Python instead of TypeScript: `npx plugbricks create inventory --kind api --lang python`. After a change to a
service or to its schema, in a running platform: `npx plugbricks dev inventory-api`.
