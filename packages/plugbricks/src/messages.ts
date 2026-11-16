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
  TEMPLATE_UNKNOWN: '"{template}" is not a template this field accepts; allowed here: {allowed}',

  // Runtime (generate, up, down).
  WAIT_TIMEOUT: '"{consumer}" gave up waiting for capability "{capability}" from "{provider}" after {timeoutSeconds}s',
  RUNTIME_NAME_CONFLICT:
    'the {first} and the {second} would both be named "{name}" in the runtime; rename one of the bricks, services, volumes or capabilities',
  RUNTIME_NAME_INVALID: '"{name}" ({what}) cannot be used as a runtime name: {detail}',
  PROVISION_SCRIPTS_TOO_LARGE:
    'the provision scripts of "{brick}" for "{capability}" take {size} bytes; a Kubernetes ConfigMap holds at most {max}',
  SECRETS_FILE_INVALID: "{file} line {line} is not KEY=value with a letters-and-digits value; fix that line (never delete a secret still in use)",
  RUNTIME_TOOL_MISSING: '"{tool}" was not found; {hint}',
  RUNTIME_COMMAND_FAILED: '"{command}" exited with {status}{detail}',
  VOLUME_PRUNE_FAILED: "could not delete volume {volume} ({detail}); it stays in pendingDeletion",

  // CLI usage (exit code 2).
  USAGE_UNKNOWN_COMMAND: 'unknown command "{command}"; run "plugbricks --help"',
  USAGE_MISSING_ARGUMENT: '"plugbricks {command}" needs {argument}',
  USAGE_UNEXPECTED_ARGUMENT: 'unexpected argument "{argument}" for "plugbricks {command}"',
  USAGE_INVALID_OPTION: "{detail}",

  // Platform files (platform.json, platform.lock, .platform/bricks).
  INVALID_JSON: "{file} is not valid JSON: {detail}",
  PLATFORM_NOT_INITIALIZED: 'no platform.json in {dir}; run "plugbricks init" first',
  PLATFORM_ALREADY_INITIALIZED: "platform.json already exists in {dir}; nothing was changed",
  PLATFORM_INVALID_NAME:
    '"{name}" is not a valid platform name (lowercase letters, digits and dashes, 2 to 40 characters); pass --name',
  PLATFORM_FILE_INVALID: "{file} does not match its schema; see the issues below",
  LOCK_MISSING: 'platform.lock is missing in {dir}; it is written by "plugbricks init"',
  LOCK_OUT_OF_SYNC: "platform.json and platform.lock disagree on brick \"{brick}\"; {detail}",
  LOCK_INCONSISTENT: "platform.lock lists volume {volume} {detail}; fix the lock before going further",

  // add
  BRICK_NOT_FOUND: "no plugin.json found at {path}",
  BRICK_PATH_NOT_PORTABLE: 'brick "{brick}" cannot be used on every OS: {detail}',
  MANIFEST_INVALID: "{path} is not a valid plugin manifest; see the issues below",
  BRICK_FILE_MISSING: 'brick "{brick}" references {file}, which does not exist in the brick',
  BRICK_SYMLINK: 'brick "{brick}" contains a symbolic link ({file}); a brick must contain regular files only',
  BRICK_NAME_CONFLICT:
    'a different brick named "{name}" is already installed (from {source}); remove it before adding this one',
  CAPABILITY_ALREADY_PROVIDED: 'brick "{brick}" provides "{capability}", which "{provider}" already provides',
  REQUIRED_CAPABILITY_MISSING:
    'brick "{brick}" requires capability "{capability}", which no installed brick provides; add a provider first',

  // remove
  BRICK_NOT_INSTALLED: 'no brick named "{name}" is installed',
  CAPABILITY_IN_USE: 'cannot remove "{brick}": capability "{capability}" is still required by {consumers}',

  // status
  BRICK_MISSING: 'the installed copy of "{brick}" is missing from .platform/bricks/{brick}',
  BRICK_MODIFIED: 'the installed copy of "{brick}" was modified after it was added (integrity mismatch)',
  BRICK_UNREADABLE: 'the installed copy of "{brick}" cannot be read: {detail}',

  // npm create plugbricks
  CREATE_MISSING_NAME: "missing project name; usage: npm create plugbricks <project-name>",
  CREATE_TARGET_NOT_EMPTY: "{dir} already exists and is not empty; choose another name or remove it first",
  SECRETS_NOT_RESTRICTED:
    "could not restrict {dir} to your user only ({detail}); other accounts on this machine may be able to read it. Restrict it before storing any secret",
} as const;

export type IssueCode = keyof typeof MESSAGES;
export type IssueParams = Record<string, string>;

export function formatMessage(code: IssueCode, params: IssueParams = {}): string {
  return MESSAGES[code].replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}
