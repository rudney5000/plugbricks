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
  PORT_CONFLICT: 'the ports of service "{service}" conflict: {detail}',
  SELF_DEPENDENCY: 'plugin "{name}" lists itself in "dependencies"',
  DUPLICATE_DEPENDENCY: 'plugin "{name}" appears twice in "dependencies"',
  AUTHORIZATION_WITHOUT_OIDC:
    'the "authorization" block is checked against the tokens of the "oidc" capability, but this brick does not require it; add "oidc" to "requires" (optional is fine)',
  OIDC_NOT_PROVIDED: 'the "oidc" block describes tokens for the router, but this brick does not provide the "oidc" capability',
  WEB_ENV_RESERVED:
    'service "{service}" serves the pages of this brick and sets {name} in its env; plugbricks sets it (the router\'s address), so remove it from the manifest',

  // Runtime (generate, up, down).
  HOST_PORT_BUSY:
    "port {port} on 127.0.0.1, where this platform publishes {what}, is already used by another program or platform; change {field} in platform.json, then run up again",
  WAIT_TIMEOUT: '"{consumer}" gave up waiting for capability "{capability}" from "{provider}" after {timeoutSeconds}s',
  RUNTIME_NAME_CONFLICT:
    'the {first} and the {second} would both be named "{name}" in the runtime; rename one of the bricks, services, volumes or capabilities',
  RUNTIME_NAME_INVALID: '"{name}" ({what}) cannot be used as a runtime name: {detail}',
  ROUTER_CONFIG_TOO_LARGE:
    "the router configuration takes {size} bytes; a Kubernetes ConfigMap holds at most {max}; remove a subgraph or use the Compose runtime",
  PROVISION_SCRIPTS_TOO_LARGE:
    'the provision scripts of "{brick}" for "{capability}" take {size} bytes; a Kubernetes ConfigMap holds at most {max}',
  SECRETS_FILE_INVALID:
    "{file} line {line} is not KEY=value with a letters-and-digits value; fix that line (never delete a secret still in use)",
  RUNTIME_TOOL_MISSING: '"{tool}" was not found; {hint}',
  RUNTIME_COMMAND_FAILED: '"{command}" exited with {status}{detail}',
  VOLUME_PRUNE_FAILED: "could not delete volume {volume} ({detail}); it stays in pendingDeletion",
  K8S_CONTEXT_REQUIRED:
    "the Kubernetes runtime needs a cluster you name: pass --context <name> (and --kubeconfig <file> when it is not in the default kubeconfig); plugbricks never uses the current kubectl context, so it cannot act on a cluster you did not choose",
  K8S_CONTEXT_REFUSED:
    'context "{context}" is refused: it is the name of the protected cluster "platform" (k3d calls its context "k3d-platform"), which plugbricks must not modify by accident; if you really mean it, add --allow-context {context}',
  K8S_KUBECONFIG_NOT_FOUND: "kubeconfig file {path} does not exist or is not a file",
  RUNTIME_UNAVAILABLE: "cannot read the state of the {runtime} runtime: {detail}",

  // CLI usage (exit code 2).
  USAGE_UNKNOWN_COMMAND: 'unknown command "{command}"; run "plugbricks --help"',
  USAGE_MISSING_ARGUMENT: '"plugbricks {command}" needs {argument}',
  USAGE_UNEXPECTED_ARGUMENT: 'unexpected argument "{argument}" for "plugbricks {command}"',
  USAGE_INVALID_OPTION: "{detail}",

  // Platform files (platform.json, platform.lock, .platform/bricks).
  INVALID_JSON: "{file} is not valid JSON: {detail}",
  PLATFORM_NOT_INITIALIZED: 'no platform.json in {dir}; run "plugbricks init" first',
  PLATFORM_ALREADY_INITIALIZED: "platform.json already exists in {dir}; nothing was changed",
  PLATFORM_INVALID_NAME: '"{name}" is not a valid platform name (lowercase letters, digits and dashes, 2 to 40 characters); pass --name',
  PLATFORM_FILE_INVALID: "{file} does not match its schema; see the issues below",
  LOCK_MISSING: 'platform.lock is missing in {dir}; it is written by "plugbricks init"',
  LOCK_OUT_OF_SYNC: 'platform.json and platform.lock disagree on brick "{brick}"; {detail}',
  WEB_PORT_MISSING: 'brick "{brick}" has no webPort in platform.json, but {use}; {fix}',
  WEB_PORT_CONFLICT: 'webPort {port} of brick "{brick}" is already used by {other}; give it another port in platform.json',
  LOCK_INCONSISTENT: "platform.lock lists volume {volume} {detail}; fix the lock before going further",

  // Federation: the subgraphs of the installed bricks (add, remove, status)
  COMPOSITION_FAILED: "the subgraphs of the installed bricks do not compose: {detail}",
  SUBGRAPH_SCHEMA_INVALID: 'the subgraph schema {file} of brick "{brick}" is not valid GraphQL (line {line}, column {column}): {detail}',
  EXTENDS_OWNER_MISSING: 'brick "{brick}" extends entity "{entity}" of brick "{owner}", which is not installed; add "{owner}" first',
  EXTENDS_ENTITY_MISSING:
    'brick "{brick}" extends entity "{entity}" of brick "{owner}", but the subgraph of "{owner}" ({file}) does not define it: an entity is an object type with @key',
  EXTENDS_ENTITY_NOT_DECLARED:
    'brick "{brick}" lists entity "{entity}" in extends, but its own subgraph schema {file} does not declare it: an entity is an object type with @key',
  DEPENDENCY_IN_USE: 'cannot {action} "{brick}": {consumers} declare it in "dependencies"; {action} them first',
  EXTENDS_IN_USE: 'cannot remove "{brick}": its entities are still extended by {consumers}',
  FEDERATION_CHANGED:
    "the federated schema of the installed subgraphs (sha256 {actual}) does not match platform.lock ({locked}); a subgraph changed since it was added",

  // add
  BRICK_NOT_FOUND: "no plugin.json found at {path}",
  BRICK_PATH_NOT_PORTABLE: 'brick "{brick}" cannot be used on every OS: {detail}',
  MANIFEST_INVALID: "{path} is not a valid plugin manifest; see the issues below",
  BRICK_FILE_MISSING: 'brick "{brick}" references {file}, which does not exist in the brick',
  BRICK_SYMLINK: 'brick "{brick}" contains a symbolic link ({file}); a brick must contain regular files only',
  BRICK_NAME_CONFLICT: 'a different brick named "{name}" is already installed (from {source}); remove it before adding this one',
  CAPABILITY_ALREADY_PROVIDED: 'brick "{brick}" provides "{capability}", which "{provider}" already provides',
  PROVIDER_DISABLED: 'capability "{capability}" is provided by "{provider}", which is disabled; enable it first',
  PLATFORM_BUSY:
    'another plugbricks command is changing this platform: "{command}" (process {pid}, since {since}); wait for it to end ({file} is removed then)',
  ADMIN_UI_MISSING: 'the admin UI is not built at "{dir}"; run "npm run build -w plugbricks-admin"',
  ADMIN_OIDC_ISSUER_INVALID: 'the OIDC issuer "{issuer}" must be an https URL (http is accepted only on 127.0.0.1, localhost or [::1])',
  ADMIN_OIDC_NOT_CONFIGURED:
    "the admin needs --client-id and an issuer: --issuer, or an enabled brick that provides oidc (and PLUGBRICKS_OIDC_CLIENT_SECRET for a confidential client), or --dev for local use",
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
