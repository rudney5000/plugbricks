// "plugbricks create <name> --kind api|web" (D28): writes a brick and the code of its service from the templates of
// this package, then adds the brick. The brick (manifest, schema) goes to bricks/<name>, where "add <name>" finds it
// (D25); the code and its image recipe go to services/<name>, outside the brick, because "add" copies a brick's whole
// folder and a service's folder holds node_modules (D28). The image is built by the person, from the project folder.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkImagePin } from "./image.js";
import { MANIFEST_SCHEMA_ID } from "./manifest.js";
import { addBrick, BRICK_FOLDER, isBrickName, PlugbricksError, readProject, type AddResult } from "./platform.js";
import { issue } from "./issues.js";

export const BRICK_KINDS = ["api", "web"] as const;
export type BrickKind = (typeof BRICK_KINDS)[number];

/** The languages of an API's service (D38); a web brick has one template. */
export const API_LANGUAGES = ["node", "python", "go"] as const;
export type ApiLanguage = (typeof API_LANGUAGES)[number];

/** Where the code of the services created by "create" goes, next to bricks/ (D28). */
export const SERVICE_FOLDER = "services";

const TEMPLATES = fileURLToPath(new URL("../templates/", import.meta.url));

export interface CreateResult {
  name: string;
  kind: BrickKind;
  /** The image its manifest names: `<platform>/<name>:0.1.0` by default, or the one given with --image. */
  image: string;
  /** Relative to the platform root, with "/". */
  brickDir: string;
  serviceDir: string;
  added: AddResult;
}

/** `order-history` -> `OrderHistory`. */
const pascal = (s: string) =>
  s
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

/**
 * The words gqlgen writes in capitals in Go names (`CommonInitialisms`, codegen/templates of gqlgen 0.17.98). The Go
 * template names the types and methods gqlgen generates, so it has to name them as gqlgen does (D39).
 */
const GO_INITIALISMS = new Set(
  "ACL API ASCII CPU CSS CSV DNS EOF GUID HTML HTTP HTTPS ICMP ID IP JSON KVK LHS PDF PGP QPS QR RAM RHS RPC SLA SMTP SQL SSH SVG TCP TLS TTL UDP UI UID URI URL UTF8 UUID VM XML XMPP XSRF XSS AWS GCP".split(
    " ",
  ),
);

/** `UserUrlItem` -> `UserURLItem`, `xIdItems` -> `XIDItems`: gqlgen's Go name of a type or field as "create" writes them. */
export const goName = (name: string) =>
  name
    // A word ends where a lower case letter is followed by anything else.
    .split(/(?<=[a-z])(?=[^a-z])/)
    .map((w) => (GO_INITIALISMS.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");

/** Every file of a folder, relative, sorted. */
function filesOf(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesOf(dir, join(prefix, e.name)) : [join(prefix, e.name)]))
    .sort();
}

/**
 * Copies a template folder: a `.tmpl` file loses its suffix and gets its placeholders replaced; a package.json or
 * package-lock.json gets the service's name (they carry none, so that Dependabot keeps the template current).
 */
function copyTemplate(from: string, to: string, values: Record<string, string>, packageName: string): void {
  for (const f of filesOf(from)) {
    let text = readFileSync(join(from, f), "utf8");
    let target = f;
    if (f.endsWith(".tmpl")) {
      target = f.slice(0, -".tmpl".length);
      text = text.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
    } else if (f === "package.json" || f === "package-lock.json") {
      const json = JSON.parse(text);
      json.name = packageName;
      if (json.packages?.[""]) json.packages[""].name = packageName;
      text = JSON.stringify(json, null, 2) + "\n";
    }
    mkdirSync(dirname(join(to, target)), { recursive: true });
    writeFileSync(join(to, target), text);
  }
}

/** The brick name for `create <base> --kind <kind>`: `<base>-<kind>`, unless `base` already ends with it. */
export function createdName(base: string, kind: BrickKind): string {
  return base.endsWith(`-${kind}`) ? base : `${base}-${kind}`;
}

/**
 * Writes bricks/<name> and services/<name> from the template of `kind`, then adds the brick. Writes nothing when it
 * refuses; when the add itself is refused, removes what it wrote, so that nothing is left half done.
 */
export function createBrick(
  root: string,
  base: string,
  kind: BrickKind,
  options: { image?: string; lang?: ApiLanguage } = {},
): CreateResult {
  const project = readProject(root);
  const name = createdName(base, kind);
  if (!isBrickName(base) || !isBrickName(name)) {
    throw new PlugbricksError([issue("BRICK_CREATE_INVALID_NAME", "", { name: base, kind })]);
  }
  if (Object.hasOwn(project.lock.bricks, name)) {
    throw new PlugbricksError([issue("BRICK_NAME_CONFLICT", "", { name, source: project.lock.bricks[name].source })]);
  }
  const brickDir = join(project.root, BRICK_FOLDER, name);
  const serviceDir = join(project.root, SERVICE_FOLDER, name);
  const taken = [brickDir, serviceDir].filter((d) => existsSync(d));
  if (taken.length) {
    throw new PlugbricksError(
      taken.map((d) => issue("BRICK_CREATE_TARGET_EXISTS", "", { name, path: relative(project.root, d).split("\\").join("/") })),
    );
  }

  // --image names the image where a cluster can pull it, a registry (D28); the same pinning rule as any manifest.
  const image = options.image ?? `${project.platform.name}/${name}:0.1.0`;
  const pinned = checkImagePin(image);
  if (!pinned.ok) {
    const params: Record<string, string> = { image };
    if (pinned.code === "IMAGE_INVALID") params.reason = pinned.reason;
    if (pinned.code === "IMAGE_FLOATING_TAG") params.tag = pinned.tag;
    throw new PlugbricksError([issue(pinned.code, "", params)]);
  }
  const stem = name.slice(0, -`-${kind}`.length) || name;
  // A type and a field named after the brick: two created APIs compose together (a Query field defined by two
  // subgraphs would need @shareable).
  const Type = `${pascal(stem)}Item`;
  const field = `${pascal(stem).charAt(0).toLowerCase()}${pascal(stem).slice(1)}Items`;
  const values = {
    name,
    image,
    schema: MANIFEST_SCHEMA_ID,
    Type,
    field,
    // The same two names as gqlgen writes them in Go (the Go template only): each from the name the schema holds.
    GoType: goName(Type),
    GoField: goName(field),
  };
  // The parent folders this call creates go too when the add is refused: nothing is left of a refused create.
  const created = [dirname(brickDir), dirname(serviceDir)].filter((d) => !existsSync(d));
  try {
    copyTemplate(join(TEMPLATES, kind, "brick"), brickDir, values, name);
    // The brick is the same whatever its service is written in: the contract is the schema (D38).
    const service = options.lang && options.lang !== "node" ? `service-${options.lang}` : "service";
    copyTemplate(join(TEMPLATES, kind, service), serviceDir, values, name);
    const added = addBrick(project.root, brickDir, { byName: name });
    return {
      name,
      kind,
      image,
      brickDir: `${BRICK_FOLDER}/${name}`,
      serviceDir: `${SERVICE_FOLDER}/${name}`,
      added,
    };
  } catch (e) {
    rmSync(brickDir, { recursive: true, force: true });
    rmSync(serviceDir, { recursive: true, force: true });
    for (const d of created) rmSync(d, { recursive: true, force: true });
    throw e;
  }
}
