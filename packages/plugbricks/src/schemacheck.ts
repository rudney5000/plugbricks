// "plugbricks schema check <brick>" (D33, step 2): composition reads a brick's schema file, never the service, so the
// file of an external subgraph can drift from what the service really serves. This asks the service for its SDL
// (`{ _service { sdl } }`, which every federation subgraph answers) and compares it with the installed copy, the one the
// router composes. Read-only: it writes nothing and runs no platform command.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Kind, parse, print, type DefinitionNode, type DocumentNode, type TypeNode } from "graphql";
import { issue } from "./issues.js";
import { BRICKS_DIR, PlugbricksError, readProject } from "./platform.js";
import { defaultExec, type Exec } from "./runtime.js";

/** One difference between the file and the service, in words a person reads. */
export type SchemaDifference = string;

/**
 * What a federation library adds to the SDL it serves and a subgraph's file never writes: the definitions of the
 * federation and link directives and their types, `_Service`, `_Any`, `_Entity`, and the fields `_entities` and
 * `_service` of Query. They are not a drift.
 */
const FEDERATION_DIRECTIVES = new Set([
  "key",
  "link",
  "external",
  "requires",
  "provides",
  "extends",
  "shareable",
  "inaccessible",
  "override",
  "tag",
  "composeDirective",
  "interfaceObject",
  "authenticated",
  "requiresScopes",
  "policy",
  "context",
  "fromContext",
  "cost",
  "listSize",
]);
const isFederationName = (name: string) => name.startsWith("_") || name.startsWith("federation__") || name.startsWith("link__");

const typeText = (t: TypeNode): string => print(t);

/**
 * What a schema says, without what does not change it: the order of definitions, fields, arguments and values, and
 * the descriptions. One entry per definition, keyed by kind and name, each with its members and its directives.
 */
function shape(doc: DocumentNode): Map<string, { directives: string; members: Map<string, string> }> {
  const out = new Map<string, { directives: string; members: Map<string, string> }>();
  for (const d of doc.definitions as readonly DefinitionNode[]) {
    if (!("name" in d) || !d.name) {
      // `extend schema @link(...)` and `schema { ... }`: compared as a whole, by what they print.
      const key = `${d.kind}:`;
      const prev = out.get(key)?.directives ?? "";
      out.set(key, { directives: [prev, print({ ...d, loc: undefined } as never)].filter(Boolean).sort().join("\n"), members: new Map() });
      continue;
    }
    const name = d.name.value;
    if (d.kind === Kind.DIRECTIVE_DEFINITION ? FEDERATION_DIRECTIVES.has(name) || isFederationName(name) : isFederationName(name)) continue;
    const members = new Map<string, string>();
    const node = d as unknown as {
      fields?: readonly {
        name: { value: string };
        type: TypeNode;
        arguments?: readonly { name: { value: string }; type: TypeNode; defaultValue?: unknown }[];
        directives?: readonly unknown[];
      }[];
      values?: readonly { name: { value: string }; directives?: readonly unknown[] }[];
      types?: readonly { name: { value: string } }[];
      directives?: readonly unknown[];
      arguments?: readonly { name: { value: string }; type: TypeNode }[];
      locations?: readonly { value: string }[];
    };
    const directives = (list?: readonly unknown[]) =>
      (list ?? [])
        .map((x) => print(x as never))
        .sort()
        .join(" ");
    for (const f of node.fields ?? []) {
      if (f.name.value.startsWith("_")) continue;
      const args = [...(f.arguments ?? [])]
        .map((a) => `${a.name.value}: ${typeText(a.type)}${a.defaultValue ? ` = ${print(a.defaultValue as never)}` : ""}`)
        .sort()
        .join(", ");
      members.set(
        f.name.value,
        `${args ? `(${args})` : ""}: ${typeText(f.type)}${f.directives?.length ? ` ${directives(f.directives)}` : ""}`,
      );
    }
    for (const v of node.values ?? []) members.set(v.name.value, directives(v.directives));
    for (const t of node.types ?? []) members.set(t.name.value, "member");
    if (d.kind === Kind.DIRECTIVE_DEFINITION) {
      members.set(
        "(arguments)",
        [...(node.arguments ?? [])]
          .map((a) => `${a.name.value}: ${typeText(a.type)}`)
          .sort()
          .join(", "),
      );
      members.set(
        "(locations)",
        [...(node.locations ?? [])]
          .map((l) => l.value)
          .sort()
          .join(" | "),
      );
    }
    // An extension and its type say the same thing to composition: they are compared together.
    const kind = d.kind.replace(/Extension$/, "Definition");
    const key = `${kind}:${d.name.value}`;
    const prev = out.get(key);
    if (prev) for (const [k, v] of members) prev.members.set(k, v);
    if (members.size === 0 && !node.directives?.length && d.kind.endsWith("Extension")) continue;
    out.set(key, prev ?? { directives: directives(node.directives), members });
    if (prev && node.directives?.length) prev.directives = [prev.directives, directives(node.directives)].filter(Boolean).join(" ");
  }
  return out;
}

const label = (key: string) => {
  const [kind, name] = key.split(":");
  const word: Record<string, string> = {
    [Kind.OBJECT_TYPE_DEFINITION]: "type",
    [Kind.INTERFACE_TYPE_DEFINITION]: "interface",
    [Kind.INPUT_OBJECT_TYPE_DEFINITION]: "input",
    [Kind.ENUM_TYPE_DEFINITION]: "enum",
    [Kind.UNION_TYPE_DEFINITION]: "union",
    [Kind.SCALAR_TYPE_DEFINITION]: "scalar",
    [Kind.DIRECTIVE_DEFINITION]: "directive",
    [Kind.SCHEMA_EXTENSION]: "the schema extension (@link)",
    [Kind.SCHEMA_DEFINITION]: "the schema definition",
  };
  return name ? `${word[kind] ?? kind} ${kind === Kind.DIRECTIVE_DEFINITION ? "@" : ""}${name}` : (word[kind] ?? kind);
};

/** The differences between the brick's file and the service's SDL; empty when they say the same thing. */
export function compareSchemas(file: string, service: string): SchemaDifference[] {
  const a = shape(parse(file));
  const b = shape(parse(service));
  const out: SchemaDifference[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(key);
    const y = b.get(key);
    if (!y) {
      out.push(`${label(key)}: in the file, not served`);
      continue;
    }
    if (!x) {
      out.push(`${label(key)}: served, not in the file`);
      continue;
    }
    if (x.directives !== y.directives) out.push(`${label(key)}: directives "${x.directives}" in the file, "${y.directives}" served`);
    for (const m of [...new Set([...x.members.keys(), ...y.members.keys()])].sort()) {
      const p = x.members.get(m);
      const q = y.members.get(m);
      if (p === q) continue;
      if (q === undefined) out.push(`${label(key)}: ${m} in the file, not served`);
      else if (p === undefined) out.push(`${label(key)}: ${m} served, not in the file`);
      else out.push(`${label(key)}: ${m}${p} in the file, ${m}${q} served`);
    }
  }
  return out;
}

/** How this machine reaches host.docker.internal: the gateway of Docker's bridge on Linux, the loopback elsewhere. */
function hostAddress(exec: Exec, root: string): string {
  if (process.platform !== "linux") return "127.0.0.1";
  const r = exec("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], {
    cwd: root,
    timeoutMs: 10_000,
  });
  const ip = r.status === 0 ? r.stdout.trim() : "";
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : "127.0.0.1";
}

/** Asks a subgraph for its SDL, in a child process (the CLI is synchronous). The error text when it does not answer one. */
export function fetchServiceSdl(url: string): { sdl: string } | { error: string } {
  const script = `
    const [url] = process.argv.slice(1);
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: "{ _service { sdl } }" }), signal: AbortSignal.timeout(10000) })
      .then(async (r) => { const t = await r.text(); process.stdout.write(JSON.stringify({ status: r.status, body: t })); })
      .catch((e) => { process.stdout.write(JSON.stringify({ error: String(e.cause?.code ?? e.cause?.message ?? e.message) })); });`;
  const r = spawnSync(process.execPath, ["-e", script, url], { encoding: "utf8", timeout: 15_000 });
  let answer: { status?: number; body?: string; error?: string };
  try {
    answer = JSON.parse(r.stdout);
  } catch {
    return { error: r.error ? r.error.message : "no answer" };
  }
  if (answer.error) return { error: answer.error };
  let body: { data?: { _service?: { sdl?: unknown } }; errors?: { message?: string }[] };
  try {
    body = JSON.parse(answer.body ?? "");
  } catch {
    return { error: `HTTP ${answer.status}, not a GraphQL answer` };
  }
  const sdl = body.data?._service?.sdl;
  if (typeof sdl !== "string") {
    return {
      error: `HTTP ${answer.status}: ${body.errors?.[0]?.message ?? "no _service.sdl in the answer"} (is it a federation subgraph?)`,
    };
  }
  return { sdl };
}

export interface SchemaCheckResult {
  brick: string;
  /** The address asked, after host.docker.internal was translated. */
  url: string;
  /** The installed copy the router composes, relative to the platform. */
  file: string;
  differences: SchemaDifference[];
}

/** Compares the installed schema of an external brick with what its service serves. */
export function schemaCheck(
  root: string,
  brick: string,
  opts: { url?: string; exec?: Exec; fetchSdl?: typeof fetchServiceSdl } = {},
): SchemaCheckResult {
  const project = readProject(root);
  if (!Object.hasOwn(project.lock.bricks, brick)) throw new PlugbricksError([issue("BRICK_NOT_INSTALLED", "", { name: brick })]);
  const copy = join(project.root, BRICKS_DIR, brick);
  const m = JSON.parse(readFileSync(join(copy, "plugin.json"), "utf8")) as { subgraph?: { url?: string; schema: string } };
  if (!m.subgraph) throw new PlugbricksError([issue("SCHEMA_CHECK_NO_SUBGRAPH", "", { brick })]);
  if (m.subgraph.url === undefined && opts.url === undefined)
    throw new PlugbricksError([issue("SCHEMA_CHECK_EXTERNAL_ONLY", "", { brick })]);
  let url = opts.url ?? m.subgraph.url!;
  if (opts.url === undefined && new URL(url).hostname === "host.docker.internal") {
    url = url.replace("host.docker.internal", hostAddress(opts.exec ?? defaultExec, project.root));
  }
  const file = `${BRICKS_DIR}/${brick}/${m.subgraph.schema}`;
  const fetched = (opts.fetchSdl ?? fetchServiceSdl)(url);
  if ("error" in fetched) throw new PlugbricksError([issue("SCHEMA_CHECK_UNREACHABLE", "", { brick, url, detail: fetched.error })]);
  let differences: SchemaDifference[];
  try {
    differences = compareSchemas(readFileSync(join(project.root, file), "utf8"), fetched.sdl);
  } catch (e) {
    throw new PlugbricksError([
      issue("SCHEMA_CHECK_UNREACHABLE", "", { brick, url, detail: `its SDL does not parse: ${(e as Error).message}` }),
    ]);
  }
  return { brick, url, file, differences };
}
