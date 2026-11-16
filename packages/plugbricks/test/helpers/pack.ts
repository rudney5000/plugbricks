import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

// Cross-platform helpers for the "test the published package" tests.
// - npm is run as `node <npm-cli.js>`: on Windows `npm` is a .cmd file, which Node refuses to
//   spawn without a shell since the 2024 security fix.
// - The tarball is extracted in JS: on Windows runners the `tar` found first may be GNU tar from
//   Git, which reads "C:\..." as a remote host.

/** Runs npm with the same npm that runs the tests (npm_execpath), falling back to `npm` on PATH. */
export function npm(args: string[], cwd: string): string {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith(".js")) return execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  return execFileSync("npm", args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
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
  const field = (h: Buffer, a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0[\s\S]*$/, "");
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
