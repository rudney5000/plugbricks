import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path, { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

// Cross-platform helpers for the "test the published package" tests.
// - npm is run as `node <npm-cli.js>`: on Windows `npm` is a .cmd file, which Node refuses to
//   spawn without a shell since the 2024 security fix, and a shell would split paths with spaces.
// - The tarball is extracted in JS: on Windows runners the `tar` found first may be GNU tar from
//   Git, which reads "C:\..." as a remote host.

/**
 * Finds npm's own entry script, to run it as `node npm-cli.js` on every OS (no shell, so paths
 * with spaces are passed as they are):
 * 1. npm_execpath, but only when it really is npm-cli.js (under yarn it points to yarn.js);
 * 2. the npm bundled with the running node: <node dir>/node_modules/npm/bin/npm-cli.js on
 *    Windows, <node dir>/../lib/node_modules/npm/bin/npm-cli.js elsewhere;
 * 3. the npm on PATH, still run through node: on Linux and macOS the `npm` link is resolved to
 *    its npm-cli.js (distribution packages put it elsewhere, e.g. /usr/share/nodejs/npm); on
 *    Windows `npm.cmd` sits next to node_modules/npm/bin/npm-cli.js.
 * Inputs are injectable so the choice can be tested on any OS.
 */
export function resolveNpmCli(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
  realpath: (p: string) => string = realpathSync,
): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fromEnv = env.npm_execpath;
  if (fromEnv && p.basename(fromEnv) === "npm-cli.js" && exists(fromEnv)) return fromEnv;
  const nodeDir = p.dirname(execPath);
  const bundled =
    platform === "win32"
      ? p.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js")
      : p.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (exists(bundled)) return bundled;
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  for (const dir of dirs) {
    if (platform === "win32") {
      const cli = p.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
      if (exists(p.join(dir, "npm.cmd")) && exists(cli)) return cli;
    } else if (exists(p.join(dir, "npm"))) {
      try {
        const target = realpath(p.join(dir, "npm"));
        if (p.basename(target) === "npm-cli.js") return target;
      } catch {
        // a broken link: try the next PATH entry
      }
    }
  }
  return undefined;
}

/** Runs npm as `node npm-cli.js ...args`, never through a shell. */
export function npm(args: string[], cwd: string): string {
  const cli = resolveNpmCli();
  if (!cli) {
    throw new Error("cannot find npm-cli.js: npm_execpath is not npm, no npm is bundled next to node, and no npm on PATH");
  }
  return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

/** `npm pack` into `dest`; returns the tarball path and the list of packed files. */
export function npmPack(pkgDir: string, dest: string): { tarball: string; files: string[] } {
  const out = npm(["pack", "--json", "--pack-destination", dest], pkgDir);
  // A prepack script prints its own output before the JSON.
  const [info] = JSON.parse(out.slice(out.indexOf("[")));
  return { tarball: join(dest, info.filename), files: info.files.map((f: { path: string }) => f.path) };
}

/** Extracts a .tgz produced by npm pack (ustar, optional pax headers) into `dest`. Regular files and directories only. */
export function extractTgz(tarball: string, dest: string): void {
  const buf = gunzipSync(readFileSync(tarball));
  const root = resolve(dest);
  let off = 0;
  let paxPath: string | undefined;
  const field = (h: Buffer, a: number, b: number) =>
    h
      .subarray(a, b)
      .toString("utf8")
      .replace(/\0[\s\S]*$/, "");
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(field(h, 124, 136).trim() || "0", 8);
    const type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const prefix = field(h, 345, 500);
    let name = prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
      continue;
    }
    if (type === "g") continue;
    if (paxPath) {
      name = paxPath;
      paxPath = undefined;
    }
    const target = resolve(root, ...name.split("/"));
    if (target !== root && !target.startsWith(root + sep)) throw new Error(`refusing to extract ${name} outside ${dest}`);
    if (type === "5") mkdirSync(target, { recursive: true });
    else if (type === "0") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    } else throw new Error(`unexpected tar entry type "${type}" for ${name}`);
  }
}

/** Links a directory; a junction on Windows, which needs no special privilege. */
export function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}
