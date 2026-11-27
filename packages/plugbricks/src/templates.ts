/**
 * Templates in manifest values: `${provider.host}`, `${provider.port}`, `${consumer.name}`,
 * `${consumer.roles}`, `${consumer.grants}`, `${web.origin}` and `${secrets.<name>}`. Which ones a field may use depends on the field (TEMPLATE_CONTEXTS).
 * Anything else written as `${...}` is refused when the brick is added, so a typo never
 * reaches a running container.
 */

/** Secret names: lowercase words joined by single underscores, so env var names never collide (see secretEnvName). */
export const SECRET_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export type TemplateVar =
  | "provider.host"
  | "provider.port"
  | "provider.web.origin"
  | "consumer.name"
  | "consumer.roles"
  | "consumer.grants"
  | "web.origin"
  | "secrets";

/** What each templated field may use. Secrets only in environment maps, never in a command line (visible in ps). */
export const TEMPLATE_CONTEXTS = {
  /** A command line is visible in ps, and nothing is substituted in it: a script reads env as $NAME (D41). */
  serviceArgs: [],
  serviceEnv: ["secrets"],
  /** The env of the service that serves a web brick's pages: also where the browser reaches it (D18). */
  webServiceEnv: ["secrets", "web.origin"],
  readyExec: ["provider.host", "provider.port"],
  provisionCommand: ["provider.host", "provider.port", "consumer.name"],
  /**
   * consumer.roles: the roles the consumer's "authorization" block names, space-separated (D22): the provision task creates
   * them on the consumer's own client. consumer.grants: "<brick>/<role>" for each role of a dependency's block that the
   * consumer's service account must hold, space-separated. Both are empty when there is nothing to say.
   */
  provisionEnv: ["provider.host", "provider.port", "consumer.name", "consumer.roles", "consumer.grants", "secrets"],
  /** provider.web.origin: where the browser reaches a provider that is a web brick, e.g. the issuer of its tokens (D20). */
  inject: ["provider.host", "provider.port", "provider.web.origin", "consumer.name", "secrets"],
} as const satisfies Record<string, readonly TemplateVar[]>;

export type TemplateContext = keyof typeof TEMPLATE_CONTEXTS;

/** A parsed value: literal text and references, in order. */
export type Segment = { text: string } | { var: Exclude<TemplateVar, "secrets"> } | { secret: string };

const TEMPLATE = /\$\{([^}]*)\}/g;

/** How the allowed templates of a context are shown in an error message. */
export function allowedList(context: TemplateContext): string {
  const allowed: readonly TemplateVar[] = TEMPLATE_CONTEXTS[context];
  if (allowed.length === 0) return "none (put the value in env, and read it as $NAME in a shell script)";
  return allowed.map((v) => (v === "secrets" ? "${secrets.<name>}" : `\${${v}}`)).join(", ");
}

/**
 * Splits a value into segments. Returns the first template that the context does not allow
 * (or that is malformed) as `unknown`, written as it appears in the manifest.
 */
export function parseTemplate(value: string, context: TemplateContext): { segments: Segment[] } | { unknown: string } {
  const allowed: readonly TemplateVar[] = TEMPLATE_CONTEXTS[context];
  const segments: Segment[] = [];
  let last = 0;
  for (const m of value.matchAll(TEMPLATE)) {
    if (m.index > last) segments.push({ text: value.slice(last, m.index) });
    const ref = m[1];
    if (ref.startsWith("secrets.") && allowed.includes("secrets") && SECRET_NAME.test(ref.slice("secrets.".length))) {
      segments.push({ secret: ref.slice("secrets.".length) });
    } else if (ref !== "secrets" && (allowed as readonly string[]).includes(ref)) {
      segments.push({ var: ref as Exclude<TemplateVar, "secrets"> });
    } else {
      return { unknown: m[0] };
    }
    last = m.index + m[0].length;
  }
  if (last < value.length) segments.push({ text: value.slice(last) });
  return { segments };
}

/** Secret names a value refers to. The value must already be valid for its context. */
export function secretsIn(value: string, context: TemplateContext): string[] {
  const r = parseTemplate(value, context);
  if ("unknown" in r) return [];
  return r.segments.flatMap((s) => ("secret" in s ? [s.secret] : []));
}
