import { describe, expect, it } from "vitest";
import {
  allTags,
  dependencyGraph,
  describeAuthorization,
  filterByTag,
  hostsOf,
  needsDeploy,
  reachability,
  requiredBy,
  summary,
  tone,
} from "./lib.js";
import type { AdminBrick, AdminDependency, RouterView } from "./types.js";

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
  webUrl: null,
  extends: "",
  provides: [],
  requires: "",
  removeBlockedBy: [],
  dependsOn: [],
  authorization: { state: "none", queries: null, mutations: null, grants: [] },
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

  it("lists where a brick answers: its page, its GraphQL endpoint through the router, or nothing", () => {
    const r = router("127.0.0.1:4000", ["healthy"]);
    const api = { ...brick("orders", "healthy", []), subgraph: true };
    const page = { ...brick("orders-web", "healthy", []), webUrl: "http://127.0.0.1:8080/orders" };
    expect(hostsOf(api, r)).toEqual([{ url: "http://127.0.0.1:4000/graphql", note: "GraphQL, through the router" }]);
    expect(hostsOf(page, r)).toEqual([{ url: "http://127.0.0.1:8080/orders", note: "Web page" }]);
    expect(hostsOf({ ...page, subgraph: true }, r).map((h) => h.note)).toEqual(["Web page", "GraphQL, through the router"]);
    expect(hostsOf(brick("postgres", "healthy", []), r)).toEqual([]);
    expect(hostsOf({ ...page, enabled: false }, r)).toEqual([]);
    expect(hostsOf(api, router(null, []))).toEqual([]);
    expect(hostsOf(api, null)).toEqual([]);
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

const dep = (brick: string, kind: AdminDependency["kind"], label: string, extra: Partial<AdminDependency> = {}): AdminDependency => ({
  brick,
  kind,
  label,
  optional: false,
  installed: true,
  enabled: true,
  ...extra,
});
const withDeps = (name: string, dependsOn: AdminDependency[]): AdminBrick => ({ ...brick(name, "healthy", []), dependsOn });

describe("the dependency graph of a brick", () => {
  // orders-web needs orders (declared); orders needs postgres (capability) and, optionally, keycloak, which needs postgres.
  const platform = [
    withDeps("orders-web", [dep("keycloak", "capability", "oidc", { optional: true }), dep("orders", "declared", "reads the orders")]),
    withDeps("orders", [dep("keycloak", "capability", "oidc", { optional: true }), dep("postgres", "capability", "database")]),
    withDeps("keycloak", [dep("postgres", "capability", "database")]),
    withDeps("postgres", []),
  ];

  it("follows the links to the end: orders-web needs orders, which needs postgres", () => {
    const g = dependencyGraph(platform, "orders-web");
    expect(g.nodes.map((n) => [n.name, n.layer])).toEqual([
      ["orders-web", 0],
      ["orders", 1],
      ["keycloak", 2],
      ["postgres", 3],
    ]);
    expect(g.edges.map((e) => `${e.from}>${e.to}${e.optional ? "?" : ""}`).sort()).toEqual([
      "keycloak>postgres",
      "orders-web>keycloak?",
      "orders-web>orders",
      "orders>keycloak?",
      "orders>postgres",
    ]);
  });

  it("puts a brick right of everything that needs it, so postgres is not beside orders", () => {
    const g = dependencyGraph(platform, "orders");
    expect(g.nodes.find((n) => n.name === "postgres")?.layer).toBe(2);
    expect(g.nodes.find((n) => n.name === "keycloak")?.layer).toBe(1);
  });

  it("lists what is needed first, each brick after its own dependencies, never the brick itself", () => {
    expect(dependencyGraph(platform, "orders-web").order).toEqual(["postgres", "keycloak", "orders"]);
    expect(dependencyGraph(platform, "orders").order).toEqual(["postgres", "keycloak"]);
    expect(dependencyGraph(platform, "postgres").order).toEqual([]);
  });

  it("shows a brick with no dependency alone", () => {
    const g = dependencyGraph(platform, "postgres");
    expect(g.nodes.map((n) => n.name)).toEqual(["postgres"]);
    expect(g.edges).toEqual([]);
  });

  it("flags a needed brick that is not installed, with nothing behind it", () => {
    const bricks = [withDeps("orders-web", [dep("orders", "declared", "reads the orders", { installed: false, enabled: false })])];
    const g = dependencyGraph(bricks, "orders-web");
    expect(g.nodes.find((n) => n.name === "orders")).toMatchObject({
      installed: false,
      enabled: false,
      version: null,
      state: null,
      layer: 1,
    });
    expect(g.order).toEqual(["orders"]);
  });

  it("terminates on a cycle and keeps every arrow pointing right but the one that closes it", () => {
    const bricks = [withDeps("a", [dep("b", "declared", "")]), withDeps("b", [dep("a", "declared", "")])];
    const g = dependencyGraph(bricks, "a");
    expect(g.nodes.map((n) => [n.name, n.layer])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect(g.order).toEqual(["b"]);
    expect(g.edges).toHaveLength(2);
  });

  it("lists who needs a brick and why, both through a capability and through a declared link", () => {
    expect(requiredBy(platform, "orders")).toEqual([{ brick: "orders-web", kind: "declared", label: "reads the orders", optional: false }]);
    expect(requiredBy(platform, "postgres").map((r) => r.brick)).toEqual(["keycloak", "orders"]);
    expect(requiredBy(platform, "orders-web")).toEqual([]);
  });
});

describe("describeAuthorization", () => {
  it("says what an API asks of a token, and that an open one asks nothing more than a valid token", () => {
    const base = { queries: null, mutations: null, grants: [] };
    expect(describeAuthorization({ ...base, state: "none" })).toBe("—");
    expect(describeAuthorization({ ...base, state: "open" })).toBe("open: any valid token may call it");
    expect(describeAuthorization({ ...base, state: "roles", queries: "orders:read", mutations: "orders:write" })).toBe(
      "queries: orders:read; mutations: orders:write",
    );
    // A class left out stays at any valid token (D20).
    expect(describeAuthorization({ ...base, state: "roles", mutations: "orders:write" })).toBe(
      "queries: any valid token; mutations: orders:write",
    );
  });
});
