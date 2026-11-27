// The ways around a rule per field that composition refuses (D43). Each refused shape was seen to give protected data to
// a caller without the rule on the pinned router (D42), and each fix was seen to close it.
import { describe, expect, it } from "vitest";
import { both, implies, writeRule } from "../src/authorization.js";
import { buildRouterConfigFile, composeSubgraphs, type SubgraphInput } from "../src/federation.js";

const LINK =
  'extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@key", "@external", "@requires", "@shareable", "@authenticated", "@requiresScopes"])\n';
const scopes = (...sets: string[][]) => `@requiresScopes(scopes: ${JSON.stringify(sets)})`;

const input = (brick: string, sdl: string): SubgraphInput => ({
  brick,
  file: `${brick}/schema.graphql`,
  sdl: LINK + sdl,
  url: `http://${brick}-app:4000/graphql`,
  extends: [],
});

/** The refusals of these schemas, as "where the rule is missing <- what it protects". */
function refused(...schemas: string[]): string[] {
  const r = composeSubgraphs(schemas.map((s, i) => input(`api${i}`, s)));
  if (r.ok) return [];
  for (const i of r.issues) expect(i.code, i.message).toBe("AUTHORIZATION_BYPASS");
  return r.issues.map((i) => `${i.params!.exposed} <- ${i.params!.protected}`);
}

describe("a rule per field that can be gone around is refused", () => {
  it("through a field of an interface, and of an interface of that interface", () => {
    const schema = (onInterface: string) => `
      interface Priced { price: Float ${onInterface} }
      interface Deep implements Priced { price: Float ${onInterface} depth: Int }
      type Gem implements Deep & Priced { price: Float ${scopes(["p"])} depth: Int }
      type Query { priced: Priced deep: Deep }`;
    expect(refused(schema(""))).toEqual(['Deep.price <- "Gem.price"', 'Priced.price <- "Gem.price"']);
    expect(refused(schema(scopes(["p"])))).toEqual([]);
    // Asking for a token only is less than asking for the scope.
    expect(refused(schema("@authenticated"))).toHaveLength(2);
  });

  it("when only the interface carries the rule: the type's own field would give the value", () => {
    const schema = (onType: string) => `
      interface Priced { price: Float @authenticated }
      type Gem implements Priced { price: Float ${onType} }
      type Query { gem: Gem }`;
    expect(refused(schema(""))).toEqual(['Gem.price <- "Priced.price"']);
    expect(refused(schema("@authenticated"))).toEqual([]);
  });

  it("through an interface or a union that can be a protected type", () => {
    const schema = (onFields: string) => `
      interface Named { name: String! }
      type Secret implements Named ${scopes(["s"])} { name: String! }
      type Open implements Named { name: String! }
      union Result = Secret | Open
      type Query { named: [Named!]! ${onFields} results: [Result!]! ${onFields} open: Open secret: Secret }`;
    expect(refused(schema(""))).toEqual(['Query.named <- "Secret"', 'Query.results <- "Secret"']);
    // The public type of the same interface needs nothing.
    expect(refused(schema(scopes(["s"])))).toEqual([]);
  });

  it("through a type that implements a protected interface", () => {
    const schema = (onType: string) => `
      interface Guarded @authenticated { v: String }
      type Thing implements Guarded ${onType} { v: String }
      type Query { thing: Thing guarded: Guarded }`;
    expect(refused(schema(""))).toEqual(['Thing <- "Guarded"']);
    expect(refused(schema("@authenticated"))).toEqual([]);
  });

  it("through a field another subgraph computes from a protected one (@requires)", () => {
    const catalog = `type Product @key(fields: "id") { id: ID! price: Float ${scopes(["price"])} } type Query { products: [Product!]! }`;
    const pricing = (rule: string) => `
      type Product @key(fields: "id") { id: ID! price: Float @external priceWithTax: Float @requires(fields: "price") ${rule} }
      type Query { pricing: Boolean }`;
    expect(refused(catalog, pricing(""))).toEqual(['Product.priceWithTax <- "Product.price"']);
    expect(refused(catalog, pricing(scopes(["price"])))).toEqual([]);
    expect(refused(catalog, pricing(scopes(["price", "tax"])))).toEqual([]);
    // Either of two scopes would let in a caller who holds "tax" alone.
    expect(refused(catalog, pricing(scopes(["price"], ["tax"])))).toHaveLength(1);
  });

  it("through a computed field that reads a protected field deeper in its selection", () => {
    const catalog = `
      type Maker @shareable { name: String secret: String @authenticated }
      type Product @key(fields: "id") { id: ID! maker: Maker }
      type Query { products: [Product!]! }`;
    const other = (rule: string) => `
      type Maker @shareable { name: String secret: String }
      type Product @key(fields: "id") { id: ID! maker: Maker @external label: String @requires(fields: "maker { secret }") ${rule} }
      type Query { other: Boolean }`;
    expect(refused(catalog, other(""))).toEqual(['Product.label <- "Maker.secret"']);
    expect(refused(catalog, other("@authenticated"))).toEqual([]);
  });

  it("leaves alone a protected type that another subgraph returns: the composer writes the rule there too", () => {
    const schemas = [
      `type Product @key(fields: "id") @authenticated { id: ID! } type Query { product: Product }`,
      `type Product @key(fields: "id") { id: ID! } type Query { latest: Product }`,
    ];
    expect(refused(...schemas)).toEqual([]);
    const config = buildRouterConfigFile(schemas.map((s, i) => input(`api${i}`, s)));
    if (!config.ok) throw new Error(config.issues[0].message);
    const rules = JSON.parse(config.json).engineConfig.fieldConfigurations as { fieldName: string; authorizationConfiguration?: object }[];
    expect(rules.filter((f) => f.authorizationConfiguration).map((f) => f.fieldName)).toEqual(["product", "latest"]);
  });

  it("names the file where the rule goes, and the rule to write", () => {
    const r = composeSubgraphs([
      input(
        "catalog",
        `interface P { price: Float } type G implements P { price: Float ${scopes(["a", "b"], ["c"])} } type Query { p: P }`,
      ),
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues[0].message).toContain('put @requiresScopes(scopes: [["a", "b"], ["c"]]) on "P.price" in catalog/schema.graphql');
  });

  it("changes nothing for schemas without a rule, or whose rules cannot be gone around", () => {
    expect(refused(`interface N { n: String } type A implements N { n: String } union U = A type Query { n: N u: U }`)).toEqual([]);
    expect(refused(`type A { n: String ${scopes(["x"])} m: String @authenticated } type Query { a: A }`)).toEqual([]);
  });
});

describe("rules as sets of scopes", () => {
  it("compares them: at least as strict, or not", () => {
    expect(implies(null, null)).toBe(true);
    expect(implies(null, [[]])).toBe(false);
    expect(implies([["a"]], [[]])).toBe(true);
    expect(implies([[]], [["a"]])).toBe(false);
    expect(implies([["a", "b"]], [["a"], ["c"]])).toBe(true);
    expect(implies([["a"], ["b"]], [["a"]])).toBe(false);
  });

  it("joins two of them, and writes the smallest form", () => {
    expect(both([["a"], ["b"]], [["c"]])).toEqual([
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(both([["a"], ["a", "b"]], [[]])).toEqual([["a"]]);
    expect(writeRule([[]])).toBe("@authenticated");
  });
});
