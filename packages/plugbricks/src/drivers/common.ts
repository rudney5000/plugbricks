/**
 * Shell script run by every wait task (Compose) and wait init container (Kubernetes). It runs the
 * provider's ready command, without a shell, until it succeeds or PB_WAIT_TIMEOUT seconds have
 * passed; on timeout it exits 124, which the drivers report as WAIT_TIMEOUT. The command comes
 * as positional parameters, so it is never re-parsed. Needs /bin/sh, date and sleep in the image.
 */
export const WAIT_SCRIPT = [
  "deadline=$(( $(date +%s) + PB_WAIT_TIMEOUT ))",
  'until "$@" >/dev/null 2>&1; do',
  '  if [ "$(date +%s)" -ge "$deadline" ]; then',
  '    echo "plugbricks: WAIT_TIMEOUT: gave up waiting for $PB_WAIT_FOR after ${PB_WAIT_TIMEOUT}s" >&2',
  "    exit 124",
  "  fi",
  '  sleep "$PB_WAIT_INTERVAL"',
  "done",
  'echo "plugbricks: $PB_WAIT_FOR is ready"',
].join("\n");

/** Exit code of the wait script when it gives up. */
export const WAIT_TIMEOUT_EXIT = 124;

/** $0 of the wait script: shows in process lists and error messages. */
export const WAIT_ARGV0 = "plugbricks-wait";

/** Where provision scripts are mounted in the provision container. */
export const PROVISION_MOUNT = "/provision";

/**
 * Both Docker Compose (variable interpolation) and Kubernetes (`$(VAR)` expansion in command,
 * args and env) read `$$` as one literal `$`. Doubling every `$` keeps literal text literal.
 */
export const escapeDollars = (s: string) => s.replace(/\$/g, "$$$$");
