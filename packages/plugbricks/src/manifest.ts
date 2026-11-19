import { checkImagePin } from "./image.js";
import { issue, type Issue } from "./issues.js";
import { MANIFEST_SCHEMA_ID, manifestSchema, schemaIssues } from "./schemas.js";
import { allowedList, parseTemplate, type TemplateContext } from "./templates.js";

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

/** Validates a parsed manifest against the JSON Schema, then the cross-field rules a schema cannot express. */
export function validateManifest(manifest: unknown): ValidationResult {
  const schemaProblems = schemaIssues(manifestSchema.validate, manifest);
  if (schemaProblems.length) return { ok: false, issues: schemaProblems };

  const m = manifest as {
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
    subgraph?: { service: string };
  };
  const issues: ManifestIssue[] = [];
  const names = new Set<string>();

  m.services.forEach((s, i) => {
    if (names.has(s.name)) {
      issues.push(issue("DUPLICATE_SERVICE", `/services/${i}/name`, { name: s.name }));
    }
    names.add(s.name);
    checkImage(s.image, `/services/${i}/image`, issues);
    checkTemplates(s.env, `/services/${i}/env`, "serviceEnv", issues);
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
  if (m.subgraph && !names.has(m.subgraph.service)) {
    issues.push(issue("UNKNOWN_SERVICE", "/subgraph/service", { name: m.subgraph.service }));
  }

  return issues.length ? { ok: false, issues } : { ok: true };
}
