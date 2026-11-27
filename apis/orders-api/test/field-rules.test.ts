// The rules per field of the schema, applied by the API itself (D45): what the router refuses (D42, D43), a call that goes
// past the router is refused too. No database: a schema of its own, executed directly.
import { buildSubgraphSchema } from "@apollo/subgraph";
import { execute, parse } from "graphql";
import { describe, expect, it } from "vitest";
import { enforceFieldRules, satisfies, type Caller } from "../src/auth.js";

const SDL = `
extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key", "@authenticated", "@requiresScopes"])

interface Priced { price: Float @requiresScopes(scopes: [["p"]]) }
type Product implements Priced @key(fields: "id") {
  id: ID!
  name: String!
  price: Float @requiresScopes(scopes: [["p"]])
  cost: Float! @requiresScopes(scopes: [["c"]])
  note: String @authenticated
  either: Int @requiresScopes(scopes: [["a", "b"], ["z"]])
  supplier: Supplier
}
type Supplier @requiresScopes(scopes: [["s"]]) { name: String! }
type Vault @key(fields: "id") @authenticated { id: ID! secret: String }
type Broken { x: Int @requiresScopes(scopes: "oops") }
type Query {
  products: [Product!]!
  supplier: Supplier
  broken: Broken
}
type Mutation { touch: Int! @requiresScopes(scopes: [["w"]]) ping: Int! }
`;
let touched = 0;
const schema = enforceFieldRules(
  buildSubgraphSchema([
    {
      typeDefs: parse(SDL),
      resolvers: {
        Query: {
          products: () => [{ id: "1", name: "chair", price: 100, cost: 60, note: "n", either: 1, supplier: { name: "ACME" } }],
          supplier: () => ({ name: "ACME" }),
          broken: () => ({ x: 1 }),
        },
        Mutation: { touch: () => ++touched, ping: () => 1 },
        Vault: { __resolveReference: () => ({ id: "1", secret: "S" }) },
      } as never,
    },
  ]),
);
const caller = (...scopes: string[]): Caller => ({ subject: "s", name: "n", roles: {}, scopes });
const run = async (query: string, who?: Caller) => {
  const r = await execute({ schema, document: parse(query), contextValue: { caller: who } });
  return { data: r.data as Record<string, unknown> | null, errors: (r.errors ?? []).map((e) => e.message) };
};

describe("rules as sets of scopes", () => {
  it("asks every scope of one set", () => {
    expect(satisfies(caller("a", "b"), [["a", "b"], ["z"]])).toBe(true);
    expect(satisfies(caller("z"), [["a", "b"], ["z"]])).toBe(true);
    expect(satisfies(caller("a"), [["a", "b"], ["z"]])).toBe(false);
  });
  it("lets @authenticated in with a token and no scope, and nobody in without a caller or with a rule that cannot be read", () => {
    expect(satisfies(caller(), [[]])).toBe(true);
    expect(satisfies(undefined, [[]])).toBe(false);
    expect(satisfies(caller("a"), [])).toBe(false);
  });
});

describe("the API applies the rules of its schema", () => {
  it("returns a protected field to a token that has the scope, and null with an error to one that has not", async () => {
    expect(await run("{ products { name price } }", caller("p"))).toEqual({
      data: { products: [{ name: "chair", price: 100 }] },
      errors: [],
    });
    const refused = await run("{ products { name price } }", caller("c"));
    expect(refused.data).toEqual({ products: [{ name: "chair", price: null }] });
    expect(refused.errors).toEqual(["forbidden: this token lacks what Product.price asks for"]);
  });

  it("nulls the parent where the field cannot be null", async () => {
    expect((await run("{ products { name cost } }", caller("p"))).data).toBeNull();
    expect((await run("{ products { name cost } }", caller("c"))).data).toEqual({ products: [{ name: "chair", cost: 60 }] });
  });

  it("asks a token for @authenticated, and refuses every protected field without one", async () => {
    expect((await run("{ products { note } }", caller())).data).toEqual({ products: [{ note: "n" }] });
    for (const q of ["{ products { price } }", "{ products { note } }", "{ products { either } }"]) {
      const r = await run(q);
      expect(r.errors, q).toEqual([expect.stringContaining("not authenticated")]);
    }
    // A field with no rule is the API's to give: the token check is what asks for a caller (D20).
    expect((await run("{ products { name } }")).errors).toEqual([]);
  });

  it("applies the sets of scopes as written: a and b, or z", async () => {
    for (const [scopes, ok] of [
      [["a", "b"], true],
      [["z"], true],
      [["a"], false],
      [[], false],
    ] as const) {
      expect((await run("{ products { either } }", caller(...scopes))).errors.length === 0, scopes.join()).toBe(ok);
    }
  });

  it("applies the rule of a type to the fields that return it, and to its own fields", async () => {
    expect((await run("{ products { supplier { name } } }", caller())).data).toEqual({ products: [{ supplier: null }] });
    expect((await run("{ supplier { name } }", caller("s"))).data).toEqual({ supplier: { name: "ACME" } });
    expect((await run("{ supplier { name } }", caller("p"))).errors).toHaveLength(1);
  });

  it("applies the rule of a type reached through _entities, which has no field above it", async () => {
    const q = '{ _entities(representations: [{ __typename: "Vault", id: "1" }]) { ... on Vault { secret } } }';
    expect((await run(q)).errors).toEqual([expect.stringContaining("not authenticated")]);
    expect((await run(q, caller())).data).toEqual({ _entities: [{ secret: "S" }] });
  });

  it("applies the rule an interface puts on a field its implementer does not repeat", async () => {
    const bare = enforceFieldRules(
      buildSubgraphSchema([
        {
          typeDefs: parse(`extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@requiresScopes"])
            interface P { price: Float @requiresScopes(scopes: [["p"]]) }
            type G implements P { price: Float } type Query { g: G }`),
          resolvers: { Query: { g: () => ({ price: 1 }) } } as never,
        },
      ]),
    );
    const r = await execute({ schema: bare, document: parse("{ g { price } }"), contextValue: { caller: caller("x") } });
    expect(r.data).toEqual({ g: { price: null } });
  });

  it("applies the rule of the interface a field returns, though its implementer carries none", async () => {
    const guarded = enforceFieldRules(
      buildSubgraphSchema([
        {
          typeDefs: parse(`extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@authenticated"])
            interface G @authenticated { v: String }
            type Thing implements G { v: String } type Query { g: G }`),
          resolvers: { Query: { g: () => ({ __typename: "Thing", v: "x" }) }, G: { __resolveType: () => "Thing" } } as never,
        },
      ]),
    );
    const ask = (who?: Caller) => execute({ schema: guarded, document: parse("{ g { v } }"), contextValue: { caller: who } });
    expect((await ask()).data).toEqual({ g: null });
    expect((await ask(caller())).data).toEqual({ g: { v: "x" } });
  });

  it("refuses a rule it cannot read rather than opening the field", async () => {
    expect((await run("{ broken { x } }", caller("anything"))).data).toEqual({ broken: { x: null } });
  });

  it("does not run a refused mutation, and runs the others", async () => {
    touched = 0;
    expect((await run("mutation { touch }", caller("p"))).data).toBeNull();
    expect(touched).toBe(0);
    expect((await run("mutation { touch }", caller("w"))).data).toEqual({ touch: 1 });
    expect((await run("mutation { ping }", caller())).data).toEqual({ ping: 1 });
  });

  it("leaves a field without a rule as it was", () => {
    const f = schema.getType("Product") as unknown as { getFields(): Record<string, { resolve?: unknown }> };
    expect(f.getFields().name.resolve).toBeUndefined();
    expect(f.getFields().price.resolve).toBeTypeOf("function");
  });
});
