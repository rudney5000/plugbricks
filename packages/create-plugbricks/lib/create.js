import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { formatMessage, initPlatform, isValidPlatformName, PlugbricksError } from "plugbricks";

const templateDir = new URL("../template/", import.meta.url);

/** Exact version of the plugbricks package this generator was released with. */
function plugbricksVersion() {
  const pkg = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("plugbricks/package.json"), "utf8"));
  return pkg.version;
}

function error(io, code, params = {}) {
  io.stderr(`error ${code}: ${formatMessage(code, params)}`);
}

/**
 * Creates a new plugbricks project in <cwd>/<name>.
 * Returns the exit code: 0 created, 1 refused, 2 usage error. Writes nothing when it refuses.
 * @param {string[]} args
 * @param {{ cwd: string, stdout: (l: string) => void, stderr: (l: string) => void }} io
 */
export function create(args, io) {
  const [name, ...extra] = args;
  if (!name || extra.length) {
    error(io, "CREATE_MISSING_NAME");
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
  renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));
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
  chmodSync(join(dir, ".secrets"), 0o700);

  io.stdout(`Created ${name} in ${dir}`);
  io.stdout("");
  io.stdout("Next steps:");
  io.stdout(`  cd ${name}`);
  io.stdout("  npm install");
  io.stdout("  npx plugbricks status");
  io.stdout("Then read README.md: it explains every folder.");
  return 0;
}
