import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Packs the package exactly as npm would publish it (prepack runs the build),
// unpacks it in a temp dir and runs the compiled code from there: this catches
// a schema path that only resolves from src/, and files missing from "files".
const pkgDir = fileURLToPath(new URL("../", import.meta.url));
const nodeModules = fileURLToPath(new URL("../../../node_modules", import.meta.url));
const example = fileURLToPath(new URL("../examples/postgres/plugin.json", import.meta.url));

let tmp: string;
let files: string[];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "plugbricks-dist-"));
  const out = execFileSync("npm", ["pack", "--json", "--pack-destination", tmp], { cwd: pkgDir, encoding: "utf8" });
  // npm prints the prepack build output before the JSON.
  const [info] = JSON.parse(out.slice(out.indexOf("[")));
  files = info.files.map((f: { path: string }) => f.path);
  execFileSync("tar", ["-xzf", join(tmp, info.filename), "-C", tmp]);
  // Dependencies come from the workspace install; the unpacked package has none of its own.
  symlinkSync(nodeModules, join(tmp, "package", "node_modules"), "dir");
}, 120_000);

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("published package", () => {
  it("ships the compiled code and the schema, not the sources or tests", () => {
    expect(files).toEqual(
      expect.arrayContaining(["package.json", "dist/index.js", "dist/index.d.ts", "schemas/plugin-manifest.schema.json"]),
    );
    expect(files.filter((f) => /^(src|test|examples)\//.test(f))).toEqual([]);
  });

  it("validates an example manifest from the built code", () => {
    const script = `
      import { readFileSync } from "node:fs";
      import { validateManifest, MANIFEST_SCHEMA_ID } from "plugbricks";
      import schema from "plugbricks/schema.json" with { type: "json" };
      if (schema.$id !== MANIFEST_SCHEMA_ID) throw new Error("schema export mismatch");
      const r = validateManifest(JSON.parse(readFileSync(process.argv[1], "utf8")));
      const bad = validateManifest({ name: "x" });
      console.log(JSON.stringify({ ok: r.ok, rejectsInvalid: !bad.ok, from: import.meta.resolve("plugbricks") }));
    `;
    // Run inside the unpacked package so "plugbricks" resolves to it via its own exports.
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script, example], {
      cwd: join(tmp, "package"),
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    });
    const r = JSON.parse(out);
    expect(r).toMatchObject({ ok: true, rejectsInvalid: true });
    expect(r.from).toContain(join(tmp, "package", "dist", "index.js"));
  });
});
