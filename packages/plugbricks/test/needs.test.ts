// What "add" proposes from bricks/ (D26), on hand-made bricks: the order, what is required and what is only declared,
// cycles, choices, and what makes it propose nothing. The CLI side (asking, --yes, refusals) is in the scenarios.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planNeeds } from "../src/needs.js";
import type { Project } from "../src/platform.js";

const nats = JSON.parse(readFileSync(new URL("../examples/nats/plugin.json", import.meta.url), "utf8"));

/** A valid brick built on examples/nats: it provides `provides` (nothing when empty) and needs what it is told. */
function brick(name: string, o: { provides?: string[]; requires?: string[]; optional?: string[]; dependencies?: string[] } = {}) {
  const m = structuredClone(nats);
  m.name = name;
  delete m.provides;
  if (o.provides?.length) m.provides = Object.fromEntries(o.provides.map((cap) => [cap, structuredClone(nats.provides.queue)]));
  const requires = {
    ...Object.fromEntries((o.requires ?? []).map((cap) => [cap, {}])),
    ...Object.fromEntries((o.optional ?? []).map((cap) => [cap, { optional: true }])),
  };
  if (Object.keys(requires).length) m.requires = requires;
  if (o.dependencies?.length) m.dependencies = o.dependencies.map((plugin) => ({ plugin }));
  return m;
}

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A project whose bricks/ holds `bricks`, with `capabilities` already installed (provider -> capabilities). */
function project(bricks: ReturnType<typeof brick>[], installed: Record<string, string[]> = {}): Project {
  root = mkdtempSync(join(tmpdir(), "pb-needs-"));
  for (const b of bricks) {
    mkdirSync(join(root, "bricks", b.name), { recursive: true });
    writeFileSync(join(root, "bricks", b.name, "plugin.json"), JSON.stringify(b));
  }
  const lock = {
    bricks: Object.fromEntries(Object.keys(installed).map((n) => [n, {}])),
    capabilities: Object.fromEntries(Object.entries(installed).flatMap(([n, caps]) => caps.map((c) => [c, n]))),
  };
  return { root, platform: { bricks: {} }, lock } as unknown as Project;
}

const names = (plan: ReturnType<typeof planNeeds>) => plan.add.map((p) => `${p.name}${p.required ? "!" : ""}`);

describe("planNeeds", () => {
  it("proposes the providers before their consumers, transitively; '!' marks what the brick cannot do without", () => {
    const p = project([brick("postgres", { provides: ["database"] }), brick("orders", { requires: ["database"] })]);
    const plan = planNeeds(p, brick("orders-web", { dependencies: ["orders"] }));
    expect(names(plan)).toEqual(["postgres", "orders"]);
    expect(plan).toMatchObject({ open: [], unmet: false });
    const strict = planNeeds(p, brick("api", { requires: ["database"] }));
    expect(names(strict)).toEqual(["postgres!"]);
  });

  it("never proposes what is installed, nor the consumers of the brick (never the other way round)", () => {
    const p = project([brick("postgres", { provides: ["database"] }), brick("orders-web", { dependencies: ["orders"] })], {
      postgres: ["database"],
    });
    expect(names(planNeeds(p, brick("orders", { requires: ["database"] })))).toEqual([]);
  });

  it("a brick reached first through a declared dependency is required once the brick asked for requires it", () => {
    // api requires cache (redis), then queue; redis declares worker; worker requires queue (nats). nats is planned on
    // the way through worker, which is only declared, then api itself requires queue: nats is required, worker is not.
    const p = project([
      brick("redis", { provides: ["cache"], dependencies: ["worker"] }),
      brick("worker", { requires: ["queue"] }),
      brick("nats", { provides: ["queue"] }),
    ]);
    expect(names(planNeeds(p, brick("api", { requires: ["cache", "queue"] })))).toEqual(["nats!", "worker", "redis!"]);
  });

  it("ends on a cycle of declared dependencies", () => {
    const p = project([brick("beta", { dependencies: ["alpha", "gamma"] }), brick("gamma", { dependencies: ["beta"] })]);
    expect(names(planNeeds(p, brick("alpha", { dependencies: ["beta"] })))).toEqual(["gamma", "beta"]);
  });

  it("leaves optional requirements and optional dependencies alone", () => {
    const p = project([brick("keycloak", { provides: ["oidc"] })]);
    const m = brick("web", { optional: ["oidc"] });
    m.dependencies = [{ plugin: "keycloak", optional: true }];
    expect(planNeeds(p, m)).toEqual({ add: [], open: [], unmet: false });
  });

  it("asks to choose between several providers, and leaves the choice open without an answer", () => {
    const p = project([brick("rabbitmq", { provides: ["queue"] }), brick("nats", { provides: ["queue"] })]);
    const consumer = brick("consumer", { requires: ["queue"] });
    expect(planNeeds(p, consumer).open).toEqual([{ capability: "queue", consumer: "consumer", candidates: ["nats", "rabbitmq"] }]);
    const asked: string[][] = [];
    const plan = planNeeds(p, consumer, (c) => (asked.push(c.candidates), "rabbitmq"));
    expect(asked).toEqual([["nats", "rabbitmq"]]);
    expect(names(plan)).toEqual(["rabbitmq!"]);
    expect(planNeeds(p, consumer, () => "kafka").open).toHaveLength(1);
  });

  it("is unmet when bricks/ cannot give a required capability, and skips invalid or misnamed bricks", () => {
    const p = project([brick("orders", { requires: ["database"] })]);
    expect(planNeeds(p, brick("orders-web", { dependencies: ["orders"] })).unmet).toBe(true);
    mkdirSync(join(root!, "bricks", "pg"), { recursive: true });
    writeFileSync(join(root!, "bricks", "pg", "plugin.json"), JSON.stringify(brick("postgres", { provides: ["database"] })));
    mkdirSync(join(root!, "bricks", "broken"), { recursive: true });
    writeFileSync(join(root!, "bricks", "broken", "plugin.json"), "{");
    expect(planNeeds(p, brick("api", { requires: ["database"] })).unmet).toBe(true);
  });
});
