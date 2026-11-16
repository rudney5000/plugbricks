import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateManifest } from "../src/manifest.js";

const load = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

describe("example manifests (milestone 1 criterion)", () => {
  it("postgres validates", () => {
    expect(validateManifest(load("examples/postgres/plugin.json"))).toEqual({ ok: true });
  });
  it("orders validates", () => {
    expect(validateManifest(load("examples/orders/plugin.json"))).toEqual({ ok: true });
  });
});

describe("invalid manifests are refused with the faulty field", () => {
  const base = () => load("examples/orders/plugin.json");

  it("missing name", () => {
    const m = base();
    delete m.name;
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.some((i) => i.message.includes("name"))).toBe(true);
  });

  it("unknown top-level field (e.g. Compose YAML leaking in)", () => {
    const r = validateManifest({ ...base(), depends_on: ["db"] });
    expect(r.ok).toBe(false);
  });

  it("floating image tag", () => {
    const m = base();
    m.services[0].image = "ghcr.io/example/orders-app:latest";
    const r = validateManifest(m);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.issues[0].path).toBe("/services/0/image");
  });

  it("image without tag", () => {
    const m = base();
    m.services[0].image = "ghcr.io/example/orders-app";
    expect(validateManifest(m).ok).toBe(false);
  });

  it("subgraph pointing at an unknown service", () => {
    const m = base();
    m.subgraph.service = "nope";
    const r = validateManifest(m);
    if (!r.ok) expect(r.issues[0].path).toBe("/subgraph/service");
    expect(r.ok).toBe(false);
  });

  it("extends requires a subgraph", () => {
    const m = base();
    delete m.subgraph;
    m.extends = [{ plugin: "orders", entities: ["Order"] }];
    expect(validateManifest(m).ok).toBe(false);
  });

  it("provider capability must name an existing service", () => {
    const m = load("examples/postgres/plugin.json");
    m.provides.database.service = "ghost";
    expect(validateManifest(m).ok).toBe(false);
  });
});
