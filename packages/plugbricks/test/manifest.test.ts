import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANIFEST_SCHEMA_ID, validateManifest } from "../src/manifest.js";
import { MESSAGES } from "../src/messages.js";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const load = (p: string) => JSON.parse(read(p));

const EXAMPLES = ["postgres", "orders-api", "shipping-api", "rabbitmq", "queue-consumer", "nats"];

/**
 * Windows has no executable bit in the file system (mode & 0o111 is always 0), so there the mode
 * recorded in git (100755) is what ships to Linux and macOS users. Elsewhere, the file mode.
 */
function isExecutable(file: URL): boolean {
  if (process.platform !== "win32") return (statSync(file).mode & 0o111) !== 0;
  const path = fileURLToPath(file);
  const r = spawnSync("git", ["ls-files", "--stage", "--", basename(path)], { cwd: dirname(path), encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`cannot read the git mode of ${path}: ${r.stderr || "not tracked"}`);
  return r.stdout.startsWith("100755 ");
}
const INVALID_DIR = "test/fixtures/invalid/";
const expected: Record<string, { code: keyof typeof MESSAGES; path: string; why: string }> = load(`${INVALID_DIR}expected.json`);

describe("example manifests (milestone 1 criterion)", () => {
  it.each(EXAMPLES)("%s validates", (name) => {
    expect(validateManifest(load(`examples/${name}/plugin.json`))).toEqual({ ok: true });
  });

  it.each(EXAMPLES)("%s points its $schema at the schema file", (name) => {
    const m = load(`examples/${name}/plugin.json`);
    expect(existsSync(new URL(`examples/${name}/${m.$schema}`, root))).toBe(true);
  });

  it("every provision script referenced by a command is shipped with the plugin", () => {
    for (const name of EXAMPLES) {
      const m = load(`examples/${name}/plugin.json`);
      for (const p of Object.values<{ provision: { command: string[]; scripts?: string } }>(m.provides ?? {})) {
        for (const arg of p.provision.command as string[]) {
          if (!arg.startsWith("/provision/")) continue;
          expect(p.provision.scripts, `${name}: command uses /provision but no scripts dir`).toBeDefined();
          const file = new URL(`examples/${name}/${p.provision.scripts}/${arg.slice("/provision/".length)}`, root);
          expect(existsSync(file), `${name}: missing ${arg}`).toBe(true);
          expect(isExecutable(file), `${name}: ${arg} not executable`).toBe(true);
        }
      }
    }
  });

  it("orders-web declares that it needs orders, which no capability says", () => {
    const m = load("examples/orders-web/plugin.json");
    expect(validateManifest(m)).toEqual({ ok: true });
    // The shipment is shown when shipping is installed, and the page works without it: an optional dependency (D22).
    expect(m.dependencies.map((d: { plugin: string; optional?: boolean }) => [d.plugin, d.optional === true])).toEqual([
      ["orders-api", false],
      ["shipping-api", true],
    ]);
    expect(Object.keys(m.requires)).toEqual(["oidc"]);
  });

  it("accepts the roles of an API and the operations a dependency uses (D22)", () => {
    const orders = load("examples/orders-api/plugin.json");
    const withBlock = (authorization: unknown) => validateManifest({ ...orders, authorization });
    expect(withBlock({ queries: "orders:read", mutations: "orders:write" })).toEqual({ ok: true });
    // One class alone is a manifest of its own: the other class stays at D20, any valid token.
    expect(withBlock({ queries: "orders.read" })).toEqual({ ok: true });
    expect(withBlock({ mutations: "orders_write-2" })).toEqual({ ok: true });
    const web = load("examples/orders-web/plugin.json");
    for (const operations of [["queries"], ["mutations"], ["queries", "mutations"]]) {
      expect(validateManifest({ ...web, dependencies: [{ plugin: "orders-api", operations }] }), operations.join()).toEqual({ ok: true });
    }
    // Neither an empty list (the default is "queries": leave the field out), nor the same class twice.
    for (const operations of [[], ["queries", "queries"]]) {
      expect(validateManifest({ ...web, dependencies: [{ plugin: "orders-api", operations }] }).ok, JSON.stringify(operations)).toBe(false);
    }
  });

  it("postgres keeps its data volume when removed", () => {
    const m = load("examples/postgres/plugin.json");
    expect(m.services[0].volumes[0].retention).toBe("retain");
  });

  it("rabbitmq shares one broker and gives every consumer its own vhost and user", () => {
    const m = load("examples/rabbitmq/plugin.json");
    expect(m.provides.queue.service).toBe("broker");
    expect(m.provides.queue.inject).toEqual({
      AMQP_URL: "amqp://${consumer.name}:${secrets.consumer_password}@${provider.host}:${provider.port}/${consumer.name}",
      QUEUE_NAME: "${consumer.name}",
    });
    expect(m.provides.queue.provision.scripts).toBe("provision");
    expect(m.services[0].extraPorts).toEqual([{ name: "management", port: 15672 }]);
    expect(m.services[0].volumes[0]).toMatchObject({ mountPath: "/var/lib/rabbitmq", retention: "retain" });
  });
});

describe("invalid manifests are refused with a stable code and the faulty field", () => {
  const files = readdirSync(new URL(INVALID_DIR, root)).filter((f) => f !== "expected.json");

  it("every fixture has an expectation and vice versa", () => {
    expect(files.sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(files)("%s", (file) => {
    const { code, path, why } = expected[file];
    const r = validateManifest(load(INVALID_DIR + file));
    expect(r.ok, why).toBe(false);
    // Each fixture carries exactly one fault, so exactly one issue.
    if (!r.ok) expect(r.issues.map((i) => ({ code: i.code, path: i.path }))).toEqual([{ code, path }]);
  });

  it("messages come from the catalog with their params filled in", () => {
    const r = validateManifest(load(`${INVALID_DIR}image-latest.json`));
    expect(r).toMatchObject({
      ok: false,
      issues: [
        {
          code: "IMAGE_FLOATING_TAG",
          message: expect.stringContaining('floating tag "latest"'),
          params: { image: "ghcr.io/example/orders-api-app:latest", tag: "latest" },
        },
      ],
    });
    if (!r.ok) for (const i of r.issues) expect(i.message).not.toMatch(/\{\w+\}/);
  });

  it("every expected code exists in the catalog", () => {
    for (const { code } of Object.values(expected)) expect(Object.keys(MESSAGES)).toContain(code);
  });
});

describe("schema identity", () => {
  it("$id is the raw GitHub URL of the schema file in this repo", () => {
    const schema = load("schemas/plugin-manifest.schema.json");
    expect(schema.$id).toBe(MANIFEST_SCHEMA_ID);
    expect(MANIFEST_SCHEMA_ID).toBe(
      "https://raw.githubusercontent.com/rudney5000/plugbricks/main/packages/plugbricks/schemas/plugin-manifest.schema.json",
    );
  });
});
