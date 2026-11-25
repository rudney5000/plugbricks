import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import {
  addBrick,
  checkWindowsAcl,
  formatMessage,
  initPlatform,
  isValidPlatformName,
  PlugbricksError,
  restrictToCurrentUser,
  WINDOWS_ACL_SCRIPT,
} from "plugbricks";

const templateDir = new URL("../template/", import.meta.url);
/** The bricks this generator ships (D25, D30): copies of the examples of plugbricks, kept equal by a test. */
const bricksDir = new URL("../bricks/", import.meta.url);
/** What every new project gets in bricks/: the bricks whose images come from Docker Hub (D25). */
export const BASE_BRICKS = ["nats", "postgres", "rabbitmq"];
/** The starters (D30): a name, what it is, and the bricks it adds, in the order they are added. */
export const STARTERS = JSON.parse(readFileSync(new URL("../starters.json", import.meta.url), "utf8"));

/**
 * The project name and the options: `<name> [--starter <starter>]`, the option before or after the name, also as
 * `--starter=<starter>`. Null on a usage error.
 * @param {string[]} args
 */
export function parseArgs(args) {
  const positionals = [];
  let starter;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--starter") {
      if (starter !== undefined || i + 1 >= args.length || args[i + 1].startsWith("-")) return null;
      starter = args[++i];
    } else if (a.startsWith("--starter=")) {
      if (starter !== undefined || a === "--starter=") return null;
      starter = a.slice("--starter=".length);
    } else if (a.startsWith("-")) {
      return null;
    } else positionals.push(a);
  }
  if (positionals.length !== 1) return null;
  return { name: positionals[0], starter };
}

/** Exact version of the plugbricks package this generator was released with. */
function plugbricksVersion() {
  const pkg = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("plugbricks/package.json"), "utf8"));
  return pkg.version;
}

function error(io, code, params = {}) {
  io.stderr(`error ${code}: ${formatMessage(code, params)}`);
}

function warning(io, code, params = {}) {
  io.stderr(`warning ${code}: ${formatMessage(code, params)}`);
}

// The restriction of .secrets/ lives in plugbricks: `up` checks the same folder with the same rules
// before writing any secret. Re-exported for the tests and for compatibility.
export { checkWindowsAcl, restrictToCurrentUser, WINDOWS_ACL_SCRIPT };

/**
 * Creates a new plugbricks project in <cwd>/<name>.
 * Returns the exit code: 0 created, 1 refused, 2 usage error. Writes nothing when it refuses.
 * @param {string[]} args
 * @param {{ cwd: string, stdout: (l: string) => void, stderr: (l: string) => void }} io
 * @param {{ restrict?: typeof restrictToCurrentUser }} [deps] injectable for tests
 */
export function create(args, io, deps = {}) {
  const restrict = deps.restrict ?? restrictToCurrentUser;
  const parsed = parseArgs(args);
  if (!parsed) {
    error(io, "CREATE_MISSING_NAME");
    return 2;
  }
  const { name, starter } = parsed;
  if (starter !== undefined && !Object.hasOwn(STARTERS, starter)) {
    error(io, "CREATE_UNKNOWN_STARTER", { starter, starters: Object.keys(STARTERS).sort().join(", ") });
    return 2;
  }
  if (!isValidPlatformName(name)) {
    error(io, "PLATFORM_INVALID_NAME", { name });
    return 1;
  }
  const dir = resolve(io.cwd, name);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    error(io, "CREATE_TARGET_NOT_EMPTY", { dir });
    return 1;
  }

  mkdirSync(dir, { recursive: true });
  cpSync(templateDir, dir, { recursive: true });
  // bricks/: the base bricks, and the starter's (D30), from the catalogue of this generator.
  const shipped = [...new Set([...BASE_BRICKS, ...(starter ? STARTERS[starter].bricks : [])])];
  for (const b of shipped) cpSync(new URL(`${b}/`, bricksDir), join(dir, "bricks", b), { recursive: true });
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));
  renameSync(join(dir, "gitattributes"), join(dir, ".gitattributes"));
  const readme = join(dir, "README.md");
  writeFileSync(readme, readFileSync(readme, "utf8").replaceAll("{{name}}", name));

  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { status: "plugbricks status" },
    devDependencies: { plugbricks: plugbricksVersion() },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  try {
    initPlatform(dir, name);
  } catch (e) {
    if (e instanceof PlugbricksError) {
      for (const i of e.issues) error(io, i.code, i.params);
      return 1;
    }
    throw e;
  }
  // Empty folders are not kept by git: a placeholder keeps .platform/bricks/ visible from the first commit.
  writeFileSync(join(dir, ".platform/bricks/.gitkeep"), "");
  mkdirSync(join(dir, ".generated"), { recursive: true });
  mkdirSync(join(dir, ".secrets"), { recursive: true });
  const secrets = restrict(join(dir, ".secrets"));
  // Not fatal: .secrets/ is still empty. "plugbricks generate" and "up" refuse to write a secret into it until it is restricted.
  if (!secrets.ok) warning(io, "SECRETS_NOT_RESTRICTED", { dir: join(dir, ".secrets"), detail: secrets.detail });

  // A starter adds its bricks without asking (the person chose it, D30), in its order: each after what it needs.
  const added = [];
  if (starter) {
    try {
      for (const b of STARTERS[starter].bricks) {
        const r = addBrick(dir, join(dir, "bricks", b), { byName: b });
        added.push(`${r.name} ${r.version}`);
      }
    } catch (e) {
      if (e instanceof PlugbricksError) {
        for (const i of e.issues) error(io, i.code, i.params);
        return 1;
      }
      throw e;
    }
  }

  io.stdout(`Created ${name} in ${dir}`);
  if (starter) {
    io.stdout(`Starter "${starter}": ${STARTERS[starter].description}.`);
    io.stdout(`Added ${added.join(", ")}`);
  }
  io.stdout("");
  io.stdout("Next steps:");
  io.stdout(`  cd ${name}`);
  io.stdout("  npm install");
  if (starter) {
    io.stdout("  npx plugbricks up          # pulls the images of the bricks, then starts them (Docker Compose)");
    for (const line of starterUrls(dir)) io.stdout(line);
  } else {
    io.stdout("  npx plugbricks add postgres");
    io.stdout("  npx plugbricks status");
  }
  io.stdout("Then read README.md: it explains every folder.");
  return 0;
}

/** Where the started platform answers once up: the router, and the entry page of each web brick (D17). */
function starterUrls(dir) {
  const platform = JSON.parse(readFileSync(join(dir, "platform.json"), "utf8"));
  const lines = [`Once it is up, the GraphQL router answers at http://127.0.0.1:${platform.router.port}/graphql`];
  for (const [brick, b] of Object.entries(platform.bricks)) {
    if (b.webPort === undefined) continue;
    const manifest = JSON.parse(readFileSync(join(dir, b.source, "plugin.json"), "utf8"));
    lines.push(`and the page of ${brick} at http://127.0.0.1:${b.webPort}${manifest.web?.path ?? "/"}`);
  }
  return lines;
}
