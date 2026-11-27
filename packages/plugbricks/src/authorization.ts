// The rules per field of a federated schema (@authenticated, @requiresScopes) and the ways around them (D42, D43).
//
// The router applies a rule to the field it is asked for: the pair (type written in the query path, field). The composer
// writes those rules in the router configuration, and does not carry them across interfaces, unions or @requires. Each
// of the four checks below was seen to give protected data to a caller without the rule, on the pinned router (D42).
import { createRequire } from "node:module";
import type { DocumentNode, SelectionSetNode, TypeNode } from "graphql";
import { issue, type Issue } from "./issues.js";

// Loaded with the composition that calls this module (see federation.ts).
const nodeRequire = createRequire(import.meta.url);

/**
 * What a caller must hold: one of these sets of scopes, whole. The empty set asks for a token and no scope
 * (@authenticated). Null: no rule, anyone.
 */
export type Rule = string[][] | null;

/** One field of the composer's answer, from which the router's rules are written. */
export interface FieldRule {
  typeName: string;
  fieldName: string;
  requiresAuthentication?: boolean;
  /** One of these sets of scopes, whole. */
  requiredScopes?: string[][];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The smallest writing of a rule: sorted sets, without a set that another one already contains. */
function normalize(sets: string[][]): string[][] {
  const sorted = sets.map((s) => [...new Set(s)].sort(compare));
  const unique = [...new Map(sorted.map((s) => [JSON.stringify(s), s])).values()];
  return unique
    .filter((s) => !unique.some((o) => o !== s && o.every((scope) => s.includes(scope))))
    .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
}

/** Both rules at once. */
export function both(a: Rule, b: Rule): Rule {
  if (!a) return b;
  if (!b) return a;
  return normalize(a.flatMap((x) => b.map((y) => [...x, ...y])));
}

/** Whether every caller `a` lets through also satisfies `b`: `a` is at least as strict. */
export function implies(a: Rule, b: Rule): boolean {
  if (!b) return true;
  if (!a) return false;
  return a.every((x) => b.some((y) => y.every((scope) => x.includes(scope))));
}

/** The rule as it is written in a schema, to be copied from a message. */
export function writeRule(rule: Exclude<Rule, null>): string {
  if (rule.length === 1 && rule[0].length === 0) return "@authenticated";
  return `@requiresScopes(scopes: [${rule.map((set) => `[${set.map((s) => JSON.stringify(s)).join(", ")}]`).join(", ")}])`;
}

const named = (t: TypeNode): string => (t.kind === "NamedType" ? t.name.value : named(t.type));

interface FieldInfo {
  type: string;
  inaccessible: boolean;
}
interface TypeInfo {
  kind: "object" | "interface" | "union" | "other";
  /** The rule written on the type itself. */
  rule: Rule;
  interfaces: string[];
  members: string[];
  fields: Map<string, FieldInfo>;
}

type Directives = readonly { name: { value: string }; arguments?: readonly { name: { value: string }; value: unknown }[] }[];

const has = (directives: Directives | undefined, name: string) => (directives ?? []).some((d) => d.name.value === name);

/** The rule of the directives of a type, as the composer wrote them in the federated schema. */
function directiveRule(directives: Directives | undefined): Rule {
  let rule: Rule = has(directives, "authenticated") ? [[]] : null;
  for (const d of directives ?? []) {
    if (d.name.value !== "requiresScopes") continue;
    const value = d.arguments?.find((a) => a.name.value === "scopes")?.value as { values?: { values?: { value: string }[] }[] } | undefined;
    const sets = (value?.values ?? []).map((set) => (set.values ?? []).map((s) => s.value));
    if (sets.length) rule = both(rule, normalize(sets));
  }
  return rule;
}

function readTypes(federated: DocumentNode): Map<string, TypeInfo> {
  const types = new Map<string, TypeInfo>();
  for (const d of federated.definitions) {
    if (!("name" in d) || !d.name || d.kind === "DirectiveDefinition") continue;
    const kind =
      d.kind === "ObjectTypeDefinition"
        ? "object"
        : d.kind === "InterfaceTypeDefinition"
          ? "interface"
          : d.kind === "UnionTypeDefinition"
            ? "union"
            : "other";
    const fields = new Map<string, FieldInfo>();
    if (d.kind === "ObjectTypeDefinition" || d.kind === "InterfaceTypeDefinition") {
      for (const f of d.fields ?? []) {
        fields.set(f.name.value, { type: named(f.type), inaccessible: has(f.directives as Directives, "inaccessible") });
      }
    }
    types.set(d.name.value, {
      kind,
      rule: directiveRule((d as { directives?: Directives }).directives),
      interfaces: ((d as { interfaces?: readonly { name: { value: string } }[] }).interfaces ?? []).map((i) => i.name.value),
      members: d.kind === "UnionTypeDefinition" ? (d.types ?? []).map((t) => t.name.value) : [],
      fields,
    });
  }
  return types;
}

/**
 * The scopes a brick's dependencies list (D44), against the schema of each: `given`, those a rule of that dependency's
 * schema asks for, sorted and without duplicates; the others are refused, for a scope is a name of the whole identity
 * provider and listing a dependency gives no other one. `schemaOf` answers undefined for a dependency that is not
 * installed (nothing to look at yet) and null for one without a subgraph.
 */
export function dependencyScopes(
  brick: string,
  dependencies: readonly { plugin: string; scopes?: string[] }[] | undefined,
  schemaOf: (plugin: string) => string | null | undefined,
): { given: string[]; issues: Issue[] } {
  const given = new Set<string>();
  const issues: Issue[] = [];
  for (const d of dependencies ?? []) {
    if (d.plugin === brick || !d.scopes) continue;
    const sdl = schemaOf(d.plugin);
    if (sdl === undefined) continue;
    const asked = sdl === null ? new Set<string>() : scopesAsked(sdl);
    for (const scope of d.scopes) {
      if (asked.has(scope)) given.add(scope);
      else {
        const known = [...asked].sort(compare).join(", ") || "none";
        issues.push(issue("DEPENDENCY_SCOPE_UNKNOWN", "", { brick, scope, target: d.plugin, known }));
      }
    }
  }
  return { given: [...given].sort(compare), issues };
}

/** The scopes a rule of this schema asks for (@requiresScopes), on a field or on a type. */
function scopesAsked(sdl: string): Set<string> {
  const { parse, visit }: typeof import("graphql") = nodeRequire("graphql");
  const scopes = new Set<string>();
  visit(parse(sdl), {
    Directive(node) {
      if (node.name.value !== "requiresScopes") return;
      visit(node, {
        StringValue(value) {
          scopes.add(value.value);
        },
      });
    },
  });
  return scopes;
}

/**
 * The places where the composed schema gives protected data to a caller the rule refuses elsewhere, one issue per place,
 * each with the rule to add there.
 *
 * 1. A field of an interface that asks less than the same field of the types that implement it, and the other way round
 *    when the interface asks what none of them does.
 * 2. A field that returns a protected type, or an interface or a union that can be one, without that rule: the router
 *    applies the rule of a type only where the composer wrote it on the field.
 * 3. A type that implements a protected interface without its rule.
 * 4. A field computed from protected fields (@requires) that asks less than they do.
 *
 * `federated` and `fieldRules` are what the composer wrote; `subgraphs` are the schemas it composed, with the names the
 * messages give them.
 */
export function authorizationBypasses(
  federated: DocumentNode,
  fieldRules: readonly FieldRule[],
  subgraphs: readonly { file: string; document: DocumentNode }[],
): Issue[] {
  const rules = new Map<string, Rule>();
  for (const f of fieldRules) {
    const sets = f.requiredScopes ?? [];
    const rule = sets.length ? normalize(sets) : f.requiresAuthentication ? [[]] : null;
    if (rule) rules.set(`${f.typeName}.${f.fieldName}`, rule);
  }
  const types = readTypes(federated);
  if (rules.size === 0 && ![...types.values()].some((t) => t.rule)) return [];
  const ruleOf = (type: string, field: string): Rule => rules.get(`${type}.${field}`) ?? null;

  const found = new Map<string, { exposed: string; protectedBy: string[]; rule: Rule }>();
  /** `exposed` asks `has`, and lets through what `source` protects with `needs`. */
  const check = (exposed: string, has: Rule, source: string, needs: Rule) => {
    if (implies(has, needs)) return;
    const at = found.get(exposed) ?? { exposed, protectedBy: [], rule: has };
    at.rule = both(at.rule, needs);
    if (!at.protectedBy.includes(source)) at.protectedBy.push(source);
    found.set(exposed, at);
  };

  const names = [...types.keys()].sort(compare);
  const implementers = (name: string) => names.filter((n) => types.get(n)!.interfaces.includes(name));
  /** The object types a value of this interface or union can be. */
  const possible = (name: string): string[] => {
    const t = types.get(name)!;
    if (t.kind === "union") return [...t.members].sort(compare);
    return implementers(name).filter((n) => types.get(n)!.kind === "object");
  };

  for (const name of names) {
    const type = types.get(name)!;
    if (type.kind === "interface") {
      const below = implementers(name);
      // 3. The rule of the interface, on every type that implements it, unless they carry it between them.
      const carried = below.reduce<Rule>((r, n) => both(r, types.get(n)!.rule), null);
      if (type.rule && !implies(carried, type.rule)) {
        for (const n of below) check(n, types.get(n)!.rule, name, type.rule);
      }
      // 1. Field by field.
      for (const [field, info] of type.fields) {
        if (info.inaccessible) continue;
        const own = ruleOf(name, field);
        for (const n of below) check(`${name}.${field}`, own, `${n}.${field}`, ruleOf(n, field));
        const together = below.reduce<Rule>((r, n) => both(r, ruleOf(n, field)), null);
        if (own && !implies(together, own)) {
          for (const n of below) check(`${n}.${field}`, ruleOf(n, field), `${name}.${field}`, own);
        }
      }
    }
    // 2. A field that returns a protected type, or an interface or a union that can be one.
    if (type.kind === "object" || type.kind === "interface") {
      for (const [field, info] of type.fields) {
        const returned = types.get(info.type);
        if (info.inaccessible || !returned) continue;
        const abstract = returned.kind === "interface" || returned.kind === "union";
        for (const n of [info.type, ...(abstract ? possible(info.type) : [])]) {
          check(`${name}.${field}`, ruleOf(name, field), n, types.get(n)?.rule ?? null);
        }
      }
    }
  }

  // 4. @requires, as the subgraphs write it: the composed schema does not keep it.
  const { parse }: typeof import("graphql") = nodeRequire("graphql");
  for (const { document } of subgraphs) {
    for (const d of document.definitions) {
      if (d.kind !== "ObjectTypeDefinition" && d.kind !== "ObjectTypeExtension" && d.kind !== "InterfaceTypeDefinition") continue;
      for (const f of d.fields ?? []) {
        const requires = (f.directives ?? []).find((x) => x.name.value === "requires");
        const value = requires?.arguments?.find((a) => a.name.value === "fields")?.value;
        if (value?.kind !== "StringValue") continue;
        const target = `${d.name.value}.${f.name.value}`;
        const walk = (set: SelectionSetNode, parent: string) => {
          for (const s of set.selections) {
            if (s.kind === "InlineFragment") {
              const on = s.typeCondition?.name.value ?? parent;
              check(target, ruleOf(d.name.value, f.name.value), on, types.get(on)?.rule ?? null);
              walk(s.selectionSet, on);
            } else if (s.kind === "Field") {
              check(target, ruleOf(d.name.value, f.name.value), `${parent}.${s.name.value}`, ruleOf(parent, s.name.value));
              const returned = types.get(parent)?.fields.get(s.name.value)?.type;
              if (s.selectionSet && returned) walk(s.selectionSet, returned);
            }
          }
        };
        const query = parse(`{ ${value.value} }`).definitions[0];
        if (query.kind === "OperationDefinition") walk(query.selectionSet, d.name.value);
      }
    }
  }

  /** The schema files that declare a type, or a field of one ("Type.field"): where the rule can be written. */
  const filesOf = (coordinate: string) => {
    const [type, field] = coordinate.split(".");
    return subgraphs
      .filter(({ document }) =>
        document.definitions.some(
          (d) =>
            "name" in d &&
            d.name?.value === type &&
            (field === undefined || ("fields" in d && (d.fields ?? []).some((f) => f.name.value === field))),
        ),
      )
      .map((s) => s.file)
      .sort(compare)
      .join(", ");
  };

  return [...found.values()]
    .sort((a, b) => compare(a.exposed, b.exposed))
    .map((b) =>
      issue("AUTHORIZATION_BYPASS", "", {
        exposed: b.exposed,
        files: filesOf(b.exposed),
        protected: [...b.protectedBy]
          .sort(compare)
          .map((p) => `"${p}"`)
          .join(", "),
        rule: writeRule(b.rule!),
      }),
    );
}
