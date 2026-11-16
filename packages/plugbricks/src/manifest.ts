import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { checkImagePin } from "./image.js";
import { formatMessage, type IssueCode, type IssueParams } from "./messages.js";

const schemaUrl = new URL("../schemas/plugin-manifest.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));

/** Identity of the manifest contract: where the schema file is published (main branch of the repo). */
export const MANIFEST_SCHEMA_ID = "https://raw.githubusercontent.com/rudney5000/plugbricks/main/packages/plugbricks/schemas/plugin-manifest.schema.json";
if (schema.$id !== MANIFEST_SCHEMA_ID) {
  throw new Error(`schema $id is "${schema.$id}", expected "${MANIFEST_SCHEMA_ID}"`);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);
const validateSchema = ajv.getSchema(MANIFEST_SCHEMA_ID)!;

export interface ManifestIssue {
  /** Stable identifier, see MESSAGES in messages.ts. */
  code: IssueCode;
  /** JSON Pointer to the faulty field. */
  path: string;
  message: string;
  params: IssueParams;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: ManifestIssue[] };

function issue(code: IssueCode, path: string, params: IssueParams = {}): ManifestIssue {
  return { code, path: path || "/", message: formatMessage(code, params), params };
}

function fromAjv(e: ErrorObject): ManifestIssue {
  const p = e.params as Record<string, unknown>;
  const at = e.instancePath;
  switch (e.keyword) {
    case "required":
      return issue("MISSING_FIELD", `${at}/${p.missingProperty}`, { field: String(p.missingProperty) });
    case "additionalProperties":
      return issue("UNKNOWN_FIELD", `${at}/${p.additionalProperty}`, { field: String(p.additionalProperty) });
    case "type":
      return issue("INVALID_TYPE", at, { type: String(p.type) });
    case "pattern":
      return issue("INVALID_FORMAT", at, { pattern: String(p.pattern) });
    case "enum":
      return issue("INVALID_VALUE", at, { allowed: (p.allowedValues as unknown[]).join(", ") });
    case "minimum":
    case "maximum":
    case "minItems":
    case "minLength":
    case "minProperties":
      return issue("OUT_OF_RANGE", at, { detail: e.message ?? e.keyword });
    case "dependentRequired":
      return issue("DEPENDENT_FIELD", `${at}/${p.property}`, {
        field: String(p.property),
        required: String(p.missingProperty),
      });
    default:
      return issue("SCHEMA_VIOLATION", at, { detail: e.message ?? e.keyword });
  }
}

function checkImage(image: string, path: string, issues: ManifestIssue[]): void {
  const r = checkImagePin(image);
  if (r.ok) return;
  if (r.code === "IMAGE_INVALID") issues.push(issue(r.code, path, { image, reason: r.reason }));
  else if (r.code === "IMAGE_FLOATING_TAG") issues.push(issue(r.code, path, { image, tag: r.tag }));
  else issues.push(issue(r.code, path, { image }));
}

/** Validates a parsed manifest against the JSON Schema, then the cross-field rules a schema cannot express. */
export function validateManifest(manifest: unknown): ValidationResult {
  if (!validateSchema(manifest)) {
    return { ok: false, issues: (validateSchema.errors ?? []).map(fromAjv) };
  }

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
