/**
 * A small YAML writer for the files the drivers generate. Keys keep their insertion order (the
 * drivers build objects in a fixed order), so the output is deterministic. A string is written
 * plain only when YAML cannot read it as anything else; otherwise it is double-quoted with JSON
 * escapes, which are valid YAML.
 */

type Yaml = string | number | boolean | null | undefined | Yaml[] | { [k: string]: Yaml };

// No leading "." either: ".5", ".inf" and ".nan" are numbers in YAML.
const PLAIN = /^[A-Za-z_/][A-Za-z0-9_./:@-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|y|n|null|~)$/i;

function scalar(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return PLAIN.test(v) && !RESERVED.test(v) && !v.endsWith(":") ? v : JSON.stringify(v);
}

const key = (k: string) => scalar(k);

function isEmptyContainer(v: Yaml): boolean {
  return (Array.isArray(v) && v.length === 0) || (!!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
}

function lines(v: Yaml, indent: string): string[] {
  if (Array.isArray(v)) {
    return v.flatMap((item) => {
      if (item && typeof item === "object" && !isEmptyContainer(item)) {
        const [first, ...rest] = lines(item, indent + "  ");
        return [`${indent}- ${first.slice(indent.length + 2)}`, ...rest];
      }
      return [`${indent}- ${inline(item)}`];
    });
  }
  if (v && typeof v === "object") {
    return Object.entries(v)
      .filter(([, x]) => x !== undefined)
      .flatMap(([k, x]) =>
        x && typeof x === "object" && !isEmptyContainer(x)
          ? [`${indent}${key(k)}:`, ...lines(x, indent + "  ")]
          : [`${indent}${key(k)}: ${inline(x)}`],
      );
  }
  return [`${indent}${inline(v)}`];
}

function inline(v: Yaml): string {
  if (Array.isArray(v)) return "[]";
  if (v && typeof v === "object") return "{}";
  return scalar(v === undefined ? null : v);
}

/** One YAML document, ending with a newline. */
export function toYaml(v: Yaml): string {
  return lines(v, "").join("\n") + "\n";
}

/** Several documents separated by `---`. */
export function toYamlDocuments(docs: Yaml[]): string {
  return docs.map(toYaml).join("---\n");
}

export type { Yaml };
