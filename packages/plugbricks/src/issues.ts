import type { ErrorObject } from "ajv/dist/2020.js";
import { formatMessage, type IssueCode, type IssueParams } from "./messages.js";

/** One problem found by plugbricks. Tools match on `code`, never on `message`. */
export interface Issue {
  /** Stable identifier, see MESSAGES in messages.ts. */
  code: IssueCode;
  /** Where the problem is: a JSON Pointer, optionally prefixed by a file name (`platform.json#/bricks`). Empty when not tied to a field. */
  path: string;
  message: string;
  params: IssueParams;
}

export function issue(code: IssueCode, path: string, params: IssueParams = {}): Issue {
  return { code, path, message: formatMessage(code, params), params };
}

/** Maps one Ajv error to a stable issue code. */
export function fromAjv(e: ErrorObject): Issue {
  const p = e.params as Record<string, unknown>;
  const at = e.instancePath;
  const here = at || "/";
  switch (e.keyword) {
    case "required":
      return issue("MISSING_FIELD", `${at}/${p.missingProperty}`, { field: String(p.missingProperty) });
    case "additionalProperties":
      return issue("UNKNOWN_FIELD", `${at}/${p.additionalProperty}`, { field: String(p.additionalProperty) });
    case "type":
      return issue("INVALID_TYPE", here, { type: String(p.type) });
    case "pattern":
      return issue("INVALID_FORMAT", here, { pattern: String(p.pattern) });
    case "enum":
      return issue("INVALID_VALUE", here, { allowed: (p.allowedValues as unknown[]).join(", ") });
    case "minimum":
    case "maximum":
    case "minItems":
    case "minLength":
    case "minProperties":
      return issue("OUT_OF_RANGE", here, { detail: e.message ?? e.keyword });
    case "dependentRequired":
      return issue("DEPENDENT_FIELD", `${at}/${p.property}`, {
        field: String(p.property),
        required: String(p.missingProperty),
      });
    default:
      return issue("SCHEMA_VIOLATION", here, { detail: e.message ?? e.keyword });
  }
}
