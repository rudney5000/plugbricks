import { checkImagePin } from "./image.js";
import { issue, type Issue } from "./issues.js";
import { MANIFEST_SCHEMA_ID, manifestSchema, schemaIssues } from "./schemas.js";
import { allowedList, parseTemplate, type TemplateContext } from "./templates.js";

/** Variables plugbricks sets on the service of a web brick when the platform has a router (D17). */
export const WEB_ENV = ["GRAPHQL_URL", "PUBLIC_GRAPHQL_URL"] as const;

export { MANIFEST_SCHEMA_ID };

/** Kept for compatibility: a manifest issue is a plain Issue whose path is a JSON Pointer. */
export type ManifestIssue = Issue;

export type ValidationResult = { ok: true } | { ok: false; issues: ManifestIssue[] };

function checkImage(image: string, path: string, issues: ManifestIssue[]): void {
  const r = checkImagePin(image);
  if (r.ok) return;
  if (r.code === "IMAGE_INVALID") issues.push(issue(r.code, path, { image, reason: r.reason }));
  else if (r.code === "IMAGE_FLOATING_TAG") issues.push(issue(r.code, path, { image, tag: r.tag }));
  else issues.push(issue(r.code, path, { image }));
}

function checkTemplate(value: string, path: string, context: TemplateContext, issues: ManifestIssue[]): void {
  const r = parseTemplate(value, context);
  if ("unknown" in r) issues.push(issue("TEMPLATE_UNKNOWN", path, { template: r.unknown, allowed: allowedList(context) }));
}

function checkTemplates(
  values: Record<string, string> | string[] | undefined,
  path: string,
  context: TemplateContext,
  issues: ManifestIssue[],
): void {
  for (const [k, v] of Object.entries(values ?? {})) checkTemplate(v, `${path}/${k}`, context, issues);
}

/** The hosts that name the machine itself: inside the router's container, its own container (D33). */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)$/i;

/**
 * A subgraph is served by one of the brick's services, or by a service that runs elsewhere (D33). An external brick
 * has no services, and nothing a service would need: it provides and requires nothing, publishes no page, and its
 * roles are the service's own business.
 */
function checkSubgraph(
  m: {
    services: unknown[];
    subgraph?: { service?: string; url?: string; path?: string; forwardAuthorization?: boolean; grpc?: { proto: string; mapping: string } };
    provides?: unknown;
    requires?: unknown;
    web?: unknown;
    authorization?: unknown;
  },
  names: Set<string>,
  issues: ManifestIssue[],
): void {
  const g = m.subgraph;
  if (!g) {
    if (m.services.length === 0) issues.push(issue("SERVICES_EMPTY", "/services", {}));
    return;
  }
  if ((g.service === undefined) === (g.url === undefined)) {
    issues.push(issue("SUBGRAPH_SERVICE_OR_URL", "/subgraph", {}));
    return;
  }
  if (g.grpc !== undefined) {
    // A gRPC service of the brick (D35): it has no path, and an external one is not supported.
    if (g.service === undefined) issues.push(issue("GRPC_NEEDS_SERVICE", "/subgraph/grpc", {}));
    if (g.path !== undefined) issues.push(issue("GRPC_SUBGRAPH_PATH", "/subgraph/path", {}));
  }
  if (g.service !== undefined) {
    if (!names.has(g.service)) issues.push(issue("UNKNOWN_SERVICE", "/subgraph/service", { name: g.service }));
    if (g.forwardAuthorization !== undefined)
      issues.push(issue("EXTERNAL_ONLY", "/subgraph/forwardAuthorization", { field: "forwardAuthorization" }));
    return;
  }
  // External (D33).
  if (g.path !== undefined) issues.push(issue("EXTERNAL_SUBGRAPH_PATH", "/subgraph/path", {}));
  if (m.services.length) issues.push(issue("EXTERNAL_WITH_SERVICES", "/services", {}));
  for (const field of ["provides", "requires", "web", "authorization"] as const) {
    if (m[field] !== undefined) issues.push(issue("EXTERNAL_FIELD_NOT_ALLOWED", `/${field}`, { field }));
  }
  let url: URL;
  try {
    url = new URL(g.url!);
  } catch {
    issues.push(issue("EXTERNAL_URL_INVALID", "/subgraph/url", { url: g.url! }));
    return;
  }
  if (url.username || url.password) issues.push(issue("EXTERNAL_URL_CREDENTIALS", "/subgraph/url", {}));
  if (LOOPBACK.test(url.hostname)) issues.push(issue("EXTERNAL_URL_LOOPBACK", "/subgraph/url", { host: url.hostname }));
}

/**
 * Whether requests to an external subgraph travel in clear to a host outside this machine and its private network:
 * `add` warns then (D33). host.docker.internal, names under .internal or .local, and private addresses are exempt.
 */
export function externalInClear(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "host.docker.internal" || host.endsWith(".internal") || host.endsWith(".local")) return false;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
  }
  return true;
}

/** Validates a parsed manifest against the JSON Schema, then the cross-field rules a schema cannot express. */
export function validateManifest(manifest: unknown): ValidationResult {
  const schemaProblems = schemaIssues(manifestSchema.validate, manifest);
  if (schemaProblems.length) return { ok: false, issues: schemaProblems };

  const m = manifest as {
    name: string;
    dependencies?: { plugin: string }[];
    services: { name: string; image: string; port: number; extraPorts?: { name: string; port: number }[]; env?: Record<string, string> }[];
    provides?: Record<
      string,
      {
        service: string;
        ready: { exec: string[]; image?: string };
        provision: { image: string; command: string[]; env?: Record<string, string> };
        inject: Record<string, string>;
      }
    >;
    subgraph?: { service?: string; url?: string; path?: string; forwardAuthorization?: boolean; grpc?: { proto: string; mapping: string } };
    volumes?: unknown;
    requires?: Record<string, unknown>;
    authorization?: { queries?: string; mutations?: string };
    web?: { service: string; path?: string };
    oidc?: { issuerPath: string; jwksPath: string; audience: string };
  };
  const issues: ManifestIssue[] = [];
  const names = new Set<string>();

  m.services.forEach((s, i) => {
    if (names.has(s.name)) {
      issues.push(issue("DUPLICATE_SERVICE", `/services/${i}/name`, { name: s.name }));
    }
    names.add(s.name);
    checkImage(s.image, `/services/${i}/image`, issues);
    // ${web.origin} only in the env of the service that serves the brick's pages (D18).
    checkTemplates(s.env, `/services/${i}/env`, m.web?.service === s.name ? "webServiceEnv" : "serviceEnv", issues);
    // Extra ports: a Kubernetes Service cannot have two ports with the same name or number, and
    // "main" is the name of the primary port.
    const portNames = new Set(["main"]);
    const portNumbers = new Set([s.port]);
    (s.extraPorts ?? []).forEach((p, j) => {
      if (portNames.has(p.name)) {
        issues.push(
          issue("PORT_CONFLICT", `/services/${i}/extraPorts/${j}/name`, {
            service: s.name,
            detail: `the name "${p.name}" is already used by another port`,
          }),
        );
      }
      if (portNumbers.has(p.port)) {
        issues.push(
          issue("PORT_CONFLICT", `/services/${i}/extraPorts/${j}/port`, {
            service: s.name,
            detail: `port ${p.port} is already used by another port`,
          }),
        );
      }
      portNames.add(p.name);
      portNumbers.add(p.port);
    });
  });

  for (const [cap, p] of Object.entries(m.provides ?? {})) {
    if (!names.has(p.service)) {
      issues.push(issue("UNKNOWN_SERVICE", `/provides/${cap}/service`, { name: p.service }));
    }
    if (!p.ready.exec.some((arg) => arg.includes("${provider.host}"))) {
      issues.push(issue("READY_NOT_TARGETING_PROVIDER", `/provides/${cap}/ready/exec`, { capability: cap }));
    }
    if (p.ready.image !== undefined) checkImage(p.ready.image, `/provides/${cap}/ready/image`, issues);
    checkImage(p.provision.image, `/provides/${cap}/provision/image`, issues);
    checkTemplates(p.ready.exec, `/provides/${cap}/ready/exec`, "readyExec", issues);
    checkTemplates(p.provision.command, `/provides/${cap}/provision/command`, "provisionCommand", issues);
    checkTemplates(p.provision.env, `/provides/${cap}/provision/env`, "provisionEnv", issues);
    checkTemplates(p.inject, `/provides/${cap}/inject`, "inject", issues);
  }
  checkSubgraph(m, names, issues);
  const dependencies = new Set<string>();
  (m.dependencies ?? []).forEach((d, i) => {
    if (d.plugin === m.name) issues.push(issue("SELF_DEPENDENCY", `/dependencies/${i}/plugin`, { name: d.plugin }));
    else if (dependencies.has(d.plugin)) issues.push(issue("DUPLICATE_DEPENDENCY", `/dependencies/${i}/plugin`, { name: d.plugin }));
    dependencies.add(d.plugin);
  });
  // The roles of "authorization" are the ones of the tokens of the oidc provider; without that requirement nothing
  // would ever read the block (D22). The schema already asks for a subgraph and for some "requires".
  if (m.authorization && !Object.hasOwn(m.requires ?? {}, "oidc")) issues.push(issue("AUTHORIZATION_WITHOUT_OIDC", "/authorization", {}));
  // The router reads the "oidc" block only from the brick that provides the capability (D19).
  if (m.oidc && !Object.hasOwn(m.provides ?? {}, "oidc")) issues.push(issue("OIDC_NOT_PROVIDED", "/oidc", {}));
  if (m.web) {
    const web = m.services.find((s) => s.name === m.web!.service);
    if (!web) issues.push(issue("UNKNOWN_SERVICE", "/web/service", { name: m.web.service }));
    // plugbricks sets these on the web service (D17); a manifest value would be overwritten silently.
    for (const name of WEB_ENV) {
      if (web?.env && Object.hasOwn(web.env, name)) {
        const at = m.services.indexOf(web);
        issues.push(issue("WEB_ENV_RESERVED", `/services/${at}/env/${name}`, { service: web.name, name }));
      }
    }
  }

  return issues.length ? { ok: false, issues } : { ok: true };
}
