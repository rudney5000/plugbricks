# Known limits

What plugbricks does not do today. The reasons are in the [decisions](../decisions.md).

## Publication

- The packages are not published on npm yet.
- The images of the application examples are built for `amd64` only.
- While the version is 0.x, a minor version may change the manifest, the command line or the lock.

## Running

- The router is published on `127.0.0.1` only (Compose) or as a `ClusterIP` Service (Kubernetes): no Ingress, no TLS.
  Put your own proxy in front of it.
- Inside the platform, services talk in plain text.
- On Docker Compose the router has no health check: `up` can return a moment before it answers.
- On Kubernetes the cluster pulls the images: an image you build has to be imported into it or pushed to a registry.
  Volume claims ask for 1Gi.
- Services run as one replica. There is no scaling, no metrics and no tracing.

## Bricks

- One provider per capability. No Kafka.
- Redis and SeaweedFS run as one server each, without replication or quotas ([their limits](./capabilities.md#cache)).
- NATS: core publish and subscribe only, no accounts, no JetStream.
- A change to the manifest of an installed brick needs `remove` then `add`.
- A subgraph over gRPC: no subscriptions and no nested keys (per the documentation of Cosmo, not tried here); a gRPC
  service that runs outside the platform is not supported.
- A subgraph that runs elsewhere is neither started nor supervised.

## Tokens

- Roles are asked per class of operation (queries, mutations), not per field, and the API enforces them, not the router.
- A role taken away stays in the tokens already given until they expire (300 s).
- Removing a dependency does not take back the roles it had given.

## The development loop and the export

- `dev` works on Docker Compose only.
- `export` is one way: there is no import, and its Kubernetes files have not been applied to a cluster in the tests.
