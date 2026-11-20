import type { AdminBrick, BricksResponse, LiveState, RouterView } from "./types";

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

/**
 * Where a brick answers: a subgraph is reached through the router (its GraphQL endpoint), never
 * directly; other bricks are not published (D9). Null when there is nothing to show.
 */
export function hostOf(brick: AdminBrick, router: RouterView | null): string | null {
  if (!brick.subgraph || !brick.enabled || !router?.address) return null;
  return `http://${router.address}/graphql`;
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
