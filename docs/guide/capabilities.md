# Databases, queues and tokens

A brick says what it needs in `requires`. The brick that `provides` it prepares what is the consumer's own, and the
consumer receives it as environment variables. Nothing is shared by hand, and no password is written in a file you
commit.

| Capability | Provider brick | The consumer receives                                                            | What is its own                          |
| ---------- | -------------- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| `database` | `postgres`     | `DATABASE_URL`                                                                   | a database and a role named like it      |
| `queue`    | `rabbitmq`     | `AMQP_URL`, `QUEUE_NAME`                                                         | a vhost, a user and a password           |
| `queue`    | `nats`         | `NATS_URL`, `SUBJECT`                                                            | a subject (no accounts, no JetStream)    |
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

A generated service (`create`) requires nothing: it checks no token until you add the check.
