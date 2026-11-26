// schema check (D33, step 2): what counts as a drift between a subgraph's file and the SDL its service serves. The
// served SDL of the fixture was recorded from a real subgraph (the template of create, @apollo/subgraph 2.17.0): it
// carries the federation definitions a file never writes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSchemas, schemaCheck } from "../src/schemacheck.js";
import { main } from "../src/cli.js";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const served = readFileSync(new URL("fixtures/schema/served-by-apollo-subgraph.graphql", import.meta.url), "utf8");
const file = `extend schema
  @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key"])

"An item of inventory-api. Another subgraph can extend it through its key."
type InventoryItem @key(fields: "id") {
  id: ID!
  name: String!
}

type Query {
  inventoryItems: [InventoryItem!]!
}
`;

describe("compareSchemas", () => {
  it("finds nothing between a file and what @apollo/subgraph serves for it: the federation definitions are not a drift", () => {
    expect(served).toContain("directive @federation__shareable");
    expect(served).toContain("_entities(representations: [_Any!]!)");
    expect(compareSchemas(file, served)).toEqual([]);
  });

  it("does not count the order of definitions and fields, nor the descriptions", () => {
    const reordered = `type Query { inventoryItems: [InventoryItem!]! }
      type InventoryItem @key(fields: "id") { "Its name." name: String! id: ID! }
      extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key"])`;
    expect(compareSchemas(file, reordered)).toEqual([]);
  });

  it("names each field added, removed or changed, and a type on one side only", () => {
    const changed = served
      .replace("  name: String!\n", "  name: String\n  price: Float!\n")
      .replace("type Query {", "type Warehouse {\n  id: ID!\n}\n\ntype Query {");
    expect(compareSchemas(file, changed)).toEqual([
      "type InventoryItem: name: String! in the file, name: String served",
      "type InventoryItem: price served, not in the file",
      "type Warehouse: served, not in the file",
    ]);
  });

  it("sees a changed key, a changed argument and an enum value", () => {
    const a = `type T @key(fields: "id") { id: ID! list(first: Int): [T!]! } enum E { A B } type Query { t: T }`;
    expect(compareSchemas(a, a.replace('@key(fields: "id")', '@key(fields: "sku")'))).toEqual([
      'type T: directives "@key(fields: "id")" in the file, "@key(fields: "sku")" served',
    ]);
    expect(compareSchemas(a, a.replace("first: Int", "first: Int!"))).toEqual([
      "type T: list(first: Int): [T!]! in the file, list(first: Int!): [T!]! served",
    ]);
    expect(compareSchemas(a, a.replace("A B", "A B C"))).toEqual(["enum E: C served, not in the file"]);
  });

  it("reads an extension and its type as one: extend type Query in the file, type Query served", () => {
    const extended = file.replace("type Query {", "extend type Query {");
    expect(compareSchemas(extended, served)).toEqual([]);
  });
});

describe("schemaCheck", () => {
  const work = join(pkg, ".test-work/schemacheck");
  const io = (cwd: string) => ({ cwd, stdout: () => {}, stderr: () => {} });

  function platform(url: string): string {
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, "bricks/inventory"), { recursive: true });
    writeFileSync(join(work, "bricks/inventory/schema.graphql"), file);
    writeFileSync(
      join(work, "bricks/inventory/plugin.json"),
      JSON.stringify({ name: "inventory", version: "0.1.0", services: [], subgraph: { url, schema: "schema.graphql" } }),
    );
    cpSync(join(pkg, "examples/postgres"), join(work, "bricks/postgres"), { recursive: true });
    expect(main(["init", "--name", "demo"], io(work))).toBe(0);
    expect(main(["add", "inventory"], io(work))).toBe(0);
    expect(main(["add", "postgres"], io(work))).toBe(0);
    return work;
  }

  it("compares the installed copy with what the address serves", () => {
    const asked: string[] = [];
    const r = schemaCheck(platform("https://catalog.example.com/graphql"), "inventory", {
      fetchSdl: (url) => (asked.push(url), { sdl: served }),
    });
    expect(asked).toEqual(["https://catalog.example.com/graphql"]);
    expect(r).toMatchObject({ file: ".platform/bricks/inventory/schema.graphql", differences: [] });
  });

  it.skipIf(process.platform !== "linux")(
    "asks host.docker.internal at the gateway of Docker's bridge, as the router's container reaches it",
    () => {
      const asked: string[] = [];
      schemaCheck(platform("http://host.docker.internal:4010/graphql"), "inventory", {
        exec: () => ({ status: 0, stdout: "172.18.0.1\n", stderr: "" }),
        fetchSdl: (url) => (asked.push(url), { sdl: served }),
      });
      expect(asked).toEqual(["http://172.18.0.1:4010/graphql"]);
    },
  );

  it("refuses a brick with no subgraph, one served inside the platform (without --url), and an unknown one", () => {
    const root = platform("https://catalog.example.com/graphql");
    expect(() => schemaCheck(root, "postgres")).toThrow(/SCHEMA_CHECK_NO_SUBGRAPH|serves no subgraph/);
    expect(() => schemaCheck(root, "nope")).toThrow(/no brick named "nope"/);
  });
});
