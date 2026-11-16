import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { issue, type Issue } from "./issues.js";
import { validateManifest } from "./manifest.js";
import { BRICKS_DIR, brickIntegrity, listBrickFiles, PlugbricksError, type Lock, type Project, type VolumeRef } from "./platform.js";
import { MANIFEST_DEFAULTS } from "./schemas.js";
import { parseTemplate, secretsIn, type Segment, type TemplateContext } from "./templates.js";

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
    volumes?: { name: string; mountPath: string; retention?: "retain" | "delete" }[];
    healthcheck?: Partial<Healthcheck> & { exec: string[] };
    env?: Record<string, string>;
  }[];
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
  env: Record<string, Value>;
  volumes: { volume: string; mountPath: string }[];
  healthcheck?: Healthcheck;
  /** Capabilities this service's brick requires, in name order; see Plan.requirements. */
  requires: string[];
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

export interface Plan {
  platform: string;
  services: PlanService[];
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

function resolveValue(
  value: string,
  context: TemplateContext,
  vars: { "provider.host"?: string; "provider.port"?: string; "consumer.name"?: string },
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
  return Object.fromEntries(Object.keys(r).sort().map((k) => [k, r[k]]));
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
): Plan {
  const names = new Names();
  const secrets = new Map<string, string>();
  const useSecret = (env: string, key: string) => {
    names.add("secret", env, key, `secret ${key}`, false);
    secrets.set(env, key);
    return env;
  };
  /** Secret names a brick's own services use: those stay the brick's, even inside provision and inject. */
  const brickSecrets = (m: BrickManifest) => new Set(m.services.flatMap((s) => Object.values(s.env ?? {}).flatMap((v) => secretsIn(v, "serviceEnv"))));

  const services: PlanService[] = [];
  const requirements: PlanRequirement[] = [];
  const scripts = new Map<string, PlanScripts>();
  const volumes: PlanVolume[] = [];

  for (const [brick, m] of [...manifests].sort(([a], [b]) => a.localeCompare(b))) {
    const own = (name: string) => useSecret(brickSecretEnv(brick, name), `${brick}/${name}`);
    const requires = Object.keys(m.requires ?? {}).sort();
    // Variables injected by every required capability; the brick's own env wins on a clash.
    const injected: Record<string, Value> = {};
    for (const cap of requires) {
      const locked = lock.bricks[brick].requires[cap];
      const provider = locked.provider;
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
      for (const [k, v] of Object.entries(p.inject)) injected[k] = resolveValue(v, "inject", vars, secret);
    }

    for (const s of m.services) {
      const name = serviceName(brick, s.name);
      names.add("service", name, `${brick}/${s.name}`, `service ${s.name} of ${brick}`);
      names.add(`container/${brick}`, s.name, `service/${s.name}`, `container of ${brick}`);
      const env: Record<string, Value> = { ...injected };
      for (const [k, v] of Object.entries(s.env ?? {})) env[k] = resolveValue(v, "serviceEnv", {}, own);
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
        env: sortedRecord(env),
        volumes: vols,
        ...(s.healthcheck ? { healthcheck: { ...MANIFEST_DEFAULTS.healthcheck, ...s.healthcheck } } : {}),
        requires,
      });
    }
  }
  // Volumes kept after a removal still own their name: a new brick must not attach them by accident.
  for (const v of [...lock.retainedVolumes, ...lock.pendingDeletion]) {
    names.add("volume", volumeName(v), `${v.brick}/${v.service}/${v.name}`, `kept volume ${v.name} of ${v.brick}/${v.service}`, false);
  }
  if (names.issues.length) throw new PlugbricksError(names.issues);

  return {
    platform,
    services: services.sort((a, b) => a.name.localeCompare(b.name)),
    requirements: requirements.sort((a, b) => a.consumer.localeCompare(b.consumer) || a.capability.localeCompare(b.capability)),
    scripts: [...scripts.values()].sort((a, b) => a.name.localeCompare(b.name)),
    volumes: volumes.sort((a, b) => a.name.localeCompare(b.name)),
    secrets: [...secrets].map(([env, key]) => ({ env, key })).sort((a, b) => a.env.localeCompare(b.env)),
  };
}

/** The plan of an initialised project, from its lock and installed copies. */
export function planProject(project: Project): Plan {
  const manifests = loadInstalledBricks(project);
  return buildPlan(project.platform.name, project.lock, manifests, (brick, dir) => {
    const base = join(project.root, BRICKS_DIR, brick, dir);
    return listBrickFiles(base, brick).map((path) => ({ path, data: readFileSync(join(base, path)) }));
  });
}
