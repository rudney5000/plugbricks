import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { composeSubgraphs, composerVersion, COMPOSER_NAME, type SubgraphInput } from "../src/federation.js";

const LINK = 'extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key"])\n';
const sub = (brick: string, sdl: string, ext: SubgraphInput["extends"] = []): SubgraphInput => ({
  brick,
  file: `.platform/bricks/${brick}/schema.graphql`,
  sdl,
  url: `http://${brick}-api:4000/graphql`,
  extends: ext,
});
const sales = sub("sales", `${LINK}type Order @key(fields: "id") { id: ID! total: Float! }\ntype Query { orders: [Order!]! }`);
const tracking = sub(
  "tracking",
  `${LINK}type Parcel @key(fields: "id") { id: ID! where: String! }\ntype Query { parcel(id: ID!): Parcel }`,
);

const composerLoaded = () =>
  // Windows spells the paths of require.cache with backslashes: compare them with "/".
  Object.keys(createRequire(import.meta.url).cache).some((p) => p.replaceAll("\\", "/").includes("@wundergraph/composition/dist/index.js"));

describe("composeSubgraphs", () => {
  // Must stay the first test of the file: it looks at what this process has loaded so far.
  it("loads the composer only when there is a subgraph to compose", () => {
    expect(composerLoaded()).toBe(false);
    expect(composeSubgraphs([])).toEqual({ ok: true });
    expect(composerLoaded()).toBe(false);
    expect(composeSubgraphs([sales]).ok).toBe(true);
    expect(composerLoaded()).toBe(true);
  });

  it("records the composer, its version, the router compatibility version, the sorted subgraphs and a sha256", () => {
    const r = composeSubgraphs([tracking, sales]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.federation).toEqual({
      composer: { name: COMPOSER_NAME, version: composerVersion() },
      routerCompatibilityVersion: "1",
      subgraphs: ["sales", "tracking"],
      schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(composerVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("gives the same result whatever the order the bricks are given in", () => {
    expect(composeSubgraphs([sales, tracking])).toEqual(composeSubgraphs([tracking, sales]));
  });

  it("hashes the schema, not its formatting or comments; a real change changes the hash", () => {
    const hash = (s: SubgraphInput) => {
      const r = composeSubgraphs([s]);
      return r.ok ? r.federation?.schemaSha256 : undefined;
    };
    const reformatted = sub(
      "sales",
      `# a comment\n${LINK}\ntype Query {\n  orders: [Order!]!\n}\n\ntype Order @key(fields: "id") {\n  id: ID!\n  total: Float!\n}\n`,
    );
    const changed = sub(
      "sales",
      `${LINK}type Order @key(fields: "id") { id: ID! total: Float! status: String }\ntype Query { orders: [Order!]! }`,
    );
    expect(hash(reformatted)).toBe(hash(sales));
    expect(hash(changed)).not.toBe(hash(sales));
  });

  it("reports a syntax error with the brick, the file, the line and the column", () => {
    const r = composeSubgraphs([sales, sub("broken", "type Parcel {\n  id: ID!\n")]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({
      code: "SUBGRAPH_SCHEMA_INVALID",
      params: { brick: "broken", file: ".platform/bricks/broken/schema.graphql", line: "3", column: "1" },
    });
    expect(r.issues[0].message).toBe(
      'the subgraph schema .platform/bricks/broken/schema.graphql of brick "broken" is not valid GraphQL (line 3, column 1): Expected Name, found <EOF>.',
    );
  });

  it("reports every broken schema, and does not try to compose after a syntax error", () => {
    const r = composeSubgraphs([sub("a", "type {"), sub("b", "type {")]);
    expect(r.ok === false && r.issues.map((i) => [i.code, i.params.brick])).toEqual([
      ["SUBGRAPH_SCHEMA_INVALID", "a"],
      ["SUBGRAPH_SCHEMA_INVALID", "b"],
    ]);
  });

  it("shows the composer's own text, once per distinct error", () => {
    const wrongTotal = sub("shipping", `${LINK}type Order @key(fields: "id") { id: ID! total: String! }`);
    const r = composeSubgraphs([sales, wrongTotal]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const details = r.issues.map((i) => i.params.detail);
    expect(new Set(details).size).toBe(details.length);
    expect(r.issues.every((i) => i.code === "COMPOSITION_FAILED")).toBe(true);
    expect(details.join("\n")).toContain('The field "Order.total" could not be federated due to incompatible types across subgraphs.');
    expect(details.join("\n")).toContain('"sales"');
    expect(details.join("\n")).toContain('"shipping"');
  });
});

describe("extends", () => {
  const shipping = (sdl: string, ext = [{ plugin: "sales", entities: ["Order"] }]) => sub("shipping", sdl, ext);
  const ownSdl = `${LINK}type Order @key(fields: "id") { id: ID! shipment: String }`;

  it("accepts an entity that the extending brick declares and the owner defines", () => {
    expect(composeSubgraphs([sales, shipping(ownSdl)]).ok).toBe(true);
  });

  it("accepts the Federation 1 spelling: extend type Order @key with an @external key", () => {
    const v1 = shipping('extend type Order @key(fields: "id") { id: ID! @external shipment: String }');
    expect(composeSubgraphs([sales, v1]).ok).toBe(true);
  });

  it("EXTENDS_OWNER_MISSING when the owner is not among the subgraphs, EXTENDS_ENTITY_MISSING when it does not define the entity", () => {
    const missing = composeSubgraphs([shipping(ownSdl)]);
    expect(missing.ok === false && missing.issues.map((i) => i.code)).toEqual(["EXTENDS_OWNER_MISSING"]);
    const other = composeSubgraphs([tracking, shipping(ownSdl, [{ plugin: "tracking", entities: ["Order"] }])]);
    expect(other.ok === false && other.issues.map((i) => i.code)).toEqual(["EXTENDS_ENTITY_MISSING"]);
  });

  it("an owner type without @key is not an entity", () => {
    const plain = sub("sales", `type Order { id: ID! }\ntype Query { orders: [Order!]! }`);
    const r = composeSubgraphs([plain, shipping(ownSdl)]);
    expect(r.ok === false && r.issues.map((i) => i.code)).toEqual(["EXTENDS_ENTITY_MISSING"]);
  });

  it("EXTENDS_ENTITY_NOT_DECLARED, one issue per entity that is listed and not declared", () => {
    const r = composeSubgraphs([
      sales,
      shipping(`${LINK}type Shipment { carrier: String }`, [{ plugin: "sales", entities: ["Order", "Customer"] }]),
    ]);
    expect(r.ok === false && r.issues.filter((i) => i.code === "EXTENDS_ENTITY_NOT_DECLARED").map((i) => i.params.entity)).toEqual([
      "Order",
      "Customer",
    ]);
  });

  it("a lone entity with no owner composes: no composer can see what extends was meant to say", () => {
    const lone = sub("ghosts", `${LINK}type Ghost @key(fields: "id") { id: ID! }\ntype Query { ghost: Ghost }`);
    expect(composeSubgraphs([sales, lone]).ok).toBe(true);
  });
});
