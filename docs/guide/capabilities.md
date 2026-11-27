# Databases, queues and tokens

A brick says what it needs in `requires`. The brick that `provides` it prepares what is the consumer's own, and the
consumer receives it as environment variables. Nothing is shared by hand, and no password is written in a file you
commit.

| Capability | Provider brick | The consumer receives                                                            | What is its own                          |
| ---------- | -------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `database` | `postgres`     | `DATABASE_URL`                                                                   | a database and a role named like it      |
| `queue`    | `rabbitmq`     | `AMQP_URL`, `QUEUE_NAME`                                                         | a vhost, a user and a password           |
| `queue`    | `nats`         | `NATS_URL`, `SUBJECT`                                                            | a subject (no accounts, no JetStream)    |
| `cache`    | `redis`        | `REDIS_URL`, `REDIS_PREFIX` | a user limited to the keys that start with its name |
| `object-storage` | `seaweedfs` | `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET` | a bucket and a key limited to it |
| `oidc`     | `keycloak`     | `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_AUDIENCE`, `OIDC_TOKEN_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | a confidential client |

A platform has one provider per capability: `rabbitmq` and `nats` are alternatives.

## Database

```bash
npx plugbricks add postgres
```

Each consumer gets its own database, which the others cannot reach.

## Queue

```bash
npx plugbricks add rabbitmq
```

One broker, never published on your machine; the administrator password is used by the provision task only.
[`apis/queue-consumer`](../../apis/queue-consumer) publishes and consumes a message with these variables.

## Cache

```bash
npx plugbricks add redis
```

Each consumer gets its own user. `REDIS_URL` carries its password; every key and every channel it uses must start with
`REDIS_PREFIX` (its name and a colon): anything else is refused with `NOPERM`. Most client libraries take the prefix as
an option (`keyPrefix` in ioredis).

- The administration commands are not given to a consumer (`CONFIG`, `FLUSHALL`, `KEYS`, `MONITOR`, `ACL`…), nor the
  search commands (`FT.*`: an index reads every key under its prefix), nor those that change the functions and the
  script cache all users share.
- A consumer can list the **names** of the other consumers' keys (`SCAN`), not read them.
- One server, shared memory: no consumer has a quota of its own, and no memory limit is set.
- Redis 8 is licensed under RSALv2, SSPLv1 or AGPLv3, at your choice
  ([its licence](https://github.com/redis/redis/blob/8.8.4/LICENSE.txt)): read it before you run it as a service for
  others.

## Object storage

```bash
npx plugbricks add seaweedfs
```

[SeaweedFS](https://github.com/seaweedfs/seaweedfs) (Apache-2.0) serves the S3 protocol. Each consumer gets a bucket
named like it and a key that reads, writes, lists and deletes objects in that bucket, and does nothing else: no other
bucket, no bucket policy or ACL (so nothing can be made public), no new key.

The variables are the ones the AWS SDKs and tools read. The address has no sub-domain per bucket, so ask for
path-style addresses where the library does not choose them itself:

```ts
const s3 = new S3Client({ forcePathStyle: true }); // @aws-sdk/client-s3
```

```python
s3 = boto3.client("s3")  # nothing to add
```

- A service that also talks to AWS itself must give those other credentials under other names.
- A brick that requires this capability needs a name of at least 3 characters (a bucket name).
- One server on one volume: no replication. The image is large (about 290 MB to download).
- After a restart of the server alone, requests can wait for about 20 seconds although it is already reported healthy.
- The store is reachable inside the platform only. A link signed for a browser (a presigned URL) points to that
  internal address.

## Tokens

`keycloak` is an identity provider that runs in the platform, with a realm and **no user**. It is not in a new
project's `bricks/`: add it from a clone of the repository.

```bash
npx plugbricks add postgres
npx plugbricks add path/to/plugbricks/packages/plugbricks/examples/keycloak
npx plugbricks up        # returns once the realm answers: about 2 minutes the first time
```

Its console is at `http://127.0.0.1:<webPort>/admin/` (user `admin`, password `PB_KEYCLOAK__ADMIN_PASSWORD` in
`.secrets/secrets.env`).

Once a brick provides `oidc`:

- the router refuses a request without a valid token of this provider, and passes the token on to the subgraphs;
- an API that requires `oidc` (optionally or not) receives the variables above and **checks the token itself**: a call
  that goes past the router is still refused. plugbricks gives it the means; the check is code in your service
  ([`apis/orders-api`](../../apis/orders-api) shows it);
- an API can also ask for a role per class of operation:

```jsonc
"authorization": { "queries": "orders:read", "mutations": "orders:write" }
```

The API receives `AUTHORIZATION_QUERIES_ROLE` and `AUTHORIZATION_MUTATIONS_ROLE` and refuses, with `FORBIDDEN`, a valid
token without the role. A brick that lists this API in its `dependencies` gets the roles of the operations it declares.
Without an identity provider, nothing is asked.

A generated service (`create`, in Node, Python or Go) asks for `oidc` as an option and checks the token itself: with an
identity provider in the platform it answers `401` to a request without a valid token, even one that goes past the router
(`/health` stays open), and without one it answers as before (D46). It receives the verified caller in its resolvers
(`context.caller` in Node, `info.context["caller"]` in Python, `CallerFrom(ctx)` in Go): who it is, and its scopes. It does
not yet check roles or the rules of a schema, which you would write yourself.

### A rule on one field

plugbricks builds nothing for this yet, but the directives of Apollo Federation in a brick's schema (`@authenticated`,
`@requiresScopes`) already reach the router, which applies them
([what was tried](../decisions.md#d42-study-a-rule-per-field-d22-step-b-with-the-pinned-router)). If you use them:

- **A rule is repeated where it could be gone around.** The router applies the rule of the field it is asked for, so
  plugbricks refuses (`AUTHORIZATION_BYPASS`) a schema where protected data has another way out: the same field on an
  interface, a field that returns a union or an interface which can be a protected type, a type that implements a
  protected interface, a field computed from a protected one (`@requires`). The message says which rule to write, and
  where (D43).
- **Your API should apply the rule too**, or a call that goes to it directly past the router gets the field. `orders-api` and
  `shipping-api` do (`apis/orders-api/src/auth.ts`, `enforceFieldRules`, D45); the services `create` writes check the token, not yet these rules.
- **A consumer says which scopes it needs**, and the `keycloak` brick creates them and gives them to its client:

  ```jsonc
  "dependencies": [{ "plugin": "catalog-api", "scopes": ["catalog:price"] }]
  ```

  Only a scope that a rule of that API's schema asks for can be listed. A scope is a name shared by the whole realm: name
  it after the API. It is never taken back; remove it in Keycloak. With another identity provider, create the scopes
  there.
- Without an identity provider, every protected field is refused.
