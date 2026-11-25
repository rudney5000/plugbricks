import type { AdminAuthorization, AdminBrick, AdminDependency, BricksResponse, LiveState, RouterView } from "./types";

export function summary(bricks: AdminBrick[]): BricksResponse["summary"] {
  return {
    total: bricks.length,
    healthy: bricks.filter((b) => b.state === "healthy").length,
    down: bricks.filter((b) => b.state === "unhealthy").length,
    stopped: bricks.filter((b) => b.state === "stopped" || b.state === "not deployed").length,
  };
}

export function filterByTag(bricks: AdminBrick[], tag: string): AdminBrick[] {
  return tag === "all" ? bricks : bricks.filter((b) => b.tags.includes(tag));
}

/** "1 of 2 subgraphs reachable": a subgraph service counts when the runtime reports it healthy. */
export function reachability(router: RouterView): { reachable: number; total: number } {
  return { reachable: router.subgraphs.filter((s) => s.state === "healthy").length, total: router.subgraphs.length };
}

/** One address where a brick answers, and what it is. */
export interface Host {
  url: string;
  note: string;
}

/**
 * Where a brick answers: its pages for a web brick (published on their own loopback port, D17), and its
 * GraphQL endpoint for a subgraph, reached through the router, never directly. Other bricks are not
 * published (D9). Empty for a disabled brick.
 */
export function hostsOf(brick: AdminBrick, router: RouterView | null): Host[] {
  if (!brick.enabled) return [];
  const hosts: Host[] = [];
  if (brick.webUrl) hosts.push({ url: brick.webUrl, note: "Web page" });
  if (brick.subgraph && router?.address) hosts.push({ url: `http://${router.address}/graphql`, note: "GraphQL, through the router" });
  return hosts;
}

/** Enabled in platform.json but not running yet: the next Deploy (up) starts it. */
export function needsDeploy(brick: AdminBrick): boolean {
  return brick.enabled && !brick.deployed;
}

export function allTags(bricks: AdminBrick[]): string[] {
  return [...new Set(bricks.flatMap((b) => b.tags))].sort();
}

/** The dot and badge colour for a state; healthy, starting, down, stopped, unknown. */
export function tone(state: LiveState): { dot: string; badge: string } {
  switch (state) {
    case "healthy":
      return { dot: "bg-emerald-500", badge: "bg-emerald-50 text-emerald-700" };
    case "starting":
      return { dot: "bg-amber-500", badge: "bg-amber-50 text-amber-700" };
    case "unhealthy":
      return { dot: "bg-red-500", badge: "bg-red-50 text-red-700" };
    case "stopped":
      return { dot: "bg-slate-400", badge: "bg-slate-100 text-slate-600" };
    case "not deployed":
      return { dot: "bg-slate-300", badge: "bg-slate-100 text-slate-500" };
    default:
      return { dot: "bg-slate-400", badge: "bg-slate-100 text-slate-600" };
  }
}

/** A brick in the dependency graph, placed in a column (0 is the brick itself) and a row. */
export interface GraphNode {
  name: string;
  version: string | null;
  state: LiveState | null;
  installed: boolean;
  enabled: boolean;
  layer: number;
  row: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: AdminDependency["kind"];
  label: string;
  optional: boolean;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** What `name` needs, each brick after the ones it needs itself; `name` is not in it. */
  order: string[];
}

/**
 * Everything `name` needs, transitively. A brick is placed one column right of the furthest brick that needs it,
 * so every arrow points right; a link back to a brick on the way (a cycle) is drawn but does not move anything.
 * A brick that is needed but not installed is a node too, flagged, with nothing behind it.
 */
export function dependencyGraph(bricks: AdminBrick[], name: string): DependencyGraph {
  const byName = new Map(bricks.map((b) => [b.name, b]));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const walk = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of byName.get(n)?.dependsOn ?? []) {
      edges.push({ from: n, to: d.brick, kind: d.kind, label: d.label, optional: d.optional });
      walk(d.brick);
    }
  };
  walk(name);

  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);

  // Longest distance from `name`, ignoring the links that close a cycle.
  const layer = new Map<string, number>();
  const onPath = new Set<string>();
  const place = (n: string, depth: number) => {
    if (onPath.has(n)) return;
    if ((layer.get(n) ?? -1) >= depth) return;
    layer.set(n, depth);
    onPath.add(n);
    for (const next of out.get(n) ?? []) place(next, depth + 1);
    onPath.delete(n);
  };
  place(name, 0);

  const rows = new Map<number, number>();
  const nodes: GraphNode[] = [...seen]
    .sort((a, b) => (layer.get(a) ?? 0) - (layer.get(b) ?? 0) || a.localeCompare(b))
    .map((n) => {
      const l = layer.get(n) ?? 0;
      const row = rows.get(l) ?? 0;
      rows.set(l, row + 1);
      const b = byName.get(n);
      return {
        name: n,
        version: b?.version ?? null,
        state: b?.state ?? null,
        installed: b !== undefined,
        enabled: b?.enabled ?? false,
        layer: l,
        row,
      };
    });

  const order: string[] = [];
  const done = new Set<string>([name]);
  const visit = (n: string) => {
    if (done.has(n)) return;
    done.add(n);
    for (const next of out.get(n) ?? []) visit(next);
    order.push(n);
  };
  for (const next of out.get(name) ?? []) visit(next);
  return { nodes, edges, order };
}

/** The bricks that list `name` among the ones they need, with why. */
export function requiredBy(
  bricks: AdminBrick[],
  name: string,
): { brick: string; kind: AdminDependency["kind"]; label: string; optional: boolean }[] {
  return bricks
    .filter((b) => b.name !== name)
    .flatMap((b) =>
      b.dependsOn.filter((d) => d.brick === name).map((d) => ({ brick: b.name, kind: d.kind, label: d.label, optional: d.optional })),
    )
    .sort((a, b) => a.brick.localeCompare(b.brick));
}

/**
 * What the Details tab says about a brick's API (D22). A class without a role asks nothing more than a valid token, and
 * a brick that requires oidc but declares no roles is open: the page says so, because nothing else on it would.
 */
export function describeAuthorization(a: AdminAuthorization): string {
  if (a.state === "none") return "—";
  if (a.state === "open") return "open: any valid token may call it";
  const any = "any valid token";
  return `queries: ${a.queries ?? any}; mutations: ${a.mutations ?? any}`;
}
