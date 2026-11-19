import { describe, expect, it } from "vitest";
import { allTags, filterByTag, summary, tone } from "./lib.js";
import type { AdminBrick } from "./types.js";

const brick = (name: string, state: AdminBrick["state"], tags: string[]): AdminBrick => ({
  name,
  version: "0.1.0",
  tags,
  enabled: true,
  deployed: state !== "stopped",
  state,
  reason: null,
  restarts: 0,
  port: 4000,
  subgraph: false,
  extends: "",
  provides: [],
  requires: "",
});

describe("the Bricks view helpers", () => {
  it("counts healthy, down and stopped bricks", () => {
    const s = summary([brick("a", "healthy", []), brick("b", "unhealthy", []), brick("c", "stopped", []), brick("d", "unknown", [])]);
    expect(s).toEqual({ total: 4, healthy: 1, down: 1, stopped: 1 });
  });

  it("filters by tag and lists the tags once, sorted", () => {
    const bricks = [brick("a", "healthy", ["api"]), brick("b", "healthy", ["api", "graphql"]), brick("c", "healthy", ["db"])];
    expect(filterByTag(bricks, "api").map((b) => b.name)).toEqual(["a", "b"]);
    expect(filterByTag(bricks, "all")).toHaveLength(3);
    expect(allTags(bricks)).toEqual(["api", "db", "graphql"]);
  });

  it("gives every state a dot and a badge colour", () => {
    expect(tone("healthy").dot).toContain("emerald");
    expect(tone("unhealthy").dot).toContain("red");
    expect(tone("stopped").badge).toContain("slate");
  });
});
