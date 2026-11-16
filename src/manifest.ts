import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

const schemaUrl = new URL("../schemas/plugin-manifest.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export interface ManifestIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: ManifestIssue[] };

function toIssue(e: ErrorObject): ManifestIssue {
  return { path: e.instancePath || "/", message: e.message ?? "invalid" };
}

/** Validates a parsed manifest against the JSON Schema, then the cross-field rules a schema cannot express. */
export function validateManifest(manifest: unknown): ValidationResult {
  if (!validateSchema(manifest)) {
    return { ok: false, issues: (validateSchema.errors ?? []).map(toIssue) };
  }

  const m = manifest as {
    services: { name: string; image: string }[];
    provides?: Record<string, { service: string }>;
    subgraph?: { service: string };
  };
  const issues: ManifestIssue[] = [];
  const names = new Set<string>();

  m.services.forEach((s, i) => {
    if (names.has(s.name)) {
      issues.push({ path: `/services/${i}/name`, message: `duplicate service name "${s.name}"` });
    }
    names.add(s.name);
    const tag = s.image.split("/").pop()!.split(":")[1];
    if (!tag || tag === "latest") {
      issues.push({ path: `/services/${i}/image`, message: "image must be pinned to a version (no tag or :latest)" });
    }
  });

  for (const [cap, p] of Object.entries(m.provides ?? {})) {
    if (!names.has(p.service)) {
      issues.push({ path: `/provides/${cap}/service`, message: `unknown service "${p.service}"` });
    }
  }
  if (m.subgraph && !names.has(m.subgraph.service)) {
    issues.push({ path: "/subgraph/service", message: `unknown service "${m.subgraph.service}"` });
  }

  return issues.length ? { ok: false, issues } : { ok: true };
}
