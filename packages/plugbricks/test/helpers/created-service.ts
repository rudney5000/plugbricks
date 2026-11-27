// What a service written by create gets in the tests that try its token check, its roles and its rules per field (D46 to D49).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

// What a service gets added to be tried: a mutation (the template has none, and the roles of a class need one), and rules
// on its item (D22 step B): the type asks for the scope items:read, `secret` for items:secret or admin, `pair` for a and b,
// `known` for a verified token. Returns the names the template chose for the item type and its query.
export function shape(work: string, brick: string, lang: string, o: { withInterface?: boolean } = {}): { type: string; field: string } {
  const withInterface = o.withInterface ?? true;
  const schema = join(work, "bricks", brick, "schema.graphql");
  const original = readFileSync(schema, "utf8");
  const type = /^type (\w+) @key/m.exec(original)![1];
  const field = /^type Query \{\s*(\w+):/m.exec(original)![1];
  const ruled = original
    .replace('import: ["@key"]', 'import: ["@key", "@authenticated", "@requiresScopes"]')
    .replace(
      `type ${type} @key(fields: "id") {`,
      `type ${type}${withInterface ? " implements Tagged" : ""} @key(fields: "id") @requiresScopes(scopes: [["items:read"]]) {`,
    )
    .replace(
      "  name: String!\n}",
      '  name: String!\n  secret: String @requiresScopes(scopes: [["items:secret"], ["admin"]])\n  pair: String @requiresScopes(scopes: [["a", "b"]])\n  known: String @authenticated\n  tag: String\n}',
    );
  expect(ruled, "the schema must change").not.toBe(original);
  writeFileSync(
    schema,
    `${ruled}\ntype Mutation {\n  touch: Boolean!\n}\n${withInterface ? '\ninterface Tagged {\n  tag: String @requiresScopes(scopes: [["items:tag"]])\n}\n' : ""}`,
  );
  const edit = (file: string, change: (text: string) => string) => {
    const path = join(work, "services", brick, file);
    const before = readFileSync(path, "utf8");
    const after = change(before);
    expect(after, `${file} must change`).not.toBe(before);
    writeFileSync(path, after);
  };
  const values = (n: string) => ({ secret: `s${n}`, pair: `p${n}`, known: `k${n}`, tag: `t${n}` });
  if (lang === "node")
    edit("src/main.ts", (t) =>
      t
        .replace("  Query: {", "  Mutation: { touch: () => true },\n  Query: {")
        .replace("  name: string;\n}", "  name: string;\n  secret?: string;\n  pair?: string;\n  known?: string;\n  tag?: string;\n}")
        .replace(
          '{ id: "1", name: "first" }',
          `{ id: "1", name: "first", ${Object.entries(values("1"))
            .map(([k, v]) => `${k}: "${v}"`)
            .join(", ")} }`,
        )
        .replace(
          '{ id: "2", name: "second" }',
          `{ id: "2", name: "second", ${Object.entries(values("2"))
            .map(([k, v]) => `${k}: "${v}"`)
            .join(", ")} }`,
        ),
    );
  if (lang === "python")
    edit("main.py", (t) =>
      t
        .replace("import QueryType,", "import MutationType, QueryType,")
        .replace(
          "query = QueryType()",
          'query = QueryType()\nmutation = MutationType()\n\n\n@mutation.field("touch")\ndef resolve_touch(*_):\n    return True\n',
        )
        .replace("query, item)", "query, mutation, item)")
        .replace(
          '{"id": "1", "name": "first"}',
          `{"id": "1", "name": "first", ${Object.entries(values("1"))
            .map(([k, v]) => `"${k}": "${v}"`)
            .join(", ")}}`,
        )
        .replace(
          '{"id": "2", "name": "second"}',
          `{"id": "2", "name": "second", ${Object.entries(values("2"))
            .map(([k, v]) => `"${k}": "${v}"`)
            .join(", ")}}`,
        ),
    );
  if (lang === "go") {
    const gv = (n: string) => `Secret: ptr("s${n}"), Pair: ptr("p${n}"), Known: ptr("k${n}"), Tag: ptr("t${n}")`;
    edit(
      "graph/resolver.go",
      (t) =>
        `${t.replace('Name: "first"}', `Name: "first", ${gv("1")}}`).replace('Name: "second"}', `Name: "second", ${gv("2")}}`)}
func ptr(s string) *string { return &s }

func (r *Resolver) Mutation() MutationResolver { return &mutationResolver{r} }

type mutationResolver struct{ *Resolver }

func (r *mutationResolver) Touch(_ context.Context) (bool, error) { return true, nil }
`,
    );
  }
  return { type, field };
}
