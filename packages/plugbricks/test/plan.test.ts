import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderCompose } from "../src/drivers/compose.js";
import { CONFIGMAP_MAX_BYTES, renderK8s, renderK8sSecret } from "../src/drivers/k8s.js";
import { buildPlan, type BrickManifest } from "../src/plan.js";
import { PlugbricksError, type Lock, type LockedBrick } from "../src/platform.js";
import { ensureSecrets, isRestrictedToCurrentUser, randomSecret, readSecrets, WINDOWS_ACL_CHECK_SCRIPT } from "../src/secrets.js";
import { parseTemplate } from "../src/templates.js";
import { toYaml, toYamlDocuments } from "../src/yaml.js";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const work = join(pkg, ".test-work/plan");
const example = (name: string): BrickManifest => JSON.parse(readFileSync(join(pkg, "examples", name, "plugin.json"), "utf8"));

/** A lock as `add` would write it, for manifests given in memory. */
function lockFor(manifests: BrickManifest[], waits: Record<string, "healthy" | "started"> = {}): Lock {
  const capabilities: Record<string, string> = {};
  for (const m of manifests) for (const cap of Object.keys(m.provides ?? {})) capabilities[cap] = m.name;
  const bricks: Record<string, LockedBrick> = {};
  for (const m of manifests) {
    bricks[m.name] = {
      version: m.version,
      source: m.name,
      integrity: `sha256-${"0".repeat(64)}`,
      provides: Object.keys(m.provides ?? {}),
      requires: Object.fromEntries(
        Object.entries(m.requires ?? {}).map(([cap, r]) => [
          cap,
          {
            // An optional requirement records no provider (D19): the plan resolves it.
            ...(r.optional ? { optional: true as const } : { provider: capabilities[cap] }),
            wait: waits[m.name] ?? r.wait ?? "healthy",
            timeoutSeconds: r.timeoutSeconds ?? 120,
          },
        ]),
      ),
      volumes: m.services.flatMap((s) =>
        (s.volumes ?? []).map((v) => ({ service: s.name, name: v.name, retention: v.retention ?? "retain" })),
      ),
    };
  }
  return { lockfileVersion: 1, bricks, capabilities, retainedVolumes: [], pendingDeletion: [] };
}

const SCRIPT = { path: "create-database.sh", data: Buffer.from("#!/bin/sh\necho ok\n") };

function plan(
  manifests: BrickManifest[],
  opts: { waits?: Record<string, "healthy" | "started">; lock?: Partial<Lock>; scripts?: (typeof SCRIPT)[] } = {},
) {
  const lock = { ...lockFor(manifests, opts.waits), ...opts.lock };
  return buildPlan("demo", lock, new Map(manifests.map((m) => [m.name, m])), () => opts.scripts ?? [SCRIPT]);
}

const consumer = (name: string, extra: Partial<BrickManifest["services"][number]> = {}): BrickManifest => ({
  name,
  version: "1.0.0",
  services: [{ name: "api", image: `ghcr.io/example/${name}:1.0.0`, port: 8080, ...extra }],
  requires: { database: {} },
});

function codes(f: () => unknown): string[] {
  try {
    f();
  } catch (e) {
    if (e instanceof PlugbricksError) return e.issues.map((i) => i.code);
    throw e;
  }
  return [];
}

describe("templates", () => {
  it("splits text, variables and secrets", () => {
    expect(parseTemplate("a${provider.host}:${secrets.pw}!", "inject")).toEqual({
      segments: [{ text: "a" }, { var: "provider.host" }, { text: ":" }, { secret: "pw" }, { text: "!" }],
    });
  });
  it("leaves a lone $ and $NAME alone: only ${...} is a template", () => {
    expect(parseTemplate("costs $5 for $USER", "serviceEnv")).toEqual({ segments: [{ text: "costs $5 for $USER" }] });
  });
  it.each([
    ["${consumer.name}", "serviceEnv"],
    ["${secrets.pw}", "provisionCommand"],
    ["${secrets.pw}", "readyExec"],
    ["${secrets}", "inject"],
    ["${secrets.a__b}", "inject"],
    ["${secrets.Pw}", "inject"],
    ["${provider.hostname}", "inject"],
    ["${}", "inject"],
  ] as const)("refuses %s in %s", (value, context) => {
    expect(parseTemplate(value, context)).toEqual({ unknown: value });
  });
});

describe("yaml", () => {
  it("quotes only what YAML would read as something else", () => {
    expect(toYaml({ a: "plain", b: "yes", c: "5432", d: "-q", e: "a: b", f: "", g: "x:", h: "line\nbreak", i: 3, j: true })).toBe(
      'a: plain\nb: "yes"\nc: "5432"\nd: "-q"\ne: "a: b"\nf: ""\ng: "x:"\nh: "line\\nbreak"\ni: 3\nj: true\n',
    );
  });
  it("writes nested lists of maps, empty containers, and skips undefined keys", () => {
    expect(toYaml({ list: [{ name: "x", args: ["a", "b"] }, "s"], empty: [], none: {}, gone: undefined })).toBe(
      "list:\n  - name: x\n    args:\n      - a\n      - b\n  - s\nempty: []\nnone: {}\n",
    );
  });
  it("quotes a leading dot: .5, .inf and .nan are numbers in YAML", () => {
    expect(toYaml({ a: ".5", b: ".inf", c: "../x" })).toBe('a: ".5"\nb: ".inf"\nc: "../x"\n');
  });
  it("separates documents", () => {
    expect(toYamlDocuments([{ a: 1 }, { b: 2 }])).toBe("a: 1\n---\nb: 2\n");
  });
});

describe("secrets", () => {
  it("are 32 letters and digits, different every time", () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(randomSecret()).not.toBe(a);
  });

  it("rejects bytes above 247 so every character is equally likely", () => {
    let calls = 0;
    const bytes = (n: number) => {
      calls++;
      return Buffer.alloc(n, calls === 1 ? 255 : 61);
    };
    expect(randomSecret(bytes)).toBe("9".repeat(32));
    expect(calls).toBe(2);
  });

  it("are generated once, kept as they are, and written 0600 in a 0700 folder that ignores itself", () => {
    const root = join(work, "secrets");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    let n = 0;
    const random = () => `v${++n}`;
    const first = ensureSecrets(root, ["PB_B__X", "PB_A__X"], { random });
    expect(first.ok && first.result.created).toEqual(["PB_A__X", "PB_B__X"]);
    const second = ensureSecrets(root, ["PB_A__X", "PB_C__X"], { random });
    expect(second.ok && second.result.created).toEqual(["PB_C__X"]);
    expect(readFileSync(join(root, ".secrets/secrets.env"), "utf8")).toBe(
      "# Generated by plugbricks. Never commit or share this file.\nPB_A__X=v1\nPB_B__X=v2\nPB_C__X=v3\n",
    );
    expect(readFileSync(join(root, ".secrets/.gitignore"), "utf8")).toContain("\n*\n");
    if (process.platform !== "win32") {
      expect(statSync(join(root, ".secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, ".secrets/secrets.env")).mode & 0o777).toBe(0o600);
    }
  });

  it("refuse a file that is not KEY=value, naming the line", () => {
    const root = join(work, "secrets-bad");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, ".secrets"), { recursive: true });
    writeFileSync(join(root, ".secrets/secrets.env"), "# comment\n\nPB_A=ok\nPB_B=\n");
    const r = readSecrets(join(root, ".secrets/secrets.env"));
    expect(!r.ok && r.issue.code).toBe("SECRETS_FILE_INVALID");
    expect(!r.ok && r.issue.params.line).toBe("4");
  });

  it("check the Windows ACL without changing it (fake PowerShell, runs on every OS)", () => {
    const user = "S-1-5-21-1-2-3-1001";
    const calls: string[][] = [];
    const run = (rules: object[]) => (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: JSON.stringify({ user, protected: true, rules }), stderr: "" };
    };
    const full = (sid: string) => ({ sid, type: "Allow", inherited: false, rights: "FullControl" });
    expect(isRestrictedToCurrentUser("C:\\p\\.secrets", { platform: "win32", run: run([full(user)]) })).toEqual({ ok: true });
    expect(calls[0].at(-1)).toBe(WINDOWS_ACL_CHECK_SCRIPT);
    expect(WINDOWS_ACL_CHECK_SCRIPT).not.toMatch(/SetAccessControl|SetAccessRuleProtection|\b(Get|Set)-Acl\b/);
    expect(isRestrictedToCurrentUser("C:\\p\\.secrets", { platform: "win32", run: run([full(user), full("S-1-5-32-544")]) })).toEqual({
      ok: false,
      detail: "other accounts still have access: S-1-5-32-544",
    });
  });
});

describe("plan", () => {
  it("gives the provider one secret of its own and each consumer its own password", () => {
    const p = plan([example("postgres"), consumer("shop"), consumer("billing")]);
    expect(p.secrets).toEqual([
      { env: "PB_POSTGRES__BILLING__CONSUMER_PASSWORD", key: "postgres/billing/consumer_password" },
      { env: "PB_POSTGRES__SHOP__CONSUMER_PASSWORD", key: "postgres/shop/consumer_password" },
      { env: "PB_POSTGRES__SUPERUSER_PASSWORD", key: "postgres/superuser_password" },
    ]);
    const shop = p.services.find((s) => s.name === "shop-api")!;
    expect(shop.env.DATABASE_URL).toEqual([
      "postgres://shop:",
      { secret: "PB_POSTGRES__SHOP__CONSUMER_PASSWORD" },
      "@postgres-db:5432/shop",
    ]);
    const req = p.requirements.find((r) => r.consumer === "shop")!;
    expect(req.provision.env.PGPASSWORD).toEqual([{ secret: "PB_POSTGRES__SUPERUSER_PASSWORD" }]);
    expect(req.wait?.exec).toEqual(["pg_isready", "-q", "-h", "postgres-db", "-p", "5432", "-t", "2"]);
  });

  it("wait: started skips the wait step on both runtimes; the provision task still runs first", () => {
    const p = plan([example("postgres"), consumer("shop")], { waits: { shop: "started" } });
    expect(p.requirements[0].wait).toBeUndefined();
    const compose = Object.values(renderCompose(p))[0];
    expect(compose).not.toContain("shop-wait-database");
    expect(compose).toMatch(/shop-provision-database:[\s\S]*depends_on:\n\s+postgres-db:\n\s+condition: service_started/);
    const k8s = Object.values(renderK8s(p)).join("");
    expect(k8s).not.toContain("wait-database");
    expect(k8s).toContain("- name: provision-database");
  });

  it("a brick's own env wins over an injected variable of the same name", () => {
    const p = plan([example("postgres"), consumer("shop", { env: { DATABASE_URL: "postgres://elsewhere" } })]);
    expect(p.services.find((s) => s.name === "shop-api")!.env.DATABASE_URL).toEqual(["postgres://elsewhere"]);
  });

  it("doubles every literal $ for Compose and Kubernetes, never inside a secret reference", () => {
    const p = plan([example("postgres"), consumer("shop", { env: { PRICE: "$5 or $(x)" } })]);
    expect(renderCompose(p)[".generated/compose/compose.yaml"]).toContain('PRICE: "$$5 or $$(x)"');
    expect(renderK8s(p)[".generated/k8s/resources.yaml"]).toContain('value: "$$5 or $$(x)"');
    expect(renderK8s(p)[".generated/k8s/resources.yaml"]).toContain('value: "postgres://shop:$(PB_POSTGRES__SHOP__CONSUMER_PASSWORD)@');
  });

  it("adds a startupProbe only with a start period, counting it in the failure threshold", () => {
    const m = consumer("shop", { healthcheck: { exec: ["true"], intervalSeconds: 5, startPeriodSeconds: 12, retries: 3 } });
    const k8s = renderK8s(plan([example("postgres"), m]))[".generated/k8s/resources.yaml"];
    expect(k8s).toMatch(
      /startupProbe:\n\s+exec:\n\s+command:\n\s+- "true"\n\s+periodSeconds: 5\n\s+timeoutSeconds: 3\n\s+failureThreshold: 6/,
    );
    expect(renderCompose(plan([example("postgres"), m]))[".generated/compose/compose.yaml"]).toContain('start_period: "12s"');
  });

  it("puts binary provision files in binaryData and refuses scripts too large for a ConfigMap", () => {
    const bin = { path: "lib/tool.bin", data: Buffer.from([0, 1, 2, 255]) };
    const k8s = renderK8s(plan([example("postgres"), consumer("shop")], { scripts: [SCRIPT, bin] }))[".generated/k8s/resources.yaml"];
    expect(k8s).toContain('binaryData:\n  lib_tool.bin: "AAEC/w=="');
    expect(k8s).toContain("- key: lib_tool.bin\n                path: lib/tool.bin");
    const big = { path: "big.sql", data: Buffer.alloc(CONFIGMAP_MAX_BYTES, "a") };
    expect(codes(() => renderK8s(plan([example("postgres"), consumer("shop")], { scripts: [big] })))).toEqual([
      "PROVISION_SCRIPTS_TOO_LARGE",
    ]);
  });

  it("refuses two secret keys that map to the same variable", () => {
    // A brick name with "--" is legal: the own secret of "pg--a" and the password of consumer "a"
    // of provider "pg" would both be PB_PG__A__CONSUMER_PASSWORD.
    const pg = { ...example("postgres"), name: "pg" };
    const odd: BrickManifest = {
      name: "pg--a",
      version: "1.0.0",
      services: [{ name: "svc", image: "ghcr.io/example/odd:1.0.0", port: 1, env: { X: "${secrets.consumer_password}" } }],
    };
    expect(codes(() => plan([pg, { ...consumer("a") }, odd]))).toContain("RUNTIME_NAME_CONFLICT");
  });

  it("refuses names longer than Kubernetes accepts", () => {
    const long = consumer("a".repeat(40), { name: "s".repeat(30) });
    expect(codes(() => plan([example("postgres"), long]))).toContain("RUNTIME_NAME_INVALID");
  });

  it("renders the Secret with exactly the plan's secrets", () => {
    const p = plan([example("postgres"), consumer("shop")]);
    const values = new Map([
      ["PB_POSTGRES__SHOP__CONSUMER_PASSWORD", "c"],
      ["PB_POSTGRES__SUPERUSER_PASSWORD", "s"],
      ["PB_OLD__X", "kept on disk, not applied"],
    ]);
    const secret = renderK8sSecret(p, values);
    expect(secret).toContain("stringData:\n  PB_POSTGRES__SHOP__CONSUMER_PASSWORD: c\n  PB_POSTGRES__SUPERUSER_PASSWORD: s\n");
    expect(secret).not.toContain("PB_OLD__X");
  });
});

describe("authorization roles (D22)", () => {
  // A provider of oidc that says in its provision env what it is given, and in inject which client the token is for.
  const idp: BrickManifest = {
    name: "idp",
    version: "1.0.0",
    services: [{ name: "app", image: "ghcr.io/example/idp:1.0.0", port: 8080 }],
    provides: {
      oidc: {
        service: "app",
        ready: { exec: ["true", "${provider.host}"] },
        provision: {
          image: "ghcr.io/example/idp:1.0.0",
          command: ["/bin/sh", "/provision/x.sh"],
          scripts: "provision",
          env: { CLIENT_ID: "${consumer.name}", ROLES: "${consumer.roles}", GRANTS: "${consumer.grants}", SCOPES: "${consumer.scopes}" },
        },
        inject: { OIDC_CLIENT_ID: "${consumer.name}" },
      },
    },
  };
  const api = (name: string, authorization?: BrickManifest["authorization"]): BrickManifest => ({
    ...consumer(name),
    requires: { oidc: { optional: true } },
    subgraph: { service: "api", schema: "schema.graphql" },
    ...(authorization ? { authorization } : {}),
  });
  const caller = (dependencies: BrickManifest["dependencies"]): BrickManifest => ({
    ...consumer("web"),
    requires: { oidc: { optional: true } },
    dependencies,
  });
  const provisionEnv = (p: ReturnType<typeof plan>, brick: string) =>
    Object.fromEntries(
      Object.entries(p.requirements.find((r) => r.consumer === brick)!.provision.env).map(([k, v]) => [
        k,
        v.map((x) => (typeof x === "string" ? x : "<secret>")).join(""),
      ]),
    );
  const serviceEnv = (p: ReturnType<typeof plan>, name: string) =>
    Object.fromEntries(Object.entries(p.services.find((s) => s.name === name)!.env).map(([k, v]) => [k, v.join("")]));

  it("gives the API its roles, and its provision task the roles to create on its client", () => {
    const p = plan([idp, api("orders", { queries: "orders:read", mutations: "orders:write" })]);
    expect(serviceEnv(p, "orders-api")).toMatchObject({
      AUTHORIZATION_QUERIES_ROLE: "orders:read",
      AUTHORIZATION_MUTATIONS_ROLE: "orders:write",
      OIDC_CLIENT_ID: "orders",
    });
    expect(provisionEnv(p, "orders")).toEqual({ CLIENT_ID: "orders", ROLES: "orders:read orders:write", GRANTS: "", SCOPES: "" });
  });

  it("injects only the classes the block names, and nothing when it has no block (D20)", () => {
    const one = plan([idp, api("shipping", { queries: "shipping:read" })]);
    expect(Object.keys(serviceEnv(one, "shipping-api")).filter((k) => k.startsWith("AUTHORIZATION_"))).toEqual([
      "AUTHORIZATION_QUERIES_ROLE",
    ]);
    const none = plan([idp, api("orders")]);
    expect(Object.keys(serviceEnv(none, "orders-api")).filter((k) => k.startsWith("AUTHORIZATION_"))).toEqual([]);
    expect(provisionEnv(none, "orders")).toMatchObject({ ROLES: "", GRANTS: "" });
  });

  it("changes nothing without an oidc provider: no variable, no task", () => {
    const p = plan([api("orders", { queries: "orders:read", mutations: "orders:write" })]);
    expect(Object.keys(serviceEnv(p, "orders-api")).filter((k) => /^(AUTHORIZATION|OIDC)_/.test(k))).toEqual([]);
    expect(p.requirements).toEqual([]);
  });

  it("grants a consumer the roles of the classes it says it uses, queries by default", () => {
    const orders = api("orders", { queries: "orders:read", mutations: "orders:write" });
    const shipping = api("shipping", { queries: "shipping:read", mutations: "shipping:write" });
    const grants = (dependencies: BrickManifest["dependencies"]) =>
      provisionEnv(plan([idp, orders, shipping, caller(dependencies)]), "web").GRANTS;
    expect(grants([{ plugin: "orders" }])).toBe("orders/orders:read");
    expect(grants([{ plugin: "orders", operations: ["mutations"] }])).toBe("orders/orders:write");
    expect(grants([{ plugin: "shipping" }, { plugin: "orders", operations: ["queries", "mutations"] }])).toBe(
      "orders/orders:read orders/orders:write shipping/shipping:read",
    );
    expect(grants(undefined)).toBe("");
  });

  it("grants nothing for a dependency that is not installed, has no block, or has no oidc client", () => {
    const orders = api("orders", { queries: "orders:read" });
    const open = api("open");
    const noOidc: BrickManifest = { ...consumer("legacy"), requires: undefined, subgraph: { service: "api", schema: "schema.graphql" } };
    const grants = (...bricks: BrickManifest[]) =>
      provisionEnv(
        plan([idp, ...bricks, caller([{ plugin: "orders" }, { plugin: "open" }, { plugin: "legacy" }, { plugin: "gone" }])]),
        "web",
      ).GRANTS;
    expect(grants(orders, open, noOidc)).toBe("orders/orders:read");
    expect(grants(open, noOidc)).toBe("");
  });

  describe("the scopes of a dependency's protected fields (D44)", () => {
    const sdl = (field: string, ...scopes: string[]) =>
      'extend schema @link(url: "https://specs.apollo.dev/federation/v2.5", import: ["@requiresScopes"])\n' +
      `type Query { ${field}: Int @requiresScopes(scopes: ${JSON.stringify(scopes.map((s) => [s]))}) }`;
    const schemas: Record<string, string> = {
      catalog: sdl("price", "catalog:price", "catalog:cost"),
      billing: sdl("invoices", "billing:read"),
    };
    /** A plan with its router, whose reader gives each API's schema: where the scopes are read. */
    const planned = (...bricks: BrickManifest[]) => {
      const all = [idp, ...bricks];
      return buildPlan("demo", lockFor(all), new Map(all.map((m) => [m.name, m])), () => [SCRIPT], {
        port: 4000,
        readSchema: (brick) => schemas[brick],
      });
    };
    const webScopes = (...bricks: BrickManifest[]) => provisionEnv(planned(...bricks), "web").SCOPES;

    it("are given to the consumer's client, sorted, each once", () => {
      const web = caller([
        { plugin: "catalog", scopes: ["catalog:price", "catalog:cost"] },
        { plugin: "billing", scopes: ["billing:read"] },
      ]);
      expect(webScopes(api("catalog"), api("billing"), web)).toBe("billing:read catalog:cost catalog:price");
      expect(provisionEnv(planned(api("catalog"), api("billing"), web), "catalog").SCOPES).toBe("");
    });

    it("are only the ones asked for", () => {
      expect(webScopes(api("catalog"), caller([{ plugin: "catalog", scopes: ["catalog:price"] }]))).toBe("catalog:price");
      expect(webScopes(api("catalog"), caller([{ plugin: "catalog" }]))).toBe("");
    });

    it("are refused when no rule of that dependency asks for them: a dependency gives no other API's scope", () => {
      const web = caller([{ plugin: "catalog", scopes: ["billing:read"] }]);
      expect(codes(() => planned(api("catalog"), api("billing"), web))).toEqual(["DEPENDENCY_SCOPE_UNKNOWN"]);
      const plain: BrickManifest = { ...consumer("plain"), requires: { oidc: { optional: true } } };
      expect(codes(() => planned(plain, api("catalog"), caller([{ plugin: "plain", scopes: ["catalog:price"] }])))).toEqual([
        "DEPENDENCY_SCOPE_UNKNOWN",
      ]);
    });

    it("are not looked for while the dependency is not installed", () => {
      expect(webScopes(api("billing"), caller([{ plugin: "catalog", scopes: ["catalog:price"], optional: true }]))).toBe("");
    });
  });

  it("a brick that lists itself or a role twice gives each role once", () => {
    const both = api("orders", { queries: "orders:use", mutations: "orders:use" });
    expect(provisionEnv(plan([idp, both]), "orders").ROLES).toBe("orders:use");
    const web = caller([{ plugin: "orders", operations: ["queries", "mutations"] }]);
    expect(provisionEnv(plan([idp, both, web]), "web").GRANTS).toBe("orders/orders:use");
  });
});
