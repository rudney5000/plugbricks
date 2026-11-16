import { checkImagePin } from "./image.js";
import { issue, type Issue } from "./issues.js";
import { MANIFEST_SCHEMA_ID, manifestSchema, schemaIssues } from "./schemas.js";

export { MANIFEST_SCHEMA_ID };

/** Kept for compatibility: a manifest issue is a plain Issue whose path is a JSON Pointer. */
export type ManifestIssue = Issue;

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: ManifestIssue[] };

function checkImage(image: string, path: string, issues: ManifestIssue[]): void {
  const r = checkImagePin(image);
  if (r.ok) return;
  if (r.code === "IMAGE_INVALID") issues.push(issue(r.code, path, { image, reason: r.reason }));
  else if (r.code === "IMAGE_FLOATING_TAG") issues.push(issue(r.code, path, { image, tag: r.tag }));
  else issues.push(issue(r.code, path, { image }));
}

/** Validates a parsed manifest against the JSON Schema, then the cross-field rules a schema cannot express. */
export function validateManifest(manifest: unknown): ValidationResult {
  const schemaProblems = schemaIssues(manifestSchema.validate, manifest);
  if (schemaProblems.length) return { ok: false, issues: schemaProblems };

  const m = manifest as {
    services: { name: string; image: string }[];
    provides?: Record<string, { service: string; ready: { exec: string[]; image?: string }; provision: { image: string } }>;
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
  }
  if (m.subgraph && !names.has(m.subgraph.service)) {
    issues.push(issue("UNKNOWN_SERVICE", "/subgraph/service", { name: m.subgraph.service }));
  }

  return issues.length ? { ok: false, issues } : { ok: true };
}
