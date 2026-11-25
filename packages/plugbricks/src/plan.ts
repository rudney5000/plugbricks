import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRouterConfigFile, type SubgraphInput } from "./federation.js";
import { ROUTER_IMAGE, ROUTER_NAME } from "./drivers/common.js";
import { issue, type Issue } from "./issues.js";
import { validateManifest } from "./manifest.js";
import {
  BRICKS_DIR,
  brickIntegrity,
  isBrickEnabled,
  listBrickFiles,
  PlugbricksError,
  type Lock,
  type Project,
  type VolumeRef,
} from "./platform.js";
import { MANIFEST_DEFAULTS, PLATFORM_DEFAULTS } from "./schemas.js";
import { parseTemplate, secretsIn, type Segment, type TemplateContext } from "./templates.js";
import { toYaml } from "./yaml.js";

/**
 * The plan: everything a driver needs, independent of the runtime. Built from platform.lock and
 * the installed copies in .platform/bricks/, never from the brick sources. Drivers are pure
 * functions plan -> files; only the secret values stay out of the plan (they are referenced by
 * their environment variable name).
 */

// ---------- manifest (as validated by the schema) ----------

export interface Healthcheck {
  exec: string[];
  intervalSeconds: number;
  timeoutSeconds: number;
  retries: number;
  startPeriodSeconds: number;
}

export interface BrickManifest {
  name: string;
  version: string;
  services: {
    name: string;
    image: string;
    port: number;
    /** Additional ports of the Service (Kubernetes), e.g. a management API (D12). */
    extraPorts?: { name: string; port: number }[];
    volumes?: { name: string; mountPath: string; retention?: "retain" | "delete" }[];
    healthcheck?: Partial<Healthcheck> & { exec: string[] };
    env?: Record<string, string>;
  }[];
  subgraph?: { service: string; schema: string; path?: string };
  /** The service that serves web pages (D17). */
  web?: { service: string; path?: string };
  /** On a web brick that provides oidc: what the router needs to check its tokens (D19). */
  oidc?: { issuerPath: string; jwksPath: string; audience: string };
  extends?: { plugin: string; entities: string[] }[];
  /** Plugins this one needs besides its capabilities (the admin shows them; `remove` refuses their target). */
  dependencies?: { plugin: string; description?: string; operations?: ("queries" | "mutations")[] }[];
  /** The client roles that the tokens of the oidc provider need for this API (D22). */
  authorization?: { queries?: string; mutations?: string };
  provides?: Record<
    string,
    {
      service: string;
      ready: { exec: string[]; image?: string; intervalSeconds?: number };
      provision: { image: string; command: string[]; scripts?: string; env?: Record<string, string> };
      inject: Record<string, string>;
    }
  >;
  requires?: Record<string, { wait?: "healthy" | "started"; timeoutSeconds?: number }>;
}

// ---------- plan ----------

/** A value: literal text and secret references (by environment variable name), in order. */
export type Part = string | { secret: string };
export type Value = Part[];

export interface PlanService {
  /** Runtime name, `<brick>-<service>`: Compose service, Kubernetes Deployment and Service, DNS name. */
  name: string;
  brick: string;
  service: string;
  image: string;
  port: number;
  /** Extra ports of the runtime Service, beyond the primary one (D12). */
  extraPorts: { name: string; port: number }[];
  env: Record<string, Value>;
  volumes: { volume: string; mountPath: string }[];
  healthcheck?: Healthcheck;
  /** Capabilities this service's brick requires, in name order; see Plan.requirements. */
  requires: string[];
  /**
   * Present on the service that serves a web brick's pages (D17): `port` is its webPort, published on
   * 127.0.0.1 by Compose (and the local port of a kubectl port-forward on Kubernetes); `path` its entry page.
   */
  web?: { port: number; path: string };
}

export interface PlanRequirement {
  consumer: string;
  capability: string;
  provider: string;
  /** Runtime name of the provider service. */
  providerService: string;
  /** Present when the consumer waits until the capability is ready (wait: healthy). */
  wait?: { name: string; image: string; exec: string[]; intervalSeconds: number; timeoutSeconds: number };
  provision: { name: string; image: string; command: string[]; env: Record<string, Value>; scripts?: string };
}

export interface PlanScripts {
  /** Kubernetes ConfigMap name. */
  name: string;
  brick: string;
  capability: string;
  /** Folder of the installed copy, relative to the platform root, with "/". */
  hostPath: string;
  files: { path: string; data: Buffer }[];
}

export interface PlanVolume {
  /** Runtime name, `<brick>-<service>-<volume>`. */
  name: string;
  brick: string;
  service: string;
  volume: string;
  retention: "retain" | "delete";
}

export interface PlanSecret {
  /** Environment variable that carries the secret: PB_<BRICK>__<NAME> or PB_<PROVIDER>__<CONSUMER>__<NAME>. */
  env: string;
  /** What it is, for messages: "postgres/superuser_password" or "postgres/orders/consumer_password". */
  key: string;
}

/** The Cosmo router, present only when at least one installed brick serves a subgraph. */
export interface PlanRouter {
  /** Runtime name: "router". */
  name: string;
  /** The pinned image, tag and digest. */
  image: string;
  /** Port published on 127.0.0.1 by Compose, and the port of the Kubernetes Service (platform.json router.port). */
  port: number;
  /** Text of router-config.json. */
  config: string;
  /** sha256 of `config`: put on the container (Compose label) and on the pod (Kubernetes annotation) so that a changed configuration recreates it; the router reads its configuration once, at start. */
  configSha256: string;
  /** The subgraph services the router calls; it starts after them. */
  subgraphs: { service: string; brick: string; healthy: boolean }[];
  /**
   * Origins a browser may call the router from (its CORS_ALLOW_ORIGINS, D17). Any other Origin is
   * refused with 403 and its request is not run; requests without an Origin header are not affected.
   * With no web brick, only the router's own origin, which no other page has.
   */
  allowedOrigins: string[];
  /**
   * Present when an enabled brick provides oidc (D19): the router then requires a token from that issuer, for that
   * audience, checked with the provider's keys, and starts only once the provider is ready.
   */
  auth?: PlanRouterAuth;
}

/**
 * WEB_PORT_MISSING, saying what needs the brick's web origin. `add` gives a webPort only to a brick that declares
 * `web`; for any other brick, adding it again cannot help, so the only fix offered is the field in platform.json.
 */
function webPortMissing(brick: string, m: BrickManifest | undefined, use: string): Issue {
  const field = `bricks.${brick}.webPort`;
  return issue("WEB_PORT_MISSING", `platform.json#/bricks/${brick}`, {
    brick,
    use,
    fix: m?.web ? `add it again (add gives a web brick a webPort), or set ${field} in platform.json` : `set ${field} in platform.json`,
  });
}

/** The token check of the router (D19), and how it waits for its provider. */
export interface PlanRouterAuth {
  provider: string;
  /** Runtime name of the provider's service, which the router waits for. */
  service: string;
  /** The provider's service has a healthcheck: Compose can wait until it is healthy. */
  healthy: boolean;
  /** The provider's web origin plus its issuerPath: the issuer its tokens carry (D18). */
  issuer: string;
  /** The keys, fetched inside the platform: the provider's service plus its jwksPath. */
  jwksUrl: string;
  audience: string;
  /** Text of router.yaml, the router configuration file named by CONFIG_PATH. */
  yaml: string;
  /** sha256 of `yaml`: on the container and the pod, so that a change recreates the router. */
  yamlSha256: string;
  /** The provider's ready command, run before the router on Kubernetes (the router cannot start without the keys). */
  wait: { image: string; exec: string[]; intervalSeconds: number; timeoutSeconds: number };
}

export interface Plan {
  platform: string;
  services: PlanService[];
  router?: PlanRouter;
  requirements: PlanRequirement[];
  scripts: PlanScripts[];
  volumes: PlanVolume[];
  secrets: PlanSecret[];
}

// ---------- names ----------

/** DNS-1035 label: what Kubernetes accepts for a Service name, and safe everywhere else. */
const LABEL = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LABEL = 63;

export const serviceName = (brick: string, service: string) => `${brick}-${service}`;
export const volumeName = (r: VolumeRef) => `${r.brick}-${r.service}-${r.name}`;
export const waitName = (consumer: string, capability: string) => `${consumer}-wait-${capability}`;
export const provisionName = (consumer: string, capability: string) => `${consumer}-provision-${capability}`;
export const scriptsName = (provider: string, capability: string) => `${provider}-${capability}-scripts`;
/** Names of the init containers inside a consumer pod (Kubernetes). */
export const initContainerName = (kind: "wait" | "provision", capability: string) => `${kind}-${capability}`;

const envPart = (s: string) => s.toUpperCase().replace(/-/g, "_");
export const brickSecretEnv = (brick: string, name: string) => `PB_${envPart(brick)}__${envPart(name)}`;
export const consumerSecretEnv = (provider: string, consumer: string, name: string) =>
  `PB_${envPart(provider)}__${envPart(consumer)}__${envPart(name)}`;

/**
 * Collects runtime names and reports two different things sharing one name: two services, a
 * service and a task, two volumes (including the volumes kept after a removal, which a new brick
 * must never attach by accident), two secrets, two ConfigMaps.
 */
class Names {
  private seen = new Map<string, Map<string, { owner: string; what: string }>>();
  issues: Issue[] = [];
  add(space: string, name: string, owner: string, what: string, label = true): void {
    if (label) {
      const detail = !LABEL.test(name)
        ? "only lowercase letters, digits and dashes, starting with a letter and not ending with a dash"
        : name.length > MAX_LABEL
          ? `it is ${name.length} characters long; the limit is ${MAX_LABEL}`
          : undefined;
      if (detail) this.issues.push(issue("RUNTIME_NAME_INVALID", "", { name, what, detail }));
    }
    const s = this.seen.get(space) ?? new Map<string, { owner: string; what: string }>();
    this.seen.set(space, s);
    const first = s.get(name);
    if (first !== undefined && first.owner !== owner) {
      this.issues.push(issue("RUNTIME_NAME_CONFLICT", "", { name, first: first.what, second: what }));
    } else s.set(name, { owner, what });
  }
}

// ---------- loading the installed bricks ----------

/** Reads every installed copy, checks it against the lock, and validates its manifest. */
export function loadInstalledBricks(project: Project): Map<string, BrickManifest> {
  const out = new Map<string, BrickManifest>();
  const problems: Issue[] = [];
  for (const name of Object.keys(project.lock.bricks).sort()) {
    const dir = join(project.root, BRICKS_DIR, name);
    const file = join(dir, "plugin.json");
    if (!existsSync(file)) {
      problems.push(issue("BRICK_MISSING", "", { brick: name }));
      continue;
    }
    try {
      if (brickIntegrity(dir, name) !== project.lock.bricks[name].integrity) {
        problems.push(issue("BRICK_MODIFIED", "", { brick: name }));
        continue;
      }
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const v = validateManifest(raw);
      const shown = `${BRICKS_DIR}/${name}/plugin.json`;
      if (!v.ok) {
        problems.push(issue("MANIFEST_INVALID", "", { path: shown }), ...v.issues.map((i) => ({ ...i, path: `${shown}#${i.path}` })));
        continue;
      }
      out.set(name, raw as BrickManifest);
    } catch (e) {
      if (e instanceof PlugbricksError) problems.push(...e.issues);
      else problems.push(issue("BRICK_UNREADABLE", "", { brick: name, detail: (e as Error).message }));
    }
  }
  if (problems.length) throw new PlugbricksError(problems);
  return out;
}

// ---------- building the plan ----------

/** The template context of a service's env: a web brick's own service may also use ${web.origin} (D18). */
function envContext(m: BrickManifest, service: string): TemplateContext {
  return m.web?.service === service ? "webServiceEnv" : "serviceEnv";
}

function resolveValue(
  value: string,
  context: TemplateContext,
  vars: {
    "provider.host"?: string;
    "provider.port"?: string;
    "provider.web.origin"?: string;
    "consumer.name"?: string;
    "web.origin"?: string;
  },
  secret: (name: string) => string,
): Value {
  const r = parseTemplate(value, context);
  // validateManifest already refused unknown templates; this only guards against a bypass.
  if ("unknown" in r) throw new Error(`unexpected template ${r.unknown} in ${context}`);
  const out: Value = [];
  const push = (p: Part) => {
    const last = out[out.length - 1];
    if (typeof p === "string" && typeof last === "string") out[out.length - 1] = last + p;
    else if (p !== "") out.push(p);
  };
  for (const s of r.segments as Segment[]) {
    if ("text" in s) push(s.text);
    else if ("var" in s) push(vars[s.var]!);
    else push({ secret: secret(s.secret) });
  }
  return out;
}

/** Text of a value that holds no secret (commands, ready probes). */
function textOf(v: Value): string {
  return v.map((p) => (typeof p === "string" ? p : "")).join("");
}

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, r[k]]),
  );
}

/**
 * Builds the plan. `readScripts` returns the files of a provision scripts folder of an installed
 * copy; it is injectable so the plan can be built from manifests in memory.
 */
export function buildPlan(
  platform: string,
  lock: Lock,
  manifests: Map<string, BrickManifest>,
  readScripts: (brick: string, dir: string) => { path: string; data: Buffer }[],
  /** With it, a platform that has a subgraph also gets its router: the port to publish, and a reader for each brick's SDL. */
  router?: { port: number; readSchema: (brick: string, file: string) => string },
  /** Volumes of disabled bricks: their names stay theirs even though they are not rendered. */
  reservedVolumes: VolumeRef[] = [],
  /** webPort of each web brick, from platform.json (D17); a web brick without one is not published. */
  webPorts: Record<string, number> = {},
): Plan {
  const names = new Names();
  const secrets = new Map<string, string>();
  const useSecret = (env: string, key: string) => {
    names.add("secret", env, key, `secret ${key}`, false);
    secrets.set(env, key);
    return env;
  };
  /** Secret names a brick's own services use: those stay the brick's, even inside provision and inject. */
  const brickSecrets = (m: BrickManifest) =>
    new Set(m.services.flatMap((s) => Object.values(s.env ?? {}).flatMap((v) => secretsIn(v, envContext(m, s.name)))));

  const services: PlanService[] = [];
  const requirements: PlanRequirement[] = [];
  const scripts = new Map<string, PlanScripts>();
  const volumes: PlanVolume[] = [];

  for (const [brick, m] of [...manifests].sort(([a], [b]) => a.localeCompare(b))) {
    const own = (name: string) => useSecret(brickSecretEnv(brick, name), `${brick}/${name}`);
    // The provider of each requirement. An optional one (D19) records none: it is wired to the brick that
    // provides the capability now, when that brick is in the plan (installed and enabled), and left out otherwise.
    const providers = new Map<string, string>();
    for (const cap of Object.keys(m.requires ?? {}).sort()) {
      const locked = lock.bricks[brick].requires[cap];
      const provider = locked.provider ?? (Object.hasOwn(lock.capabilities, cap) ? lock.capabilities[cap] : undefined);
      if (locked.optional && (provider === undefined || !manifests.has(provider))) continue;
      providers.set(cap, provider!);
    }
    const requires = [...providers.keys()];
    // Variables injected by every required capability; the brick's own env wins on a clash.
    const injected: Record<string, Value> = {};
    for (const cap of requires) {
      const locked = lock.bricks[brick].requires[cap];
      const provider = providers.get(cap)!;
      const pm = manifests.get(provider)!;
      const p = pm.provides![cap];
      const providerSvc = pm.services.find((s) => s.name === p.service)!;
      const vars = {
        "provider.host": serviceName(provider, p.service),
        "provider.port": String(providerSvc.port),
        "consumer.name": brick,
      };
      const providerOwn = brickSecrets(pm);
      const secret = (name: string) =>
        providerOwn.has(name)
          ? useSecret(brickSecretEnv(provider, name), `${provider}/${name}`)
          : useSecret(consumerSecretEnv(provider, brick, name), `${provider}/${brick}/${name}`);

      let scriptsKey: string | undefined;
      if (p.provision.scripts !== undefined) {
        scriptsKey = scriptsName(provider, cap);
        if (!scripts.has(scriptsKey)) {
          names.add("configmap", scriptsKey, `${provider}/provides/${cap}`, `provision scripts of ${provider} for ${cap}`);
          scripts.set(scriptsKey, {
            name: scriptsKey,
            brick: provider,
            capability: cap,
            hostPath: `${BRICKS_DIR}/${provider}/${p.provision.scripts}`,
            files: readScripts(provider, p.provision.scripts),
          });
        }
      }

      const wait =
        locked.wait === "healthy"
          ? {
              name: waitName(brick, cap),
              image: p.ready.image ?? providerSvc.image,
              exec: p.ready.exec.map((a) => textOf(resolveValue(a, "readyExec", vars, secret))),
              intervalSeconds: p.ready.intervalSeconds ?? MANIFEST_DEFAULTS.readyIntervalSeconds,
              timeoutSeconds: locked.timeoutSeconds,
            }
          : undefined;
      if (wait) {
        names.add("service", wait.name, `${brick}/requires/${cap}`, `wait task of ${brick} for ${cap}`);
        names.add(`container/${brick}`, initContainerName("wait", cap), `wait/${cap}`, `init container of ${brick}`);
      }
      const provision = {
        name: provisionName(brick, cap),
        image: p.provision.image,
        command: p.provision.command.map((a) => textOf(resolveValue(a, "provisionCommand", vars, secret))),
        env: sortedRecord(
          Object.fromEntries(Object.entries(p.provision.env ?? {}).map(([k, v]) => [k, resolveValue(v, "provisionEnv", vars, secret)])),
        ),
        ...(scriptsKey ? { scripts: scriptsKey } : {}),
      };
      names.add("service", provision.name, `${brick}/requires/${cap}`, `provision task of ${brick} for ${cap}`);
      names.add(`container/${brick}`, initContainerName("provision", cap), `provision/${cap}`, `init container of ${brick}`);
      requirements.push({ consumer: brick, capability: cap, provider, providerService: vars["provider.host"], wait, provision });
      // The provider's web origin (D20), for what a consumer must compare with what the browser sees, e.g. an issuer.
      const providerOrigin = webPorts[provider] !== undefined ? `http://127.0.0.1:${webPorts[provider]}` : undefined;
      for (const [k, v] of Object.entries(p.inject)) {
        if (providerOrigin === undefined && v.includes("${provider.web.origin}")) {
          throw new PlugbricksError([
            webPortMissing(provider, manifests.get(provider), `"${brick}" is given \${provider.web.origin} (${k})`),
          ]);
        }
        injected[k] = resolveValue(v, "inject", { ...vars, "provider.web.origin": providerOrigin }, secret);
      }
    }

    for (const s of m.services) {
      const name = serviceName(brick, s.name);
      names.add("service", name, `${brick}/${s.name}`, `service ${s.name} of ${brick}`);
      names.add(`container/${brick}`, s.name, `service/${s.name}`, `container of ${brick}`);
      const env: Record<string, Value> = { ...injected };
      // The address the browser uses for a web brick (D18): known only once the platform gave it a webPort.
      const webOrigin = m.web?.service === s.name && webPorts[brick] !== undefined ? `http://127.0.0.1:${webPorts[brick]}` : undefined;
      for (const [k, v] of Object.entries(s.env ?? {})) {
        const context = envContext(m, s.name);
        if (context === "webServiceEnv" && webOrigin === undefined && v.includes("${web.origin}")) {
          throw new PlugbricksError([webPortMissing(brick, m, `its service "${s.name}" uses \${web.origin} (${k})`)]);
        }
        env[k] = resolveValue(v, context, { "web.origin": webOrigin }, own);
      }
      const vols = (s.volumes ?? []).map((v) => {
        const ref = { brick, service: s.name, name: v.name };
        const vname = volumeName(ref);
        names.add("volume", vname, `${brick}/${s.name}/${v.name}`, `volume ${v.name} of ${brick}/${s.name}`);
        volumes.push({ name: vname, brick, service: s.name, volume: v.name, retention: v.retention ?? MANIFEST_DEFAULTS.retention });
        return { volume: vname, mountPath: v.mountPath };
      });
      services.push({
        name,
        brick,
        service: s.name,
        image: s.image,
        port: s.port,
        extraPorts: (s.extraPorts ?? []).map((p) => ({ name: p.name, port: p.port })),
        env: sortedRecord(env),
        volumes: vols,
        ...(s.healthcheck ? { healthcheck: { ...MANIFEST_DEFAULTS.healthcheck, ...s.healthcheck } } : {}),
        requires,
        ...(m.web?.service === s.name && webPorts[brick] !== undefined
          ? { web: { port: webPorts[brick], path: m.web.path ?? MANIFEST_DEFAULTS.webPath } }
          : {}),
      });
    }
  }
  // Volumes kept after a removal still own their name: a new brick must not attach them by accident.
  for (const v of [...lock.retainedVolumes, ...lock.pendingDeletion]) {
    names.add("volume", volumeName(v), `${v.brick}/${v.service}/${v.name}`, `kept volume ${v.name} of ${v.brick}/${v.service}`, false);
  }
  for (const v of reservedVolumes) {
    names.add("volume", volumeName(v), `${v.brick}/${v.service}/${v.name}`, `volume of disabled ${v.brick}`, false);
  }
  const planRouter = router ? buildRouter(manifests, services, router, names, webPorts) : undefined;
  if (names.issues.length) throw new PlugbricksError(names.issues);

  return {
    platform,
    services: services.sort((a, b) => a.name.localeCompare(b.name)),
    ...(planRouter ? { router: planRouter } : {}),
    requirements: requirements.sort((a, b) => a.consumer.localeCompare(b.consumer) || a.capability.localeCompare(b.capability)),
    scripts: [...scripts.values()].sort((a, b) => a.name.localeCompare(b.name)),
    volumes: volumes.sort((a, b) => a.name.localeCompare(b.name)),
    secrets: [...secrets].map(([env, key]) => ({ env, key })).sort((a, b) => a.env.localeCompare(b.env)),
  };
}

/** The router of a platform: its configuration from the subgraphs of the installed bricks, and the services it waits for. */
function buildRouter(
  manifests: Map<string, BrickManifest>,
  services: PlanService[],
  router: { port: number; readSchema: (brick: string, file: string) => string },
  names: Names,
  webPorts: Record<string, number>,
): PlanRouter | undefined {
  const inputs: SubgraphInput[] = [];
  const subgraphs: PlanRouter["subgraphs"] = [];
  for (const [brick, m] of manifests) {
    if (!m.subgraph) continue;
    const service = services.find((s) => s.brick === brick && s.service === m.subgraph!.service)!;
    inputs.push({
      brick,
      file: `${BRICKS_DIR}/${brick}/${m.subgraph.schema}`,
      sdl: router.readSchema(brick, m.subgraph.schema),
      url: `http://${service.name}:${service.port}${m.subgraph.path ?? "/graphql"}`,
      extends: m.extends ?? [],
    });
    subgraphs.push({ service: service.name, brick, healthy: service.healthcheck !== undefined });
  }
  if (inputs.length === 0) return undefined;
  names.add("service", ROUTER_NAME, "router", "the router");
  names.add("configmap", `${ROUTER_NAME}-config`, "router", "the router configuration");
  const built = buildRouterConfigFile(inputs);
  if (!built.ok) throw new PlugbricksError(built.issues);
  const auth = routerAuth(manifests, services, webPorts);
  return {
    name: ROUTER_NAME,
    image: ROUTER_IMAGE,
    port: router.port,
    config: built.json,
    configSha256: createHash("sha256").update(built.json).digest("hex"),
    subgraphs: subgraphs.sort((a, b) => a.service.localeCompare(b.service)),
    allowedOrigins: allowedOrigins(router.port, services),
    ...(auth ? { auth } : {}),
  };
}

/** The issuer of an oidc provider's tokens: its web origin, which the browser and the tokens use (D18), plus its issuerPath. */
const oidcIssuer = (webPort: number, issuerPath: string) => `http://127.0.0.1:${webPort}${issuerPath}`;

/**
 * The issuer of the platform's own oidc provider (D19, point 7): an enabled brick that provides oidc and describes it,
 * with its webPort. The admin uses it when --issuer is not given. Undefined when there is none.
 */
export function platformOidcIssuer(project: Project): { brick: string; issuer: string } | undefined {
  for (const [brick, m] of loadInstalledBricks(project)) {
    if (!isBrickEnabled(project.platform, brick) || !m.oidc || !m.provides?.oidc) continue;
    const webPort = Object.hasOwn(project.platform.bricks, brick) ? project.platform.bricks[brick].webPort : undefined;
    if (webPort !== undefined) return { brick, issuer: oidcIssuer(webPort, m.oidc.issuerPath) };
  }
  return undefined;
}

/** How long the router waits for its oidc provider on Kubernetes: a first start of Keycloak took about 2 minutes (D18). */
export const ROUTER_OIDC_WAIT_SECONDS = 300;

/** The router's token check (D19), from the enabled brick that provides oidc and describes it; none without one. */
function routerAuth(
  manifests: Map<string, BrickManifest>,
  services: PlanService[],
  webPorts: Record<string, number>,
): PlanRouterAuth | undefined {
  const found = [...manifests].find(([, m]) => m.oidc !== undefined && m.provides?.oidc !== undefined);
  if (!found) return undefined;
  const [provider, m] = found;
  if (webPorts[provider] === undefined) {
    throw new PlugbricksError([webPortMissing(provider, m, "the router checks the tokens of its issuer, which is its web origin (D19)")]);
  }
  const p = m.provides!.oidc;
  const svc = services.find((s) => s.brick === provider && s.service === p.service)!;
  const vars = { "provider.host": svc.name, "provider.port": String(svc.port) };
  const issuer = oidcIssuer(webPorts[provider], m.oidc!.issuerPath);
  const jwksUrl = `http://${svc.name}:${svc.port}${m.oidc!.jwksPath}`;
  const yaml = toYaml({
    version: "1",
    authentication: { jwt: { jwks: [{ url: jwksUrl, issuers: [issuer], audiences: [m.oidc!.audience], algorithms: ["RS256"] }] } },
    authorization: { require_authentication: true },
    // The token goes on to every subgraph, which checks it itself (D20): by default the router passes nothing on.
    headers: { all: { request: [{ op: "propagate", named: "Authorization" }] } },
  });
  return {
    provider,
    service: svc.name,
    healthy: svc.healthcheck !== undefined,
    issuer,
    jwksUrl,
    audience: m.oidc!.audience,
    yaml,
    yamlSha256: createHash("sha256").update(yaml).digest("hex"),
    wait: {
      image: p.ready.image ?? svc.image,
      exec: p.ready.exec.map((a) => textOf(resolveValue(a, "readyExec", vars, () => ""))),
      intervalSeconds: p.ready.intervalSeconds ?? MANIFEST_DEFAULTS.readyIntervalSeconds,
      timeoutSeconds: ROUTER_OIDC_WAIT_SECONDS,
    },
  };
}

/**
 * The origins a browser may call the router from (D17): each published web page, by the two names of the
 * loopback address; with none, only the router's own origin, which no other page has.
 */
function allowedOrigins(routerPort: number, services: PlanService[]): string[] {
  const pages = services
    .flatMap((s) => (s.web ? [s.web.port] : []))
    .sort((a, b) => a - b)
    .flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return pages.length ? pages : [`http://127.0.0.1:${routerPort}`];
}

/** The plan of an initialised project, from its lock and installed copies. */
export function planProject(project: Project): Plan {
  const installed = loadInstalledBricks(project);
  // A disabled brick is installed but not rendered; its volumes keep their names for when it returns.
  const manifests = new Map([...installed].filter(([brick]) => isBrickEnabled(project.platform, brick)));
  const reservedVolumes = Object.entries(project.lock.bricks)
    .filter(([brick]) => !isBrickEnabled(project.platform, brick))
    .flatMap(([brick, locked]) => locked.volumes.map((v) => ({ brick, service: v.service, name: v.name })));
  return buildPlan(
    project.platform.name,
    project.lock,
    manifests,
    (brick, dir) => {
      const base = join(project.root, BRICKS_DIR, brick, dir);
      return listBrickFiles(base, brick).map((path) => ({ path, data: readFileSync(join(base, path)) }));
    },
    {
      port: project.platform.router?.port ?? PLATFORM_DEFAULTS.routerPort,
      readSchema: (brick, file) => readFileSync(join(project.root, BRICKS_DIR, brick, file), "utf8"),
    },
    reservedVolumes,
    Object.fromEntries(
      Object.entries(project.platform.bricks).flatMap(([brick, b]) => (b.webPort !== undefined ? [[brick, b.webPort]] : [])),
    ),
  );
}
