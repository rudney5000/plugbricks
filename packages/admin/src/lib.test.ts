import { describe, expect, it } from "vitest";
import { allTags, filterByTag, hostOf, needsDeploy, reachability, summary, tone } from "./lib.js";
import type { AdminBrick, RouterView } from "./types.js";

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
  removeBlockedBy: [],
});

const router = (address: string | null, states: AdminBrick["state"][]): RouterView => ({
  state: "healthy",
  address,
  image: "router",
  digest: null,
  subgraphs: states.map((state, i) => ({ brick: `b${i}`, name: `b${i}-app`, state })),
  config: null,
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

  it("counts the subgraphs the router can reach", () => {
    expect(reachability(router("127.0.0.1:4000", ["healthy", "unhealthy"]))).toEqual({ reachable: 1, total: 2 });
    expect(reachability(router("127.0.0.1:4000", []))).toEqual({ reachable: 0, total: 0 });
  });

  it("gives a subgraph brick the router's GraphQL endpoint, and nothing to the others", () => {
    const api = { ...brick("orders", "healthy", []), subgraph: true };
    expect(hostOf(api, router("127.0.0.1:4000", ["healthy"]))).toBe("http://127.0.0.1:4000/graphql");
    expect(hostOf(brick("postgres", "healthy", []), router("127.0.0.1:4000", []))).toBeNull();
    expect(hostOf({ ...api, enabled: false }, router("127.0.0.1:4000", []))).toBeNull();
    expect(hostOf(api, router(null, []))).toBeNull();
    expect(hostOf(api, null)).toBeNull();
  });

  it("flags an enabled brick that is not running as needing a deploy", () => {
    expect(needsDeploy({ ...brick("a", "not deployed", []), deployed: false })).toBe(true);
    expect(needsDeploy(brick("a", "healthy", []))).toBe(false);
    expect(needsDeploy({ ...brick("a", "stopped", []), enabled: false })).toBe(false);
  });

  it("gives every state a dot and a badge colour", () => {
    expect(tone("healthy").dot).toContain("emerald");
    expect(tone("unhealthy").dot).toContain("red");
    expect(tone("stopped").badge).toContain("slate");
  });
});
