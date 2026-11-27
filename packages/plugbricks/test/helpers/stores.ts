// What the consumers of the cache and object-storage capabilities (D41) can and cannot do, checked from inside their
// containers, the same way on Docker Compose and on Kubernetes. The scripts use the variables the providers inject and
// never print a secret: only statuses, replies and the data the test itself wrote.
import { expect } from "vitest";

export type Consumer = "store-a" | "store-b";
/** Runs a shell script in one service of a consumer ("cli" has redis-cli, "curl" has curl) and returns what it printed. */
export type Exec = (consumer: Consumer, service: "cli" | "curl", script: string) => string;

const redis = (command: string) => `redis-cli -u "$REDIS_URL" --no-auth-warning ${command} 2>&1`;

/** The HTTP status of a request signed with the consumer's own key; the body stays in /tmp/body. */
const signed = (args: string) =>
  `curl -sS -m 10 -o /tmp/body -w '%{http_code}' --aws-sigv4 "aws:amz:$AWS_REGION:s3" ` +
  `--user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" -H 'x-amz-content-sha256: UNSIGNED-PAYLOAD' ${args}`;
const object = (bucket: string) => `"$AWS_ENDPOINT_URL_S3/${bucket}/hello.txt"`;

/** Each consumer writes a key and an object of its own. */
export function writeStores(exec: Exec): void {
  for (const c of ["store-a", "store-b"] as const) {
    expect(exec(c, "cli", redis('SET "${REDIS_PREFIX}greeting" "hello from $REDIS_PREFIX"'))).toBe("OK");
    expect(exec(c, "curl", signed(`-X PUT --data-binary "object of $S3_BUCKET" ${object("$S3_BUCKET")}`))).toBe("200");
  }
}

/** Both consumers still read what `writeStores` wrote, with the credentials they were given. */
export function readStores(exec: Exec): void {
  for (const c of ["store-a", "store-b"] as const) {
    expect(exec(c, "cli", redis('GET "${REDIS_PREFIX}greeting"')), c).toBe(`hello from ${c}:`);
    expect(exec(c, "curl", `${signed(object("$S3_BUCKET"))}; echo; cat /tmp/body`), c).toBe(`200\nobject of ${c}`);
  }
}

/**
 * store-a reaches nothing of store-b, administers nothing, and nothing answers a request without credentials.
 * `server` is the address of the SeaweedFS container itself on the platform network: the service name on Compose, the
 * pod's IP on Kubernetes (its Service forwards the S3 port only, so it would hide what the container listens on).
 */
export function checkIsolation(exec: Exec, server: string): void {
  const a = (script: string) => exec("store-a", "cli", script);
  for (const refused of [
    "GET store-b:greeting",
    "SET store-b:greeting taken",
    "EVAL \"return redis.call('get','store-b:greeting')\" 0",
    "CONFIG GET requirepass",
    "FLUSHALL",
    "KEYS '*'",
    "ACL SETUSER store-a allkeys",
    "FT.CREATE theirs PREFIX 1 store-b: SCHEMA name TEXT",
  ]) {
    expect(a(redis(refused)), refused).toMatch(/NOPERM|ACL failure/);
  }
  expect(a("redis-cli -h redis-server ping 2>&1")).toContain("NOAUTH");

  const s3 = (args: string) => exec("store-a", "curl", signed(args));
  expect(s3(object("store-b"))).toBe("403");
  expect(s3(`-X PUT --data-binary taken ${object("store-b")}`)).toBe("403");
  expect(s3(`-X PUT -H 'x-amz-copy-source: /store-b/hello.txt' "$AWS_ENDPOINT_URL_S3/store-a/copied"`)).toBe("403");
  expect(s3(`-X PUT "$AWS_ENDPOINT_URL_S3/one-more-bucket"`)).toBe("403");
  // Nothing opens the bucket to a request without credentials.
  expect(s3(`-X PUT -H 'x-amz-acl: public-read-write' "$AWS_ENDPOINT_URL_S3/store-a?acl="`)).toBe("403");
  expect(exec("store-a", "curl", `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${object("store-a")}`)).toBe("403");
  // The list of buckets holds its own only.
  expect(exec("store-a", "curl", `${signed('"$AWS_ENDPOINT_URL_S3/"')} >/dev/null; grep -o '<Name>[^<]*' /tmp/body`)).toBe("<Name>store-a");
  // The master, volume and filer servers, which ask for no key, listen inside the container only: connections to them
  // are refused (curl exit 7) on Compose, while the S3 port of the same address answers. On Kubernetes the pod network
  // drops the packet instead of rejecting it (curl exit 28, a timeout): the address does not answer either, which is
  // what this checks, so both exit codes are accepted.
  const connect = (port: number) =>
    exec("store-a", "curl", `curl -sS -m 5 -o /dev/null http://${server}:${port}/healthz 2>/dev/null; echo $?`);
  expect(connect(8333), "the S3 port, to prove the address is the server's").toBe("0");
  for (const port of [9333, 19333, 8080, 18080, 8888, 18888]) expect(["7", "28"], `${port}`).toContain(connect(port));
}
