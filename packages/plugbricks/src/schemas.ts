import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { fromAjv, type Issue } from "./issues.js";

/** Schemas are published from the main branch of the repository; their $id is that URL. */
export const SCHEMA_BASE_URL = "https://raw.githubusercontent.com/rudney5000/plugbricks/main/packages/plugbricks/schemas/";
export const MANIFEST_SCHEMA_ID = `${SCHEMA_BASE_URL}plugin-manifest.schema.json`;
export const PLATFORM_SCHEMA_ID = `${SCHEMA_BASE_URL}platform.schema.json`;
export const LOCK_SCHEMA_ID = `${SCHEMA_BASE_URL}platform-lock.schema.json`;

const ajv = new Ajv2020({ allErrors: true, strict: true });

/** Loads a schema shipped in ../schemas and refuses to start if its $id is not the expected one. */
function load(file: string, id: string): { schema: any; validate: ValidateFunction } {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
  if (schema.$id !== id) throw new Error(`schema ${file} has $id "${schema.$id}", expected "${id}"`);
  ajv.addSchema(schema);
  return { schema, validate: ajv.getSchema(id)! };
}

export const manifestSchema = load("plugin-manifest.schema.json", MANIFEST_SCHEMA_ID);
export const platformSchema = load("platform.schema.json", PLATFORM_SCHEMA_ID);
export const lockSchema = load("platform-lock.schema.json", LOCK_SCHEMA_ID);

/** Runs a compiled schema; returns [] when valid. `prefix` is prepended to every issue path (e.g. "platform.json#"). */
export function schemaIssues(validate: ValidateFunction, data: unknown, prefix = ""): Issue[] {
  if (validate(data)) return [];
  return (validate.errors ?? []).map((e) => {
    const i = fromAjv(e);
    return { ...i, path: prefix + i.path };
  });
}

/** Defaults declared in the manifest schema, so the lock never hard-codes them. */
export const MANIFEST_DEFAULTS = {
  wait: manifestSchema.schema.$defs.require.properties.wait.default as "healthy" | "started",
  timeoutSeconds: manifestSchema.schema.$defs.require.properties.timeoutSeconds.default as number,
  retention: manifestSchema.schema.$defs.service.properties.volumes.items.properties.retention.default as "retain" | "delete",
};
