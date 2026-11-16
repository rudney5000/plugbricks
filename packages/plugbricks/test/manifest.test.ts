import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANIFEST_SCHEMA_ID, validateManifest } from "../src/manifest.js";
import { MESSAGES } from "../src/messages.js";

const root = new URL("../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const load = (p: string) => JSON.parse(read(p));

const EXAMPLES = ["postgres", "orders"];
const INVALID_DIR = "test/fixtures/invalid/";
const expected: Record<string, { code: keyof typeof MESSAGES; path: string; why: string }> = load(
  `${INVALID_DIR}expected.json`,
);

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
      for (const p of Object.values<any>(m.provides ?? {})) {
        for (const arg of p.provision.command as string[]) {
          if (!arg.startsWith("/provision/")) continue;
          expect(p.provision.scripts, `${name}: command uses /provision but no scripts dir`).toBeDefined();
          const file = new URL(`examples/${name}/${p.provision.scripts}/${arg.slice("/provision/".length)}`, root);
          expect(existsSync(file), `${name}: missing ${arg}`).toBe(true);
          expect(statSync(file).mode & 0o111, `${name}: ${arg} not executable`).not.toBe(0);
        }
      }
    }
  });

  it("postgres keeps its data volume when removed", () => {
    const m = load("examples/postgres/plugin.json");
    expect(m.services[0].volumes[0].retention).toBe("retain");
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
          params: { image: "ghcr.io/example/orders-app:latest", tag: "latest" },
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
  it("$id is the versioned contract URL", () => {
    const schema = load("schemas/plugin-manifest.schema.json");
    expect(schema.$id).toBe(MANIFEST_SCHEMA_ID);
    expect(MANIFEST_SCHEMA_ID).toMatch(/^https:\/\/.+\/v\d+\.json$/);
  });
});
