import type { AdminBrick, BricksResponse, LiveState } from "./types";

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
