/**
 * Stable error codes and their message templates.
 *
 * Codes are part of the public contract: tools and tests match on `code`, never on
 * the message text. Never rename or reuse a code; add a new one instead.
 * Templates use {param} placeholders filled from the issue's params.
 */
export const MESSAGES = {
  // JSON Schema violations (one code per Ajv keyword we expect to hit).
  MISSING_FIELD: 'missing required field "{field}"',
  UNKNOWN_FIELD: 'unknown field "{field}"',
  INVALID_TYPE: "must be of type {type}",
  INVALID_FORMAT: "does not match the expected format {pattern}",
  INVALID_VALUE: "must be one of: {allowed}",
  OUT_OF_RANGE: "{detail}",
  DEPENDENT_FIELD: 'field "{field}" requires field "{required}"',
  SCHEMA_VIOLATION: "{detail}",

  // Cross-field rules the schema cannot express.
  DUPLICATE_SERVICE: 'duplicate service name "{name}"',
  UNKNOWN_SERVICE: 'unknown service "{name}"',
  IMAGE_INVALID: 'image reference "{image}" is not valid: {reason}',
  IMAGE_NOT_PINNED: 'image "{image}" must be pinned to a version or a digest',
  IMAGE_FLOATING_TAG: 'image "{image}" uses floating tag "{tag}"; pin an exact version such as 1.2.3 or a sha256 digest',
  READY_NOT_TARGETING_PROVIDER:
    'ready command of capability "{capability}" must target ${provider.host}, otherwise it probes the waiting container itself',

  // Runtime (drivers and `plugbricks status`, milestone 3).
  WAIT_TIMEOUT: '"{consumer}" gave up waiting for capability "{capability}" from "{provider}" after {timeoutSeconds}s',
} as const;

export type IssueCode = keyof typeof MESSAGES;
export type IssueParams = Record<string, string>;

export function formatMessage(code: IssueCode, params: IssueParams = {}): string {
  return MESSAGES[code].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}
