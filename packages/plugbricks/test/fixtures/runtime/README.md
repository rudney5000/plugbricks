# Fixtures of `plugbricks status --runtime`

Read by `test/live.test.ts`. The platform is `demo`: postgres, orders, shipping and the router.

## `compose/`, `inspect/`: recorded

Recorded on 2026-11-18 with Docker Compose 5.5.1 (Docker Engine 29.8.0, Linux), from
`docker compose --project-name <p> ps --all --format json` and
`docker inspect --format '{"id":…,"restartCount":…,"oomKilled":…}'` on a platform made with
plugbricks (postgres, orders, shipping, router), and on a small Compose project whose containers
had a failing health check, a crash loop (`exit 3`, `restart: always`) and a created container.

Then trimmed: only the fields plugbricks reads (plus a few for realism) are kept, the project is
renamed `demo`, `Labels` are dropped (they hold absolute paths of the recording machine), and the
rows of the small project are renamed onto the services of `demo`.

| File                                                         | What it is                                                                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `healthy.ndjson`                                             | Everything up. One JSON object per line: the format of Compose 2.21 and later.                                              |
| `healthy-array.json`                                         | The same rows as one JSON array, the format of Compose up to 2.20. **Not recorded** with an old Compose: built from the above. |
| `stopped.ndjson`                                             | `docker compose stop shipping-app`; the router was restarting (exit 255).                                                    |
| `starting.ndjson`                                            | postgres-db just started, health check not passed yet.                                                                      |
| `unhealthy-restarting.ndjson`                                | orders-app with a failing health check, shipping-app crash-looping (exit 3).                                                |
| `created.ndjson`                                             | shipping-app created, never started.                                                                                        |
| `partial.ndjson`, `pull-failure.ndjson`                      | shipping has no container at all (removed, or its image could not be pulled, so Compose never created it).                  |
| `wait-timeout.ndjson`                                        | The wait task of shipping exited 124, so shipping-app was created and never started. Exit code set by hand.                 |
| `undeclared.ndjson`                                          | One more container, `cache-redis`, of a brick that platform.json no longer lists. Added by hand from a recorded row.        |
| `nothing.ndjson`                                             | No container: Compose prints nothing (recorded).                                                                            |
| `inspect/healthy.ndjson`, `inspect/unhealthy-restarting.ndjson` | Restart counts of the containers above, matched by id.                                                                   |

## `k8s/`: written by hand

No cluster was available when they were written. They follow the Kubernetes API (`apps/v1`
Deployment, `v1` Pod and Service, the status fields `kubectl get deployments,pods,services
--output json` returns). The k3d test (`test/e2e-k8s.test.ts`, run in CI) checks
`status --runtime k8s` on a real cluster.

Every pod spec has an environment variable whose value is `NEVER-PRINTED-env-value-7f3a`, and a
`secretKeyRef`: the tests check that neither ever reaches the output.

| File                     | What it is                                                                     |
| ------------------------ | ------------------------------------------------------------------------------ |
| `healthy.json`           | Every pod Running and Ready, the router Service with its cluster IP.            |
| `crashloop.json`         | orders-app in CrashLoopBackOff, last exit code 1, 4 restarts.                   |
| `pending.json`           | shipping-app Pending, not schedulable.                                          |
| `image-pull.json`        | shipping-app in ImagePullBackOff.                                               |
| `wait-timeout.json`      | The init container wait-database of shipping-app exited 124, in CrashLoopBackOff. |
| `starting.json`          | orders-app running, not ready yet, during a rollout.                            |
| `readiness-failing.json` | orders-app running, not ready, rollout finished: its readiness probe fails.     |
| `partial.json`           | No shipping-app Deployment; a Deployment `cache-redis` of a removed brick.      |
| `nothing.json`           | An empty namespace.                                                             |
