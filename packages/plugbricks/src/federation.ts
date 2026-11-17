import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DocumentNode } from "graphql";
import { issue, type Issue } from "./issues.js";

// Checks that the subgraphs of the installed bricks compose into one federated schema, with
// @wundergraph/composition (see decision D8). The composer is loaded the first time it is needed:
// a platform without any subgraph never pays for it. It is a CommonJS package, so a synchronous
// require is enough and add, remove and status stay synchronous.

const nodeRequire = createRequire(import.meta.url);

type Composition = typeof import("@wundergraph/composition");
type GraphQL = typeof import("graphql");

let composition: Composition | undefined;
let graphql: GraphQL | undefined;
const loadComposition = (): Composition => (composition ??= nodeRequire("@wundergraph/composition"));
const loadGraphql = (): GraphQL => (graphql ??= nodeRequire("graphql"));

export const COMPOSER_NAME = "@wundergraph/composition";
export const composerVersion = (): string => nodeRequire(`${COMPOSER_NAME}/package.json`).version;

/** Plain code point order: the same on every machine, whatever its locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One installed brick that serves a subgraph. */
export interface SubgraphInput {
  brick: string;
  /** SDL file as shown in messages, relative to the platform folder, with "/". */
  file: string;
  sdl: string;
  /** Where the router will reach it: http://<brick>-<service>:<port><path>. */
  url: string;
  /** Entities of other bricks this one extends (the `extends` field of its manifest). */
  extends: { plugin: string; entities: string[] }[];
}

export interface FederationLock {
  composer: { name: string; version: string };
  routerCompatibilityVersion: string;
  /** Names of the bricks that serve a subgraph, sorted. */
  subgraphs: string[];
  /** sha256 of the federated schema (printed from its AST, so insensitive to formatting). */
  schemaSha256: string;
}

export type FederationResult = { ok: true; federation: FederationLock } | { ok: false; issues: Issue[] };

interface Parsed extends SubgraphInput {
  document: DocumentNode;
}

/** The object types (definitions or extensions) named `name` that carry @key: what a federation calls an entity. */
function declaresEntity(document: DocumentNode, name: string): boolean {
  return document.definitions.some(
    (d) =>
      (d.kind === "ObjectTypeDefinition" || d.kind === "ObjectTypeExtension") &&
      d.name.value === name &&
      // Only "@key" itself: an @link import that renames it to another name is not recognized.
      (d.directives ?? []).some((directive) => directive.name.value === "key"),
  );
}

const definitionKey = (d: DocumentNode["definitions"][number]): string => `${d.kind}:${"name" in d && d.name ? d.name.value : ""}`;

function parseAll(inputs: SubgraphInput[]): { parsed: Parsed[]; issues: Issue[] } {
  const { parse } = loadGraphql();
  const parsed: Parsed[] = [];
  const issues: Issue[] = [];
  for (const input of inputs) {
    try {
      parsed.push({ ...input, document: parse(input.sdl) });
    } catch (e) {
      const error = e as { message: string; locations?: readonly { line: number; column: number }[] };
      const at = error.locations?.[0];
      issues.push(
        issue("SUBGRAPH_SCHEMA_INVALID", "", {
          brick: input.brick,
          file: input.file,
          line: String(at?.line ?? 1),
          column: String(at?.column ?? 1),
          detail: error.message.split("\n")[0].replace(/^Syntax Error: /, ""),
        }),
      );
    }
  }
  return { parsed, issues };
}

/** What composition cannot see: the intent written in `extends` (a lone `type Order @key` composes fine). */
function extendsIssues(parsed: Parsed[]): Issue[] {
  const byBrick = new Map(parsed.map((p) => [p.brick, p]));
  const issues: Issue[] = [];
  for (const p of parsed) {
    for (const ext of p.extends) {
      for (const entity of ext.entities) {
        if (!declaresEntity(p.document, entity)) {
          issues.push(issue("EXTENDS_ENTITY_NOT_DECLARED", "", { brick: p.brick, entity, file: p.file }));
        }
        const owner = byBrick.get(ext.plugin);
        if (!owner) {
          issues.push(issue("EXTENDS_OWNER_MISSING", "", { brick: p.brick, entity, owner: ext.plugin }));
        } else if (!declaresEntity(owner.document, entity)) {
          issues.push(issue("EXTENDS_ENTITY_MISSING", "", { brick: p.brick, entity, owner: ext.plugin, file: owner.file }));
        }
      }
    }
  }
  return issues;
}

type FederationSuccess = Extract<ReturnType<Composition["federateSubgraphs"]>, { success: true }>;

/**
 * The common steps of every use of the composer: 1. GraphQL syntax errors (nothing else is tried),
 * 2. the `extends` checks, 3. the composer's own errors, one issue each, identical ones once, with
 * the composer's text as it is. The subgraphs are sorted by brick name: the result must not depend
 * on the order the bricks were added in.
 */
function federate(inputs: SubgraphInput[]): { ok: true; sorted: Parsed[]; result: FederationSuccess } | { ok: false; issues: Issue[] } {
  const { parsed, issues: syntax } = parseAll(inputs);
  if (syntax.length) return { ok: false, issues: syntax };
  const wrong = extendsIssues(parsed);
  if (wrong.length) return { ok: false, issues: wrong };

  const sorted = [...parsed].sort((a, b) => compare(a.brick, b.brick));
  const result = loadComposition().federateSubgraphs({
    subgraphs: sorted.map((p) => ({ name: p.brick, url: p.url, definitions: p.document })),
  });
  if (!result.success) {
    const seen = new Set<string>();
    const issues: Issue[] = [];
    for (const error of result.errors) {
      if (seen.has(error.message)) continue;
      seen.add(error.message);
      issues.push(issue("COMPOSITION_FAILED", "", { detail: error.message }));
    }
    return { ok: false, issues };
  }
  return { ok: true, sorted, result };
}

/**
 * Composes the subgraphs of the given bricks. Returns the data the lock records, or the refusals.
 * No subgraph at all: nothing to compose, no federation (ok with `federation: undefined`).
 */
export function composeSubgraphs(inputs: SubgraphInput[]): { ok: true; federation?: FederationLock } | { ok: false; issues: Issue[] } {
  if (inputs.length === 0) return { ok: true };
  const composed = federate(inputs);
  if (!composed.ok) return composed;
  const { sorted, result } = composed;
  const { print } = loadGraphql();
  // The definitions are sorted by kind and name: the hash must not change when a subgraph only
  // lists its types in another order. Fields keep the order the composer gives them.
  const definitions = [...result.federatedGraphAST.definitions].sort((a, b) => compare(definitionKey(a), definitionKey(b)));
  return {
    ok: true,
    federation: {
      composer: { name: COMPOSER_NAME, version: composerVersion() },
      routerCompatibilityVersion: loadComposition().ROUTER_COMPATIBILITY_VERSION_ONE,
      subgraphs: sorted.map((p) => p.brick),
      schemaSha256: createHash("sha256")
        .update(print({ ...result.federatedGraphAST, definitions }))
        .digest("hex"),
    },
  };
}
